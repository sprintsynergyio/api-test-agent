import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseAgentFlags as parseFlags } from './flags';
import { reportLabels } from './http';
import { matchCases } from './match-cases';
import { parseTestTitle, testTypeOf } from './model';
import { finalizeSheetPlan, sheetStatusConflict, type Plan } from './plan';
import { casesFromRows, checkXlsxContainer, cleanTitle, loadSheetFile, mapColumns, matchExplicit, parseDelimited, parseSheet, previewSheet, SheetError, type SheetCase } from './test-cases';
import { buildTraceRows, csvSafe, traceCsv, traceTotals, traceXlsx, type TraceRow } from './traceability';
import { validateSpec } from './validate';
import type { Endpoint } from './config';
import type { ProbeResult } from './probe';

// npm run test:test-cases: the team test case sheet import (agent/test-cases.ts), endpoint matching,
// the sheet plan rules, the gate's sheet titles and the traceability back-map. Offline, no model.

let failed = 0;
let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`ok    ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}\n      ${String((err as Error)?.message ?? err).split('\n').join('\n      ')}`);
  }
}
async function rejects(p: Promise<unknown>, re: RegExp) {
  await assert.rejects(p, (err: unknown) => err instanceof SheetError && re.test((err as Error).message));
}

const ENDPOINTS = [
  { id: 'list-products', method: 'GET', path: '/products' },
  { id: 'create-product', method: 'POST', path: '/products' },
  { id: 'get-product', method: 'GET', path: '/products/{id}' },
  { id: 'update-product', method: 'PUT', path: '/products/{id}' },
  { id: 'delete-product', method: 'DELETE', path: '/products/{id}' },
];

// ---------- Parsing ----------

await check('CSV: quoted fields with commas, quotes and line breaks', async () => {
  const s = await parseSheet('ID,Title,Steps,Expected Result\nTC-1,"List, all","GET /products\nthen check","200 ""ok"""\n', 'a.csv');
  assert.equal(s.format, 'csv');
  assert.equal(s.cases.length, 1);
  assert.equal(s.cases[0].title, 'List, all');
  assert.equal(s.cases[0].steps, 'GET /products\nthen check');
  assert.equal(s.cases[0].expected, '200 "ok"');
});

await check('TSV pasted from a spreadsheet, with a BOM and CRLF', async () => {
  const s = await parseSheet('\uFEFFTest Case ID\tSummary\tTest Steps\tExpected Outcome\r\nTC-9\tGet one\tGET /products/1\t200\r\n');
  assert.equal(s.format, 'tsv');
  assert.equal(s.cases[0].id, 'TC-9');
  assert.equal(s.cases[0].title, 'Get one');
  assert.equal(s.cases[0].expected, '200');
});

await check('semicolon CSV (European Excel) is detected', () => {
  const { rows, delimiter } = parseDelimited('ID;Title;Expected\nTC-1;A, b;200\n');
  assert.equal(delimiter, ';');
  assert.deepEqual(rows[1], ['TC-1', 'A, b', '200']);
});

await check('column aliases are case-insensitive and cover Jira, Xray and TestRail names', () => {
  const m = mapColumns(['ISSUE KEY', 'Summary', 'Custom field (Manual Test Steps)', 'Custom field (Expected Result)', 'HTTP Method', 'API Endpoint', 'Severity', 'Pre-conditions', 'Test Data', 'Assignee']);
  assert.deepEqual(m.index, { id: 0, title: 1, steps: 2, expected: 3, method: 4, endpoint: 5, priority: 6, preconditions: 7, testData: 8 });
  assert.deepEqual(m.ignored, ['Assignee']);
});

await check('bad rows: missing ID, duplicate ID, reserved ID, unsafe characters, no steps', () => {
  const s = casesFromRows(
    [
      ['ID', 'Title', 'Steps', 'Expected'],
      ['', 'No id', 'GET /products', '200'],
      ['TC-1', 'First', 'GET /products', '200'],
      ['TC-1', 'Again', 'GET /products', '200'],
      ['happy', 'Reserved', 'GET /products', '200'],
      ["TC-[2]'x", "It's a `test` \\ ${x}", 'GET /products', '200'],
      ['TC-3', 'Empty', '', ''],
      ['', '', '', ''],
    ],
    'csv',
  );
  assert.deepEqual(s.cases.map((c) => c.id), ['ROW-2', 'TC-1', 'TC-1-2', 'ROW-5', 'TC--2--x', 'TC-3']);
  assert.equal(s.cases[4].title, 'It\u2019s a \u2019test\u2019 / $ {x}');
  const msgs = s.warnings.map((w) => w.message).join('\n');
  for (const re of [/missing ID, using ROW-2/, /duplicate ID "TC-1"/, /reserved/, /changed to "TC--2--x"/, /no steps and no expected/]) assert.match(msgs, re);
});

await check('step-per-row exports: a row without ID and title continues the case above', () => {
  const s = casesFromRows([['Key', 'Summary', 'Step', 'Expected Result'], ['T-1', 'Create', 'POST /products', '201'], ['', '', 'then GET it', '200']], 'csv');
  assert.equal(s.cases.length, 1);
  assert.equal(s.cases[0].steps, 'POST /products\nthen GET it');
});

await check('refuses: no title or steps column, empty, a pasted link, .xls, a header only', async () => {
  await rejects(parseSheet('Foo,Bar\n1,2\n'), /no Title or Steps column/);
  await rejects(parseSheet(''), /empty/);
  await rejects(parseSheet('https://example.atlassian.net/browse/QA-1'), /a link was pasted where a sheet was expected.*Jira or Confluence link/);
  await rejects(parseSheet(Buffer.from('x'), 'old.xls'), /\.xls files are not supported/);
  await rejects(parseSheet('ID,Title\n'), /no test cases/);
});

await check('loadSheetFile reads only sheet files (never .env or a key file)', async () => {
  await rejects(loadSheetFile('.env'), /must be a \.csv/);
  await rejects(loadSheetFile('input/local-shop.json'), /must be a \.csv/);
  const s = await loadSheetFile('input/local-shop-test-cases.csv');
  assert.equal(s.cases.length, 11);
});

await check('row and cell caps', async () => {
  const many = ['ID,Title,Expected', ...Array.from({ length: 1001 }, (_, i) => `T-${i},t,200`)].join('\n');
  await rejects(parseSheet(many), /more than 1000 test cases/);
  const s = await parseSheet(`ID,Title,Steps\nT-1,t,${'x'.repeat(5000)}\n`);
  assert.equal(s.cases[0].steps.length, 4000);
  assert.ok(s.warnings.some((w) => /shortened/.test(w.message)));
});

await check('XLSX: stored values only, formulas never run, aliases, numbers and dates, no prototype pollution', async () => {
  const s = await parseSheet(readFileSync('test-fixtures/test-cases/sample.xlsx'), 'sample.xlsx');
  assert.equal(s.format, 'xlsx');
  assert.deepEqual(s.cases.map((c) => c.id), ['TC-101', '102', 'TC-103', 'TC-104']);
  assert.equal(s.cases[0].endpoint, 'GET /products');
  // "=1+1" has no stored value: the title falls back to the steps, nothing is evaluated.
  assert.equal(s.cases[2].title, 'GET /products/1');
  assert.equal(s.cases[3].steps, '');
  assert.equal(s.cases[3].priority, '2026-01-15');
  assert.ok(s.ignored.includes('__proto__'));
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(Object.getPrototypeOf(s.cases[0]), Object.prototype);
});

await check('XLSX: a file that is not a zip, and a zip bomb by its directory, are refused before unzipping', async () => {
  await rejects(parseSheet(Buffer.from('PK\u0003\u0004 not really a zip archive at all'), 'x.xlsx'), /damaged/);
  await rejects(parseSheet(Buffer.from('hello'), 'x.xlsx'), /not an \.xlsx file/);
  const xlsx = traceXlsx([]);
  const bomb = Buffer.from(xlsx);
  const cd = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bomb.writeUInt32LE(0xfffffff0, cd + 24);
  assert.throws(() => checkXlsxContainer(bomb), /expands to more than 60 MB/);
});

await check('cleanTitle keeps a title safe inside a TypeScript string', () => {
  assert.equal(cleanTitle('a\n"b"\t`c`'), 'a \u201db\u201d \u2019c\u2019');
});

// ---------- Matching ----------

const sc = (o: Partial<SheetCase>): SheetCase => ({ id: 'TC-1', row: 2, title: 't', steps: '', expected: '', endpoint: '', method: '', priority: '', preconditions: '', testData: '', ...o });

await check('matching: the Endpoint column (id, METHOD /path, URL, :id), then the steps', () => {
  assert.equal(matchExplicit(sc({ endpoint: 'get-product' }), ENDPOINTS).endpointId, 'get-product');
  assert.equal(matchExplicit(sc({ endpoint: 'DELETE /products/{productId}' }), ENDPOINTS).endpointId, 'delete-product');
  assert.equal(matchExplicit(sc({ endpoint: 'https://shop.example/products/:id', method: 'PUT' }), ENDPOINTS).endpointId, 'update-product');
  assert.equal(matchExplicit(sc({ endpoint: '/products' }), ENDPOINTS).endpointId, null, 'a path shared by two methods needs the Method column');
  assert.equal(matchExplicit(sc({ steps: 'Send GET /products/42 and check' }), ENDPOINTS).endpointId, 'get-product');
  assert.equal(matchExplicit(sc({ steps: 'POST /orders' }), ENDPOINTS).endpointId, null);
});

await check('matching: the AI fallback (fake model) matches by words and never drops a case', async () => {
  const prev = process.env.FAKE_MODEL;
  process.env.FAKE_MODEL = '1';
  try {
    const cases = [sc({ id: 'A', title: 'Update a product price', endpoint: 'Update product' }), sc({ id: 'B', title: 'Monthly sales report as PDF' }), sc({ id: 'C', endpoint: 'list-products' })];
    const { results } = await matchCases(cases, ENDPOINTS, { useModel: true });
    assert.equal(results.get('A')?.endpointId, 'update-product');
    assert.equal(results.get('A')?.by, 'ai');
    assert.equal(results.get('B')?.endpointId, null);
    assert.match(results.get('B')?.reason ?? '', /no matching endpoint/);
    assert.equal(results.get('C')?.by, 'column');
    const none = await matchCases(cases, ENDPOINTS, { useModel: false });
    assert.equal(none.results.get('A')?.endpointId, null);
  } finally {
    if (prev === undefined) delete process.env.FAKE_MODEL;
    else process.env.FAKE_MODEL = prev;
  }
});

await check('preview: row count, column mapping and per-row warnings', async () => {
  const p = previewSheet(await loadSheetFile('input/local-shop-test-cases.csv'), ENDPOINTS);
  assert.equal(p.count, 11);
  assert.equal(p.matched, 8);
  const row11 = p.rows.find((r) => r.id === 'ROW-11');
  assert.ok(row11 && row11.warnings.some((w) => /missing ID/.test(w)));
  assert.ok(p.rows.find((r) => r.id === 'TC-007')?.warnings.some((w) => /unknown endpoint/.test(w)));
});

// ---------- Plan rules ----------

const ENDPOINT = { id: 'get-product', method: 'GET', path: '/products/{id}', requiresAuth: true } as unknown as Endpoint;
const PROBE = { endpointId: 'get-product', method: 'GET', path: '/products/1', status: 200, usable: true } as unknown as ProbeResult;
const planCase = (o: Partial<Plan['cases'][number]>): Plan['cases'][number] => ({ id: 'x', type: 'happy', title: 'x', requestDescription: 'GET the product', expectedStatus: '200', assertions: ['status is 200'], ...o });

await check('sheet plan: titles carry the case ID and type, statuses follow the rules, contradictions need review', () => {
  const sheet = [
    sc({ id: 'TC-5', title: 'View one product', steps: 'GET /products/{id}', expected: '200 with fields' }),
    sc({ id: 'TC-6', title: 'Missing product', steps: 'GET /products/999', expected: '404' }),
    sc({ id: 'TC-7', title: 'Server error', steps: 'GET /products/x', expected: '500 Internal Server Error' }),
    sc({ id: 'TC-8', title: 'Happy but 201', steps: 'GET /products/1', expected: '201 Created' }),
    sc({ id: 'TC-9', title: 'Forgotten', steps: 'GET /products/1', expected: '200' }),
  ];
  const raw: Plan = {
    endpointId: 'get-product',
    cases: [
      planCase({ caseId: 'TC-5', expectedStatus: '201' }),
      planCase({ caseId: 'TC-6', type: 'invalid-input', expectedStatus: '404' }),
      planCase({ caseId: 'TC-7', type: 'invalid-input' }),
      planCase({ caseId: 'TC-8' }),
      planCase({ title: '[auth] get-product without a token', type: 'auth', requestDescription: 'no auth header', expectedStatus: '401|403' }),
      planCase({ title: 'response fields and types', type: 'schema', requestDescription: 'GET an existing product, check every field' }),
    ],
  };
  const { plan, errors } = finalizeSheetPlan(raw, ENDPOINT, PROBE, [], sheet, 'sheet-plus-agent');
  assert.deepEqual(errors, []);
  const titles = plan.cases.map((c) => c.title);
  assert.ok(titles.includes('[TC-5] [happy] View one product'));
  assert.equal(plan.cases.find((c) => c.caseId === 'TC-5')?.expectedStatus, '200', 'the probe status, never the model guess');
  assert.equal(plan.cases.find((c) => c.caseId === 'TC-6')?.expectedStatus, '4xx');
  assert.ok(titles.includes('[agent] [auth] get-product without a token'));
  const review = Object.fromEntries((plan.needsReview ?? []).map((n) => [n.caseId, n.reason]));
  assert.match(review['TC-7'], /never writes a test that expects a 5xx/);
  // The sheet decides the status: TC-8 is planned with 201 and an early warning, never dropped.
  assert.equal(review['TC-8'], undefined);
  assert.equal(plan.cases.find((c) => c.caseId === 'TC-8')?.expectedStatus, '201');
  assert.match(plan.cases.find((c) => c.caseId === 'TC-8')?.probeNote ?? '', /the sheet expects 201; the API answered 200 when probed/);
  assert.match(review['TC-9'], /did not plan/);
  assert.equal(plan.needsReview?.find((n) => n.caseId === 'TC-7')?.title, '[TC-7] [needs-review] Server error');
});

await check('sheet-only mode drops agent suggestions; plus mode drops repeats of a sheet case', () => {
  const sheet = [sc({ id: 'TC-5', title: 'View one product', steps: 'GET /products/{id}', expected: '200' })];
  const raw: Plan = { endpointId: 'get-product', cases: [planCase({ caseId: 'TC-5', title: 'View one product' }), planCase({ title: 'View one product', requestDescription: 'GET /products/{id}' }), planCase({ type: 'auth', title: 'no token', expectedStatus: '401|403' })] };
  const only = finalizeSheetPlan(raw, ENDPOINT, PROBE, [], sheet, 'sheet-only').plan;
  assert.deepEqual(only.cases.map((c) => c.source), ['sheet']);
  const plus = finalizeSheetPlan(raw, ENDPOINT, PROBE, [], sheet, 'sheet-plus-agent').plan;
  assert.deepEqual(plus.cases.map((c) => c.title), ['[TC-5] [happy] View one product', '[agent] [auth] no token']);
});

await check('sheetStatusConflict: auth and authz statuses, no codes means no conflict', () => {
  assert.equal(sheetStatusConflict('auth', '401 Unauthorized', 200), null);
  assert.match(sheetStatusConflict('auth', '400', 200) ?? '', /does not fit a auth test/);
  assert.equal(sheetStatusConflict('happy', 'the product is shown', 200), null);
});

// ---------- Titles, gate and labels ----------

await check('parseTestTitle and testTypeOf read [ID] [type] and [agent] titles', () => {
  assert.deepEqual(parseTestTitle('[TC-1] [happy] list'), { caseId: 'TC-1', type: 'happy' });
  assert.deepEqual(parseTestTitle('[agent] [auth] x'), { caseId: null, type: 'auth' });
  assert.deepEqual(parseTestTitle('[schema] x'), { caseId: null, type: 'schema' });
  assert.equal(testTypeOf('[TC 9] [invalid-input] y'), 'invalid-input');
  assert.equal(testTypeOf('[TC-1] plain'), null);
});

await check('the gate applies the type rules to [ID] [type] titles and requires every planned title', () => {
  const head = "import { test, expect } from '../tests/fixtures/ctx';\n\nfunction recordStatus(status: number) {\n  test.info().annotations.push({ type: 'actual-status', description: String(status) });\n}\n\n";
  const good = `${head}test.describe('get-product GET /products/{id}', () => {
  test('[TC-5] [happy] View one product', async ({ ctx }) => {
    const id = await ctx.createResource('create-product');
    const response = await ctx.api.get(\`/products/\${id}\`);
    recordStatus(response.status());
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { id: number };
    expect(typeof body.id).toBe('number');
  });
});
`;
  const opts = { name: 'get-product', planTypes: ['happy'], probeStatus: 200, requiredTitles: ['[TC-5] [happy] View one product'] };
  const ok = validateSpec(good, opts);
  assert.ok(ok.ok, JSON.stringify(ok));
  const missing = validateSpec(good, { ...opts, requiredTitles: ['[TC-5] [happy] View one product', '[TC-6] [invalid-input] Missing'] });
  assert.ok(!missing.ok);
  const wrong = validateSpec(good.replace('toBe(200)', 'toBe(201)'), opts);
  assert.ok(!wrong.ok, 'a [ID] [happy] test still must assert the probe status');
});

await check('Allure labels: caseId and tags for sheet cases and agent suggestions', () => {
  const l = reportLabels('shop', ['', 'get-product.spec.ts', 'get-product GET /products/{id}', '[TC-5] [happy] View one product'], 'get-product.spec.ts');
  assert.ok(l.some((x) => x.name === 'caseId' && x.value === 'TC-5'));
  assert.ok(l.some((x) => x.name === 'tag' && x.value === 'test-case-sheet'));
  assert.ok(l.some((x) => x.name === 'story' && x.value === 'happy'));
  const a = reportLabels('shop', ['', 'f', 'd', '[agent] [auth] x'], 'f');
  assert.ok(a.some((x) => x.name === 'tag' && x.value === 'agent-suggestion'));
  assert.ok(!a.some((x) => x.name === 'caseId'));
});

await check('flags: --test-cases and --test-cases-mode', () => {
  const f = parseFlags(['input/a.json', '--test-cases', 'sheet.csv', '--test-cases-mode', 'sheet-only']);
  assert.equal(f.testCases, 'sheet.csv');
  assert.equal(f.testCasesMode, 'sheet-only');
  assert.throws(() => parseFlags(['input/a.json', '--test-cases-mode', 'all']));
});

// ---------- Traceability ----------

await check('traceability rows: passed, failed, needs review, not automated, agent suggestions', () => {
  const plan: Plan = {
    endpointId: 'get-product',
    cases: [
      { ...planCase({ caseId: 'TC-1', source: 'sheet', title: '[TC-1] [happy] a' }) },
      { ...planCase({ caseId: 'TC-2', source: 'sheet', type: 'auth', title: '[TC-2] [auth] b', expectedStatus: '401|403' }) },
      { ...planCase({ source: 'agent', title: '[agent] [schema] c', type: 'schema' }) },
    ],
    needsReview: [{ caseId: 'TC-3', reason: 'vague' }],
  };
  const rows = buildTraceRows({
    cases: [{ id: 'TC-1', title: 'a' }, { id: 'TC-2', title: 'b' }, { id: 'TC-3', title: 'c' }, { id: 'TC-4', title: 'd' }],
    matches: new Map([['TC-1', { endpointId: 'get-product', by: 'column', reason: '' }], ['TC-2', { endpointId: 'get-product', by: 'ai', reason: '' }], ['TC-3', { endpointId: 'get-product', by: 'column', reason: '' }], ['TC-4', { endpointId: null, by: null, reason: 'no endpoint' }]]),
    endpoints: [{ endpointId: 'get-product', specFile: 'generated/get-product.spec.ts', plan, failureReason: null, skippedReason: null }],
    outcomes: [
      { endpointId: 'get-product', title: '[TC-1] [happy] a', passed: true, actualStatus: 200, error: '' },
      { endpointId: 'get-product', title: '[TC-2] [auth] b', passed: false, actualStatus: 200, error: 'Error: expect\nlong' },
      { endpointId: 'get-product', title: '[agent] [schema] c', passed: true, actualStatus: 200, error: '' },
    ],
    findings: [{ endpointId: 'get-product', testTitle: '[TC-2] [auth] b', classification: 'suspected API finding', expectedStatus: '401|403', actualStatus: 200 }],
    ran: true,
  });
  assert.deepEqual(rows.map((r) => [r.id, r.status]), [['TC-1', 'passed'], ['TC-2', 'failed'], ['TC-3', 'needs review'], ['TC-4', 'not automated'], ['agent', 'passed']]);
  assert.match(rows[1].reason, /^suspected API finding: expected 401\|403, got 200; endpoint matched by the AI/);
  assert.equal(rows[0].testFile, 'generated/get-product.spec.ts');
  assert.deepEqual(traceTotals(rows), { rows: 4, automated: 2, passed: 1, failed: 1, partiallyCovered: 0, needsReview: 1, notAutomated: 1, skipped: 0, manual: 0, blocked: 0, knownIssues: 0, unexpectedPasses: 0, accepted5xx: 0, agentSuggestions: 1, assertionCoverage: { asserted: 0, clauses: 0, percent: null } });
  // A needs-review case only has a placeholder that never runs: its Test file cell is blank.
  assert.equal(rows[2].testFile, '');
  assert.equal(rows[3].testFile, '');
});

await check('traceability: blank Test file when the gate dropped the case, full reasons, coverage, Jira and Confluence', () => {
  const longReason = `the steps need a seeded file ${'and more detail '.repeat(40)}end of reason`;
  const clauses = [
    { n: 1, text: 'Status 200', status: 'asserted' as const, via: 'status' as const },
    { n: 2, text: 'items is an array', status: 'asserted' as const, via: 'assertion' as const },
    { n: 3, text: `every item has a png name ${'x'.repeat(150)}`, status: 'not-asserted' as const, reason: `needs a visual check ${'y'.repeat(120)}` },
  ];
  const plan: Plan = {
    endpointId: 'list',
    cases: [{ ...planCase({ caseId: 'TC-1', source: 'sheet', title: '[TC-1] [happy] a' }), clauses }],
    needsReview: [{ caseId: 'TC-2', reason: longReason }],
    notAutomated: [{ caseId: 'TC-3', title: '[TC-3] [happy] c', reason: 'static gate: must assert the body' }],
  };
  const rows = buildTraceRows({
    cases: [
      { id: 'TC-1', title: 'a', expected: '1. Status 200. 2. items is an array. 3. every item has a png name', jira: 'QA-11', confluence: 'https://team.atlassian.net/wiki/spaces/QA/pages/1' },
      { id: 'TC-2', title: 'b', expected: '1. Status 200' },
      { id: 'TC-3', title: 'c', expected: '1. Status 200\n2. body has id' },
    ],
    matches: new Map(['TC-1', 'TC-2', 'TC-3'].map((id) => [id, { endpointId: 'list', by: 'column', reason: '' }])),
    endpoints: [{ endpointId: 'list', specFile: 'list.spec.ts', plan, failureReason: null, skippedReason: null }],
    outcomes: [{ endpointId: 'list', title: '[TC-1] [happy] a', passed: true, actualStatus: 200, error: '' }],
    findings: [],
    ran: true,
  });
  assert.equal(rows[0].status, 'partially covered');
  assert.equal(rows[0].coverage, '2/3 (66.7%)');
  assert.ok(rows[0].reason.includes('x'.repeat(150)) && rows[0].reason.includes('y'.repeat(120)), 'clause text and reason are not clipped');
  assert.equal(rows[0].jira, 'QA-11');
  assert.equal(rows[0].confluence, 'https://team.atlassian.net/wiki/spaces/QA/pages/1');
  assert.equal(rows[1].testFile, '', 'needs review: no test file');
  assert.equal(rows[1].reason, longReason.replace(/\s+/g, ' ').trim(), 'the needs-review reason is complete');
  assert.equal(rows[2].testFile, '', 'dropped by the gate: no test file');
  assert.equal(rows[2].coverage, '');
  const t = traceTotals(rows);
  // 2 of TC-1's 3 clauses; TC-2 (1 clause) and TC-3 (2 clauses) have no test, so they count as not asserted.
  assert.deepEqual(t.assertionCoverage, { asserted: 2, clauses: 6, percent: 33.3 });
  const csv = traceCsv(rows);
  assert.ok(csv.startsWith('ID,Title,Endpoint,Test file,Status,Reason code,Coverage,Reason,Jira,Confluence\r\n'));
  assert.ok(csv.includes(',QA-11,https://team.atlassian.net/wiki/spaces/QA/pages/1\r\n'));
  assert.ok(csv.includes('end of reason'));
});

await check('sheet columns: Jira and Confluence reference columns are read; Jira key stays the ID', async () => {
  const sheet = await parseSheet('ID,Title,Steps,Expected Result,Jira,Confluence Page\nTC-1,a,GET /x,200,QA-7,https://team.atlassian.net/wiki/x\nTC-2,b,GET /y,200,,\n', 's.csv');
  assert.equal(sheet.cases[0].jira, 'QA-7');
  assert.equal(sheet.cases[0].confluence, 'https://team.atlassian.net/wiki/x');
  assert.equal(sheet.cases[1].jira, undefined, 'no empty reference fields (keeps the sheet hash of older sheets)');
  const keyed = await parseSheet('Jira Key,Summary,Steps\nQA-1,a,GET /x\n', 's.csv');
  assert.equal(keyed.cases[0].id, 'QA-1');
  assert.equal(keyed.cases[0].jira, undefined);
});

const ROWS: TraceRow[] = [{ id: 'TC-1', title: '=HYPERLINK("x")', endpoint: 'a', testFile: 'a.spec.ts', status: 'passed', reason: 'has, comma', source: 'sheet', coverage: '1/1 (100%)', jira: '-QA-1' }];

await check('traceability CSV: header, CRLF, quoting and formula escaping', () => {
  assert.equal(csvSafe('=1+1'), "'=1+1");
  assert.equal(csvSafe('-2'), "'-2");
  assert.equal(csvSafe('@x'), "'@x");
  const csv = traceCsv(ROWS);
  assert.equal(csv, 'ID,Title,Endpoint,Test file,Status,Reason code,Coverage,Reason,Jira,Confluence\r\nTC-1,"\'=HYPERLINK(""x"")",a,a.spec.ts,passed,,1/1 (100%),"has, comma",\'-QA-1,\r\n');
});

await check('traceability XLSX: a valid zip with inline strings that our own parser reads back', async () => {
  const buf = traceXlsx(ROWS);
  checkXlsxContainer(buf);
  const back = await parseSheet(buf, 'traceability.xlsx');
  assert.equal(back.cases[0].id, 'TC-1');
  assert.equal(back.cases[0].title, '=HYPERLINK(\u201dx\u201d)');
  // The cell is a string, never a formula.
  const sheetAt = buf.indexOf(Buffer.from('xl/worksheets/sheet1.xml'));
  assert.ok(sheetAt > 0);
  assert.ok(!buf.includes(Buffer.from('<f>')));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
