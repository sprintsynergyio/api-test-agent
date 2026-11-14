// npm run test:ui: the UI server's input validation, run history and evidence routes, plus the ids the
// page must keep. Offline: no agent run, no model call. Run from the project root.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UI_PORT = Number(process.env.UI_TEST_PORT || 3850);
const RUNS_DIR = path.join(ROOT, "runs");

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

function startUi(extraEnv) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, UI_PORT: String(UI_PORT), SKIP_CLI_DETECT: "1", ENV_FILE: path.join(ROOT, "ui", "ui.test.env.none") };
    delete env.HOSTED;
    delete env.UI_USERS;
    delete env.AGENT_FORCE_PRODUCTION;
    Object.assign(env, extraEnv);
    const child = spawn(process.execPath, [path.join(ROOT, "ui", "server.mjs")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => reject(new Error(`UI did not start: ${out}`)), 15000);
    child.stdout.on("data", (d) => {
      out += d;
      if (out.includes("running on")) {
        clearTimeout(timer);
        resolve(child);
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

async function api(method, route, body, cookie) {
  const headers = {};
  if (body) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`http://127.0.0.1:${UI_PORT}${route}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed, setCookie: res.headers.get("set-cookie") };
}

const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const localShop = () => JSON.parse(read("input/local-shop.json"));

// A finished run folder with the snapshot shape the server writes: summary.json, done.json, results.json.
function fakeRun(summary, extra = {}) {
  const id = crypto.randomBytes(12).toString("hex");
  const dir = path.join(RUNS_DIR, id);
  fs.mkdirSync(path.join(dir, "pactum"), { recursive: true });
  fs.writeFileSync(path.join(dir, "input.json"), JSON.stringify({ secret: "must-not-be-served" }));
  fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify(summary));
  fs.writeFileSync(path.join(dir, "done.json"), JSON.stringify({ exitCode: 0, finishedAt: Date.now() - (extra.ageMs || 0) }));
  const attachment = { request: { method: "DELETE", path: "/products/7", headers: { Authorization: "<redacted>" } }, response: { status: 204, body: "" } };
  fs.writeFileSync(
    path.join(dir, "results.json"),
    JSON.stringify({
      suites: [{ specs: [{ title: "[auth] delete-product without auth is rejected", tests: [{ results: [{ attachments: [
        { name: "Allure Metadata", contentType: "application/json", body: Buffer.from("{}").toString("base64") },
        { name: "DELETE /products/7 -> 204", contentType: "application/json", body: Buffer.from(JSON.stringify(attachment)).toString("base64") },
      ] }] }] }] }],
    }),
  );
  fs.writeFileSync(path.join(dir, "pactum", "status.json"), "[]");
  return { id, dir };
}

const SUMMARY = {
  status: "completed",
  inputFile: "input/local-shop.json",
  baseUrl: "http://localhost:4900",
  testFramework: "playwright",
  framework: { name: "local-shop", dir: "frameworks/local-shop", files: ["package.json"] },
  totals: { endpoints: 5, testsGenerated: 12, passed: 10, failed: 2 },
  findings: [
    { endpointId: "delete-product", testTitle: "[auth] delete-product without auth is rejected", type: "auth", expectedStatus: "401|403", actualStatus: 204, classification: "suspected API finding" },
    { endpointId: "get-product", testTitle: "[schema] fields", type: "schema", expectedStatus: 200, actualStatus: 200, classification: "needs review" },
  ],
  endpoints: [],
  durationSec: 42,
};

async function main() {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  const made = [];
  let ui = await startUi({});
  try {
    // ---- static page ----
    await check("index.html keeps the ids the routes and the new areas need", () => {
      const html = read("ui/index.html");
      for (const id of [
        "fwToggle", "cAuth", "profileBox", "profileDims", "findings", "redactMode", "redactFields",
        "cAuthLogin", "cAuthQuery", "cAuthCookie", "cRoles", "cAddRole", "runsBody", "strip",
        "inputSel", "savedBase", "savedToken", "jsonBox", "epList", "runBtn", "stopBtn", "term", "epTable", "code", "copyBtn",
        "setupWrap", "setupProvider", "setupKey", "setupModel", "setupVerifyBtn", "setupSaveBtn", "modelStatus", "loginWrap", "mainGrid",
        "cName", "cBase", "cAuthValue", "cEps", "cAdd", "cSave", "cSource", "impText", "impBtn", "impUse",
      ]) assert.ok(html.includes(`id="${id}"`), `missing id ${id}`);
      assert.ok(html.includes('data-act="jira"'), "missing the Jira copy button");
      assert.ok(html.includes('data-act="md"'), "missing the Markdown copy button");
      assert.ok(html.includes("Copy as Jira ticket"), "missing the Jira copy label");
    });
    await check("index.html is self-contained: no external scripts, styles or fonts", () => {
      const html = read("ui/index.html");
      assert.ok(!/<script[^>]+src=/.test(html), "external script");
      assert.ok(!/<link[^>]+href="https?:/.test(html), "external stylesheet");
      assert.ok(!/@import|fonts\.googleapis|cdn\./.test(html), "external font or CDN");
      assert.ok(!/—|–/.test(html), "em or en dash in the page");
    });
    await check("GET / serves the page", async () => {
      const res = await fetch(`http://127.0.0.1:${UI_PORT}/`);
      assert.equal(res.status, 200);
      assert.ok((await res.text()).includes('id="fwToggle"'));
    });

    // ---- validate-input ----
    await check("validate-input accepts input/local-shop.json (header auth) and resolves the host", async () => {
      const { status, body } = await api("POST", "/api/validate-input", { json: read("input/local-shop.json") });
      assert.equal(status, 200);
      assert.equal(body.ok, true, JSON.stringify(body.problems));
      assert.equal(body.auth.type, "header");
      assert.equal(body.auth.oneRunValue, false);
      assert.equal(body.hostClass, "local");
      assert.equal(body.mode, "full");
      assert.equal(body.framework, "playwright");
    });
    await check("validate-input accepts the login type with a role and lists the env names", async () => {
      const { body } = await api("POST", "/api/validate-input", { json: read("input/local-shop-login.json") });
      assert.equal(body.ok, true, JSON.stringify(body.problems));
      assert.equal(body.auth.type, "login");
      assert.deepEqual(body.auth.roles, ["viewer"]);
      assert.ok(body.auth.envNames.includes("LOCAL_API_VIEWER_PASSWORD"));
      assert.ok(!JSON.stringify(body).includes("admin-pass"), "no credential value in the answer");
      assert.ok(Array.isArray(body.auth.envMissing), "envMissing lists names the server's .env lacks");
      for (const n of body.auth.envMissing) assert.ok(body.auth.envNames.includes(n));
    });
    await check("validate-input accepts the query and cookie types and flags the one-run value", async () => {
      const q = localShop();
      q.auth = { type: "query", param: "api_key", valueEnv: "CUSTOM_API_AUTH" };
      const a = await api("POST", "/api/validate-input", { json: JSON.stringify(q) });
      assert.equal(a.body.ok, true, JSON.stringify(a.body.problems));
      assert.equal(a.body.auth.type, "query");
      assert.equal(a.body.auth.oneRunValue, true);
      const c = localShop();
      c.auth = { type: "cookie", name: "session", valueEnv: "SESSION_COOKIE", roles: { viewer: { valueEnv: "VIEWER_COOKIE" } } };
      const b = await api("POST", "/api/validate-input", { json: JSON.stringify(c) });
      assert.equal(b.body.ok, true, JSON.stringify(b.body.problems));
      assert.equal(b.body.auth.type, "cookie");
      assert.deepEqual(b.body.auth.roles, ["viewer"]);
      assert.deepEqual(b.body.auth.envNames, ["SESSION_COOKIE", "VIEWER_COOKIE"]);
    });
    await check("validate-input with a profile: dimensions without a selection, resolved URL with one", async () => {
      const json = read("input/example-profile.json");
      const none = await api("POST", "/api/validate-input", { json });
      assert.equal(none.body.ok, false);
      assert.ok(none.body.dimensions && none.body.dimensions.env, "dimensions listed");
      assert.ok(none.body.problems.some((p) => p.path === "profile"), JSON.stringify(none.body.problems));
      const some = await api("POST", "/api/validate-input", { json, selection: "env=staging,brand=alpha,region=eu" });
      assert.equal(some.body.ok, true, JSON.stringify(some.body.problems));
      assert.equal(some.body.baseUrl, "https://alpha-eu.staging.example-shop.test");
      assert.equal(some.body.hostClass, "non-production");
      assert.deepEqual(some.body.selection, { env: "staging", brand: "alpha", region: "eu" });
    });
    await check("validate-input rejects a bad input with a field path and a message", async () => {
      const bad = localShop();
      bad.endpoints[0].path = "products";
      bad.endpoints[1].method = "FETCH";
      const { status, body } = await api("POST", "/api/validate-input", { json: JSON.stringify(bad) });
      assert.equal(status, 200);
      assert.equal(body.ok, false);
      const paths = body.problems.map((p) => p.path);
      assert.ok(paths.includes("endpoints[0].path"), JSON.stringify(body.problems));
      assert.ok(paths.includes("endpoints[1].method"), JSON.stringify(body.problems));
      for (const p of body.problems) assert.ok(typeof p.message === "string" && p.message.length > 0);
    });
    await check("validate-input rejects text that is not JSON and an unknown auth type", async () => {
      const a = await api("POST", "/api/validate-input", { json: "{ not json" });
      assert.equal(a.body.ok, false);
      assert.equal(a.body.problems[0].path, "(root)");
      const b = localShop();
      b.auth = { type: "oauth-dance", valueEnv: "X" };
      const r = await api("POST", "/api/validate-input", { json: JSON.stringify(b) });
      assert.equal(r.body.ok, false);
      assert.ok(r.body.problems.some((p) => p.path.startsWith("auth")), JSON.stringify(r.body.problems));
    });
    await check("POST /api/run refuses a bad input with the problems, and a production host", async () => {
      const bad = localShop();
      bad.endpoints[0].path = "products";
      const a = await api("POST", "/api/run", { json: JSON.stringify(bad) });
      assert.equal(a.status, 400);
      assert.ok(Array.isArray(a.body.problems) && a.body.problems[0].path === "endpoints[0].path", JSON.stringify(a.body));
      const prod = localShop();
      prod.baseUrl = "https://api.example.com";
      const b = await api("POST", "/api/run", { json: JSON.stringify(prod) });
      assert.equal(b.status, 400);
      assert.match(b.body.error, /REFUSED: api\.example\.com looks like a production host/);
      const q = localShop();
      q.auth = { type: "query", param: "api_key", valueEnv: "CUSTOM_API_AUTH" };
      const c = await api("POST", "/api/run", { json: JSON.stringify(q) });
      assert.equal(c.status, 400);
      assert.match(c.body.error, /needs an auth value for this run/);
    });

    // ---- run history and evidence, local mode ----
    const r1 = fakeRun(SUMMARY, { ageMs: 60000 });
    const r2 = fakeRun({ ...SUMMARY, testFramework: "pactum", findings: [] });
    made.push(r1.dir, r2.dir);
    await check("GET /api/runs lists finished runs newest first with the row shape", async () => {
      const { status, body } = await api("GET", "/api/runs");
      assert.equal(status, 200);
      assert.ok(Array.isArray(body) && body.length >= 2);
      assert.ok(body.length <= 20);
      const ids = body.map((r) => r.id);
      assert.ok(ids.indexOf(r2.id) < ids.indexOf(r1.id), "newest first");
      const row = body.find((r) => r.id === r1.id);
      for (const k of ["id", "finishedAt", "exitCode", "status", "inputFile", "name", "baseUrl", "testFramework", "findings", "tests", "failed", "durationSec"]) assert.ok(k in row, `row has ${k}`);
      assert.equal(row.findings, 1);
      assert.equal(row.testFramework, "playwright");
      assert.equal(row.name, "local-shop");
      assert.equal(body.find((r) => r.id === r2.id).testFramework, "pactum");
    });
    await check("GET /api/summary?run= serves a past run", async () => {
      const { status, body } = await api("GET", `/api/summary?run=${r1.id}`);
      assert.equal(status, 200);
      assert.equal(body.durationSec, 42);
    });
    await check("GET /api/evidence?test= decodes the report's attachments and skips Allure metadata", async () => {
      const { status, body } = await api("GET", `/api/evidence?run=${r1.id}&test=${encodeURIComponent("[auth] delete-product without auth is rejected")}`);
      assert.equal(status, 200);
      assert.equal(body.exchanges.length, 1);
      assert.equal(body.exchanges[0].request.method, "DELETE");
      assert.equal(body.exchanges[0].response.status, 204);
      const none = await api("GET", `/api/evidence?run=${r1.id}&test=${encodeURIComponent("[happy] nothing")}`);
      assert.deepEqual(none.body.exchanges, []);
    });
    await check("GET /api/evidence?file= serves the results snapshot only", async () => {
      const ok = await api("GET", `/api/evidence?run=${r1.id}&file=results.json`);
      assert.equal(ok.status, 200);
      assert.ok(ok.body.suites, "results.json served");
      for (const f of ["../../.env", "../" + r2.id + "/results.json", "..%2F..%2Fpackage.json", "input.json", "summary.json", "done.json", "/etc/passwd", "pactum/../input.json"]) {
        const r = await api("GET", `/api/evidence?run=${r1.id}&file=${f}`);
        assert.ok(r.status === 403 || r.status === 404, `${f}: ${r.status}`);
        assert.ok(!JSON.stringify(r.body).includes("must-not-be-served"), `${f} leaked input.json`);
      }
      const missing = await api("GET", `/api/evidence?run=${r1.id}&file=pactum/evidence/none.json`);
      assert.equal(missing.status, 404);
      const noArgs = await api("GET", `/api/evidence?run=${r1.id}`);
      assert.equal(noArgs.status, 400);
    });
    await check("GET /api/evidence without ?run reads reports/ of the live run and refuses paths outside it", async () => {
      const r = await api("GET", "/api/evidence?file=../package.json");
      assert.equal(r.status, 403);
      const r2 = await api("GET", "/api/evidence?file=../ui/server.mjs");
      assert.equal(r2.status, 403);
    });
    await check("GET /api/evidence?run= with an unknown id falls back to the live run, never another folder", async () => {
      const r = await api("GET", "/api/evidence?run=000000000000000000000000&file=results.json");
      assert.ok(r.status === 403 || r.status === 404, String(r.status));
    });
  } finally {
    await stop(ui);
  }

  // ---- login mode: runs belong to their owner ----
  const hash = bcrypt.hashSync("pw-alpha", 4);
  ui = await startUi({ UI_USERS: `alpha:${hash},beta:${hash}` });
  try {
    const login = async (user) => {
      const r = await api("POST", "/api/login", { user, password: "pw-alpha" });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.setCookie.split(";")[0];
    };
    await check("login mode: the new routes are 401 without a session", async () => {
      for (const [m, route, body] of [["GET", "/api/runs"], ["GET", `/api/evidence?run=${made[0].split(path.sep).pop()}&file=results.json`], ["POST", "/api/validate-input", { json: "{}" }]]) {
        const r = await api(m, route, body);
        assert.equal(r.status, 401, `${m} ${route}: ${r.status}`);
      }
    });
    await check("login mode: a user sees no runs they did not start, and cannot read another run's evidence", async () => {
      const cookie = await login("alpha");
      const runs = await api("GET", "/api/runs", undefined, cookie);
      assert.equal(runs.status, 200);
      assert.deepEqual(runs.body, []);
      const id = made[0].split(path.sep).pop();
      const ev = await api("GET", `/api/evidence?run=${id}&file=results.json`, undefined, cookie);
      assert.equal(ev.status, 404);
      const ev2 = await api("GET", `/api/evidence?run=${id}&test=x`, undefined, cookie);
      assert.equal(ev2.status, 404);
      const sum = await api("GET", `/api/summary?run=${id}`, undefined, cookie);
      assert.notEqual(sum.status, 200);
    });
    await check("login mode: validate-input works with a session", async () => {
      const cookie = await login("beta");
      const r = await api("POST", "/api/validate-input", { json: read("input/local-shop-login.json") }, cookie);
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, true);
    });
  } finally {
    await stop(ui);
    for (const d of made) fs.rmSync(d, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
