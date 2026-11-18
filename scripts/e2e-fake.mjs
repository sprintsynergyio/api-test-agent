// End-to-end check with no model key, on any OS (CI runs it on Linux, macOS and Windows):
//   1. start the local demo API with its planted bugs
//   2. run the whole agent (FAKE_MODEL=1) for the Playwright and the Pactum input, and for the sample test
//      case sheet (Playwright with agent suggestions, Pactum with only the sheet); expect exit 1 (findings)
//   3. restart the API with the bugs fixed
//   4. copy each exported framework to a temp folder outside this repo, npm install, npm test; expect a pass
// Usage: npm run test:e2e   (needs npm to start it: the exported projects are installed with the same npm)
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  { input: "input/local-shop-sheet.json", framework: "playwright", sheet: "sheet-plus-agent" },
  { input: "input/local-shop-pactum.json", framework: "pactum", sheet: "sheet-only", args: ["--test-cases", path.join("input", "local-shop-test-cases.csv"), "--test-cases-mode", "sheet-only"] },
];

function checkSheetRun(label, summary, mode) {
  const t = summary.testCases;
  check(Boolean(t) && t.mode === mode && t.rows === 11, `${label}: summary.testCases has the 11 sheet rows in ${mode} mode`);
  if (!t) return;
  const got = Object.fromEntries((t.cases || []).map((c) => [c.id, c.status]));
  for (const [id, status] of Object.entries(SHEET_STATUS)) check(got[id] === status, `${label}: ${id} is ${status} (got ${got[id]})`);
  check(mode === "sheet-only" ? t.agentSuggestions === 0 : t.agentSuggestions > 0, `${label}: agent suggestions ${mode === "sheet-only" ? "off" : "on"} (${t.agentSuggestions})`);
  const csv = fs.readFileSync(path.join(ROOT, "out", "traceability.csv"), "utf8");
  check(csv.startsWith("ID,Title,Endpoint,Test file,Status,Reason\r\n") && csv.includes("TC-008,"), `${label}: out/traceability.csv written`);
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

async function startApi(fixed) {
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
const exported = [];
try {
  api = await startApi(false);
  for (const { input, framework, sheet, args = [] } of INPUTS) {
    const env = { ...process.env, FAKE_MODEL: "1", LOCAL_API_AUTH_VALUE: TOKEN };
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
    if (sheet) checkSheetRun(`${input} (${sheet})`, summary, sheet);
    else check(summary.testCases === null, `${input}: no test case sheet, summary.testCases is null`);
    if (summary.framework?.dir) {
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
  for (const { dir } of exported) fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failures.length ? `\n${failures.length} e2e check(s) failed` : "\nAll e2e checks passed");
process.exit(failures.length ? 1 : 0);
