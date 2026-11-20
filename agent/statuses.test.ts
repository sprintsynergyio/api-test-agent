import assert from 'node:assert/strict';
import type { Endpoint } from './config';
import { runExitCode } from './exit-codes';
import { parseAgentFlags } from './flags';
import { pactumAdapter, pactumOutcomes, type MochaJson, type StatusEntry } from './frameworks/pactum';
import { outcomesFromReport, playwrightAdapter, type PlaywrightJson } from './frameworks/playwright';
import { addCaseMarkers, needsReviewBlock } from './generate';
import { finalizeSheetPlan, type Plan } from './plan';
import type { ProbeResult } from './probe';
import { manualCodeOf, parseSheet, prepareSheetCases, type SheetCase } from './test-cases';
import { fillPlaceholders, jiraKeyIn, parseTestData, placeholdersIn, reasonCodeOf, requiredDataNames, requiredDataVerdict } from './test-data';
import { buildTraceRows, traceCsv, traceTotals } from './traceability';
import { validateSpec } from './validate';

// npm run test:statuses: statuses beyond passed / failed (skipped, manual, blocked, known issue,
// unexpected pass) with their reason codes, the Known issue / Required data / Automation sheet columns,
// the per-environment test data file, the markers the agent adds (never the model), the gate rejecting
// them in model code, results parsing for both frameworks, traceability and --fail-on skipped.
// Offline, no model, no API.

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

const sheetCase = (id: string, over: Partial<SheetCase> = {}): SheetCase => ({ id, row: 2, title: 'a case', steps: 'Send GET /photos', expected: 'Status 200', endpoint: 'list-photos', method: 'GET', priority: '', preconditions: '', testData: '', ...over });
const ep = (e: Partial<Endpoint> = {}): Endpoint => ({ id: 'list-photos', method: 'GET', path: '/photos', requiresAuth: false, ...e }) as Endpoint;
const probe = (status: number): ProbeResult => ({ endpointId: 'list-photos', status, contentType: 'application/json', body: { data: [] }, durationMs: 1, usable: true }) as ProbeResult;

// ---------- test data file ----------

await check('test data file: values, lookup and environment are read; bad shapes are refused with the reason', () => {
  const d = parseTestData({ environment: 'dev', values: { OTHER_BRAND: 'globex', LIMIT: 5 }, lookup: { endpointId: 'list-badges', query: { page_size: 100 } } });
  assert.deepEqual(d, { environment: 'dev', values: { OTHER_BRAND: 'globex', LIMIT: '5' }, lookup: { endpointId: 'list-badges', query: { page_size: 100 } } });
  assert.deepEqual(parseTestData({}), { values: {} });
  assert.throws(() => parseTestData([]), /must be a JSON object/);
  assert.throws(() => parseTestData({ value: {} }), /unknown key\(s\) value/);
  assert.throws(() => parseTestData({ values: { brand: 'x' } }), /must be UPPER_CASE/);
  assert.throws(() => parseTestData({ values: { BRAND: { a: 1 } } }), /must be a string, number or boolean/);
  assert.throws(() => parseTestData({ lookup: { query: {} } }), /needs "endpointId"/);
});

await check('placeholders: [UPPER_CASE] names (3+ characters) are filled; [], [0], [id], [OK] are left alone', () => {
  assert.deepEqual(placeholdersIn('GET /badges?brand=[OTHER_BRAND]&x=[0]&y=[id]&z=[OK]&w=[]'), ['OTHER_BRAND']);
  assert.deepEqual(fillPlaceholders('brand [OTHER_BRAND] and [MISSING_ONE]', { OTHER_BRAND: 'globex' }), { text: 'brand globex and [MISSING_ONE]', missing: ['MISSING_ONE'] });
  assert.deepEqual(requiredDataNames('Test_A.png; kk-coming-soon.png\nb.png, Test_A.png'), ['Test_A.png', 'kk-coming-soon.png', 'b.png']);
});

await check('required data verdict: DATA_NOT_ON_ENV lists what is missing; ENV_UNAVAILABLE when the lookup fails; null when all there', () => {
  assert.equal(requiredDataVerdict(['a.png'], 'list', 'dev', { status: 200, text: '[{"file":"a.png"}]' }), null);
  assert.equal(requiredDataVerdict(['a.png', 'b.png', 'c.png'], 'list', 'dev', { status: 200, text: 'a.png' }), 'DATA_NOT_ON_ENV: not on this environment (dev) (looked up with list): b.png, c.png');
  assert.match(requiredDataVerdict(['a'], 'list', undefined, { status: 503, text: '' })!, /^ENV_UNAVAILABLE: the data lookup list answered 503/);
  assert.match(requiredDataVerdict(['a'], 'list', undefined, { status: 401, text: '' })!, /^ENV_UNAVAILABLE/);
  assert.match(requiredDataVerdict(['a'], 'list', undefined, { status: 404, text: '' })!, /^ENV_UNAVAILABLE: .*check "lookup"/);
  assert.match(requiredDataVerdict(['a'], 'list', 'dev', { status: null, text: '', error: 'ECONNREFUSED' })!, /^ENV_UNAVAILABLE: the data lookup list failed \(dev\): ECONNREFUSED/);
  assert.equal(reasonCodeOf('DATA_NOT_ON_ENV: x'), 'DATA_NOT_ON_ENV');
  assert.equal(reasonCodeOf('skipped: read-only mode'), null);
  assert.equal(jiraKeyIn('see https://acme.atlassian.net/browse/QA-123 please'), 'QA-123');
  assert.equal(jiraKeyIn('the brand bug'), null);
});

// ---------- sheet columns ----------

await check('sheet: Known issue, Required data and Automation columns; a Known issue without a Jira key is ignored with a warning', async () => {
  const s = await parseSheet('ID,Title,Steps,Expected Result,Known issue,Required data,Automation\nTC-1,One,GET /a,200,QA-7: 500 for unknown brands,a.png; b.png,\nTC-2,Two,GET /a,200,the brand bug,,Manual - visual check\nTC-3,Three,GET /a,200,,,\n', 's.csv');
  assert.equal(s.columns.knownIssue, 'Known issue');
  assert.equal(s.columns.requiredData, 'Required data');
  assert.equal(s.columns.automation, 'Automation');
  assert.equal(s.cases[0].knownIssue, 'QA-7: 500 for unknown brands');
  assert.equal(s.cases[0].requiredData, 'a.png; b.png');
  assert.equal(s.cases[1].knownIssue, undefined);
  assert.equal(s.cases[1].automation, 'Manual - visual check');
  assert.ok(s.warnings.some((w) => w.caseId === 'TC-2' && /has no Jira key/.test(w.message)));
  // Empty cells add nothing, so older sheets keep the same case objects (and hashes).
  assert.deepEqual(Object.keys(s.cases[2]).sort(), ['endpoint', 'expected', 'id', 'method', 'preconditions', 'priority', 'row', 'steps', 'testData', 'title']);
});

await check('sheet: "Bug" and "Defect" columns are the known issue; IDs skipped / manual are reserved', async () => {
  const s = await parseSheet('ID,Title,Steps,Expected Result,Defect\nmanual,One,GET /a,200,QA-1\n', 's.csv');
  assert.equal(s.columns.knownIssue, 'Defect');
  assert.equal(s.cases[0].id, 'ROW-2');
});

await check('manual cells: Manual, Not automatable, No are manual; visual words make it MANUAL_VISUAL; Automated is not', () => {
  assert.equal(manualCodeOf('Manual'), 'MANUAL');
  assert.equal(manualCodeOf('Not automatable'), 'MANUAL');
  assert.equal(manualCodeOf('No'), 'MANUAL');
  assert.equal(manualCodeOf('Manual - visual check'), 'MANUAL_VISUAL');
  assert.equal(manualCodeOf('manually compare the screenshot'), 'MANUAL_VISUAL');
  assert.equal(manualCodeOf('Automated'), null);
  assert.equal(manualCodeOf(''), null);
});

await check('prepareSheetCases: fills placeholders from the test data; a missing value is MISSING_TEST_DATA; manual wins; Required data without a lookup is noted', () => {
  const { cases, notes } = prepareSheetCases(
    [
      sheetCase('TC-1', { steps: 'GET /badges?brand=[OTHER_BRAND]', expected: 'Status 200; brand is [OTHER_BRAND]' }),
      sheetCase('TC-2', { steps: 'GET /badges?brand=[THIRD_BRAND]' }),
      sheetCase('TC-3', { steps: 'GET /badges?brand=[THIRD_BRAND]', automation: 'Manual' }),
      sheetCase('TC-4', { requiredData: 'a.png' }),
    ],
    { environment: 'dev', values: { OTHER_BRAND: 'globex' } },
  );
  assert.equal(cases[0].steps, 'GET /badges?brand=globex');
  assert.equal(cases[0].expected, 'Status 200; brand is globex');
  assert.equal(cases[0].declaredSkip, undefined);
  assert.equal(cases[1].declaredSkip?.code, 'MISSING_TEST_DATA');
  assert.match(cases[1].declaredSkip!.reason, /^MISSING_TEST_DATA: needs \[THIRD_BRAND\]; add it to "values" in the test data file for dev/);
  assert.equal(cases[2].declaredSkip?.code, 'MANUAL');
  assert.ok(notes.some((n) => /TC-2: no test data for \[THIRD_BRAND\]/.test(n)));
  assert.ok(notes.some((n) => /TC-4: Required data "a.png" is not checked: the test data file has no "lookup"/.test(n)));
  // Without a test data file every placeholder is missing.
  assert.equal(prepareSheetCases([sheetCase('TC-5', { steps: '[OTHER_BRAND]' })], null).cases[0].declaredSkip?.code, 'MISSING_TEST_DATA');
});

// ---------- plan ----------

const rawPlan = (over: Partial<Plan['cases'][number]> = {}, needsReview: Plan['needsReview'] = undefined): Plan =>
  ({ endpointId: 'list-photos', cases: [{ caseId: 'TC-1', id: 'tc-1', type: 'happy', title: 't', requestDescription: 'GET', expectedStatus: '200', assertions: ['status is 200'], ...over }], ...(needsReview ? { needsReview } : {}) }) as Plan;

await check('plan: a Known issue and Required data come from the sheet onto the planned case', () => {
  const out = finalizeSheetPlan(rawPlan(), ep(), probe(200), [], [sheetCase('TC-1', { knownIssue: 'QA-7: wrong total', requiredData: 'a.png; b.png' })], 'sheet-only');
  assert.equal(out.plan.cases[0].knownIssue, 'KNOWN_ISSUE QA-7: wrong total');
  assert.deepEqual(out.plan.cases[0].requiredData, ['a.png', 'b.png']);
});

await check('plan: a known issue whose probe shows the bug keeps the sheet status; the sheet decides the status for every case; a 5xx is still refused', () => {
  const sheet = [sheetCase('TC-1', { expected: 'Status 200 with the badges', knownIssue: 'QA-8: 500 for this brand' })];
  const out = finalizeSheetPlan(rawPlan(), ep(), probe(500), [], sheet, 'sheet-only');
  assert.equal(out.plan.needsReview, undefined);
  assert.equal(out.plan.cases[0].expectedStatus, '200');
  // PR 3: the sheet decides the status, so a plain case is planned too, with a probe note.
  const plain = finalizeSheetPlan(rawPlan(), ep(), probe(500), [], [sheetCase('TC-1', { expected: 'Status 200 with the badges' })], 'sheet-only');
  assert.equal(plain.plan.needsReview, undefined);
  assert.equal(plain.plan.cases[0].expectedStatus, '200');
  assert.match(plain.plan.cases[0].probeNote ?? '', /the API answered 500 when probed/);
  const fivexx = finalizeSheetPlan(rawPlan(), ep(), probe(500), [], [sheetCase('TC-1', { expected: 'Status 500', knownIssue: 'QA-9' })], 'sheet-only');
  assert.equal(fivexx.plan.needsReview?.length, 1);
});

await check('plan: the model may give a needsReview code (MANUAL_VISUAL, MISSING_TEST_DATA, SPEC_UNCLEAR), never MANUAL; titles carry [manual] / [skipped]', () => {
  const sheet = [sheetCase('TC-1'), sheetCase('TC-2'), sheetCase('TC-3')];
  const raw = { endpointId: 'list-photos', cases: [], needsReview: [{ caseId: 'TC-1', reason: 'only a person can see it', code: 'MANUAL_VISUAL' }, { caseId: 'TC-2', reason: 'needs a brand', code: 'MISSING_TEST_DATA' }, { caseId: 'TC-3', reason: 'vague', code: 'MANUAL' }] } as unknown as Plan;
  const out = finalizeSheetPlan(raw, ep(), probe(200), [], sheet, 'sheet-only');
  const nr = out.plan.needsReview!;
  assert.equal(nr[0].code, 'MANUAL_VISUAL');
  assert.match(nr[0].title!, /^\[TC-1\] \[manual\] /);
  assert.equal(nr[1].code, 'MISSING_TEST_DATA');
  assert.match(nr[1].title!, /^\[TC-2\] \[skipped\] /);
  assert.equal(nr[2].code, undefined);
  assert.match(nr[2].title!, /^\[TC-3\] \[needs-review\] /);
});

// ---------- placeholders and markers written by the agent ----------

await check('placeholders: coded cases go in a "skipped" block with the reason code; plain needs review keeps its block', () => {
  const items = [
    { caseId: 'TC-1', title: '[TC-1] [needs-review] a', reason: 'vague' },
    { caseId: 'TC-2', title: '[TC-2] [skipped] b', reason: 'MISSING_TEST_DATA: needs [X]', code: 'MISSING_TEST_DATA' as const },
    { caseId: 'TC-3', title: '[TC-3] [manual] c', reason: 'looks', code: 'MANUAL_VISUAL' as const },
  ];
  const pw = needsReviewBlock(playwrightAdapter, items);
  assert.match(pw, /test\.describe\('needs review'[\s\S]*type: 'needs-review'/);
  assert.match(pw, /test\.describe\('skipped'[\s\S]*test\.fixme\("\[TC-2\] \[skipped\] b", \{ annotation: \{ type: 'skip-reason', description: "MISSING_TEST_DATA: needs \[X\]" \} \}/);
  assert.match(pw, /description: "MANUAL_VISUAL: looks"/);
  const pa = needsReviewBlock(pactumAdapter, items);
  assert.match(pa, /describe\('skipped'[\s\S]*\/\/ skipped: MANUAL_VISUAL: looks\n  it\("\[TC-3\] \[manual\] c"\);/);
});

const PW_SPEC = `import { test, expect } from '../tests/fixtures/ctx';

test.describe('list-photos GET /photos', () => {
  test('[TC-1] [happy] one', async ({ ctx }) => {
    const response = await ctx.api.get('/photos');
    test.info().annotations.push({ type: 'actual-status', description: String(response.status()) });
    expect(response.status()).toBe(200);
  });

  test('[TC-2] [happy] two', async ({ ctx }) => {
    const response = await ctx.api.get('/photos');
    expect(response.status()).toBe(200);
  });
});
`;
const markedPlan = (fw: 'pw' | 'pa'): Plan =>
  ({
    endpointId: 'list-photos',
    cases: [
      { caseId: 'TC-1', id: 'a', type: 'happy', title: '[TC-1] [happy] one', requestDescription: '', expectedStatus: '200', assertions: [], knownIssue: 'KNOWN_ISSUE QA-7: wrong total', requiredData: fw === 'pw' ? ['a.png'] : ['a.png', 'b.png'] },
      { caseId: 'TC-2', id: 'b', type: 'happy', title: '[TC-2] [happy] two', requestDescription: '', expectedStatus: '200', assertions: [] },
    ],
  }) as Plan;

await check('markers (Playwright): ctx.requireData then test.fail as the first lines of the marked test only', () => {
  const { code, failed: bad } = addCaseMarkers(playwrightAdapter, PW_SPEC, markedPlan('pw'));
  assert.deepEqual(bad, []);
  assert.match(code, /test\('\[TC-1\] \[happy\] one', async \(\{ ctx \}\) => \{\n    await ctx\.requireData\(\["a\.png"\]\);\n    test\.fail\(true, "KNOWN_ISSUE QA-7: wrong total"\);\n    const response/);
  assert.equal(code.match(/test\.fail/g)?.length, 1);
  // The marked file is still the model's file plus the agent's lines.
  assert.equal(code.replace(/\n    await ctx\.requireData\(\["a\.png"\]\);\n    test\.fail\(true, "KNOWN_ISSUE QA-7: wrong total"\);/, ''), PW_SPEC);
});

await check('markers (Playwright): a test that does not take { ctx } cannot be marked and is reported', () => {
  const odd = PW_SPEC.replace("test('[TC-1] [happy] one', async ({ ctx }) => {", "test('[TC-1] [happy] one', async function () {");
  const { failed: bad } = addCaseMarkers(playwrightAdapter, odd, markedPlan('pw'));
  assert.equal(bad.length, 1);
  assert.match(bad[0].reason, /does not take \{ ctx \}/);
});

const PA_SPEC = `import { ctx, expect, recordStatus } from '../tests-pactum/setup/ctx';

describe('list-photos GET /photos', () => {
  it('[TC-1] [happy] one', async () => {
    const response = await ctx.api.get('/photos');
    recordStatus(response.status());
    expect(response.status()).toBe(200);
  });

  it('[TC-2] [happy] two', async () => {
    const response = await ctx.api.get('/photos');
    recordStatus(response.status());
    expect(response.status()).toBe(200);
  });
});
`;

await check('markers (Pactum): requireDataFor before the it, knownIssue wraps its function, imports added', () => {
  const { code, failed: bad } = addCaseMarkers(pactumAdapter, PA_SPEC, markedPlan('pa'));
  assert.deepEqual(bad, []);
  assert.match(code, /^import \{ ctx, expect, recordStatus, knownIssue, requireDataFor \} from '\.\.\/tests-pactum\/setup\/ctx';/);
  assert.match(code, /\n  requireDataFor\("\[TC-1\] \[happy\] one", \["a\.png","b\.png"\]\);\n  it\('\[TC-1\] \[happy\] one', knownIssue\("KNOWN_ISSUE QA-7: wrong total", async \(\) => \{/);
  assert.match(code, /expect\(response\.status\(\)\)\.toBe\(200\);\n  \}\)\);\n\n  it\('\[TC-2\]/);
  assert.equal(code.match(/knownIssue\(/g)?.length, 1);
});

await check('markers: nothing to mark leaves the file untouched', () => {
  const plain = { ...markedPlan('pw'), cases: markedPlan('pw').cases.map((c) => ({ ...c, knownIssue: undefined, requiredData: undefined })) } as Plan;
  assert.equal(addCaseMarkers(playwrightAdapter, PW_SPEC, plain).code, PW_SPEC);
});

// ---------- the gate: markers only from the agent ----------

const gateOpts = { name: 'list-photos', planTypes: ['happy'], probeStatus: 200, probeHasBody: false };
await check('gate (Playwright): model code may not use test.fixme, test.fail, test.info().skip or ctx.requireData', () => {
  const base = `import { test, expect } from '../tests/fixtures/ctx';\n\ntest('[happy] one', async ({ ctx }) => {\n  const response = await ctx.api.get('/photos');\n  test.info().annotations.push({ type: 'actual-status', description: String(response.status()) });\n  expect(response.status()).toBe(200);\nINSERT\n});\n`;
  const reasons = (line: string) => {
    const r = validateSpec(base.replace('INSERT', line), gateOpts);
    return r.ok ? [] : r.reasons;
  };
  assert.deepEqual(reasons(''), []);
  assert.ok(reasons("  test.fail(true, 'x');").some((r) => /contains test\.fail/.test(r)));
  assert.ok(reasons("  test.fixme(true, 'x');").some((r) => /contains test\.fixme/.test(r)));
  assert.ok(reasons("  test.info().skip(true, 'x');").some((r) => /through test\.info\(\)/.test(r)));
  assert.ok(reasons("  await ctx.requireData(['a']);").some((r) => /calls ctx\.requireData/.test(r)));
});

await check('gate (Pactum): model code may not call knownIssue or requireDataFor', () => {
  const ok = pactumAdapter.validate(PA_SPEC, { name: 'list-photos', planTypes: ['happy', 'happy'], probeStatus: 200, probeHasBody: false });
  assert.ok(ok.ok, JSON.stringify(ok));
  const marked = addCaseMarkers(pactumAdapter, PA_SPEC, markedPlan('pa')).code;
  const r = pactumAdapter.validate(marked, { name: 'list-photos', planTypes: ['happy', 'happy'], probeStatus: 200, probeHasBody: false });
  assert.ok(!r.ok);
  const all = r.ok ? [] : r.reasons;
  assert.ok(all.some((x) => /calls knownIssue/.test(x)));
  assert.ok(all.some((x) => /calls requireDataFor/.test(x)));
});

// ---------- results parsing ----------

const clean = (t: string) => t;
await check('Playwright results: precondition skip is blocked, test.fail that failed is a known issue, one that passed is an unexpected pass; read-only and placeholders stay out', () => {
  const t = (title: string, status: string, resultStatus: string, annotations: { type: string; description?: string }[] = [], error = '') => ({ title, file: 'list-photos.spec.ts', tests: [{ status, annotations, results: [{ status: resultStatus, annotations: [], errors: error ? [{ message: error }] : [] }] }] });
  const report: PlaywrightJson = {
    suites: [
      {
        specs: [
          t('[TC-1] [happy] blocked', 'skipped', 'skipped', [{ type: 'skip', description: 'DATA_NOT_ON_ENV: not on this environment (dev) (looked up with list): a.png' }]),
          t('[TC-2] [happy] known', 'expected', 'failed', [{ type: 'fail', description: 'KNOWN_ISSUE QA-7: wrong total' }, { type: 'actual-status', description: '500' }], 'expect(received).toBe(expected)'),
          t('[TC-3] [happy] fixed', 'unexpected', 'passed', [{ type: 'fail', description: 'KNOWN_ISSUE QA-8: x' }, { type: 'actual-status', description: '200' }]),
          t('[TC-4] [happy] read-only', 'skipped', 'skipped', [{ type: 'skip', description: 'skipped: read-only mode' }]),
          t('[TC-5] [skipped] declared', 'skipped', 'skipped', [{ type: 'skip-reason', description: 'MISSING_TEST_DATA: needs [X]' }]),
          t('[TC-6] [happy] plain', 'expected', 'passed'),
        ],
      },
    ] as unknown as PlaywrightJson['suites'],
  };
  const { outcomes } = outcomesFromReport(report, clean);
  const by = Object.fromEntries(outcomes.map((o) => [o.title.slice(1, 5), o]));
  assert.deepEqual(Object.keys(by).sort(), ['TC-1', 'TC-2', 'TC-3', 'TC-6']);
  assert.equal(by['TC-1'].kind, 'blocked');
  assert.equal(by['TC-1'].reasonCode, 'DATA_NOT_ON_ENV');
  assert.equal(by['TC-1'].passed, false);
  assert.equal(by['TC-2'].kind, 'known-issue');
  assert.equal(by['TC-2'].passed, false);
  assert.equal(by['TC-2'].actualStatus, 500);
  assert.equal(by['TC-3'].kind, 'unexpected-pass');
  assert.equal(by['TC-3'].passed, false);
  assert.match(by['TC-3'].error, /^UNEXPECTED PASS: KNOWN_ISSUE QA-8: x; the test passed/);
  assert.equal(by['TC-6'].passed, true);
  assert.equal(by['TC-6'].kind, undefined);
});

await check('Pactum results: a precondition skip is blocked; a knownIssue Mocha passed is a known issue, one Mocha failed is an unexpected pass', () => {
  const T = (title: string, err?: string) => ({ title, fullTitle: `d ${title}`, file: '/x/generated/list-photos.spec.ts', ...(err ? { err: { message: err } } : {}) });
  const report: MochaJson = {
    tests: [T('[TC-1] blocked'), T('[TC-2] known'), T('[TC-3] fixed', 'UNEXPECTED PASS: KNOWN_ISSUE QA-8: x; the test passed'), T('[TC-4] read-only'), T('[TC-5] plain')],
    passes: [T('[TC-2] known'), T('[TC-5] plain')],
    pending: [T('[TC-1] blocked'), T('[TC-4] read-only')],
  };
  const st = (title: string, extra: Partial<StatusEntry>): StatusEntry => ({ file: 'list-photos.spec.ts', title, state: 'passed', actualStatus: null, requestsSent: 1, ...extra });
  const statuses = [st('[TC-1] blocked', { state: 'pending', skipReason: 'ENV_UNAVAILABLE: the data lookup list answered 503' }), st('[TC-2] known', { knownIssue: 'KNOWN_ISSUE QA-7: wrong total', knownIssueError: 'expected 200 to be 500', actualStatus: 500 }), st('[TC-3] fixed', { state: 'failed', knownIssue: 'KNOWN_ISSUE QA-8: x', actualStatus: 200 }), st('[TC-5] plain', {})];
  const { outcomes } = pactumOutcomes(report, statuses, clean);
  const by = Object.fromEntries(outcomes.map((o) => [o.title.slice(1, 5), o]));
  assert.deepEqual(Object.keys(by).sort(), ['TC-1', 'TC-2', 'TC-3', 'TC-5']);
  assert.equal(by['TC-1'].kind, 'blocked');
  assert.equal(by['TC-1'].reasonCode, 'ENV_UNAVAILABLE');
  assert.equal(by['TC-2'].kind, 'known-issue');
  assert.equal(by['TC-2'].error, 'expected 200 to be 500');
  assert.equal(by['TC-3'].kind, 'unexpected-pass');
  assert.equal(by['TC-5'].passed, true);
  for (const k of ['TC-1', 'TC-2', 'TC-3']) assert.equal(by[k].passed, false);
});

// ---------- traceability ----------

await check('traceability: skipped, manual, blocked, known issue and unexpected pass rows with reason codes; none counts as passed', () => {
  const pc = (id: string) => ({ title: `[${id}] [happy] t`, caseId: id, source: 'sheet' as const, expectedStatus: '200', clauses: [{ n: 1, text: 'Status 200', status: 'asserted' as const }] });
  const rows = buildTraceRows({
    cases: ['TC-1', 'TC-2', 'TC-3', 'TC-4', 'TC-5', 'TC-6', 'TC-7'].map((id) => ({ id, title: id, expected: 'Status 200' })),
    matches: new Map(['TC-1', 'TC-2', 'TC-3', 'TC-4', 'TC-5', 'TC-6', 'TC-7'].map((id) => [id, { endpointId: 'list-photos', by: 'column', reason: '' }])),
    endpoints: [
      {
        endpointId: 'list-photos',
        specFile: 'list-photos.spec.ts',
        failureReason: null,
        skippedReason: null,
        plan: {
          cases: [pc('TC-4'), pc('TC-5'), pc('TC-6'), pc('TC-7')],
          needsReview: [
            { caseId: 'TC-1', reason: 'MISSING_TEST_DATA: needs [X]', code: 'MISSING_TEST_DATA' },
            { caseId: 'TC-2', reason: 'MANUAL_VISUAL: looks', code: 'MANUAL_VISUAL' },
            { caseId: 'TC-3', reason: 'vague', code: 'SPEC_UNCLEAR' },
          ],
        },
      },
    ],
    outcomes: [
      { endpointId: 'list-photos', title: '[TC-4] [happy] t', passed: false, actualStatus: null, error: '', kind: 'blocked', reasonCode: 'DATA_NOT_ON_ENV', reason: 'DATA_NOT_ON_ENV: a.png' },
      { endpointId: 'list-photos', title: '[TC-5] [happy] t', passed: false, actualStatus: 500, error: 'expected 500 to be 200', kind: 'known-issue', reasonCode: 'KNOWN_ISSUE', reason: 'KNOWN_ISSUE QA-7: wrong' },
      { endpointId: 'list-photos', title: '[TC-6] [happy] t', passed: false, actualStatus: 200, error: 'UNEXPECTED PASS', kind: 'unexpected-pass', reasonCode: 'KNOWN_ISSUE', reason: 'KNOWN_ISSUE QA-8: x' },
      { endpointId: 'list-photos', title: '[TC-7] [happy] t', passed: true, actualStatus: 200, error: '' },
    ],
    findings: [],
    ran: true,
  });
  const st = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(st['TC-1'].status, 'skipped');
  assert.equal(st['TC-1'].reasonCode, 'MISSING_TEST_DATA');
  assert.equal(st['TC-1'].testFile, '');
  assert.equal(st['TC-2'].status, 'manual');
  assert.equal(st['TC-3'].status, 'needs review');
  assert.equal(st['TC-3'].reasonCode, 'SPEC_UNCLEAR');
  assert.equal(st['TC-4'].status, 'blocked');
  assert.equal(st['TC-4'].testFile, 'list-photos.spec.ts');
  assert.equal(st['TC-4'].asserted, 0);
  assert.equal(st['TC-5'].status, 'known issue');
  assert.match(st['TC-5'].reason, /^KNOWN_ISSUE QA-7: wrong; failed as expected \(got 500\): expected 500 to be 200$/);
  assert.equal(st['TC-6'].status, 'unexpected pass');
  assert.match(st['TC-6'].reason, /the bug may be fixed/);
  assert.equal(st['TC-7'].status, 'passed');
  const t = traceTotals(rows);
  assert.deepEqual([t.passed, t.skipped, t.manual, t.needsReview, t.blocked, t.knownIssues, t.unexpectedPasses, t.automated], [1, 1, 1, 1, 1, 1, 1, 4]);
  assert.ok(traceCsv(rows).startsWith('ID,Title,Endpoint,Test file,Status,Reason code,Coverage,Reason,Jira,Confluence\r\n'));
  assert.match(traceCsv(rows), /\r\nTC-4,TC-4,list-photos,list-photos\.spec\.ts,blocked,DATA_NOT_ON_ENV,,DATA_NOT_ON_ENV: a\.png,,\r\n/);
});

// ---------- CI policy ----------

await check('--fail-on skipped: exit 1 when anything did not run; finding (default) ignores skips; none exits 0', () => {
  const base = { status: 'completed', findings: 0, untestedEndpoints: 0, exportFailed: false };
  assert.equal(runExitCode({ ...base, failOn: 'finding', skipped: 3 }), 0);
  assert.equal(runExitCode({ ...base, failOn: 'skipped', skipped: 3 }), 1);
  assert.equal(runExitCode({ ...base, failOn: 'skipped', skipped: 0 }), 0);
  assert.equal(runExitCode({ ...base, failOn: 'skipped', findings: 1, skipped: 0 }), 1);
  assert.equal(runExitCode({ ...base, failOn: 'none', findings: 2, skipped: 3 }), 0);
  assert.equal(runExitCode({ ...base, status: 'no-tests', failOn: 'skipped', skipped: 0 }), 2);
  assert.equal(parseAgentFlags(['--fail-on', 'skipped']).failOn, 'skipped');
  assert.throws(() => parseAgentFlags(['--fail-on', 'skips']), /none, finding, skipped/);
  assert.equal(parseAgentFlags(['--test-data', 'input/test-data.dev.json']).testData, 'input/test-data.dev.json');
  assert.throws(() => parseAgentFlags(['--test-data', ' ']), /--test-data needs/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
