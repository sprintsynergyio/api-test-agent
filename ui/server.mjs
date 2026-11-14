// Demo UI server. No dependencies. Run from the project root: node ui/server.mjs
// Open http://localhost:3000
//
// Contract with the agent (agent/cli.ts):
//   - stdout phase headers: "=== PROBING ===", "=== PLANNING ===", "=== GENERATING ===",
//     "=== RUNNING TESTS ===", "=== SUMMARY ==="
//   - per endpoint lines inside probe/plan/generate: "<endpointId> OK <detail>" or "<endpointId> FAILED <reason>"
//   - out/summary.json in the shape documented in ui/CONTRACT.md
//
// AGENT_CMD env var overrides the agent command (used for testing the UI with a mock agent).
//
// Input validation uses the agent's own zod schema (agent/config.ts, loaded through tsx), so every auth
// type, roles, profiles and redaction settings the agent accepts are accepted here too. Every run, with
// or without login, gets a folder under runs/<runId>/ with its input and a snapshot of its results, so
// the page can list past runs and show the evidence of each finding (ui/CONTRACT.md section 11).
//
// Hosted mode (HOSTED=1): for a shared server (the SprintSynergy VPS). Login is required (UI_USERS),
// ANTHROPIC_API_KEY is required, local and private hosts are refused, a production host never gets
// writes, runs are rate limited per login, queued one at a time, and each login only sees its own
// runs (snapshots under runs/<runId>/). Without HOSTED and without UI_USERS the server behaves as
// the local demo always has. See docs/HOSTING.md.

import dotenv from "dotenv";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

// ENV_FILE (tests) points at another .env; the default is the project root .env.
dotenv.config({ quiet: true, ...(process.env.ENV_FILE ? { path: path.resolve(process.env.ENV_FILE) } : {}) });
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { classifyHost, localRefusalMessage, refusalMessage, safetyMode } from "./host-class.mjs";

const require = createRequire(import.meta.url);
const bcrypt = require("bcryptjs");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.UI_PORT || 3000);
const HOSTED = process.env.HOSTED === "1";
const HOST = process.env.HOST || "127.0.0.1";
const FORCE_PRODUCTION = process.env.AGENT_FORCE_PRODUCTION === "1";
const RUNS_DIR = path.join(ROOT, "runs");
const RUNS_PER_HOUR = positiveInt(process.env.HOSTED_RUNS_PER_HOUR, 5);
const MAX_QUEUE = positiveInt(process.env.HOSTED_QUEUE, 5);
const RUN_TTL_MS = positiveInt(process.env.HOSTED_RUN_TTL_HOURS, 24) * 60 * 60 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_COOKIE = "ats_session";

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// UI_USERS: "name:bcryptHash,name2:bcryptHash". Hashes come from npm run ui:hash -- <password>.
function parseUsers(text) {
  const users = new Map();
  for (const entry of String(text || "").split(",").map((e) => e.trim()).filter(Boolean)) {
    const i = entry.indexOf(":");
    const name = i > 0 ? entry.slice(0, i).trim() : "";
    const hash = i > 0 ? entry.slice(i + 1).trim() : "";
    if (!/^[a-zA-Z0-9._-]{1,40}$/.test(name) || !/^\$2[aby]\$\d\d\$/.test(hash)) {
      console.error(`UI_USERS entry is not "name:bcryptHash": ${entry.slice(0, 20)}... Make hashes with: npm run ui:hash -- <password>`);
      process.exit(1);
    }
    users.set(name, hash);
  }
  return users;
}
const USERS = parseUsers(process.env.UI_USERS);
const LOGIN_REQUIRED = USERS.size > 0;

if (HOST !== "127.0.0.1" && HOST !== "localhost" && !HOSTED) {
  console.error(`HOST=${HOST} is only allowed with HOSTED=1. Without hosted mode the UI listens on 127.0.0.1 only.`);
  process.exit(1);
}
if (HOSTED && !LOGIN_REQUIRED) {
  console.error("HOSTED=1 requires UI_USERS (name:bcryptHash,...). Make a hash with: npm run ui:hash -- <password>");
  process.exit(1);
}
// Model provider (mirrors agent/claude.ts modelChoice): LLM_PROVIDER anthropic (default) or openai.
const PROVIDERS = [
  { id: "anthropic", label: "Claude (Anthropic)", defaultModel: "claude-sonnet-5-5", keyEnv: "ANTHROPIC_API_KEY" },
  { id: "openai", label: "OpenAI", defaultModel: "gpt-6.1-sol", keyEnv: "OPENAI_API_KEY" },
];
function providerId() {
  const raw = String(process.env.LLM_PROVIDER || "anthropic").trim().toLowerCase();
  return raw === "openai" ? "openai" : "anthropic";
}
function providerOf(id) {
  return PROVIDERS.find((p) => p.id === id) || PROVIDERS[0];
}
if (HOSTED && !process.env[providerOf(providerId()).keyEnv]) {
  console.error(`HOSTED=1 requires ${providerOf(providerId()).keyEnv} (LLM_PROVIDER=${providerId()}): the hosted agent never uses a personal Claude login.`);
  process.exit(1);
}
// Settings can be changed from the browser only on a personal machine: no login, not hosted.
const SETTINGS_EDITABLE = !HOSTED && !LOGIN_REQUIRED;
const ENV_FILE = process.env.ENV_FILE ? path.resolve(process.env.ENV_FILE) : path.join(ROOT, ".env");
const ENV_EXAMPLE = path.join(ROOT, ".env.example");
// Is the Claude Code CLI on this machine? Checked once at start; SKIP_CLI_DETECT=1 (tests) says no.
const CLI_FOUND = process.env.SKIP_CLI_DETECT === "1" ? false : detectClaudeCli();
function detectClaudeCli() {
  try {
    const r = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 15000, env: childEnvWithoutSecrets() });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}
function childEnvWithoutSecrets() {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  for (const k of Object.keys(env)) if (/AUTH|ANTHROPIC_API_KEY|OPENAI_API_KEY/i.test(k)) delete env[k];
  return env;
}
function settingsState() {
  const id = providerId();
  const p = providerOf(id);
  const hasKey = Boolean(process.env[p.keyEnv]);
  const model = process.env.LLM_MODEL || (id === "anthropic" ? process.env.CLAUDE_MODEL : "") || (hasKey || id === "openai" ? p.defaultModel : "default");
  const via = id === "anthropic" && !hasKey ? "cli" : "api";
  const configured = hasKey || (id === "anthropic" && CLI_FOUND);
  return { provider: id, model, hasKey, via, configured, editable: SETTINGS_EDITABLE, providers: PROVIDERS };
}
// Replace or add KEY=value lines in .env, keeping every other line as it is.
function writeEnvLines(pairs) {
  let text = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : fs.existsSync(ENV_EXAMPLE) ? fs.readFileSync(ENV_EXAMPLE, "utf8") : "";
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  for (const [key, value] of Object.entries(pairs)) {
    const line = `${key}=${value}`;
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      if (new RegExp(`^\\s*#?\\s*${key}=`).test(lines[i]) && !found) {
        lines[i] = line;
        found = true;
      }
    }
    if (!found) lines.push(line);
  }
  fs.writeFileSync(ENV_FILE, lines.join("\n") + "\n", { mode: 0o600 });
  try {
    fs.chmodSync(ENV_FILE, 0o600);
  } catch {}
  for (const [key, value] of Object.entries(pairs)) process.env[key] = value;
}
// Agent modules loaded on first use through tsx (already a dev dependency: the server starts the agent
// with it): claude.ts for verifyProviderKey, config.ts and model.ts for input validation and profiles.
const agentModules = {};
async function agentModule(name) {
  if (!agentModules[name]) {
    const { tsImport } = await import("tsx/esm/api");
    agentModules[name] = await tsImport(path.join(ROOT, "agent", `${name}.ts`), import.meta.url);
  }
  return agentModules[name];
}
async function verifyKey(provider, key, model) {
  return (await agentModule("claude")).verifyProviderKey(provider, key, model);
}

// Validates input JSON the way the agent does (zod schema, then the rules zod cannot express, then the
// profile selection). Never throws. Returns every problem as { path, message } so the page can point at
// the field, plus what the page needs to show before a run: the resolved base URL, the host class, the
// profile dimensions, the framework and the auth environment variables the run will read.
async function validateInput(text, selectionText) {
  const out = { ok: false, problems: [], baseUrl: null, hostClass: null, mode: null, selection: null, dimensions: null, framework: "playwright", auth: null, redaction: null, endpoints: 0, name: null };
  let raw;
  try {
    raw = JSON.parse(String(text ?? ""));
  } catch (e) {
    out.problems.push({ path: "(root)", message: `Invalid JSON: ${e.message}` });
    return out;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    out.problems.push({ path: "(root)", message: "Input must be a JSON object" });
    return out;
  }
  const cfgMod = await agentModule("config");
  const parsed = cfgMod.ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) out.problems.push({ path: issuePath(issue.path), message: issue.message });
    return out;
  }
  for (const problem of cfgMod.configProblems(parsed.data)) out.problems.push(splitProblem(problem));
  const data = parsed.data;
  out.name = data.name || null;
  out.framework = data.framework || "playwright";
  out.endpoints = data.endpoints.length;
  out.redaction = { mode: (data.redaction && data.redaction.mode) || "standard", fields: (data.redaction && data.redaction.fields) || [] };
  if (data.profile) out.dimensions = data.profile.dimensions;
  if (data.auth) {
    const a = data.auth;
    const roles = Object.keys(a.roles || {});
    const envNames = a.type === "login" ? Object.values(a.credentialsEnv) : [a.valueEnv];
    for (const r of roles) {
      const role = a.roles[r];
      if (role.credentialsEnv) envNames.push(...Object.values(role.credentialsEnv));
      if (role.valueEnv) envNames.push(role.valueEnv);
    }
    const names = [...new Set(envNames)];
    // Which of those the server's own environment (.env) lacks: names only, never values.
    const envMissing = names.filter((n) => n !== "CUSTOM_API_AUTH" && !process.env[n]);
    out.auth = { type: a.type, roles, envNames: names, envMissing, oneRunValue: a.type !== "login" && a.valueEnv === "CUSTOM_API_AUTH" };
  }
  if (out.problems.length) return out;
  const modelMod = await agentModule("model");
  let resolved;
  try {
    resolved = modelMod.applyProfile(data, selectionText || undefined);
  } catch (e) {
    out.problems.push({ path: "profile", message: String(e.message || e) });
    return out;
  }
  out.baseUrl = resolved.baseUrl;
  out.selection = resolved.selection || null;
  const { hostClass, mode } = safetyMode(resolved.baseUrl, data, { forceProduction: FORCE_PRODUCTION, hosted: HOSTED });
  out.hostClass = hostClass;
  out.mode = mode;
  out.ok = true;
  return out;
}
function issuePath(parts) {
  return parts.reduce((acc, key) => (typeof key === "number" ? `${acc}[${key}]` : acc ? `${acc}.${String(key)}` : String(key)), "") || "(root)";
}
// configProblems strings look like: field "endpoints[1].setup.endpointId" references unknown endpoint "x"
function splitProblem(text) {
  const m = String(text).match(/^field "([^"]+)" (.*)$/s);
  return m ? { path: m[1], message: m[2] } : { path: "(root)", message: String(text) };
}
const INPUT_DIR = path.join(ROOT, "input");
const RUN_FILE = "input/ui-run.json";
const SUMMARY = path.join(ROOT, "out", "summary.json");
const INDEX = path.join(ROOT, "ui", "index.html");
const HOST_CLASS = path.join(ROOT, "ui", "host-class.mjs");
const PROTECTED_INPUTS = new Set(["endpoints.json", "demo-small.json", "local-shop.json"]);
const IMPORT_TYPES = ["postman", "openapi", "curl", "har", "text"];
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
// A text import makes up to 2 Claude calls of up to 3 minutes each.
const IMPORT_TIMEOUT_MS = 7 * 60 * 1000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".zip": "application/zip",
  ".txt": "text/plain; charset=utf-8",
  ".webm": "video/webm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".gif": "image/gif",
};

let run = null; // { id, owner, user, dir, proc, lines, startedAt, exitCode, clients: Set<{ res, sid }> }
const queue = []; // jobs waiting for the single agent slot: { id, owner, user, dir, inputPath, authValue }
const sessions = new Map(); // sid -> { user, createdAt, lastSeen, runIds: [] }
const runStarts = new Map(); // user -> [timestamp] of runs started or queued in the last hour

function newId() {
  return crypto.randomBytes(12).toString("hex");
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionOf(req) {
  if (!LOGIN_REQUIRED) return null;
  const sid = parseCookies(req)[SESSION_COOKIE];
  const s = sid && sessions.get(sid);
  if (!s) return null;
  if (Date.now() - s.lastSeen > SESSION_TTL_MS) {
    sessions.delete(sid);
    return null;
  }
  s.lastSeen = Date.now();
  return { sid, ...s };
}

function sessionCookie(req, sid, maxAgeSec) {
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure}`;
}

// Routes that need a login when UI_USERS is set. Static files and the login routes stay open.
function needsLogin(method, p) {
  if (p === "/api/session" || p === "/api/login" || p === "/api/logout") return false;
  return p.startsWith("/api/") || p === "/report" || p.startsWith("/report/") || p === "/allure" || p.startsWith("/allure/");
}

function runsThisHour(user) {
  const cutoff = Date.now() - 60 * 60 * 1000;
  const list = (runStarts.get(user) || []).filter((t) => t > cutoff);
  runStarts.set(user, list);
  return list.length;
}

// Every run has its own folder under runs/: its input and, when it ends, a snapshot of the results.
// Without login the agent's fixed paths (out/, reports/, generated/) are served for the latest run as
// always, and ?run=<id> serves an earlier one; with login a run is only served to the login that made it.
const SNAPSHOT = [
  ["out/summary.json", "summary.json"],
  ["out/framework.zip", "framework.zip"],
  ["reports/html", "html"],
  ["reports/allure-report", "allure-report"],
  ["reports/results.json", "results.json"],
  ["reports/pactum", "pactum"],
  ["generated", "generated"],
];
const LOCAL_RUNS_KEPT = 20;

function snapshotRun(r) {
  for (const [from, to] of SNAPSHOT) {
    const src = path.join(ROOT, from);
    if (!fs.existsSync(src)) continue;
    fs.cpSync(src, path.join(r.dir, to), { recursive: true, filter: (f) => !f.includes(`${path.sep}.candidate`) });
  }
  fs.writeFileSync(path.join(r.dir, "done.json"), JSON.stringify({ exitCode: r.exitCode, finishedAt: Date.now() }));
}

// The run a request may see: ?run=<id> when the session owns it, else the session's latest finished run.
function runDirFor(session, url) {
  if (!LOGIN_REQUIRED) {
    const wanted = url.searchParams.get("run");
    if (wanted && /^[a-f0-9]{24}$/.test(wanted) && fs.existsSync(path.join(RUNS_DIR, wanted, "done.json"))) return path.join(RUNS_DIR, wanted);
    return ROOT;
  }
  const wanted = url.searchParams.get("run");
  const ids = session ? session.runIds : [];
  const id = wanted ? (ids.includes(wanted) ? wanted : null) : [...ids].reverse().find((i) => fs.existsSync(path.join(RUNS_DIR, i, "done.json"))) || null;
  return id ? path.join(RUNS_DIR, id) : null;
}

function artifact(dir, name) {
  if (!dir) return null;
  if (dir === ROOT) return path.join(ROOT, SNAPSHOT.find(([, to]) => to === name)[0]);
  return path.join(dir, name);
}

function cleanupRuns() {
  if (!fs.existsSync(RUNS_DIR)) return;
  const cutoff = Date.now() - RUN_TTL_MS;
  // Without login there is no TTL: the last LOCAL_RUNS_KEPT runs stay, older ones go.
  if (!LOGIN_REQUIRED) {
    const dirs = fs.readdirSync(RUNS_DIR).map((id) => ({ id, mtime: safeMtime(path.join(RUNS_DIR, id)) })).filter((d) => d.mtime !== null).sort((a, b) => b.mtime - a.mtime);
    for (const d of dirs.slice(LOCAL_RUNS_KEPT)) {
      const inUse = run && run.id === d.id && run.exitCode === null;
      if (!inUse) fs.rmSync(path.join(RUNS_DIR, d.id), { recursive: true, force: true });
    }
    return;
  }
  for (const id of fs.readdirSync(RUNS_DIR)) {
    const dir = path.join(RUNS_DIR, id);
    let mtime;
    try {
      mtime = fs.statSync(dir).mtimeMs;
    } catch {
      continue;
    }
    const inUse = (run && run.id === id && run.exitCode === null) || queue.some((j) => j.id === id);
    if (mtime < cutoff && !inUse) {
      fs.rmSync(dir, { recursive: true, force: true });
      for (const s of sessions.values()) s.runIds = s.runIds.filter((r) => r !== id);
      console.log(`UI: removed old run ${id}`);
    }
  }
  for (const [sid, s] of sessions) if (Date.now() - s.lastSeen > SESSION_TTL_MS) sessions.delete(sid);
}

function safeMtime(dir) {
  try {
    return fs.statSync(dir).mtimeMs;
  } catch {
    return null;
  }
}

// One line per past run for GET /api/runs, newest first, read from each run folder's summary snapshot.
function listRuns(session) {
  if (!fs.existsSync(RUNS_DIR)) return [];
  const ids = LOGIN_REQUIRED ? [...(session ? session.runIds : [])] : fs.readdirSync(RUNS_DIR).filter((id) => /^[a-f0-9]{24}$/.test(id));
  const rows = [];
  for (const id of ids) {
    const dir = path.join(RUNS_DIR, id);
    if (!fs.existsSync(path.join(dir, "done.json"))) continue;
    let done = {};
    let summary = null;
    try {
      done = JSON.parse(fs.readFileSync(path.join(dir, "done.json"), "utf8"));
    } catch {}
    try {
      summary = JSON.parse(fs.readFileSync(path.join(dir, "summary.json"), "utf8"));
    } catch {}
    const findings = summary && Array.isArray(summary.findings) ? summary.findings.filter((f) => /api finding/i.test(f.classification || "")).length : null;
    rows.push({
      id,
      finishedAt: done.finishedAt || safeMtime(dir),
      exitCode: done.exitCode ?? null,
      status: summary ? summary.status : null,
      inputFile: summary ? summary.inputFile : null,
      name: summary && summary.framework ? summary.framework.name : null,
      baseUrl: summary ? summary.baseUrl : null,
      testFramework: summary ? summary.testFramework || "playwright" : null,
      findings,
      tests: summary && summary.totals ? summary.totals.testsGenerated : null,
      failed: summary && summary.totals ? summary.totals.failed : null,
      durationSec: summary ? summary.durationSec : null,
    });
  }
  return rows.sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0)).slice(0, 20);
}

// The folder evidence files are read from: reports/ for the live run, the run's snapshot otherwise.
function evidenceBase(dir) {
  return dir === ROOT ? path.join(ROOT, "reports") : dir;
}

// Request and response pairs recorded for one test, from the Playwright JSON report (attachments are
// inline, base64) or from reports/pactum/status.json plus its evidence files. Everything in them was
// redacted by the agent before it was written; the server only reads and decodes.
function evidenceForTest(dir, title) {
  const base = evidenceBase(dir);
  const out = [];
  const pw = path.join(base, "results.json");
  if (fs.existsSync(pw)) {
    let report;
    try {
      report = JSON.parse(fs.readFileSync(pw, "utf8"));
    } catch {
      report = null;
    }
    const walk = (suite) => {
      for (const spec of suite.specs || []) {
        for (const t of spec.tests || []) {
          const last = t.results && t.results[t.results.length - 1];
          if (!last || spec.title !== title) continue;
          for (const a of last.attachments || []) {
            if (a.contentType !== "application/json" || !a.body || /allure/i.test(a.name || "")) continue;
            try {
              const parsed = JSON.parse(Buffer.from(a.body, "base64").toString("utf8"));
              out.push({ name: a.name, request: parsed.request || null, response: parsed.response || null });
            } catch {}
          }
        }
      }
      for (const child of suite.suites || []) walk(child);
    };
    if (report) for (const s of report.suites || []) walk(s);
  }
  const pactumStatus = path.join(base, "pactum", "status.json");
  if (!out.length && fs.existsSync(pactumStatus)) {
    let entries = [];
    try {
      entries = JSON.parse(fs.readFileSync(pactumStatus, "utf8"));
    } catch {}
    for (const e of entries) {
      if (e.title !== title) continue;
      for (const file of e.evidence || []) {
        const f = path.join(base, "pactum", "evidence", path.basename(file));
        if (!fs.existsSync(f)) continue;
        try {
          const parsed = JSON.parse(fs.readFileSync(f, "utf8"));
          out.push({ name: `${parsed.request?.method || ""} ${parsed.request?.path || ""} -> ${parsed.response?.status ?? "failed"}`.trim(), file: `pactum/evidence/${path.basename(file)}`, request: parsed.request || null, response: parsed.response || null });
        } catch {}
      }
    }
  }
  return out;
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => resolve(raw));
  });
}

// Like readBody, but stops keeping data past limit bytes and resolves null.
function readBodyCapped(req, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
    });
    req.on("end", () => resolve(size > limit ? null : Buffer.concat(chunks).toString("utf8")));
  });
}

// Runs agent/import.ts with the content on stdin. Nothing is written to disk. The importer never
// needs an API auth value, so it gets no environment variable with AUTH in its name.
function runImport(type, content) {
  return new Promise((resolve) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/AUTH/i.test(name)));
    const child = spawn(path.join(ROOT, "node_modules", ".bin", "tsx"), ["agent/import.ts", type], {
      cwd: ROOT,
      env: { ...env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, IMPORT_TIMEOUT_MS);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    // If the importer exits before reading all of stdin, "close" below reports how it failed.
    child.stdin.on("error", () => {});
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `import FAILED could not start the importer: ${err.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin.end(content);
  });
}

function listInputs() {
  if (!fs.existsSync(INPUT_DIR)) return [];
  return fs
    .readdirSync(INPUT_DIR)
    .filter((f) => f.endsWith(".json") && f !== "ui-run.json")
    .sort();
}


const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

// With login on, only the session that owns the run sees its stream.
function broadcast(event, data) {
  if (!run) return;
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of run.clients) if (!LOGIN_REQUIRED || c.sid === run.owner) c.res.write(msg);
}

function pushLine(line) {
  const clean = line.replace(ANSI, "").replace(/\r/g, "");
  run.lines.push(clean);
  broadcast("log", clean);
}

function agentCommand() {
  if (process.env.AGENT_CMD) {
    const parts = process.env.AGENT_CMD.split(" ").filter(Boolean);
    return { cmd: parts[0], args: parts.slice(1) };
  }
  const tsx = path.join(ROOT, "node_modules", ".bin", "tsx");
  return { cmd: tsx, args: ["agent/cli.ts"] };
}

function startRun(job) {
  const { cmd, args } = agentCommand();
  // The agent only clears out/ after it has loaded the input, so a run that fails earlier would leave the
  // previous summary behind. Remove it here so a run can never be shown the old run's results.
  fs.rmSync(SUMMARY, { force: true });
  const proc = spawn(cmd, [...args, job.inputPath], {
    cwd: ROOT,
    // A custom auth value is passed to this run only, through the environment. It is never written to disk.
    // HOSTED (when set) is inherited, so the agent applies the hosted safety rules too.
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", ...(job.authValue ? { CUSTOM_API_AUTH: job.authValue } : {}), ...(job.selection ? { AGENT_SELECT: job.selection } : {}) },
  });
  const prevClients = run ? run.clients : new Set();
  run = { id: job.id, owner: job.owner, user: job.user, dir: job.dir, proc, lines: [], startedAt: Date.now(), exitCode: null, clients: prevClients };
  if (job.user) console.log(`UI: run ${job.id} started for ${job.user}`);
  broadcast("start", { startedAt: run.startedAt, runId: run.id });

  for (const stream of [proc.stdout, proc.stderr]) {
    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk.toString();
      const parts = buf.split("\n");
      buf = parts.pop();
      parts.forEach(pushLine);
    });
    stream.on("end", () => {
      if (buf) pushLine(buf);
      buf = "";
    });
  }
  proc.on("error", (err) => {
    pushLine(`UI: could not start the agent: ${err.message}`);
  });
  proc.on("close", (code) => {
    run.exitCode = code ?? 1;
    if (run.dir) {
      try {
        snapshotRun(run);
      } catch (err) {
        pushLine(`UI: could not save the run's results: ${err.message}`);
      }
    }
    broadcast("done", { exitCode: run.exitCode, durationSec: Math.round((Date.now() - run.startedAt) / 1000), runId: run.id });
    startNext();
  });
}

function startNext() {
  if (isRunning() || queue.length === 0) return;
  startRun(queue.shift());
}

function queuePosition(sid) {
  const i = queue.findIndex((j) => j.owner === sid);
  return i === -1 ? null : i + 1;
}

function isRunning() {
  return run && run.exitCode === null;
}

function serveFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { error: "not found" });
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  if (req.method === "GET" && (p === "/" || p === "/index.html")) return serveFile(res, INDEX);
  if (req.method === "GET" && p === "/host-class.mjs") return serveFile(res, HOST_CLASS);

  const session = sessionOf(req);
  if (LOGIN_REQUIRED && needsLogin(req.method, p) && !session) return json(res, 401, { error: "Login required" });

  if (req.method === "GET" && p === "/api/session") {
    return json(res, 200, { loginRequired: LOGIN_REQUIRED, hosted: HOSTED, user: session ? session.user : null, runsPerHour: HOSTED ? RUNS_PER_HOUR : null });
  }

  if (req.method === "POST" && p === "/api/login") {
    if (!LOGIN_REQUIRED) return json(res, 400, { error: "This server has no login" });
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { error: "Request body must be JSON" });
    }
    const user = String((body && body.user) || "");
    const password = String((body && body.password) || "");
    const hash = USERS.get(user);
    const ok = hash ? await bcrypt.compare(password, hash) : false;
    if (!ok) {
      await new Promise((r) => setTimeout(r, 500));
      console.log(`UI: login failed for ${user || "(empty)"}`);
      return json(res, 401, { error: "Wrong user name or password" });
    }
    const sid = newId();
    sessions.set(sid, { user, createdAt: Date.now(), lastSeen: Date.now(), runIds: [] });
    console.log(`UI: ${user} logged in`);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Set-Cookie": sessionCookie(req, sid, SESSION_TTL_MS / 1000) });
    return res.end(JSON.stringify({ user }));
  }

  if (req.method === "GET" && p === "/api/settings") return json(res, 200, settingsState());

  if (req.method === "POST" && (p === "/api/settings/verify" || p === "/api/settings")) {
    if (!SETTINGS_EDITABLE) return json(res, 403, { error: "Model settings can only be changed on a personal machine (no login, not hosted). Set the key in .env on the server." });
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { error: "Request body must be JSON" });
    }
    const provider = String((body && body.provider) || "").trim().toLowerCase();
    const key = String((body && body.key) || "").trim();
    const model = String((body && body.model) || "").trim();
    if (!PROVIDERS.some((x) => x.id === provider)) return json(res, 400, { error: "provider must be anthropic or openai" });
    if (!/^[A-Za-z0-9._:-]{8,300}$/.test(key)) return json(res, 400, { error: "That does not look like an API key. Paste the whole key with no spaces." });
    if (model && !/^[A-Za-z0-9._-]{1,80}$/.test(model)) return json(res, 400, { error: "The model name may only contain letters, numbers, dots, dashes and underscores." });
    let check;
    try {
      check = await verifyKey(provider, key, model);
    } catch (err) {
      return json(res, 500, { error: `Could not verify the key: ${String(err && err.message ? err.message : err).split(key).join("<redacted>").slice(0, 200)}` });
    }
    if (p === "/api/settings/verify") return json(res, 200, check);
    if (!check.ok) return json(res, 400, { error: check.error, check });
    const pairs = { LLM_PROVIDER: provider, LLM_MODEL: model, [providerOf(provider).keyEnv]: key };
    try {
      writeEnvLines(pairs);
    } catch (err) {
      return json(res, 500, { error: `Could not write .env: ${String(err && err.message ? err.message : err).split(key).join("<redacted>")}` });
    }
    console.log(`UI: model settings saved (${provider}, ${model || providerOf(provider).defaultModel}) to ${path.basename(ENV_FILE)}`);
    return json(res, 200, settingsState());
  }

  if (req.method === "POST" && p === "/api/logout") {
    if (session) sessions.delete(session.sid);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Set-Cookie": sessionCookie(req, "", 0) });
    return res.end(JSON.stringify({ loggedOut: true }));
  }

  if (req.method === "GET" && p === "/api/inputs") return json(res, 200, listInputs());

  if (req.method === "GET" && p === "/api/input") {
    const name = url.searchParams.get("name");
    if (!listInputs().includes(name)) return json(res, 404, { error: "unknown input file" });
    return json(res, 200, { name, content: fs.readFileSync(path.join(INPUT_DIR, name), "utf8") });
  }

  if (req.method === "GET" && p === "/api/state") {
    const mine = !LOGIN_REQUIRED || (run && run.owner === (session && session.sid));
    const summaryFile = artifact(runDirFor(session, url), "summary.json");
    return json(res, 200, {
      running: !!isRunning(),
      yours: !!(isRunning() && mine),
      startedAt: run && mine ? run.startedAt : null,
      exitCode: run && mine ? run.exitCode : null,
      hasSummary: !!(summaryFile && fs.existsSync(summaryFile)),
      queued: queue.length,
      position: session ? queuePosition(session.sid) : null,
      hosted: HOSTED,
      user: session ? session.user : null,
    });
  }

  if (req.method === "POST" && p === "/api/validate-input") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { error: "Request body must be JSON" });
    }
    if (typeof body.json !== "string") return json(res, 400, { error: "json must be a string" });
    const selection = body.selection === undefined || body.selection === null ? undefined : String(body.selection);
    return json(res, 200, await validateInput(body.json, selection));
  }

  if (req.method === "POST" && p === "/api/run") {
    if (isRunning() && !LOGIN_REQUIRED) return json(res, 409, { error: "A run is already in progress" });
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { error: "Request body must be JSON" });
    }
    if (typeof body.json !== "string") return json(res, 400, { error: "json must be a string" });
    if (body.authValue !== undefined && typeof body.authValue !== "string") return json(res, 400, { error: "authValue must be a string" });
    if (body.selection !== undefined && body.selection !== null && typeof body.selection !== "string") return json(res, 400, { error: "selection must be a string" });
    const selection = body.selection || undefined;
    const checked = await validateInput(body.json, selection);
    if (!checked.ok) {
      const first = checked.problems[0];
      return json(res, 400, { error: `${first.path === "(root)" ? "" : first.path + ": "}${first.message}`, problems: checked.problems });
    }
    const cfg = JSON.parse(body.json);
    // The safety guard does not depend on the browser: the same rules as agent/safety.ts decide here on
    // the resolved base URL. AGENT_FORCE_PRODUCTION=1 (testing only) treats every host as production.
    // Hosted: a local or private host is the server's own network and is refused outright.
    if (checked.mode === "refused") {
      const message = checked.hostClass === "local" ? localRefusalMessage(checked.baseUrl) : refusalMessage(checked.baseUrl);
      console.log(`UI: run refused, ${checked.hostClass} host (${message})`);
      return json(res, 400, { error: message });
    }
    if (checked.auth && checked.auth.oneRunValue && !body.authValue) {
      return json(res, 400, { error: "This API needs an auth value for this run. Enter it in the auth field." });
    }
    const id = newId();
    const dir = path.join(RUNS_DIR, id);
    if (LOGIN_REQUIRED) {
      if (queue.some((j) => j.owner === session.sid) || (isRunning() && run.owner === session.sid)) {
        return json(res, 409, { error: "You already have a run in progress or queued" });
      }
      if (HOSTED && runsThisHour(session.user) >= RUNS_PER_HOUR) {
        return json(res, 429, { error: `Limit reached: ${RUNS_PER_HOUR} runs per hour per login. Try again later.` });
      }
      if (isRunning() && queue.length >= MAX_QUEUE) return json(res, 429, { error: `The queue is full (${MAX_QUEUE} waiting). Try again in a few minutes.` });
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "input.json"), body.json);
      const s = sessions.get(session.sid);
      s.runIds.push(id);
      if (HOSTED) runStarts.set(session.user, [...(runStarts.get(session.user) || []), Date.now()]);
      const job = { id, owner: session.sid, user: session.user, dir, inputPath: path.relative(ROOT, path.join(dir, "input.json")), authValue: body.authValue || "", selection };
      if (isRunning()) {
        queue.push(job);
        console.log(`UI: run ${id} queued for ${session.user} (position ${queue.length})`);
        return json(res, 202, { queued: true, position: queue.length, runId: id });
      }
      startRun(job);
      return json(res, 202, { started: true, runId: id });
    }
    // An unedited saved API runs from its own file so summary.inputFile names the selected API.
    // Edited or custom JSON runs from input/ui-run.json. The run folder keeps a copy of the input and,
    // when the run ends, a snapshot of the results for the run history.
    const saved = listInputs().find((f) => fs.readFileSync(path.join(INPUT_DIR, f), "utf8") === body.json);
    if (!saved) fs.writeFileSync(path.join(ROOT, RUN_FILE), body.json);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "input.json"), body.json);
    cleanupRuns();
    startRun({ id, owner: null, user: null, dir, inputPath: saved ? `input/${saved}` : RUN_FILE, authValue: body.authValue || "", selection });
    return json(res, 202, { started: true, runId: id });
  }

  if (req.method === "GET" && p === "/api/runs") return json(res, 200, listRuns(session));

  if (req.method === "GET" && p === "/api/evidence") {
    const dir = runDirFor(session, url);
    if (!dir) return json(res, 404, { error: "No run found." });
    const file = url.searchParams.get("file");
    const title = url.searchParams.get("test");
    if (file) {
      const base = evidenceBase(dir);
      const target = path.normalize(path.join(base, file));
      if (!target.startsWith(base + path.sep) || !/\.(json|txt|html)$/.test(target)) return json(res, 403, { error: "forbidden" });
      // A run folder also holds input.json and the generated specs: only the reports snapshot is evidence.
      const rel = path.relative(base, target);
      if (dir !== ROOT && rel !== "results.json" && !rel.startsWith("pactum" + path.sep)) return json(res, 403, { error: "forbidden" });
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return json(res, 404, { error: "evidence file not found" });
      return serveFile(res, target);
    }
    if (!title) return json(res, 400, { error: "test or file is required" });
    return json(res, 200, { test: title, exchanges: evidenceForTest(dir, title) });
  }

  if (req.method === "POST" && p === "/api/import") {
    // The JSON envelope escapes the content, so allow some room above 5 MB before parsing it.
    const raw = await readBodyCapped(req, 3 * MAX_IMPORT_BYTES);
    if (raw === null) return json(res, 413, { error: "The content is larger than 5 MB." });
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json(res, 400, { error: "Request body must be JSON" });
    }
    const type = body && body.type;
    if (!IMPORT_TYPES.includes(type)) return json(res, 400, { error: `type must be one of: ${IMPORT_TYPES.join(", ")}` });
    if (typeof body.content !== "string" || !body.content.trim()) return json(res, 400, { error: "content must be a non-empty string" });
    if (Buffer.byteLength(body.content, "utf8") > MAX_IMPORT_BYTES) return json(res, 413, { error: "The content is larger than 5 MB." });
    const result = await runImport(type, body.content);
    // Log Claude's call lines (no content in them) and counts. Never the content itself.
    for (const line of result.stderr.split("\n")) if (line.startsWith("[claude] ")) console.log(`UI: import ${line}`);
    if (result.timedOut) {
      console.log(`UI: import ${type} timed out`);
      return json(res, 504, { error: "The import timed out." });
    }
    if (result.code !== 0) {
      const lines = result.stderr.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("[claude] "));
      const failure = (lines.find((l) => l.startsWith("import FAILED ")) ?? lines.pop() ?? `the importer exited with ${result.code}`).replace(/^import FAILED /, "");
      console.log(`UI: import ${type} failed (exit ${result.code})`);
      return json(res, 422, { error: failure });
    }
    let out;
    try {
      out = JSON.parse(result.stdout);
    } catch {
      return json(res, 500, { error: "The importer did not print JSON." });
    }
    console.log(`UI: import ${type}: ${out.input.endpoints.length} endpoints, ${out.skipped.length} skipped, ${out.warnings.length} warnings`);
    return json(res, 200, out);
  }

  if (req.method === "POST" && p === "/api/inputs/save") {
    // Saved inputs are shared by every login, so a hosted server keeps its kit read-only.
    if (HOSTED) return json(res, 403, { error: "Saving APIs is disabled on the hosted server. Paste the JSON in the Custom API tab instead." });
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { error: "Request body must be JSON" });
    }
    const name = String((body && body.name) || "");
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name) || name === "ui-run") return json(res, 400, { error: "Name must use lowercase letters, numbers and dashes" });
    const file = `${name}.json`;
    if (PROTECTED_INPUTS.has(file)) return json(res, 409, { error: `${file} is a kit file and cannot be overwritten` });
    if (typeof body.json !== "string") return json(res, 400, { error: "json must be a string" });
    const checked = await validateInput(body.json);
    // A profile input is saved without a selection; the page picks one at run time.
    const blocking = checked.problems.filter((x) => x.path !== "profile");
    if (blocking.length) return json(res, 400, { error: `${blocking[0].path === "(root)" ? "" : blocking[0].path + ": "}${blocking[0].message}`, problems: blocking });
    if (/"(Bearer|Basic) [^"]+"/.test(body.json)) return json(res, 400, { error: "Input files must not contain auth values" });
    // Production consent is given per run in the UI, never stored in an input file.
    const cfg = JSON.parse(body.json);
    let text = body.json;
    if ("allowProduction" in cfg || "allowWrites" in cfg) {
      delete cfg.allowProduction;
      delete cfg.allowWrites;
      text = JSON.stringify(cfg, null, 2) + "\n";
    }
    fs.writeFileSync(path.join(INPUT_DIR, file), text);
    return json(res, 200, { saved: true, file });
  }

  if (req.method === "GET" && p === "/api/framework/download") {
    const dir = runDirFor(session, url);
    const zip = artifact(dir, "framework.zip");
    if (!zip || !fs.existsSync(zip)) return json(res, 404, { error: "No framework yet. Run the agent first." });
    let name = "playwright-api-framework";
    try {
      const s = JSON.parse(fs.readFileSync(artifact(dir, "summary.json"), "utf8"));
      if (s.framework && /^[a-z0-9-]+$/.test(s.framework.name || "")) name = `${s.framework.name}-${s.testFramework === "pactum" ? "pactum" : "playwright"}-tests`;
    } catch {}
    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${name}.zip"`,
      "Cache-Control": "no-store",
    });
    return fs.createReadStream(zip).pipe(res);
  }

  if (req.method === "POST" && p === "/api/stop") {
    if (!isRunning()) return json(res, 409, { error: "No run in progress" });
    if (LOGIN_REQUIRED && run.owner !== session.sid) return json(res, 403, { error: "This run belongs to another login" });
    run.proc.kill("SIGTERM");
    pushLine("UI: run stopped by user");
    return json(res, 200, { stopped: true });
  }

  if (req.method === "GET" && p === "/api/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    if (!run) run = { id: null, owner: null, user: null, dir: null, proc: null, lines: [], startedAt: null, exitCode: -1, clients: new Set() };
    const sid = session ? session.sid : null;
    const mine = !LOGIN_REQUIRED || run.owner === sid;
    if (run.startedAt && mine) {
      res.write(`event: start\ndata: ${JSON.stringify({ startedAt: run.startedAt, runId: run.id })}\n\n`);
      for (const l of run.lines) res.write(`event: log\ndata: ${JSON.stringify(l)}\n\n`);
      if (run.exitCode !== null && run.exitCode !== -1) {
        res.write(`event: done\ndata: ${JSON.stringify({ exitCode: run.exitCode, replay: true, runId: run.id })}\n\n`);
      }
    }
    const client = { res, sid };
    run.clients.add(client);
    const ping = setInterval(() => res.write(": ping\n\n"), 15000);
    req.on("close", () => {
      clearInterval(ping);
      run.clients.delete(client);
    });
    return;
  }

  if (req.method === "GET" && p === "/api/summary") {
    const file = artifact(runDirFor(session, url), "summary.json");
    if (!file || !fs.existsSync(file)) return json(res, 404, { error: "No summary yet. Run the agent first." });
    try {
      return json(res, 200, JSON.parse(fs.readFileSync(file, "utf8")));
    } catch (e) {
      return json(res, 500, { error: `summary.json is not valid JSON: ${e.message}` });
    }
  }

  if (req.method === "GET" && p === "/api/spec") {
    const name = url.searchParams.get("name") || "";
    if (!/^[a-z0-9-]+\.spec\.ts$/.test(name)) return json(res, 400, { error: "invalid spec name" });
    const dir = artifact(runDirFor(session, url), "generated");
    const file = dir ? path.join(dir, name) : null;
    if (!file || !fs.existsSync(file)) return json(res, 404, { error: "spec not found" });
    return json(res, 200, { name, content: fs.readFileSync(file, "utf8") });
  }

  if (req.method === "GET" && (p === "/allure" || p.startsWith("/allure/"))) {
    const base = artifact(runDirFor(session, url), "allure-report");
    if (!base) return json(res, 404, { error: "Allure report not found. Run the agent first." });
    let rel = decodeURIComponent(p.slice("/allure".length)) || "/index.html";
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.normalize(path.join(base, rel));
    if (!file.startsWith(base)) return json(res, 403, { error: "forbidden" });
    if (!fs.existsSync(file)) return json(res, 404, { error: "Allure report not found. Run the agent first." });
    return serveFile(res, file);
  }

  if (req.method === "GET" && (p === "/report" || p.startsWith("/report/"))) {
    const base = artifact(runDirFor(session, url), "html");
    if (!base) return json(res, 404, { error: "Report not found. Run the agent first." });
    let rel = decodeURIComponent(p.slice("/report".length)) || "/index.html";
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.normalize(path.join(base, rel));
    if (!file.startsWith(base)) return json(res, 403, { error: "forbidden" });
    if (!fs.existsSync(file)) return json(res, 404, { error: "Report not found. Run the agent first." });
    return serveFile(res, file);
  }

  json(res, 404, { error: "not found" });
});

fs.mkdirSync(RUNS_DIR, { recursive: true });
cleanupRuns();
setInterval(cleanupRuns, 60 * 60 * 1000).unref();

server.listen(PORT, HOST, () => {
  const where = HOST === "127.0.0.1" || HOST === "localhost" ? `http://localhost:${PORT}` : `http://${HOST}:${PORT}`;
  const mode = HOSTED ? `hosted mode: login required, ${USERS.size} user(s), ${RUNS_PER_HOUR} runs/hour, queue ${MAX_QUEUE}, local hosts refused` : LOGIN_REQUIRED ? `login required, ${USERS.size} user(s)` : "local demo, no login";
  const st = settingsState();
  const modelLine = st.configured ? `model: ${st.provider} ${st.model} (${st.via === "cli" ? "Claude Code login" : "API key"})` : `model: not set up yet (${SETTINGS_EDITABLE ? "the page will ask for a key" : "set a key in .env"})`;
  console.log(`API Test Agent UI running on ${where} (${mode}); ${modelLine}`);
});
