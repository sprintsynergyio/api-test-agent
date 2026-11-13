// npm run test:settings: the model settings routes of ui/server.mjs against a fake provider server.
// Offline, no real key. Run from the project root.

import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UI_PORT = Number(process.env.SETTINGS_TEST_UI_PORT || 3800);
const GOOD_KEY = "sk-test-good-key-0123456789";
const BAD_KEY = "sk-test-bad-key-0123456789";

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok    ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}\n      ${String(err && err.message ? err.message : err).split("\n").join("\n      ")}`);
  }
}

// Fake provider: answers both the Anthropic and the OpenAI shapes. 401 for any key but GOOD_KEY,
// 404 for a model containing "missing".
function startFakeProvider() {
  return new Promise((resolve) => {
    const seen = [];
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw || "{}");
        const key = req.headers["x-api-key"] || String(req.headers.authorization || "").replace(/^Bearer /, "");
        seen.push({ url: req.url, key, body });
        const reply = (status, obj) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(obj));
        };
        if (key !== GOOD_KEY) return reply(401, { error: { type: "authentication_error", message: `invalid key ${key}` } });
        if (String(body.model).includes("missing")) return reply(404, { error: { type: "not_found_error", message: `model ${body.model} not found` } });
        if (req.url === "/v1/messages") return reply(200, { content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 1 } });
        return reply(200, { choices: [{ message: { content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1 } });
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, seen }));
  });
}

function startUi(extraEnv) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, UI_PORT: String(UI_PORT), SKIP_CLI_DETECT: "1", ...extraEnv };
    delete env.ANTHROPIC_API_KEY;
    delete env.OPENAI_API_KEY;
    delete env.LLM_PROVIDER;
    delete env.LLM_MODEL;
    delete env.CLAUDE_MODEL;
    delete env.HOSTED;
    delete env.UI_USERS;
    Object.assign(env, extraEnv);
    const child = spawn(process.execPath, [path.join(ROOT, "ui", "server.mjs")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => reject(new Error(`UI did not start: ${out}`)), 15000);
    child.stdout.on("data", (d) => {
      out += d;
      if (out.includes("running on")) {
        clearTimeout(timer);
        resolve({ child, firstLine: out.trim().split("\n").pop() });
      }
    });
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`UI exited with ${code}: ${out}`));
    });
  });
}

function stop(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
}

async function api(method, route, body) {
  const res = await fetch(`http://127.0.0.1:${UI_PORT}${route}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

async function main() {
  const fake = await startFakeProvider();
  const base = `http://127.0.0.1:${fake.port}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ats-settings-"));
  const envFile = path.join(tmp, ".env");
  fs.writeFileSync(envFile, "LOCAL_API_AUTH_VALUE=Bearer keep-me\n# a comment stays\nMAX_CLAUDE_CALLS=30\nLLM_PROVIDER=\n");

  let ui = await startUi({ ENV_FILE: envFile, ANTHROPIC_BASE_URL: base, OPENAI_BASE_URL: base });
  try {
    await check("startup line says the model is not set up yet", () => {
      assert.match(ui.firstLine, /model: not set up yet \(the page will ask for a key\)/);
    });

    await check("GET /api/settings: not configured, editable, no key, providers listed", async () => {
      const { status, body } = await api("GET", "/api/settings");
      assert.equal(status, 200);
      assert.equal(body.configured, false);
      assert.equal(body.editable, true);
      assert.equal(body.hasKey, false);
      assert.equal(body.provider, "anthropic");
      assert.deepEqual(body.providers.map((p) => p.id), ["anthropic", "openai"]);
      assert.ok(!JSON.stringify(body).includes("sk-"), "no key in the response");
    });

    await check("verify with a bad key: ok false, 401 explained, key not echoed", async () => {
      const { status, body } = await api("POST", "/api/settings/verify", { provider: "anthropic", key: BAD_KEY });
      assert.equal(status, 200);
      assert.equal(body.ok, false);
      assert.match(body.error, /rejected \(HTTP 401\)/);
      assert.ok(!body.error.includes(BAD_KEY), body.error);
    });

    await check("verify with the good key for both providers: ok true, default model used", async () => {
      const a = await api("POST", "/api/settings/verify", { provider: "anthropic", key: GOOD_KEY });
      assert.equal(a.body.ok, true);
      assert.equal(a.body.model, "claude-sonnet-5-5");
      const o = await api("POST", "/api/settings/verify", { provider: "openai", key: GOOD_KEY });
      assert.equal(o.body.ok, true);
      assert.equal(o.body.model, "gpt-6.1-sol");
      const last = fake.seen[fake.seen.length - 1];
      assert.equal(last.url, "/v1/chat/completions");
      assert.equal(last.body.max_completion_tokens, 5);
    });

    await check("verify with an unknown model: 404 explained", async () => {
      const { body } = await api("POST", "/api/settings/verify", { provider: "openai", key: GOOD_KEY, model: "gpt-missing" });
      assert.equal(body.ok, false);
      assert.match(body.error, /not found \(HTTP 404\)/);
    });

    await check("verify rejects a key that does not look like one, without calling the provider", async () => {
      const before = fake.seen.length;
      const { status, body } = await api("POST", "/api/settings/verify", { provider: "openai", key: "short" });
      assert.equal(status, 400);
      assert.match(body.error, /does not look like an API key/);
      assert.equal(fake.seen.length, before);
    });

    await check("save with a bad key: 400 and nothing written", async () => {
      const { status, body } = await api("POST", "/api/settings", { provider: "openai", key: BAD_KEY });
      assert.equal(status, 400);
      assert.match(body.error, /HTTP 401/);
      assert.ok(!fs.readFileSync(envFile, "utf8").includes(BAD_KEY));
    });

    await check("save with the good key writes .env, keeps other lines, replaces the empty LLM_PROVIDER line", async () => {
      const { status, body } = await api("POST", "/api/settings", { provider: "openai", key: GOOD_KEY, model: "gpt-custom" });
      assert.equal(status, 200);
      assert.equal(body.configured, true);
      assert.equal(body.hasKey, true);
      assert.equal(body.provider, "openai");
      assert.equal(body.model, "gpt-custom");
      assert.equal(body.via, "api");
      assert.ok(!JSON.stringify(body).includes(GOOD_KEY), "the key is never returned");
      const text = fs.readFileSync(envFile, "utf8");
      const lines = text.split("\n");
      assert.ok(lines.includes("LOCAL_API_AUTH_VALUE=Bearer keep-me"), "other lines kept");
      assert.ok(lines.includes("# a comment stays"), "comments kept");
      assert.ok(lines.includes("MAX_CLAUDE_CALLS=30"));
      assert.equal(lines.filter((l) => l.startsWith("LLM_PROVIDER=")).length, 1, "one LLM_PROVIDER line");
      assert.ok(lines.includes("LLM_PROVIDER=openai"));
      assert.ok(lines.includes("LLM_MODEL=gpt-custom"));
      assert.ok(lines.includes(`OPENAI_API_KEY=${GOOD_KEY}`));
      if (process.platform !== "win32") assert.equal(fs.statSync(envFile).mode & 0o777, 0o600, ".env is mode 600");
    });

    await check("GET /api/settings after save reflects the new choice", async () => {
      const { body } = await api("GET", "/api/settings");
      assert.equal(body.configured, true);
      assert.equal(body.provider, "openai");
      assert.equal(body.hasKey, true);
    });
  } finally {
    await stop(ui.child);
  }

  // A second start reads the saved .env (ENV_FILE) and reports the choice on its startup line.
  ui = await startUi({ ENV_FILE: envFile });
  try {
    await check("a restart reads the saved .env: startup line names the provider and model", () => {
      assert.match(ui.firstLine, /model: openai gpt-custom \(API key\)/);
    });
  } finally {
    await stop(ui.child);
  }

  // With UI_USERS set (a shared machine) the settings routes are read-only even after login.
  const { default: bcrypt } = await import("bcryptjs");
  const hash = bcrypt.hashSync("demo-pass", 4);
  ui = await startUi({ ENV_FILE: envFile, UI_USERS: `demo:${hash}` });
  try {
    await check("with UI_USERS set: 401 without login, then editable false and POST 403 after login", async () => {
      const g = await api("GET", "/api/settings");
      assert.equal(g.status, 401, "settings need a login like every other api route");
      const login = await fetch(`http://127.0.0.1:${UI_PORT}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user: "demo", password: "demo-pass" }) });
      assert.equal(login.status, 200);
      const cookie = String(login.headers.get("set-cookie")).split(";")[0];
      const withCookie = (method, route, body) =>
        fetch(`http://127.0.0.1:${UI_PORT}${route}`, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() }));
      const st = await withCookie("GET", "/api/settings");
      assert.equal(st.status, 200);
      assert.equal(st.body.editable, false);
      const v = await withCookie("POST", "/api/settings/verify", { provider: "openai", key: GOOD_KEY });
      assert.equal(v.status, 403);
      const sv = await withCookie("POST", "/api/settings", { provider: "openai", key: GOOD_KEY });
      assert.equal(sv.status, 403);
      assert.ok(!fs.readFileSync(envFile, "utf8").includes("LLM_PROVIDER=anthropic"), "nothing was written");
    });
  } finally {
    await stop(ui.child);
  }

  fake.server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
