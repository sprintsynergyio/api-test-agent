// npm run test:ui-smoke: starts the UI the way a user does (npm run ui), then calls the routes that load
// the agent's TypeScript modules on first use (input validation loads config.ts and model.ts, the key check
// loads claude.ts) and checks the server is still up afterwards. Offline: the key check goes to a closed
// local port. CI runs it from a folder with spaces in its path and on a second drive letter on Windows.
// Usage: npm run test:ui-smoke   (needs npm to start it, like test:e2e)
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.UI_SMOKE_PORT || 3870);
const BASE = `http://127.0.0.1:${PORT}`;
const NPM = process.env.npm_execpath;
if (!NPM) {
  console.error("Run this through npm (npm run test:ui-smoke), so it starts the UI with npm run ui.");
  process.exit(2);
}
console.log(`UI smoke from ${ROOT}`);

const env = { ...process.env, UI_PORT: String(PORT), SKIP_CLI_DETECT: "1", ENV_FILE: path.join(ROOT, "ui", "ui.test.env.none"), OPENAI_BASE_URL: "http://127.0.0.1:9" };
for (const k of ["HOSTED", "UI_USERS", "AGENT_FORCE_PRODUCTION", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "LLM_PROVIDER", "LLM_MODEL"]) delete env[k];
const ui = spawn(process.execPath, [NPM, "run", "ui"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
let out = "";
ui.stdout.on("data", (d) => (out += d));
ui.stderr.on("data", (d) => (out += d));

function stop() {
  if (ui.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(ui.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  // npm starts the server as its own child: end the whole process group, or the server keeps the pipes open.
  else {
    try {
      process.kill(-ui.pid, "SIGTERM");
    } catch {
      ui.kill("SIGTERM");
    }
  }
}
function fail(message) {
  console.error(`FAIL  ${message}\n--- npm run ui output ---\n${out}\n---`);
  stop();
  process.exit(1);
}
function alive() {
  if (ui.exitCode !== null) fail(`npm run ui exited with code ${ui.exitCode}`);
}
async function post(route, body) {
  alive();
  let res;
  try {
    res = await fetch(BASE + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch (err) {
    fail(`POST ${route}: ${err.message}`);
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    fail(`POST ${route}: ${res.status}, not JSON: ${text.slice(0, 300)}`);
  }
  return { status: res.status, body: json };
}

// 1. npm run ui starts and listens.
for (let i = 0; ; i++) {
  alive();
  if (/running on/.test(out)) break;
  if (i >= 60) fail("npm run ui did not print its start line within 30s");
  await new Promise((r) => setTimeout(r, 500));
}
console.log("ok    npm run ui started");

// 2. Input validation: the first call loads agent/config.ts and agent/model.ts through tsx.
const input = fs.readFileSync(path.join(ROOT, "input", "local-shop.json"), "utf8");
const v = await post("/api/validate-input", { json: input });
if (v.status !== 200 || v.body.ok !== true) fail(`validate-input: ${v.status} ${JSON.stringify(v.body).slice(0, 500)}`);
console.log(`ok    validate-input loads config.ts and model.ts (${v.body.endpoints} endpoints, ${v.body.baseUrl})`);

// 3. Key check: loads agent/claude.ts; the call itself fails fast on the closed port and must come back as a
//    clean "not ok", not a crash.
const k = await post("/api/settings/verify", { provider: "openai", key: "sk-smoke-not-a-real-key", model: "smoke-model" });
if (k.status !== 200 || k.body.ok !== false || typeof k.body.error !== "string") fail(`settings/verify: ${k.status} ${JSON.stringify(k.body).slice(0, 500)}`);
console.log("ok    settings/verify loads claude.ts and reports the unreachable provider");

// 4. Still up, and nothing on the console about module loading.
await new Promise((r) => setTimeout(r, 1000));
alive();
const s = await fetch(`${BASE}/api/settings`).catch((err) => fail(`GET /api/settings: ${err.message}`));
if (s.status !== 200) fail(`GET /api/settings: ${s.status}`);
if (/ERR_UNSUPPORTED_ESM_URL_SCHEME|ERR_MODULE_NOT_FOUND|ERR_INVALID_URL/.test(out)) fail("module loading error in the UI output");
console.log("ok    UI still running, no module loading errors");
stop();
console.log("\nUI smoke passed");
process.exit(0);
