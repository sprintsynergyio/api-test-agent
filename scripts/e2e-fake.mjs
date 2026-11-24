// End-to-end check with no model key, on any OS (CI runs it on Linux, macOS and Windows):
//   1. start the local demo API with its planted bugs
//   2. run the whole agent (FAKE_MODEL=1) for the Playwright and the Pactum input, and for the sample test
//      case sheet (Playwright with agent suggestions, Pactum with only the sheet, and the same sheet as a
//      table on a fake Confluence page read through a link); expect exit 1 (findings)
//   3. restart the API with the bugs fixed
//   4. copy each exported framework to a temp folder outside this repo, npm install, npm test; expect a pass
// Usage: npm run test:e2e   (needs npm to start it: the exported projects are installed with the same npm)
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mockEnv, CONFLUENCE_PAGE_ID } from "./mock-atlassian.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4000;
const TOKEN = process.env.LOCAL_API_AUTH_VALUE || "Bearer local-shop-demo-token";
const NPM = process.env.npm_execpath;
if (!NPM) {
  console.error("Run this through npm (npm run test:e2e), so the exported projects use the same npm.");
  process.exit(2);
}
// The sample sheet (input/local-shop-test-cases.csv) against the planted bugs: TC-008 hits delete-no-auth,
// TC-009 and the row without an ID name no endpoint of this API, TC-010 is too vague to automate.
const SHEET_STATUS = {
  "TC-001": "passed", "TC-002": "passed", "TC-003": "passed", "TC-004": "passed", "TC-005": "passed", "TC-006": "passed", "TC-007": "passed",
  "TC-008": "failed", "TC-009": "not automated", "ROW-11": "not automated", "TC-010": "needs review",
};
const INPUTS = [
  { input: "input/local-shop.json", framework: "playwright" },
  { input: "input/local-shop-pactum.json", framework: "pactum" },
  // The clients layout (agent/client-layer.ts): the same API and the same findings, with every request
  // sent through a client class the agent wrote. Its export runs standalone like the others.
  { input: "input/local-shop-clients.json", framework: "playwright", clients: true },
  { input: "input/local-shop-sheet.json", framework: "playwright", sheet: "sheet-plus-agent" },
  { input: "input/local-shop-pactum.json", framework: "pactum", sheet: "sheet-only", args: ["--test-cases", path.join("input", "local-shop-test-cases.csv"), "--test-cases-mode", "sheet-only"] },
  // The sample sheet as a Confluence table, read live through a link (scripts/mock-atlassian.mjs). Its
  // export is not installed again: the two runs above already prove the exported projects.
  { input: "input/local-shop.json", framework: "playwright", sheet: "sheet-only", confluence: true, noExport: true },
  // Statuses beyond passed / failed (input/local-shop-statuses-test-cases.csv with the test data file
  // input/local-shop-test-data.json): a Known issue on the planted delete-no-auth bug, a Known issue on a
  // bug that does not exist (unexpected pass), a placeholder with no test data, a manual case and Required
  // data that is not on the API. Their exports run against the API with the planted bugs (below).
  { input: "input/local-shop-statuses.json", framework: "playwright", statuses: true },
  { input: "input/local-shop-pactum.json", framework: "pactum", statuses: true, args: ["--test-cases", path.join("input", "local-shop-statuses-test-cases.csv"), "--test-cases-mode", "sheet-only", "--test-data", path.join("input", "local-shop-test-data.json")] },
  // Probe redesign (input/local-shop-probes-test-cases.csv): the sheet decides the expected status, cases
  // with their own ids get their own GET probe (writes never), an endpoint whose probe is not usable is
  // still planned from the sheet, and a documented 5xx is an accepted 5xx. Exports run against the API
  // with the planted bugs (below): only the sheet's wrong 201 fails.
  { input: "input/local-shop-probes.json", framework: "playwright", probes: true },
  { input: "input/local-shop-probes-pactum.json", framework: "pactum", probes: true },
  // Setup chains (input/local-shop-setup.json): a user made by register (idField "user.id", unique email),
  // a cart item whose path id is a product id (bodyFrom), a review read and deleted at the top level.
  // Every probe is usable, every test but the planted delete-no-auth one passes, cleanup leaves nothing.
  { input: "input/local-shop-setup.json", framework: "playwright", setupChains: true },
  { input: "input/local-shop-setup-pactum.json", framework: "pactum", setupChains: true },
];

function checkSetupRun(label, summary) {
  const endpoints = summary.endpoints || [];
  check(endpoints.length === 11 && endpoints.every((e) => e.probeUsable !== false && !e.failureReason && !e.skippedReason), `${label}: all 11 endpoints probed and tested (${endpoints.filter((e) => e.failureReason || e.skippedReason).map((e) => e.id).join(", ") || "none failed"})`);
  const findings = summary.findings || [];
  check(findings.length === 1 && findings[0].endpointId === "delete-product" && findings[0].actualStatus === 204, `${label}: the only finding is the planted delete-no-auth bug (${findings.map((f) => `${f.endpointId} ${f.actualStatus}`).join(", ")})`);
  check(summary.totals?.failed === 1 && summary.totals?.passed === summary.totals?.testsGenerated - 1, `${label}: every other test passed (${summary.totals?.passed}/${summary.totals?.testsGenerated})`);
  check(summary.cleanup?.failed === 0 && summary.cleanup?.skippedNoDeleteEndpoint === 0 && summary.cleanup?.created === summary.cleanup?.deleted, `${label}: cleanup deleted everything it made (${summary.cleanup?.deleted}/${summary.cleanup?.created})`);
  const specs = ["add-cart-item", "register"].map((id) => fs.readFileSync(path.join(ROOT, "generated", `${id}.spec.ts`), "utf8"));
  check(/ctx\.body\(p\)/.test(specs[0]) && /ctx\.body\(\)/.test(specs[1]), `${label}: the specs build bodies with ctx.body (bodyFrom and unique)`);
}

const PROBE_CASES = {
  "TC-301": "passed", "TC-302": "passed", "TC-303": "failed", "TC-304": "accepted 5xx", "TC-305": "needs review", "TC-306": "passed", "TC-307": "passed",
};

function checkProbesRun(label, summary) {
  const t = summary.testCases;
  check(Boolean(t) && t.rows === 7, `${label}: summary.testCases has the 7 rows of the probes sheet`);
  if (!t) return;
  const got = Object.fromEntries((t.cases || []).map((c) => [c.id, c]));
  for (const [id, status] of Object.entries(PROBE_CASES)) check(got[id]?.status === status, `${label}: ${id} is ${status} (got ${got[id]?.status})`);
  check(t.accepted5xx === 1 && summary.totals?.accepted5xx === 1, `${label}: one accepted 5xx in testCases and totals`);
  check((summary.accepted5xx || []).length === 1 && summary.accepted5xx[0].status === 503 && /TC-304/.test(summary.accepted5xx[0].testTitle), `${label}: summary.accepted5xx lists TC-304 with 503`);
  const findings = summary.findings || [];
  check(findings.length === 1 && /TC-303/.test(findings[0].testTitle) && findings[0].classification === "needs review", `${label}: the sheet's wrong 201 is the only finding, needs review`);
  const eps = Object.fromEntries((summary.endpoints || []).map((e) => [e.id, e]));
  for (const id of ["get-product", "maintenance"]) check(eps[id]?.probeUsable === false && eps[id]?.plannedFromSheet === true && !eps[id]?.skipped, `${label}: ${id} probe not usable, planned from the sheet`);
  const warn = summary.probeWarnings || [];
  check(warn.some((w) => w.caseId === "TC-303" && /201/.test(w.message)) && warn.filter((w) => w.endpointId === "get-product" || w.endpointId === "maintenance").length >= 2, `${label}: probeWarnings name the 201 mismatch and both unusable probes`);
  const cp = summary.caseProbes || {};
  const probed = (cp.results || []).map((r) => r.caseId).sort().join(",");
  check(cp.cap === 20 && cp.sent === 3 && probed === "TC-301,TC-302,TC-306" && (cp.results || []).every((r) => /^GET /.test(r.request)), `${label}: case probes sent 3 GETs (TC-301, TC-302, TC-306), got ${probed}`);
  check((cp.notProbed || []).some((n) => n.caseId === "TC-307" && /PUT/.test(n.reason)), `${label}: the PUT case is never probed`);
}

const STATUS_CASES = {
  "TC-201": ["passed", null], "TC-202": ["known issue", "KNOWN_ISSUE"], "TC-203": ["skipped", "MISSING_TEST_DATA"], "TC-204": ["manual", "MANUAL_VISUAL"],
  "TC-205": ["blocked", "DATA_NOT_ON_ENV"], "TC-206": ["unexpected pass", "KNOWN_ISSUE"], "TC-207": ["passed", null],
};

function checkStatusesRun(label, summary) {
  const t = summary.testCases;
  check(Boolean(t) && t.rows === 7, `${label}: summary.testCases has the 7 rows of the statuses sheet`);
  if (!t) return;
  const got = Object.fromEntries((t.cases || []).map((c) => [c.id, c]));
  for (const [id, [status, code]] of Object.entries(STATUS_CASES)) check(got[id]?.status === status && (got[id]?.reasonCode ?? null) === code, `${label}: ${id} is ${status}${code ? ` (${code})` : ""} (got ${got[id]?.status}, ${got[id]?.reasonCode})`);
  check(t.passed === 2 && t.skipped === 1 && t.manual === 1 && t.blocked === 1 && t.knownIssues === 1 && t.unexpectedPasses === 1, `${label}: testCases counts 2 passed, 1 skipped, 1 manual, 1 blocked, 1 known issue, 1 unexpected pass`);
  const totals = summary.totals || {};
  check(totals.passed === 2 && totals.failed === 1 && totals.skipped === 3 && totals.knownIssues === 1, `${label}: totals never count skips or known issues as passed (passed ${totals.passed}, failed ${totals.failed}, skipped ${totals.skipped}, known ${totals.knownIssues})`);
  check(JSON.stringify(totals.skippedByCode) === JSON.stringify({ DATA_NOT_ON_ENV: 1, MISSING_TEST_DATA: 1, MANUAL_VISUAL: 1 }), `${label}: totals.skippedByCode (${JSON.stringify(totals.skippedByCode)})`);
  check((summary.findings || []).length === 1 && /^UNEXPECTED PASS/.test(summary.findings[0].error) && summary.findings[0].classification === "needs review", `${label}: the unexpected pass is the only finding, needs review`);
  check((summary.knownIssues || []).length === 1 && /SHOP-8/.test(summary.knownIssues[0].reason), `${label}: summary.knownIssues lists SHOP-8`);
  check(/^ID,Title,Endpoint,Test file,Status,Reason code,Coverage,Reason,Jira,Confluence\r\n/.test(fs.readFileSync(path.join(ROOT, "out", "traceability.csv"), "utf8")), `${label}: traceability.csv has the Reason code column`);
  const specs = fs.readdirSync(path.join(ROOT, "generated")).filter((f) => f.endsWith(".spec.ts")).map((f) => fs.readFileSync(path.join(ROOT, "generated", f), "utf8")).join("\n");
  const pactum = summary.testFramework === "pactum";
  check(pactum ? /knownIssue\("KNOWN_ISSUE SHOP-8: delete does not check the token", async/.test(specs) : /test\.fail\(true, "KNOWN_ISSUE SHOP-8: delete does not check the token"\);/.test(specs), `${label}: the agent marked the known issue`);
  check(pactum ? /requireDataFor\("\[TC-205\] \[[a-z-]+\] View one product", \["Summer Hat \(seasonal\)"\]\);/.test(specs) : /await ctx\.requireData\(\["Summer Hat \(seasonal\)"\]\);/.test(specs), `${label}: the agent added the required data check`);
  check(/\[TC-203\] \[skipped\]/.test(specs) && /\[TC-204\] \[manual\]/.test(specs), `${label}: skipped and manual placeholders are in the spec`);
  check(fs.existsSync(path.resolve(ROOT, summary.framework?.dir ?? "-", "config", "test-data.json")) && fs.existsSync(path.resolve(ROOT, summary.framework?.dir ?? "-", "src", "test-data.ts")), `${label}: the export has config/test-data.json and src/test-data.ts`);
  const contract = spawnSync(process.execPath, [tsxEntry(), "agent/check-contract.ts"], { cwd: ROOT, encoding: "utf8" });
  check(contract.status === 0, `${label}: contract check passes (${(contract.stdout + contract.stderr).trim().split("\n").pop()})`);
}

function checkClientsRun(label, summary) {
  check(summary.layout === "clients", `${label}: summary.layout is clients (${summary.layout})`);
  const gen = path.join(ROOT, "generated");
  check(fs.existsSync(path.join(gen, "clients", "base.ts")) && fs.existsSync(path.join(gen, "clients", "products.ts")) && fs.existsSync(path.join(gen, "data", "products.ts")), `${label}: the agent wrote generated/clients and generated/data`);
  const specs = fs.readdirSync(gen).filter((f) => f.endsWith(".spec.ts"));
  const texts = specs.map((f) => fs.readFileSync(path.join(gen, f), "utf8"));
  check(specs.length === 5 && texts.every((t) => /import \{ ProductsClient \} from '\.\.\/generated\/clients\/products';/.test(t) && /new ProductsClient\(ctx\.(?:api|noAuthApi)\)\./.test(t)), `${label}: all 5 specs send their requests through ProductsClient`);
  check(texts.every((t) => !/ctx\.(?:api|noAuthApi)\.(?:get|post|put|patch|delete|head|fetch)\(/.test(t) && !/['"\`]\/products/.test(t)), `${label}: no spec calls the request context or writes a path itself`);
  check(summary.totals?.failed === 1 && (summary.findings || []).length === 1 && /\[auth\] delete-product/.test(summary.findings[0].testTitle) && summary.findings[0].classification === "suspected API finding", `${label}: the same finding as the flat layout (delete-product without auth), got ${JSON.stringify((summary.findings || []).map((f) => f.testTitle))}`);
  const dir = path.resolve(ROOT, summary.framework?.dir ?? "-");
  const has = (f) => fs.existsSync(path.join(dir, ...f.split("/")));
  check(has("src/clients/base.ts") && has("src/clients/products.ts") && has("src/data/products.ts"), `${label}: the export has src/clients and src/data`);
  const exportedSpecs = fs.existsSync(path.join(dir, "tests")) ? fs.readdirSync(path.join(dir, "tests")).filter((f) => f.endsWith(".spec.ts")).map((f) => fs.readFileSync(path.join(dir, "tests", f), "utf8")) : [];
  check(exportedSpecs.length === 5 && exportedSpecs.every((t) => /from '\.\.\/src\/clients\/products'/.test(t) && !/generated\//.test(t)), `${label}: exported specs import ../src/clients, never generated/`);
  check(fs.existsSync(path.join(dir, "README.md")) && /## Client layer/.test(fs.readFileSync(path.join(dir, "README.md"), "utf8")), `${label}: the export README explains the client layer`);
  const contract = spawnSync(process.execPath, [tsxEntry(), "agent/check-contract.ts"], { cwd: ROOT, encoding: "utf8" });
  check(contract.status === 0, `${label}: contract check passes (${(contract.stdout + contract.stderr).trim().split("\n").pop()})`);
}

function checkSheetRun(label, summary, mode, format) {
  const t = summary.testCases;
  check(Boolean(t) && t.mode === mode && t.rows === 11, `${label}: summary.testCases has the 11 sheet rows in ${mode} mode`);
  if (!t) return;
  if (format) check(t.format === format && t.source?.kind === format, `${label}: summary.testCases.format and source are ${format} (${t.format}, ${t.source?.kind})`);
  const got = Object.fromEntries((t.cases || []).map((c) => [c.id, c.status]));
  for (const [id, status] of Object.entries(SHEET_STATUS)) check(got[id] === status, `${label}: ${id} is ${status} (got ${got[id]})`);
  check(mode === "sheet-only" ? t.agentSuggestions === 0 : t.agentSuggestions > 0, `${label}: agent suggestions ${mode === "sheet-only" ? "off" : "on"} (${t.agentSuggestions})`);
  const csv = fs.readFileSync(path.join(ROOT, "out", "traceability.csv"), "utf8");
  check(csv.startsWith("ID,Title,Endpoint,Test file,Status,Reason code,Coverage,Reason,Jira,Confluence\r\n") && csv.includes("TC-008,"), `${label}: out/traceability.csv written`);
  const xlsx = fs.readFileSync(path.join(ROOT, "out", "traceability.xlsx"));
  check(xlsx.readUInt32LE(0) === 0x04034b50, `${label}: out/traceability.xlsx written`);
  const spec = fs.readFileSync(path.join(ROOT, "generated", "get-product.spec.ts"), "utf8");
  check(spec.includes("[TC-005] [") && spec.includes("[TC-010] [needs-review]"), `${label}: generated test names carry the case IDs and the needs-review case`);
  if (summary.framework?.dir) check(fs.existsSync(path.resolve(ROOT, summary.framework.dir, "traceability.csv")), `${label}: the exported framework has traceability.csv`);
  if (summary.testFramework === "playwright") {
    const dir = path.join(ROOT, "reports", "allure-results");
    const labels = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith("-result.json")).flatMap((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).labels || []) : [];
    check(labels.some((l) => l.name === "caseId" && l.value === "TC-001"), `${label}: Allure results carry the caseId label`);
  }
}

function tsxEntry() {
  const dir = path.join(ROOT, "node_modules", "tsx");
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  return path.join(dir, typeof meta.bin === "string" ? meta.bin : meta.bin.tsx);
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGTERM");
}

// The checks start their own local API on this port. A server already listening there (an
// `npm run api:local` left open) would answer instead, the new one would fail with EADDRINUSE, and the
// checks would run against a server whose data earlier runs have changed. Wait briefly for a server
// that is shutting down, then refuse.
async function ensurePortFree() {
  for (let i = 0; i < 20; i++) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(1000) });
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`port ${PORT} is already in use (an \`npm run api:local\` still running?). Stop it first: these checks start their own local API.`);
}

async function startApi(fixed) {
  await ensurePortFree();
  const env = { ...process.env, PORT: String(PORT) };
  if (fixed) env.FIXED = "1";
  else delete env.FIXED;
  const child = spawn(process.execPath, [path.join(ROOT, "local-api", "server.mjs")], { cwd: ROOT, env, stdio: "inherit", windowsHide: true });
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error("local API exited before it was ready");
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/products`, { headers: { Authorization: TOKEN } });
      if (res.status < 500) return child;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  killTree(child);
  throw new Error("local API did not start within 30s");
}

// The fake Atlassian site runs in its own process: the agent runs are spawnSync, which blocks this one.
async function startAtlassian() {
  const child = spawn(process.execPath, [path.join(ROOT, "scripts", "mock-atlassian.mjs"), "0"], { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
  let out = "";
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`mock Atlassian site did not start: ${out}`)), 15000);
    child.stdout.on("data", (d) => {
      out += d;
      const m = /Mock Atlassian site on (http:\/\/[\d.]+:\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    child.on("exit", (code) => reject(new Error(`mock Atlassian site exited with ${code}: ${out}`)));
  });
  return { child, url, env: mockEnv(url) };
}

function run(cmd, args, opts) {
  console.log(`\n$ ${path.basename(cmd)} ${args.map((a) => path.basename(a) === a ? a : path.relative(ROOT, a) || a).join(" ")}  (in ${opts.cwd})`);
  const r = spawnSync(cmd, args, { stdio: "inherit", windowsHide: true, ...opts });
  if (r.error) throw r.error;
  return r.status;
}

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failures.push(what);
};

let api = null;
let atlassian = null;
const exported = [];
try {
  api = await startApi(false);
  atlassian = await startAtlassian();
  for (const { input, framework, sheet, args: given = [], confluence, noExport, statuses, probes, clients, setupChains } of INPUTS) {
    const env = { ...process.env, FAKE_MODEL: "1", LOCAL_API_AUTH_VALUE: TOKEN };
    const args = confluence ? ["--test-cases", `${atlassian.url}/wiki/spaces/QA/pages/${CONFLUENCE_PAGE_ID}/Local+shop+API+test+cases`, "--test-cases-mode", sheet] : given;
    if (confluence) Object.assign(env, atlassian.env);
    const code = run(process.execPath, [tsxEntry(), "agent/cli.ts", input, ...args], { cwd: ROOT, env });
    check(code === 1, `${input}: agent exits 1 (findings against the planted bugs), got ${code}`);
    const summary = JSON.parse(fs.readFileSync(path.join(ROOT, "out", "summary.json"), "utf8"));
    check(summary.schemaVersion === 1, `${input}: summary.json schemaVersion is 1`);
    if (input === "input/local-shop.json") {
      const list = (summary.endpoints || []).find((e) => e.id === "list-products");
      check(Array.isArray(list?.responseSchemaIssues) && list.responseSchemaIssues.length === 0, `${input}: list-products probe matches its documented response schema`);
    }
    check(summary.exitCode === code, `${input}: summary.json exitCode matches the process (${summary.exitCode})`);
    check((summary.findings || []).length > 0, `${input}: summary.json lists findings (${(summary.findings || []).length})`);
    check(summary.testFramework === framework && Boolean(summary.framework?.dir), `${input}: ${framework} project exported (${summary.framework?.dir})`);
    check(Boolean(summary.framework?.zip) && fs.existsSync(path.resolve(ROOT, summary.framework.zip)), `${input}: framework zip written`);
    if (setupChains) checkSetupRun(`${input} (setup chains)`, summary);
    if (probes) checkProbesRun(`${input} (probes)`, summary);
    else if (statuses) checkStatusesRun(`${input} (statuses)`, summary);
    else if (sheet) checkSheetRun(`${input} (${confluence ? "Confluence link, " : ""}${sheet})`, summary, sheet, confluence ? "confluence" : null);
    else check(summary.testCases === null, `${input}: no test case sheet, summary.testCases is null`);
    if (clients) checkClientsRun(`${input} (clients layout)`, summary);
    else check(summary.layout === undefined && !fs.existsSync(path.join(ROOT, "generated", "clients")), `${input}: flat layout, no client layer written`);
    if (confluence) {
      const text = fs.readFileSync(path.join(ROOT, "out", "summary.json"), "utf8");
      check(!text.includes(atlassian.env.ATLASSIAN_API_TOKEN), `${input} (Confluence link): the Atlassian token is not in summary.json`);
      const seen = await fetch(`${atlassian.url}/__seen`).then((r) => r.json()).catch(() => []);
      check(seen.some((s) => s.path === `/wiki/api/v2/pages/${CONFLUENCE_PAGE_ID}` && s.auth === "Basic"), `${input} (Confluence link): the page was read through the Confluence v2 API with Basic auth`);
    }
    if (statuses && summary.framework?.dir) {
      // The export against the API with the planted bugs: the known issue fails as expected (not a
      // failure), the missing data skips, and only the unexpected pass fails the suite.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ata-e2e-${framework}-statuses-`));
      fs.cpSync(path.resolve(ROOT, summary.framework.dir), dir, { recursive: true });
      fs.writeFileSync(path.join(dir, ".env"), `LOCAL_API_AUTH_VALUE=${TOKEN}\n`);
      const xenv = { ...process.env };
      delete xenv.FAKE_MODEL;
      delete xenv.LOCAL_API_AUTH_VALUE;
      delete xenv.TEST_DATA_FILE;
      try {
        const install = run(process.execPath, [NPM, "install", "--no-audit", "--no-fund"], { cwd: dir, env: xenv });
        check(install === 0, `${framework} statuses export: npm install`);
        if (install === 0) {
          const r = spawnSync(process.execPath, [NPM, "test"], { cwd: dir, env: xenv, encoding: "utf8", windowsHide: true });
          const out = `${r.stdout}${r.stderr}`;
          const one = framework === "pactum" ? /\b3 passing\b/.test(out) && /\b3 pending\b/.test(out) && /\b1 failing\b/.test(out) && /UNEXPECTED PASS: KNOWN_ISSUE SHOP-10/.test(out) : /\b1 failed\b/.test(out) && /\b3 skipped\b/.test(out) && /Expected to fail, but passed/.test(out) && /TC-206/.test(out);
          check(r.status !== 0 && one, `${framework} statuses export: npm test fails only on the unexpected pass (known issue expected, missing data skipped)${one ? "" : `\n${out.slice(-1500)}`}`);
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    if (probes && summary.framework?.dir) {
      // The export: the accepted 5xx passes against the maintenance route, the own-id cases pass, and only
      // the sheet's wrong 201 fails.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ata-e2e-${framework}-probes-`));
      fs.cpSync(path.resolve(ROOT, summary.framework.dir), dir, { recursive: true });
      fs.writeFileSync(path.join(dir, ".env"), `LOCAL_API_AUTH_VALUE=${TOKEN}\n`);
      const xenv = { ...process.env };
      delete xenv.FAKE_MODEL;
      delete xenv.LOCAL_API_AUTH_VALUE;
      try {
        const install = run(process.execPath, [NPM, "install", "--no-audit", "--no-fund"], { cwd: dir, env: xenv });
        check(install === 0, `${framework} probes export: npm install`);
        if (install === 0) {
          const r = spawnSync(process.execPath, [NPM, "test"], { cwd: dir, env: xenv, encoding: "utf8", windowsHide: true });
          const out = `${r.stdout}${r.stderr}`;
          const one = framework === "pactum" ? /\b5 passing\b/.test(out) && /\b1 failing\b/.test(out) && /TC-303/.test(out) : /\b1 failed\b/.test(out) && /\b5 passed\b/.test(out) && /TC-303/.test(out);
          check(r.status !== 0 && one, `${framework} probes export: npm test fails only on the sheet's wrong 201${one ? "" : `\n${out.slice(-1500)}`}`);
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    if (summary.framework?.dir && !noExport && !statuses && !probes) {
      const copy = fs.mkdtempSync(path.join(os.tmpdir(), `ata-e2e-${framework}${sheet ? "-sheet" : ""}-`));
      fs.cpSync(path.resolve(ROOT, summary.framework.dir), copy, { recursive: true });
      exported.push({ input, framework, dir: copy });
    }
  }
  killTree(api);
  api = null;
  await new Promise((r) => setTimeout(r, 1000));
  api = await startApi(true);
  for (const { input, framework, dir } of exported) {
    fs.writeFileSync(path.join(dir, ".env"), `LOCAL_API_AUTH_VALUE=${TOKEN}\n`);
    const env = { ...process.env };
    delete env.FAKE_MODEL;
    delete env.LOCAL_API_AUTH_VALUE; // the exported project must read it from its own .env
    const install = run(process.execPath, [NPM, "install", "--no-audit", "--no-fund"], { cwd: dir, env });
    check(install === 0, `${framework} export: npm install`);
    if (install !== 0) continue;
    const test = run(process.execPath, [NPM, "test"], { cwd: dir, env });
    check(test === 0, `${framework} export (${input}): npm test passes against the fixed API`);
  }
} catch (err) {
  check(false, `e2e crashed: ${err?.stack || err}`);
} finally {
  killTree(api);
  killTree(atlassian?.child);
  for (const { dir } of exported) fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures.length ? `\n${failures.length} e2e check(s) failed` : "\nAll e2e checks passed");
process.exit(failures.length ? 1 : 0);
