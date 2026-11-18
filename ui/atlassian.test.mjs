// npm run test:ui-atlassian: the UI server's Jira and Confluence routes against a fake Atlassian site
// (scripts/mock-atlassian.mjs): the setup card's save (checked first, written to .env, the token never
// sent back), the link preview for Jira (with Xray steps), Confluence and Zephyr Scale, the host guard,
// and the run checks. Offline, no real Atlassian account. Run from the project root.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startMockAtlassian, MOCK_EMAIL, MOCK_TOKEN, MOCK_XRAY, MOCK_ZEPHYR_TOKEN, CONFLUENCE_PAGE_ID } from "../scripts/mock-atlassian.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UI_PORT = Number(process.env.ATL_TEST_UI_PORT || 3870);

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
    const env = { ...process.env, UI_PORT: String(UI_PORT), SKIP_CLI_DETECT: "1" };
    for (const k of ["HOSTED", "UI_USERS", "AGENT_FORCE_PRODUCTION"]) delete env[k];
    for (const k of Object.keys(env)) if (/^(ATLASSIAN|CONFLUENCE|XRAY|ZEPHYR)_/.test(k)) delete env[k];
    Object.assign(env, extraEnv);
    const child = spawn(process.execPath, [path.join(ROOT, "ui", "server.mjs")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => reject(new Error(`UI did not start: ${out}`)), 15000);
    child.stdout.on("data", (d) => {
      out += d;
      if (out.includes("running on")) {
        clearTimeout(timer);
        resolve({ child, log: () => out });
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
  return { status: res.status, text, body: JSON.parse(text) };
}

const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

async function main() {
  const mock = await startMockAtlassian();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ata-atlassian-"));
  const envFile = path.join(tmp, ".env");
  fs.writeFileSync(envFile, "LOCAL_API_AUTH_VALUE=Bearer keep-me\n# Jira\nATLASSIAN_BASE_URL=\n");
  // The vendor hosts are pointed at the mock (loopback is the only non-vendor host allowed for them).
  // The mock is on 127.0.0.1, so say it is Cloud (a real *.atlassian.net site is detected).
  let ui = await startUi({ ENV_FILE: envFile, ATLASSIAN_DEPLOYMENT: "cloud", XRAY_BASE_URL: `${mock.url}/xray`, ZEPHYR_BASE_URL: `${mock.url}/zephyr/v2` });
  try {
    await check("GET /api/atlassian: not connected yet, editable on a personal machine", async () => {
      const r = await api("GET", "/api/atlassian");
      assert.equal(r.status, 200);
      assert.equal(r.body.configured, false);
      assert.equal(r.body.editable, true);
      assert.equal(r.body.hasToken, false);
    });

    await check("a link before setup says how to connect; a run with a link is refused the same way", async () => {
      const p = await api("POST", "/api/test-cases/preview", { link: `${mock.url}/browse/SHOP-101` });
      assert.equal(p.status, 400);
      assert.match(p.body.error, /not set up: add ATLASSIAN_BASE_URL, ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN/);
      const r = await api("POST", "/api/run", { json: read("input/local-shop.json"), testCases: { link: `${mock.url}/browse/SHOP-101`, mode: "sheet-only" } });
      assert.equal(r.status, 400);
      assert.match(r.body.error, /^test case link: Jira and Confluence are not set up/);
    });

    await check("POST /api/atlassian: a wrong token is checked first, explained, never echoed or saved", async () => {
      const wrong = "wrong-token-ABCDEFG-0123456789";
      const r = await api("POST", "/api/atlassian", { baseUrl: mock.url, email: MOCK_EMAIL, token: wrong });
      assert.equal(r.status, 400);
      assert.match(r.body.error, /401 \(not signed in\): check ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN/);
      assert.ok(!r.text.includes(wrong), "the token came back");
      assert.ok(!fs.readFileSync(envFile, "utf8").includes(wrong), "a failed check wrote .env");
    });

    await check("POST /api/atlassian: checks the account, writes .env (keeping other lines), never returns a token", async () => {
      const r = await api("POST", "/api/atlassian", { baseUrl: `${mock.url}/`, email: MOCK_EMAIL, token: MOCK_TOKEN, xrayClientId: MOCK_XRAY.id, xrayClientSecret: MOCK_XRAY.secret, zephyrToken: MOCK_ZEPHYR_TOKEN });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.user, "QA Lead");
      assert.equal(r.body.configured, true);
      assert.equal(r.body.xray, true);
      assert.equal(r.body.zephyr, true);
      for (const secret of [MOCK_TOKEN, MOCK_XRAY.secret, MOCK_ZEPHYR_TOKEN]) assert.ok(!r.text.includes(secret), "a secret came back");
      const env = fs.readFileSync(envFile, "utf8");
      assert.match(env, new RegExp(`^ATLASSIAN_BASE_URL=${mock.url.replace(/[.]/g, "\\.")}$`, "m"));
      assert.match(env, new RegExp(`^ATLASSIAN_API_TOKEN=${MOCK_TOKEN}$`, "m"));
      assert.match(env, /^XRAY_CLIENT_SECRET=mock-xray-secret/m);
      assert.match(env, /^LOCAL_API_AUTH_VALUE=Bearer keep-me$/m);
      if (process.platform !== "win32") assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
      const g = await api("GET", "/api/atlassian");
      assert.equal(g.body.hasToken, true);
      assert.ok(!g.text.includes(MOCK_TOKEN));
    });

    await check("POST /api/atlassian: an empty token field keeps the saved token", async () => {
      const r = await api("POST", "/api/atlassian", { baseUrl: mock.url, email: MOCK_EMAIL, token: "" });
      assert.equal(r.status, 200, r.text);
      assert.match(fs.readFileSync(envFile, "utf8"), new RegExp(`^ATLASSIAN_API_TOKEN=${MOCK_TOKEN}$`, "m"));
    });

    await check("preview a Jira search link: 6 issues, Xray steps, custom fields, two pages", async () => {
      const r = await api("POST", "/api/test-cases/preview", { link: `${mock.url}/issues/?jql=project%20%3D%20SHOP`, json: read("input/local-shop.json") });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.format, "jira");
      assert.equal(r.body.source.kind, "jira");
      assert.equal(r.body.source.steps, "Xray Cloud");
      assert.equal(r.body.count, 6);
      assert.equal(r.body.matched, 5);
      assert.equal(r.body.columns.endpoint.header, "Endpoint");
      assert.equal(r.body.rows.find((x) => x.id === "SHOP-102").expected, "400 Bad Request");
      assert.ok(mock.seen.some((s) => s.search.includes("nextPageToken=page-2")), "the second page was read");
    });

    await check("preview a Confluence page link: the sample table, 11 cases, same column matching as a sheet", async () => {
      const r = await api("POST", "/api/test-cases/preview", { content: `${mock.url}/wiki/spaces/QA/pages/${CONFLUENCE_PAGE_ID}/Local+shop+API+test+cases`, json: read("input/local-shop.json") });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.format, "confluence");
      assert.equal(r.body.count, 11);
      assert.equal(r.body.matched, 8);
      assert.equal(r.body.columns.id.header, "Test Case ID");
    });

    await check("preview Zephyr Scale and JQL; a link on another site is refused before any request", async () => {
      const z = await api("POST", "/api/test-cases/preview", { link: "zephyr: project = SHOP" });
      assert.equal(z.status, 200, z.text);
      assert.equal(z.body.count, 2);
      const j = await api("POST", "/api/test-cases/preview", { link: "key = SHOP-104" });
      assert.equal(j.status, 200, j.text);
      assert.equal(j.body.rows[0].expected, "404 Not Found");
      const before = mock.seen.length;
      const other = await api("POST", "/api/test-cases/preview", { link: "https://evil.example.com/browse/SHOP-1" });
      assert.equal(other.status, 400);
      assert.match(other.body.error, /the link is on evil\.example\.com, but the Atlassian site in \.env is 127\.0\.0\.1/);
      assert.equal(mock.seen.length, before);
      const missing = await api("POST", "/api/test-cases/preview", { link: `${mock.url}/wiki/spaces/QA/pages/1` });
      assert.equal(missing.status, 400);
      assert.match(missing.body.error, /Confluence said 404 for page 1/);
    });

    await check("POST /api/run: a link on another site or not a link is a 400 before the run starts", async () => {
      const other = await api("POST", "/api/run", { json: read("input/local-shop.json"), testCases: { link: "https://evil.example.com/browse/SHOP-1" } });
      assert.equal(other.status, 400);
      assert.match(other.body.error, /^test case link: the link is on evil\.example\.com/);
      const cfg = JSON.parse(read("input/local-shop.json"));
      cfg.testCases = { link: "hello there" };
      const bad = await api("POST", "/api/run", { json: JSON.stringify(cfg) });
      assert.equal(bad.status, 400);
      assert.match(bad.body.error, /paste one Jira or Confluence link, or a JQL query/);
    });

    await check("the server log never holds a token", async () => {
      const log = ui.log();
      for (const secret of [MOCK_TOKEN, MOCK_XRAY.secret, MOCK_ZEPHYR_TOKEN]) assert.ok(!log.includes(secret), "a secret in the server log");
      assert.match(log, /Jira and Confluence settings saved \(127\.0\.0\.1:\d+, cloud\)/);
    });
  } finally {
    await stop(ui.child);
  }

  // A shared machine (UI_USERS): the setup route is read-only even after login.
  const { default: bcrypt } = await import("bcryptjs");
  ui = await startUi({ ENV_FILE: envFile, UI_USERS: `demo:${bcrypt.hashSync("demo-pass", 4)}` });
  try {
    await check("with UI_USERS set: editable false and POST /api/atlassian 403", async () => {
      const login = await fetch(`http://127.0.0.1:${UI_PORT}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user: "demo", password: "demo-pass" }) });
      assert.equal(login.status, 200);
      const cookie = String(login.headers.get("set-cookie")).split(";")[0];
      const g = await api("GET", "/api/atlassian", null, cookie);
      assert.equal(g.body.editable, false);
      assert.ok(!g.text.includes(MOCK_TOKEN));
      const p = await api("POST", "/api/atlassian", { baseUrl: mock.url, email: MOCK_EMAIL, token: "x-0123456789" }, cookie);
      assert.equal(p.status, 403);
    });
  } finally {
    await stop(ui.child);
  }

  await mock.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
