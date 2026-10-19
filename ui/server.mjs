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

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { classifyHost, refusalMessage } from "./host-class.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.UI_PORT || 3000);
const INPUT_DIR = path.join(ROOT, "input");
const RUN_FILE = "input/ui-run.json";
const SUMMARY = path.join(ROOT, "out", "summary.json");
const GENERATED = path.join(ROOT, "generated");
const REPORT_DIR = path.join(ROOT, "reports", "html");
const ALLURE_DIR = path.join(ROOT, "reports", "allure-report");
const INDEX = path.join(ROOT, "ui", "index.html");
const HOST_CLASS = path.join(ROOT, "ui", "host-class.mjs");
const FRAMEWORK_ZIP = path.join(ROOT, "out", "framework.zip");
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

let run = null; // { proc, lines, startedAt, exitCode, clients }

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

// Quick shape check so the user gets instant feedback. The agent does the full zod validation.
function checkInput(text) {
  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch (e) {
    return `Invalid JSON: ${e.message}`;
  }
  if (!cfg || typeof cfg !== "object") return "Input must be a JSON object";
  if (typeof cfg.baseUrl !== "string" || !/^https?:\/\//.test(cfg.baseUrl)) return "baseUrl must be a URL starting with http:// or https://";
  if (!Array.isArray(cfg.endpoints) || cfg.endpoints.length === 0) return "endpoints must be a non-empty array";
  if (cfg.auth !== undefined && (typeof cfg.auth !== "object" || typeof cfg.auth.header !== "string" || typeof cfg.auth.valueEnv !== "string")) {
    return "auth must have header and valueEnv";
  }
  for (const flag of ["allowProduction", "allowWrites"]) {
    if (cfg[flag] !== undefined && typeof cfg[flag] !== "boolean") return `${flag} must be true or false`;
  }
  for (const [i, e] of cfg.endpoints.entries()) {
    if (!e || typeof e.id !== "string") return `endpoints[${i}].id is required`;
    if (e.requiresAuth === true && !cfg.auth) return `endpoints[${i}] requires auth but the input has no auth section`;
    if (typeof e.method !== "string") return `endpoints[${i}].method is required`;
    if (typeof e.path !== "string" || !e.path.startsWith("/")) return `endpoints[${i}].path must start with /`;
  }
  return null;
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

function broadcast(event, data) {
  if (!run) return;
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of run.clients) c.write(msg);
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

function startRun(authValue, inputPath) {
  const { cmd, args } = agentCommand();
  // The agent only clears out/ after it has loaded the input, so a run that fails earlier would leave the
  // previous summary behind. Remove it here so a run can never be shown the old run's results.
  fs.rmSync(SUMMARY, { force: true });
  const proc = spawn(cmd, [...args, inputPath], {
    cwd: ROOT,
    // A custom auth value is passed to this run only, through the environment. It is never written to disk.
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", ...(authValue ? { CUSTOM_API_AUTH: authValue } : {}) },
  });
  const prevClients = run ? run.clients : new Set();
  run = { proc, lines: [], startedAt: Date.now(), exitCode: null, clients: prevClients };
  broadcast("start", { startedAt: run.startedAt });

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
    broadcast("done", { exitCode: run.exitCode, durationSec: Math.round((Date.now() - run.startedAt) / 1000) });
  });
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

  if (req.method === "GET" && p === "/api/inputs") return json(res, 200, listInputs());

  if (req.method === "GET" && p === "/api/input") {
    const name = url.searchParams.get("name");
    if (!listInputs().includes(name)) return json(res, 404, { error: "unknown input file" });
    return json(res, 200, { name, content: fs.readFileSync(path.join(INPUT_DIR, name), "utf8") });
  }

  if (req.method === "GET" && p === "/api/state") {
    return json(res, 200, {
      running: !!isRunning(),
      startedAt: run ? run.startedAt : null,
      exitCode: run ? run.exitCode : null,
      hasSummary: fs.existsSync(SUMMARY),
    });
  }

  if (req.method === "POST" && p === "/api/run") {
    if (isRunning()) return json(res, 409, { error: "A run is already in progress" });
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { error: "Request body must be JSON" });
    }
    const problem = checkInput(body && body.json);
    if (problem) return json(res, 400, { error: problem });
    if (body.authValue !== undefined && typeof body.authValue !== "string") return json(res, 400, { error: "authValue must be a string" });
    const cfg = JSON.parse(body.json);
    // The safety guard does not depend on the browser: a production host needs allowProduction.
    // AGENT_FORCE_PRODUCTION=1 (testing only) treats every host as production, as in the agent.
    const hostClass = process.env.AGENT_FORCE_PRODUCTION === "1" ? "production" : classifyHost(cfg.baseUrl);
    if (hostClass === "production" && cfg.allowProduction !== true) {
      console.log("UI: run refused, production host without allowProduction");
      return json(res, 400, { error: refusalMessage(cfg.baseUrl) });
    }
    if (cfg.auth && cfg.auth.valueEnv === "CUSTOM_API_AUTH" && !body.authValue) {
      return json(res, 400, { error: "This API needs an auth header value" });
    }
    // An unedited saved API runs from its own file so summary.inputFile names the selected API.
    // Edited or custom JSON runs from input/ui-run.json.
    const saved = listInputs().find((f) => fs.readFileSync(path.join(INPUT_DIR, f), "utf8") === body.json);
    if (!saved) fs.writeFileSync(path.join(ROOT, RUN_FILE), body.json);
    startRun(body.authValue || "", saved ? `input/${saved}` : RUN_FILE);
    return json(res, 202, { started: true });
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
    const problem = checkInput(body.json);
    if (problem) return json(res, 400, { error: problem });
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
    if (!fs.existsSync(FRAMEWORK_ZIP)) return json(res, 404, { error: "No framework yet. Run the agent first." });
    let name = "playwright-api-framework";
    try {
      const s = JSON.parse(fs.readFileSync(SUMMARY, "utf8"));
      if (s.framework && /^[a-z0-9-]+$/.test(s.framework.name || "")) name = `${s.framework.name}-playwright-tests`;
    } catch {}
    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${name}.zip"`,
      "Cache-Control": "no-store",
    });
    return fs.createReadStream(FRAMEWORK_ZIP).pipe(res);
  }

  if (req.method === "POST" && p === "/api/stop") {
    if (!isRunning()) return json(res, 409, { error: "No run in progress" });
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
    if (!run) run = { proc: null, lines: [], startedAt: null, exitCode: -1, clients: new Set() };
    if (run.startedAt) {
      res.write(`event: start\ndata: ${JSON.stringify({ startedAt: run.startedAt })}\n\n`);
      for (const l of run.lines) res.write(`event: log\ndata: ${JSON.stringify(l)}\n\n`);
      if (run.exitCode !== null && run.exitCode !== -1) {
        res.write(`event: done\ndata: ${JSON.stringify({ exitCode: run.exitCode, replay: true })}\n\n`);
      }
    }
    run.clients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 15000);
    req.on("close", () => {
      clearInterval(ping);
      run.clients.delete(res);
    });
    return;
  }

  if (req.method === "GET" && p === "/api/summary") {
    if (!fs.existsSync(SUMMARY)) return json(res, 404, { error: "No summary yet. Run the agent first." });
    try {
      return json(res, 200, JSON.parse(fs.readFileSync(SUMMARY, "utf8")));
    } catch (e) {
      return json(res, 500, { error: `summary.json is not valid JSON: ${e.message}` });
    }
  }

  if (req.method === "GET" && p === "/api/spec") {
    const name = url.searchParams.get("name") || "";
    if (!/^[a-z0-9-]+\.spec\.ts$/.test(name)) return json(res, 400, { error: "invalid spec name" });
    const file = path.join(GENERATED, name);
    if (!fs.existsSync(file)) return json(res, 404, { error: "spec not found" });
    return json(res, 200, { name, content: fs.readFileSync(file, "utf8") });
  }

  if (req.method === "GET" && (p === "/allure" || p.startsWith("/allure/"))) {
    let rel = decodeURIComponent(p.slice("/allure".length)) || "/index.html";
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.normalize(path.join(ALLURE_DIR, rel));
    if (!file.startsWith(ALLURE_DIR)) return json(res, 403, { error: "forbidden" });
    if (!fs.existsSync(file)) return json(res, 404, { error: "Allure report not found. Run the agent first." });
    return serveFile(res, file);
  }

  if (req.method === "GET" && (p === "/report" || p.startsWith("/report/"))) {
    let rel = decodeURIComponent(p.slice("/report".length)) || "/index.html";
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.normalize(path.join(REPORT_DIR, rel));
    if (!file.startsWith(REPORT_DIR)) return json(res, 403, { error: "forbidden" });
    if (!fs.existsSync(file)) return json(res, 404, { error: "Report not found. Run the agent first." });
    return serveFile(res, file);
  }

  json(res, 404, { error: "not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`API Test Agent UI running on http://localhost:${PORT}`);
});
