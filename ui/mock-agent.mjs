// UI TESTING ONLY. Prints fake agent output and writes a FAKE out/summary.json so you can check the UI
// before the real agent exists. Never use this in the demo. Run: AGENT_CMD="node ui/mock-agent.mjs" node ui/server.mjs
import fs from "node:fs";
const file = process.argv[2];
const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const ids = cfg.endpoints.map(e => e.id);
fs.rmSync("out", { recursive: true, force: true }); fs.rmSync("generated", { recursive: true, force: true }); fs.rmSync("reports", { recursive: true, force: true });
const t0 = Date.now();
console.log("=== PROBING ===");
for (const id of ids) { await wait(250); console.log(`${id} OK 200`); }
console.log("=== PLANNING ===");
for (const id of ids) { await wait(350); console.log(`${id} OK 5 cases`); }
console.log("=== GENERATING ===");
fs.mkdirSync("generated", { recursive: true });
for (const id of ids) { await wait(350); console.log(`${id} OK written generated/${id}.spec.ts`);
  fs.writeFileSync(`generated/${id}.spec.ts`, `import { test, expect } from '../tests/fixtures/ctx';

// Generated for ${id}
test('[happy] ${id} returns success', async ({ ctx }) => {
  const res = await ctx.api.get('/products');
  test.info().annotations.push({ type: 'actual-status', description: String(res.status()) });
  expect(res.status()).toBe(200);
});

test('[auth] ${id} rejects missing token', async ({ ctx }) => {
  const id = await ctx.createResource('create-product');
  const res = await ctx.noAuthApi.delete(\`/products/\${id}\`);
  test.info().annotations.push({ type: 'actual-status', description: String(res.status()) });
  expect([401, 403]).toContain(res.status());
});
`); }
console.log("=== RUNNING TESTS ===");
await wait(500);
console.log("Running 23 tests using 4 workers");
console.log("  ✓  1 [happy] list-products returns success (120ms)");
console.log("  ✘  2 [invalid-input] create-product rejects text price (88ms)");
console.log("  ✘  3 [auth] delete-product rejects missing token (64ms)");
console.log("  2 failed, 21 passed");
fs.mkdirSync("reports/html", { recursive: true });
fs.writeFileSync("reports/html/index.html", "<h1>Playwright report placeholder</h1>");
console.log("=== SUMMARY ===");
const endpoints = cfg.endpoints.map((e, i) => ({ id: e.id, method: e.method, path: e.path, requiresAuth: e.requiresAuth, probeStatus: 200, casesPlanned: 4 + (i % 2), specWritten: true, specFile: `${e.id}.spec.ts`, passed: 4 + (i % 2) - (e.id === 'create-product' || e.id === 'delete-product' ? 1 : 0), failed: (e.id === 'create-product' || e.id === 'delete-product') ? 1 : 0, failureReason: null }));
const summary = { status: "completed", inputFile: file, baseUrl: cfg.baseUrl, startedAt: new Date(t0).toISOString(), durationSec: Math.round((Date.now()-t0)/1000), claudeCalls: { used: 10, budget: 30 },
  totals: { endpoints: endpoints.length, testsGenerated: 23, passed: 21, failed: 2 }, endpoints,
  findings: [
    { endpointId: "create-product", testTitle: "[invalid-input] create-product rejects price sent as text", type: "invalid-input", expectedStatus: "4xx", actualStatus: 500, classification: "suspected API finding", error: "Expected 4xx, received 500" },
    { endpointId: "delete-product", testTitle: "[auth] delete-product rejects request without token", type: "auth", expectedStatus: "401|403", actualStatus: 204, classification: "suspected API finding", error: "Expected 401|403, received 204" } ] };
fs.mkdirSync("out", { recursive: true });
fs.writeFileSync("out/summary.json", JSON.stringify(summary, null, 2));
console.log("2 suspected API findings");
