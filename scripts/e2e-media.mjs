// End-to-end check of the media demo with no model key, on any OS (CI runs it on Linux, macOS and
// Windows). It covers what a sheet-only run against a real API needs beyond JSON CRUD:
//   - a base URL with a path (http://localhost:4000/media/v1) and endpoint paths with a leading slash
//   - an image endpoint (Content-Type, Cache-Control, body size and the PNG signature, never json())
//   - a paged read-only list whose tests compare two pages (stable data, each test independent)
//   - 400 validation errors on query-only and body endpoints ("400 or 404, not 500" negation)
//   - per-case coverage: needs review when the API disagrees with the sheet, partially covered when a
//     clause has no assertion; sheet-only mode adds no agent tests
// Steps: start the local demo API, run the agent (FAKE_MODEL=1) with Playwright and with Pactum on
// input/local-media.json, check summary.json, the traceability and the generated specs, then copy each
// exported framework to a temp folder, npm install, npm test; expect a pass.
// Usage: npm run test:e2e-media
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4000;
const NPM = process.env.npm_execpath;
if (!NPM) {
  console.error("Run this through npm (npm run test:e2e-media), so the exported projects use the same npm.");
  process.exit(2);
}
const EXPECTED = {
  "TC-101": "passed", "TC-102": "passed", "TC-103": "passed", "TC-104": "passed", "TC-105": "needs review",
  "TC-106": "passed", "TC-107": "passed", "TC-108": "passed", "TC-109": "partially covered",
};

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

async function startApi() {
  const child = spawn(process.execPath, [path.join(ROOT, "local-api", "server.mjs")], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: "inherit", windowsHide: true });
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error("local API exited before it was ready");
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/media/v1/photos`);
      if (res.status === 200) return child;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  killTree(child);
  throw new Error("local API did not start within 30s");
}

function run(cmd, args, opts) {
  console.log(`\n$ ${path.basename(cmd)} ${args.map((a) => (path.basename(a) === a ? a : path.relative(ROOT, a) || a)).join(" ")}  (in ${opts.cwd})`);
  const r = spawnSync(cmd, args, { stdio: "inherit", windowsHide: true, ...opts });
  if (r.error) throw r.error;
  return r.status;
}

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failures.push(what);
};
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

function allureLabels(dir) {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) return [];
  return fs.readdirSync(full).filter((f) => f.endsWith("-result.json")).map((f) => JSON.parse(fs.readFileSync(path.join(full, f), "utf8")));
}

// The Pactum run uses a copy of the input next to a copy of the sheet, with "framework": "pactum".
const tmpInputs = fs.mkdtempSync(path.join(os.tmpdir(), "ata-media-input-"));
const media = JSON.parse(read("input/local-media.json"));
fs.writeFileSync(path.join(tmpInputs, "local-media-pactum.json"), JSON.stringify({ ...media, name: "local-media-pactum", framework: "pactum" }, null, 2));
fs.copyFileSync(path.join(ROOT, "input", "local-media-test-cases.csv"), path.join(tmpInputs, "local-media-test-cases.csv"));
const RUNS = [
  { label: "playwright", input: "input/local-media.json", allure: "reports/allure-results" },
  { label: "pactum", input: path.join(tmpInputs, "local-media-pactum.json"), allure: "reports/pactum/allure-results" },
];

let api = null;
const exported = [];
try {
  api = await startApi();
  for (const { label, input, allure } of RUNS) {
    const env = { ...process.env, FAKE_MODEL: "1" };
    const code = run(process.execPath, [tsxEntry(), "agent/cli.ts", input], { cwd: ROOT, env });
    check(code === 0, `${label}: agent exits 0 (no findings on the media API), got ${code}`);
    const summary = JSON.parse(read("out/summary.json"));
    const t = summary.testCases;
    check(Boolean(t) && t.mode === "sheet-only" && t.rows === 9, `${label}: summary.testCases has the 9 sheet rows in sheet-only mode`);
    const got = Object.fromEntries((t?.cases || []).map((c) => [c.id, c]));
    for (const [id, status] of Object.entries(EXPECTED)) check(got[id]?.status === status, `${label}: ${id} is ${status} (got ${got[id]?.status}: ${got[id]?.reason})`);
    check(t?.passed === 7 && t?.partiallyCovered === 1 && t?.needsReview === 1, `${label}: totals 7 passed, 1 partially covered, 1 needs review (got ${t?.passed}, ${t?.partiallyCovered}, ${t?.needsReview})`);
    const ac = t?.assertionCoverage;
    check(ac && Number.isInteger(ac.clauses) && ac.clauses > 0 && ac.asserted < ac.clauses && typeof ac.percent === "number", `${label}: summary.testCases.assertionCoverage counts the sheet's clauses (${JSON.stringify(ac)})`);
    check(got["TC-109"]?.coverage && /^\d+\/\d+ \([\d.]+%\)$/.test(got["TC-109"].coverage), `${label}: the partially covered case shows its coverage (${got["TC-109"]?.coverage})`);
    const csvText = read("out/traceability.csv");
    check(/^ID,Title,Endpoint,Test file,Status,Coverage,Reason,Jira,Confluence\r\n/.test(csvText), `${label}: traceability.csv has the Coverage, Jira and Confluence columns`);
    check(/clause 2 "photos are sorted by title"/.test(got["TC-109"]?.reason ?? ""), `${label}: the partially covered case lists the clause that is not asserted`);
    check(/expected download_url contains \/cdn\/, actual download_url is \/media\/v1\/files\//.test(got["TC-105"]?.reason ?? ""), `${label}: the needs-review case shows expected vs actual`);
    check(t?.agentSuggestions === 0, `${label}: sheet-only adds no agent tests (${t?.agentSuggestions})`);
    const list = read("generated/list-photos.spec.ts");
    const allSpecs = fs.readdirSync(path.join(ROOT, "generated")).filter((f) => f.endsWith(".spec.ts")).map((f) => read(`generated/${f}`)).join("\n");
    check(/expect\(String\(response\.headers\(\)\['content-type'\]\)\)\.toContain\(["']json["']\)/.test(allSpecs), `${label}: a case whose expected result names JSON asserts the Content-Type header`);
    const thumb = read("generated/get-thumbnail.spec.ts");
    check(!/\[agent\]/.test(list + thumb + read("generated/resize-photo.spec.ts")), `${label}: no [agent] tests in a sheet-only run`);
    check(!/mode:\s*['"]serial['"]|describe\.serial/.test(list), `${label}: the spec that compares pages never uses serial mode (each test is independent)`);
    check(/"page":2/.test(list) && /\/\/ covers clause 2/.test(list), `${label}: the paging case compares page 1 and page 2 with clause markers`);
    check(thumb.includes("toString('hex')).toBe(\"89504e47\")") && !/thumbnail[\s\S]*Download[\s\S]*response\.json\(\)/.test(thumb), `${label}: the image test checks the PNG signature and never parses JSON`);
    check(thumb.includes("expect([400,404]).toContain(response.status())"), `${label}: "400 or 404, not 500 or 502" asserts the 4xx list`);
    check(summary.totals.passed === summary.totals.testsGenerated && summary.totals.failed === 0, `${label}: every generated test passed against the base path (${summary.totals.passed}/${summary.totals.testsGenerated})`);
    const results = allureLabels(allure);
    const partial = results.find((r) => String(r.name).startsWith("[TC-109]"));
    check(Boolean(partial?.labels?.some((l) => l.name === "tag" && l.value === "partially covered")), `${label}: Allure tags the partially covered case`);
    check(Boolean(results.find((r) => String(r.name).startsWith("[TC-105]"))?.labels?.some((l) => l.name === "tag" && l.value === "needs review")), `${label}: Allure tags the needs-review case`);
    const contract = spawnSync(process.execPath, [tsxEntry(), "agent/check-contract.ts"], { cwd: ROOT, encoding: "utf8" });
    check(contract.status === 0, `${label}: contract check clean ${contract.status === 0 ? "" : contract.stdout + contract.stderr}`);
    if (summary.framework?.dir) {
      const copy = fs.mkdtempSync(path.join(os.tmpdir(), `ata-e2e-media-${label}-`));
      fs.cpSync(path.resolve(ROOT, summary.framework.dir), copy, { recursive: true });
      exported.push({ label, dir: copy });
    } else check(false, `${label}: framework exported`);
  }
  for (const { label, dir } of exported) {
    const env = { ...process.env };
    delete env.FAKE_MODEL;
    const install = run(process.execPath, [NPM, "install", "--no-audit", "--no-fund"], { cwd: dir, env });
    check(install === 0, `${label} export: npm install`);
    if (install !== 0) continue;
    const test = run(process.execPath, [NPM, "test"], { cwd: dir, env });
    check(test === 0, `${label} export: npm test passes against the base path`);
  }
} catch (err) {
  check(false, `e2e crashed: ${err?.stack || err}`);
} finally {
  killTree(api);
  for (const { dir } of exported) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(tmpInputs, { recursive: true, force: true });
}
console.log(failures.length ? `\n${failures.length} e2e check(s) failed` : "\nAll media e2e checks passed");
process.exit(failures.length ? 1 : 0);
