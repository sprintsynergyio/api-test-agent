import assert from 'node:assert/strict';
import { configProblems, type Config, type Endpoint } from './config';
import { parseAgentFlags } from './flags';
import { sheetStatusGate } from './generate';
import { runSetup } from './http';
import { groupRoutes } from './importers/core';
import { buildInput } from './importers/core';
import { finalizeSheetPlan, planEndpoint, sheetStatusDecision, type Plan } from './plan';
import { caseProbePlan, type ProbeResult } from './probe';
import { matchExplicit, parseSheet, pathValuesFor, type SheetCase } from './test-cases';
import { buildTraceRows, traceTotals } from './traceability';
import { validateSpec } from './validate';

// npm run test:probe-redesign: the sheet decides the expected status (the probe only shows the shape), an
// unusable probe no longer blocks the team's cases, per-case GET probes (never writes, capped), a 5xx only
// when the sheet documents it, and literal paths grouped into routes. Offline, no model, no API.

let failed = 0;
let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`ok    ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}\n      ${String((err as Error)?.stack ?? err).split('\n').slice(0, 8).join('\n      ')}`);
  }
}

const sheetCase = (id: string, over: Partial<SheetCase> = {}): SheetCase => ({ id, row: 2, title: 'a case', steps: 'Send GET /products/42', expected: 'Status 200', endpoint: 'get-product', method: 'GET', priority: '', preconditions: '', testData: '', ...over });
const ep = (e: Partial<Endpoint> = {}): Endpoint => ({ id: 'get-product', method: 'GET', path: '/products/{id}', requiresAuth: false, ...e }) as Endpoint;
const probe = (status: number | null, over: Partial<ProbeResult> = {}): ProbeResult =>
  ({ endpointId: 'get-product', method: 'GET', path: '/products/1', status, contentType: 'application/json', body: { id: 1 }, durationMs: 1, usable: status !== null && status >= 200 && status < 300, requestBody: null, query: null, headers: null, ...over }) as ProbeResult;
const rawPlan = (over: Partial<Plan['cases'][number]> = {}, caseId = 'TC-1'): Plan =>
  ({ endpointId: 'get-product', cases: [{ caseId, id: caseId.toLowerCase(), type: 'happy', title: 't', requestDescription: 'GET', expectedStatus: '200', assertions: ['status is 200'], ...over }] }) as Plan;

// ---------- the sheet decides the status ----------

await check('status: a 2xx in the sheet wins over the probe, with a note; several codes pick the probed one', () => {
  assert.deepEqual(sheetStatusDecision('201 Created', probe(200)), { status: '201', note: "the sheet expects 201; the API answered 200 when probed. The test expects the sheet's 201, so the run shows which one is right" });
  assert.deepEqual(sheetStatusDecision('200 or 201', probe(201)), { status: '201' });
  assert.deepEqual(sheetStatusDecision('Status 200', probe(200)), { status: '200' });
});

await check('status: no code in the sheet takes the probe 2xx; no usable probe means needs review (SPEC_UNCLEAR)', () => {
  assert.deepEqual(sheetStatusDecision('the product is shown', probe(200)), { status: '200' });
  const none = sheetStatusDecision('the product is shown', probe(404));
  assert.ok('conflict' in none && none.code === 'SPEC_UNCLEAR' && /names no expected status/.test(none.conflict));
  const down = sheetStatusDecision('the product is shown', probe(null, { error: 'ECONNREFUSED' }));
  assert.ok('conflict' in down && /ECONNREFUSED/.test(down.conflict));
});

await check('status: a 5xx only when documented (column or tag); then exactly that code, marked accepted 5xx', () => {
  const plain = sheetStatusDecision('503 Service Unavailable', probe(503));
  assert.ok('conflict' in plain && /Documented 5xx/.test(plain.conflict));
  assert.deepEqual(sheetStatusDecision('503 Service Unavailable', probe(503), { documented5xx: 'yes' }), { status: '503', accepted5xx: true });
  const vague = sheetStatusDecision('a 5xx error', probe(503), { documented5xx: 'yes' });
  assert.ok('conflict' in vague && /names no exact code/.test(vague.conflict));
});

await check('status: a known issue never expects its 5xx; only-5xx known issues need the correct status', () => {
  assert.deepEqual(sheetStatusDecision('200, currently 500', probe(500), { knownIssue: 'QA-1' }).hasOwnProperty('status'), true);
  const only = sheetStatusDecision('Status 500', probe(500), { knownIssue: 'QA-1' });
  assert.ok('conflict' in only && /that 5xx is the bug/.test(only.conflict));
  // Even documented, a known issue's 5xx stays the bug.
  const both = sheetStatusDecision('Status 500', probe(500), { knownIssue: 'QA-1', documented5xx: 'yes' });
  assert.ok('conflict' in both);
});

await check('status: the case probe comes first, and the note says it was the case\'s own request', () => {
  const d = sheetStatusDecision('Status 200', probe(200), { caseProbe: { status: 404, usable: false, path: '/products/42' } });
  assert.ok('status' in d && d.status === '200' && /with this case's own request \(\/products\/42\)/.test(d.note ?? ''));
  assert.deepEqual(sheetStatusDecision('the product', probe(404), { caseProbe: { status: 200, usable: true } }), { status: '200' });
});

// ---------- the plan ----------

await check('plan: a documented 5xx case is planned as happy with accepted5xx; the model cannot set accepted5xx itself', () => {
  const sheet = [sheetCase('TC-1', { expected: 'Status 503 while the import runs', documented5xx: 'yes, see API spec 4.2' }), sheetCase('TC-2', { expected: 'Status 200' })];
  const raw = { endpointId: 'get-product', cases: [{ ...rawPlan({ type: 'invalid-input', expectedStatus: '4xx' }).cases[0] }, { ...rawPlan({ accepted5xx: true, pathValues: { id: 'x' } }, 'TC-2').cases[0] }] } as Plan;
  const out = finalizeSheetPlan(raw, ep(), probe(200), [], sheet, 'sheet-only');
  const one = out.plan.cases.find((c) => c.caseId === 'TC-1')!;
  assert.equal(one.type, 'happy');
  assert.equal(one.expectedStatus, '503');
  assert.equal(one.accepted5xx, true);
  assert.equal(one.title, '[TC-1] [happy] a case');
  const two = out.plan.cases.find((c) => c.caseId === 'TC-2')!;
  assert.equal(two.accepted5xx, undefined);
  assert.equal(two.pathValues, undefined, 'path values come from the sheet request line only');
});

await check('plan: path values and probe notes travel with the case; agent suggestions never carry them', () => {
  const sheet = [sheetCase('TC-1', { expected: 'Status 200', pathValues: { id: '42' } })];
  const raw = { endpointId: 'get-product', cases: [rawPlan().cases[0], { id: 'mine', type: 'auth', title: 'no token', requestDescription: 'x', expectedStatus: '401|403', assertions: ['a'], accepted5xx: true, probeNote: 'x', pathValues: { id: '1' } }] } as Plan;
  const out = finalizeSheetPlan(raw, ep({ requiresAuth: true }), probe(200), [], sheet, 'sheet-plus-agent', undefined, { 'TC-1': probe(404, { path: '/products/42' }) });
  const sheetPlanned = out.plan.cases.find((c) => c.caseId === 'TC-1')!;
  assert.deepEqual(sheetPlanned.pathValues, { id: '42' });
  assert.match(sheetPlanned.probeNote ?? '', /answered 404 when probed with this case's own request/);
  const agent = out.plan.cases.find((c) => c.source === 'agent')!;
  assert.equal(agent.accepted5xx ?? agent.probeNote ?? agent.pathValues, undefined);
});

await check('plan: an unusable probe stops only the agent\'s own plan; the team\'s cases are planned from the sheet', async () => {
  process.env.FAKE_MODEL = '1';
  const own = await planEndpoint(ep(), probe(404));
  assert.ok(!own.ok && /probe not usable: 404/.test(own.reason));
  const sheet = [sheetCase('TC-1', { steps: 'Send GET /products/42 for one product', expected: '200 with the product' }), sheetCase('TC-2', { steps: 'Send GET /products/42 for one product', expected: 'returns the product' })];
  const fromSheet = await planEndpoint(ep(), probe(404), { sheetCases: sheet, testCaseMode: 'sheet-plus-agent' });
  assert.ok(fromSheet.ok, fromSheet.ok ? '' : fromSheet.reason);
  if (fromSheet.ok) {
    assert.deepEqual(fromSheet.plan.cases.map((c) => [c.caseId, c.expectedStatus, c.source]), [['TC-1', '200', 'sheet']], 'no agent suggestions without a usable probe');
    assert.deepEqual(fromSheet.plan.needsReview?.map((n) => [n.caseId, n.code]), [['TC-2', 'SPEC_UNCLEAR']]);
  }
});

// ---------- the gate ----------

const SPEC = (status: number, extra = '') => `import { test, expect } from '../tests/fixtures/ctx';

function recordStatus(status: number) {
  test.info().annotations.push({ type: 'actual-status', description: String(status) });
}

test.describe('get-product', () => {
  test('[TC-1] [happy] a case', async ({ ctx }) => {
    const response = await ctx.api.get('/products/42');
    recordStatus(response.status());
    expect(response.status()).toBe(${status});${extra}
  });
});
`;
const BODY = `\n    const body = (await response.json()) as Record<string, unknown>;\n    expect(typeof body.id).toBe('number');`;
const gate = { name: 'get-product', planTypes: ['happy'], probeStatus: 200, requiredTitles: ['[TC-1] [happy] a case'] };

await check("gate: a sheet status replaces the probe status for that test; the probe's is then rejected", () => {
  assert.equal(validateSpec(SPEC(201), { ...gate, expectedStatuses: { '[TC-1] [happy] a case': 201 }, bodyOptional: ['[TC-1] [happy] a case'] }).ok, true);
  const wrong = validateSpec(SPEC(200), { ...gate, expectedStatuses: { '[TC-1] [happy] a case': 201 }, bodyOptional: ['[TC-1] [happy] a case'] });
  assert.ok(!wrong.ok && wrong.reasons.some((r) => /toBe\(201\), the sheet's expected status/.test(r)), wrong.reasons.join(' | '));
  // Without bodyOptional the body rule still applies.
  assert.ok(!validateSpec(SPEC(201), { ...gate, expectedStatuses: { '[TC-1] [happy] a case': 201 } }).ok);
  assert.equal(validateSpec(SPEC(201, BODY), { ...gate, expectedStatuses: { '[TC-1] [happy] a case': 201 } }).ok, true);
});

await check('gate: a documented 5xx allows exactly that toBe for that test; every other 5xx form is still rejected', () => {
  const ok = { ...gate, accepted5xx: { '[TC-1] [happy] a case': 503 }, bodyOptional: ['[TC-1] [happy] a case'] };
  assert.equal(validateSpec(SPEC(503), ok).ok, true, validateSpec(SPEC(503), ok).reasons.join(' | '));
  assert.ok(!validateSpec(SPEC(500), ok).ok, 'another 5xx');
  assert.ok(!validateSpec(SPEC(503, '\n    expect(response.status()).toBeGreaterThanOrEqual(500);'), ok).ok, 'a range');
  assert.ok(!validateSpec(SPEC(503), { ...gate, bodyOptional: ['[TC-1] [happy] a case'] }).ok, 'not documented');
});

await check('sheetStatusGate: only cases whose status is not the probe\'s, and documented 5xx, get their own rule', () => {
  const plan = { endpointId: 'get-product', cases: [
    { ...rawPlan().cases[0], title: 'a', expectedStatus: '200' },
    { ...rawPlan().cases[0], title: 'b', expectedStatus: '201' },
    { ...rawPlan().cases[0], title: 'c', expectedStatus: '503', accepted5xx: true },
    { ...rawPlan().cases[0], title: 'd', type: 'invalid-input', expectedStatus: '4xx' },
  ] } as Plan;
  assert.deepEqual(sheetStatusGate(plan, probe(200)), { expectedStatuses: { b: 201 }, accepted5xx: { c: 503 }, bodyOptional: ['b', 'c'] });
  assert.deepEqual(sheetStatusGate(plan, probe(404)).expectedStatuses, { a: 200, b: 201 }, 'no usable probe: every exact status is the sheet\'s');
});

// ---------- sheet columns and matching ----------

await check('sheet: a Documented 5xx column ("yes" or a reference) or the @documented-5xx tag; "no" is ignored', async () => {
  const csv = 'ID,Title,Steps,Expected,Documented 5xx\nTC-1,Busy,GET /a,503,yes - spec 4.2\nTC-2,Busy,GET /a,503,no\nTC-3,Busy @documented-5xx,GET /a,503,\n';
  const s = await parseSheet(Buffer.from(csv), 'x.csv');
  assert.deepEqual(s.cases.map((c) => c.documented5xx), ['yes - spec 4.2', undefined, 'tag @documented-5xx']);
  assert.equal(s.columns.documented5xx, 'Documented 5xx');
});

await check('matching: the case keeps the values its own request puts in the path', () => {
  assert.deepEqual(pathValuesFor('/products/42', '/products/{id}'), { id: '42' });
  assert.deepEqual(pathValuesFor('https://x.test/asset/globex/badge?x=1', '/asset/{brand}/badge'), { brand: 'globex' });
  assert.equal(pathValuesFor('/products/{id}', '/products/{id}'), undefined);
  const refs = [{ id: 'get-product', method: 'GET', path: '/products/{id}' }];
  assert.deepEqual(matchExplicit(sheetCase('TC-1', { endpoint: '' }), refs).pathValues, { id: '42' });
  assert.deepEqual(matchExplicit(sheetCase('TC-1', { endpoint: 'GET /products/7' }), refs).pathValues, { id: '7' });
});

// ---------- per-case probes ----------

await check('case probes: GET only, never a case that needs setup, at most the cap', () => {
  const get = ep();
  const reqs = [
    { caseId: 'TC-1', endpoint: get, pathValues: { id: '1' } },
    { caseId: 'TC-2', endpoint: ep({ id: 'del', method: 'DELETE' }), pathValues: { id: '2' } },
    { caseId: 'TC-3', endpoint: ep({ id: 'rev', path: '/products/{id}/reviews/{reviewId}' }), pathValues: { id: '3' } },
    { caseId: 'TC-4', endpoint: get, pathValues: { id: '4' } },
    { caseId: 'TC-5', endpoint: get, pathValues: { id: '5' } },
  ];
  const { send, notProbed } = caseProbePlan(reqs, 2);
  assert.deepEqual(send.map((r) => r.caseId), ['TC-1', 'TC-4']);
  assert.deepEqual(notProbed.map((n) => [n.caseId, /never probed|setup step|cap of 2/.exec(n.reason)?.[0]]), [['TC-2', 'never probed'], ['TC-3', 'setup step'], ['TC-5', 'cap of 2']]);
  assert.deepEqual(caseProbePlan(reqs, 0).send, []);
  // A fixed route value fills the other placeholder, so no setup is needed.
  assert.equal(caseProbePlan([{ caseId: 'TC-6', endpoint: ep({ path: '/s/{stack}/p/{id}', pathParams: { stack: '1234' } }), pathValues: { id: '1' } }], 5).send.length, 1);
});

await check('flags: --case-probes N (0 turns them off), default 20', () => {
  assert.equal(parseAgentFlags(['input/x.json']).caseProbes, 20);
  assert.equal(parseAgentFlags(['input/x.json', '--case-probes', '0']).caseProbes, 0);
  assert.throws(() => parseAgentFlags(['input/x.json', '--case-probes', '-1']));
});

// ---------- routes ----------

await check('routes: value segments and one differing middle word become placeholders; the last segment never merges', () => {
  const warnings: string[] = [];
  const out = groupRoutes(
    [
      { method: 'GET', pathname: '/catalog-api/1234/asset/acme/badge' },
      { method: 'GET', pathname: '/catalog-api/1234/asset/globex/badge' },
      { method: 'GET', pathname: '/products/42' },
      { method: 'POST', pathname: '/products/import' },
      { method: 'POST', pathname: '/products/export' },
      { method: 'GET', pathname: '/products' },
    ],
    warnings,
  );
  assert.deepEqual(out.map((r) => `${r.method} ${r.pathname} ${JSON.stringify(r.pathParams ?? null)}`), [
    'GET /catalog-api/{catalogApiId}/asset/{asset}/badge {"catalogApiId":"1234","asset":"acme"}',
    'GET /products/{productId} {"productId":"42"}',
    'POST /products/import null',
    'POST /products/export null',
    'GET /products null',
  ]);
  assert.ok(warnings.some((w) => /Grouped 2 requests into one route GET \/catalog-api\/\{catalogApiId\}\/asset\/\{asset\}\/badge/.test(w)));
});

await check('routes: the importer writes pathParams (no setup for a recorded value); groupRoutes: false keeps literal paths', () => {
  const reqs = [
    { item: 'a', method: 'GET', url: 'https://api.test/brands/acme/badge' },
    { item: 'b', method: 'GET', url: 'https://api.test/brands/globex/badge' },
    { item: 'c', method: 'POST', url: 'https://api.test/brands', body: { kind: 'json' as const, text: '{"name":"x"}' } },
  ];
  const grouped = buildInput(reqs as never).input.endpoints;
  const route = grouped.find((e) => e.path === '/brands/{brand}/badge')!;
  assert.deepEqual(route.pathParams, { brand: 'acme' });
  assert.equal(route.setup, undefined, 'a recorded value needs no created resource');
  const literal = buildInput(reqs as never, { groupRoutes: false }).input.endpoints;
  assert.deepEqual(literal.filter((e) => e.method === 'GET').map((e) => e.path), ['/brands/acme/badge', '/brands/globex/badge']);
});

await check('config: pathParams must name placeholders; runSetup fills them when no setup step does', async () => {
  const base = { baseUrl: 'http://localhost:4000', endpoints: [ep({ pathParams: { id: '42' } })] } as unknown as Config;
  assert.deepEqual(configProblems(base), []);
  const bad = { ...base, endpoints: [ep({ pathParams: { nope: '1' } })] } as unknown as Config;
  assert.match(configProblems(bad)[0], /pathParams\.nope" is not a placeholder of \/products\/\{id\}/);
  assert.deepEqual(await runSetup(base, null as never, ep({ pathParams: { id: '42' } })), { id: '42' });
  assert.deepEqual(await runSetup(base, null as never, ep({ pathParams: { id: '42' } }), { id: '7' }), { id: '7' }, 'a known value wins');
});

// ---------- traceability ----------

await check('traceability: a passing documented 5xx is "accepted 5xx"; a failing case shows the probe warning', () => {
  const pc = (caseId: string, over: Record<string, unknown> = {}) => ({ caseId, source: 'sheet' as const, title: `[${caseId}] [happy] x`, expectedStatus: '200', ...over });
  const rows = buildTraceRows({
    cases: [{ id: 'TC-1', title: 'x', expected: 'Status 503', documented5xx: 'yes' }, { id: 'TC-2', title: 'x', expected: 'Status 201' }],
    matches: new Map(['TC-1', 'TC-2'].map((id) => [id, { endpointId: 'get-product', by: 'column', reason: '' }])),
    endpoints: [{ endpointId: 'get-product', specFile: 'get-product.spec.ts', failureReason: null, skippedReason: null, plan: { cases: [pc('TC-1', { expectedStatus: '503', accepted5xx: true }), pc('TC-2', { expectedStatus: '201', probeNote: 'the sheet expects 201; the API answered 200 when probed' })] } }],
    outcomes: [
      { endpointId: 'get-product', title: '[TC-1] [happy] x', passed: true, actualStatus: 503, error: '' },
      { endpointId: 'get-product', title: '[TC-2] [happy] x', passed: false, actualStatus: 200, error: 'expected 201' },
    ],
    findings: [],
    ran: true,
  });
  assert.equal(rows[0].status, 'accepted 5xx');
  assert.match(rows[0].reason, /documented 5xx: the API answered 503 as the sheet documents \(yes\)/);
  assert.equal(rows[1].status, 'failed');
  assert.match(rows[1].reason, /probe warning before the run: the sheet expects 201/);
  assert.equal(traceTotals(rows).accepted5xx, 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
