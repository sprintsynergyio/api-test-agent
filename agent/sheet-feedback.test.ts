import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config, Endpoint } from './config';
import { contentTypeNeedle, describeExpectedStatus, expectedContentType, parseExpectedStatus, splitClauses } from './expected';
import { parseAgentFlags } from './flags';
import { addAllureLabels } from './frameworks/allure-labels';
import { pactumAdapter } from './frameworks/pactum';
import { playwrightAdapter } from './frameworks/playwright';
import { coveredClauses, pruneFailingTests, withWrittenCoverage } from './generate';
import { createClients, disposeClients } from './http';
import { importOpenApi } from './importers/openapi';
import { fileSignature, isBinaryContentType, joinUrl } from './model';
import { buildSheetPrompt, clausesFor, dataStability, finalizeSheetPlan, invalidInputSource, isStatusOnlyClause, type Plan } from './plan';
import type { ProbeResult } from './probe';
import type { SheetCase } from './test-cases';
import { buildTraceRows, passedStatus, traceTotals, traceXlsx } from './traceability';
import { applyReportFont, REPORT_FONT_STACK } from './report-font';
import { validateSpec, type ValidateOptions } from './validate';

// npm run test:sheet-feedback: what a sheet-only run against a real API needs beyond JSON CRUD.
// Base URLs with a path, image responses, invalid-input on query endpoints, cross-call checks on
// stable data, "not 500" negation, per-clause coverage ("partially covered", "needs review"), and the
// static gate dropping one test instead of the whole file. Offline, no model; runs on every OS in CI.

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

// ---------- base URL with a path ----------

await check('joinUrl keeps the base URL path when the endpoint path starts with a slash', () => {
  assert.equal(joinUrl('https://api.example.test/v1/media', '/photos'), 'https://api.example.test/v1/media/photos');
  assert.equal(joinUrl('https://api.example.test/v1/media/', '/photos'), 'https://api.example.test/v1/media/photos');
  assert.equal(joinUrl('https://api.example.test/v1/media', 'photos'), 'https://api.example.test/v1/media/photos');
  assert.equal(joinUrl('https://api.example.test/v1/media//', '//photos/1'), 'https://api.example.test/v1/media/photos/1');
  assert.equal(joinUrl('https://api.example.test', '/photos'), 'https://api.example.test/photos');
  assert.equal(joinUrl('https://api.example.test/v1', '/photos?page=2'), 'https://api.example.test/v1/photos?page=2');
  assert.equal(joinUrl('https://api.example.test/v1?key=x', '/photos'), 'https://api.example.test/v1/photos');
  assert.equal(joinUrl('https://api.example.test/v1', ''), 'https://api.example.test/v1');
  assert.equal(joinUrl('https://api.example.test/v1', 'https://other.example.test/x'), 'https://other.example.test/x');
});

await check('joinUrl is pure string work: no backslashes on Windows, ports and encoded segments kept', () => {
  const url = joinUrl('http://localhost:4000/media/v1', '/files/a%20b');
  assert.equal(url, 'http://localhost:4000/media/v1/files/a%20b');
  assert.ok(!url.includes('\\'), url);
});

// An in-process API under /api/v2 with an image endpoint, to prove the HTTP layer and the probe.
const seen: string[] = [];
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://x');
  seen.push(`${req.method} ${url.pathname}${url.search}`);
  if (url.pathname === '/api/v2/items') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ items: [{ id: 1 }], page: 1 }));
  }
  if (url.pathname === '/api/v2/image') {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=60', 'Content-Length': String(PNG.length) });
    return res.end(PNG);
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end('{"error":"not found"}');
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const port = (server.address() as { port: number }).port;
const baseConfig = (): Config => ({
  baseUrl: `http://127.0.0.1:${port}/api/v2`,
  selection: null,
  defaultHeaders: { Accept: 'application/json' },
  auth: undefined,
  endpoints: [
    { id: 'list-items', method: 'GET', path: '/items', requiresAuth: false, query: { page: 1 } },
    { id: 'get-image', method: 'GET', path: '/image', requiresAuth: false },
  ],
}) as Config;

await check('the HTTP layer sends /items to <base>/api/v2/items, not <host>/items', async () => {
  const clients = await createClients(baseConfig(), {});
  try {
    seen.length = 0;
    const res = await clients.api.get('/items', { params: { page: 2 } });
    assert.equal(res.status(), 200);
    assert.deepEqual(seen, ['GET /api/v2/items?page=2']);
    const res2 = await clients.noAuthApi.get('items');
    assert.equal(res2.status(), 200);
  } finally {
    await disposeClients(clients);
  }
});

await check('the probe joins the base path and reads an image as bytes with its signature and headers', async () => {
  const { probeAll } = await import('./probe');
  seen.length = 0;
  const run = await probeAll(baseConfig(), {});
  const img = run.results.get('get-image')!;
  assert.equal(img.status, 200);
  assert.ok(seen.includes('GET /api/v2/image'), seen.join(', '));
  assert.equal(img.binary?.signature, 'png');
  assert.equal(img.binary?.signatureHex, '89504e47');
  assert.equal(img.binary?.bytes, PNG.length);
  assert.equal(img.body, undefined, 'no JSON body for an image');
  assert.match(img.responseHeaders?.['cache-control'] ?? '', /max-age=60/);
  assert.equal(run.results.get('list-items')!.status, 200);
});
server.close();

await check('file signatures and binary content types', () => {
  assert.equal(fileSignature(Buffer.from('ffd8ffe000104a46', 'hex'))?.kind, 'jpeg');
  assert.equal(fileSignature(Buffer.from('89504e470d0a1a0a', 'hex'))?.kind, 'png');
  assert.equal(fileSignature(Buffer.from('GIF89a', 'latin1'))?.kind, 'gif');
  assert.equal(fileSignature(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'))?.kind, 'webp');
  assert.equal(fileSignature(Buffer.from('%PDF-1.7', 'latin1'))?.kind, 'pdf');
  assert.equal(fileSignature(Buffer.from('{"a":1}', 'latin1')), null);
  assert.equal(isBinaryContentType('image/png'), true);
  assert.equal(isBinaryContentType('application/pdf'), true);
  assert.equal(isBinaryContentType('application/octet-stream'), true);
  assert.equal(isBinaryContentType('application/json; charset=utf-8'), false);
  assert.equal(isBinaryContentType('application/problem+json'), false);
  assert.equal(isBinaryContentType('text/csv'), false);
  assert.equal(isBinaryContentType(null), false);
});

// ---------- expected results: negation, "X or Y", clauses ----------

await check('"Response is 400 or 404 JSON error, not 500 or 502" expects 400 or 404 and rules out 500 and 502', () => {
  const s = parseExpectedStatus('Response is 400 or 404 JSON error, not 500 or 502');
  assert.deepEqual(s.expects, [400, 404]);
  assert.deepEqual(s.forbids, [500, 502]);
  assert.equal(describeExpectedStatus(s), '400 or 404 (never 500 or 502)');
});

await check('negation words: never, must not be, instead of, other than; reason phrases are not negations', () => {
  assert.deepEqual(parseExpectedStatus('400 Bad Request, never 500').expects, [400]);
  assert.deepEqual(parseExpectedStatus('400 Bad Request, never 500').forbids, [500]);
  assert.deepEqual(parseExpectedStatus('Status must not be 500').forbids, [500]);
  assert.deepEqual(parseExpectedStatus('Status must not be 500').expects, []);
  assert.deepEqual(parseExpectedStatus('422 instead of 500').expects, [422]);
  assert.deepEqual(parseExpectedStatus('422 instead of 500').forbids, [500]);
  assert.deepEqual(parseExpectedStatus('404 Not Found').expects, [404]);
  assert.deepEqual(parseExpectedStatus('404 Not Found').forbids, []);
  assert.deepEqual(parseExpectedStatus('204 No Content').expects, [204]);
  const ranges = parseExpectedStatus('A 4xx error, not 5xx');
  assert.deepEqual(ranges.expectsRanges, ['4xx']);
  assert.deepEqual(ranges.forbidsRanges, ['5xx']);
  assert.deepEqual(parseExpectedStatus('Returns 200 or 201 but never 500').expects, [200, 201]);
});

await check('splitClauses: semicolons, sentences, lines and list markers', () => {
  assert.deepEqual(splitClauses('Status 200; Content-Type is image/png. Body is not empty'), ['Status 200', 'Content-Type is image/png', 'Body is not empty']);
  assert.deepEqual(splitClauses('1. Status 200\n2. each photo has id\n- total is a number'), ['Status 200', 'each photo has id', 'total is a number']);
  assert.deepEqual(splitClauses(''), []);
  assert.equal(splitClauses(Array.from({ length: 20 }, (_, i) => `c${i}`).join('; ')).length, 12);
});

await check('status-only clauses are covered by the status assertion; others need their own', () => {
  assert.equal(isStatusOnlyClause('Response is 400 or 404 JSON error, not 500 or 502'), true);
  assert.equal(isStatusOnlyClause('Status 200'), true);
  assert.equal(isStatusOnlyClause('200 OK'), true);
  assert.equal(isStatusOnlyClause("each photo's download_url contains /cdn/"), false);
  assert.equal(isStatusOnlyClause('200 with the photo id'), false);
});

await check('clausesFor: a clause the model left out is not asserted; a contradicted one keeps expected vs actual', () => {
  const clauses = clausesFor('Status 200; each photo has id; download_url contains /cdn/; sorted by title', [
    { clause: 2, check: 'typeof id is number' },
    { clause: 3, disagrees: { expected: 'download_url contains /cdn/', actual: 'download_url is /files/1.png' } },
  ]);
  assert.deepEqual(clauses.map((c) => c.status), ['asserted', 'asserted', 'probe-disagrees', 'not-asserted']);
  assert.equal(clauses[0].via, 'status');
  assert.equal(clauses[2].actual, 'download_url is /files/1.png');
  assert.match(clauses[3].reason ?? '', /did not turn it into an assertion/);
});

// ---------- which case types an endpoint gets ----------

const ep = (e: Partial<Endpoint>): Endpoint => ({ id: 'list-photos', method: 'GET', path: '/photos', requiresAuth: false, ...e }) as Endpoint;
const sheetCase = (id: string, expected: string, title = 'a case', steps = 'Send GET /photos with page abc'): SheetCase => ({ id, row: 2, title, steps, expected, endpoint: 'list-photos', method: 'GET', priority: '', preconditions: '', testData: '' });

await check('invalid-input: body, path id, allowInvalidInput, documented 4xx or a sheet case that expects a 4xx', () => {
  assert.equal(invalidInputSource(ep({ query: { page: 1 } })), null);
  assert.match(invalidInputSource(ep({ method: 'POST', body: { a: 1 } }))!, /request body/);
  assert.match(invalidInputSource(ep({ path: '/photos/{id}' }))!, /path id/);
  assert.match(invalidInputSource(ep({ allowInvalidInput: true }))!, /allowInvalidInput/);
  assert.match(invalidInputSource(ep({ errorStatuses: [400, 422] }))!, /documents 400, 422/);
  assert.match(invalidInputSource(ep({}), [sheetCase('TC-7', 'Response is 400 or 404 JSON error, not 500')])!, /TC-7 expects 400 or 404/);
  assert.equal(invalidInputSource(ep({}), [sheetCase('TC-8', '401 without a token')]), null, '401/403 are auth, not invalid-input');
  assert.equal(invalidInputSource(ep({}), [sheetCase('TC-9', 'Status 200, never 500')]), null);
});

const jsonProbe: ProbeResult = { endpointId: 'list-photos', status: 200, contentType: 'application/json', body: { data: [{ id: 1, title: 'n' }], total: 3 }, durationMs: 1, usable: true } as ProbeResult;

await check('the sheet prompt says why invalid-input is on, how negation reads, and numbers the clauses', () => {
  const prompt = buildSheetPrompt(ep({}), jsonProbe, [], [sheetCase('TC-7', 'Response is 400 or 404 JSON error, not 500 or 502')], 'sheet-only');
  assert.match(prompt, /Allowed case types for this endpoint: "happy", "schema", "invalid-input"/);
  assert.match(prompt, /invalid-input is on for this endpoint because sheet case TC-7 expects 400 or 404/);
  assert.match(prompt, /"expectedStatus": "400 or 404 \(never 500 or 502\)"/);
  assert.match(prompt, /"1: Response is 400 or 404 JSON error, not 500 or 502"/);
  assert.match(prompt, /Codes after "not", "never", "must not be"/);
  const off = buildSheetPrompt(ep({}), jsonProbe, [], [sheetCase('TC-1', 'Status 200')], 'sheet-only');
  assert.match(off, /invalid-input is off for this endpoint \(invalid-input tests are on when/);
});

// ---------- response format (Content-Type) ----------

await check('expectedContentType: media types, "JSON error", plain text; ruled-out and request formats ignored', () => {
  assert.equal(expectedContentType('1. Status 200 OK and Content-Type application/json.'), 'application/json');
  assert.equal(expectedContentType('Response is 400 JSON error, never 500'), 'application/json');
  assert.equal(expectedContentType('Status 200; Content-Type is image/png; body is not empty'), 'image/png');
  assert.equal(expectedContentType('Status 404 and the body is plain text'), 'text/plain');
  assert.equal(expectedContentType('returns application/problem+json'), 'application/problem+json');
  assert.equal(expectedContentType('Status 404, not JSON'), null);
  assert.equal(expectedContentType('400 with a non-JSON body'), null);
  assert.equal(expectedContentType('Send POST /resize with an empty JSON body'), null);
  assert.equal(expectedContentType('200 with the product'), null);
  assert.equal(contentTypeNeedle('application/problem+json'), 'json');
  assert.equal(contentTypeNeedle('text/plain'), 'text/plain');
});

await check('finalizeSheetPlan: a case that names its format gets contentType', () => {
  const raw = { endpointId: 'list-photos', cases: [{ caseId: 'TC-3', id: 'txt', type: 'invalid-input', title: 'x', requestDescription: 'GET /photos?page=abc', expectedStatus: '4xx', assertions: ['status is 4xx'] }] } as Plan;
  const out = finalizeSheetPlan(raw, ep({ allowInvalidInput: true }), jsonProbe, [], [sheetCase('TC-3', 'Status 400 and a plain text body')], 'sheet-only');
  assert.equal(out.plan.cases[0].contentType, 'text/plain');
  const none = finalizeSheetPlan({ ...raw, cases: [{ ...raw.cases[0], caseId: 'TC-4' }] } as Plan, ep({ allowInvalidInput: true }), jsonProbe, [], [sheetCase('TC-4', 'Status 400')], 'sheet-only');
  assert.equal(none.plan.cases[0].contentType, undefined);
});

await check('gate: a case with contentType must assert Content-Type; a non-JSON one must never call response.json()', () => {
  const title = '[TC-20d] [invalid-input] plain text error';
  const head = "import { test, expect } from '../tests/fixtures/ctx';\n\ntest.describe('x', () => {\n";
  const test = (lines: string) => `${head}  test('${title}', async ({ ctx }) => {\n    const response = await ctx.api.get('/photos', { params: { page: 'abc' } });\n    test.info().annotations.push({ type: 'actual-status', description: String(response.status()) });\n    expect(response.status()).toBeGreaterThanOrEqual(400);\n    expect(response.status()).toBeLessThanOrEqual(499);\n${lines}  });\n});\n`;
  const opts: ValidateOptions = { name: 'ct', planTypes: ['invalid-input'], probeStatus: 200, requiredTitles: [title], contentTypes: { [title]: 'text/plain' } };
  const missing = validateSpec(test(''), opts);
  assert.ok((missing.byTest[title] ?? []).some((r) => /expects a text\/plain response: assert/.test(r)), JSON.stringify(missing.byTest));
  const parsesJson = validateSpec(test("    expect(String(response.headers()['content-type'])).toContain('text/plain');\n    const body = await response.json();\n    expect(body.error).toBe('x');\n"), opts);
  assert.ok((parsesJson.byTest[title] ?? []).some((r) => /never call response\.json\(\)/.test(r)));
  const good = validateSpec(test("    expect(String(response.headers()['content-type'])).toContain('text/plain');\n    const text = await response.text();\n    expect(text.length).toBeGreaterThan(0);\n"), opts);
  assert.deepEqual(good.byTest[title] ?? [], []);
  const viaVar = validateSpec(test("    const ct = response.headers()['content-type'];\n    expect(ct).toContain('text/plain');\n"), opts);
  assert.deepEqual(viaVar.byTest[title] ?? [], [], 'a header variable counts');
  const json = validateSpec(test("    expect(String(response.headers()['content-type'])).toContain('json');\n    const body = await response.json();\n    expect(typeof body.error).toBe('string');\n"), { ...opts, contentTypes: { [title]: 'application/json' } });
  assert.deepEqual(json.byTest[title] ?? [], [], 'JSON cases may parse the body');
});

await check('report font: the HTML reports get the Calibri stack once, before </head>; the traceability XLSX uses Calibri', () => {
  const dir = mkdtempSync(join(tmpdir(), 'font-'));
  try {
    const file = join(dir, 'index.html');
    writeFileSync(file, '<!doctype html><html><head><title>r</title></head><body>x</body></html>');
    assert.equal(applyReportFont(file), true);
    assert.equal(applyReportFont(file), false, 'idempotent');
    const html = readFileSync(file, 'utf8');
    assert.equal(REPORT_FONT_STACK, "Calibri, Carlito, 'Segoe UI', Arial, sans-serif");
    assert.equal(html.split('data-sprintsynergy-font').length, 2);
    assert.ok(html.indexOf('data-sprintsynergy-font') < html.indexOf('</head>'));
    assert.ok(!/@font-face|url\(/.test(html), 'no font file is loaded');
    assert.equal(applyReportFont(join(dir, 'missing.html')), false, 'a missing report is not an error');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const xlsx = traceXlsx([]);
  assert.ok(xlsx.length > 0);
});

// ---------- cross-call checks and stable data ----------

await check('dataStability: GET is stable unless the run writes the same resource; stableData always is', () => {
  const list = ep({});
  const writer = ep({ id: 'create-photo', method: 'POST', path: '/photos', body: {} });
  const other = ep({ id: 'render', method: 'POST', path: '/render', body: {} });
  assert.equal(dataStability(list, [list]).stable, true);
  assert.equal(dataStability(list, [list, other]).stable, true);
  const s = dataStability(list, [list, writer]);
  assert.equal(s.stable, false);
  assert.match(s.why, /create-photo \(POST \/photos\)/);
  assert.equal(dataStability(writer, [writer]).stable, false);
  assert.equal(dataStability(ep({ stableData: true }), [ep({ stableData: true }), writer]).stable, true);
});

const crossPlan = (cross: boolean): Plan => ({
  endpointId: 'list-photos',
  cases: [{ caseId: 'TC-2', id: 'paging', type: 'happy', title: 'Walk pages', requestDescription: 'GET page 1 and 2', expectedStatus: '200', assertions: ['no id on both pages'], ...(cross ? { crossCall: true } : {}) }],
  needsReview: [],
}) as Plan;
const pagingCase = sheetCase('TC-2', 'Status 200; no photo id appears on both pages', 'Walk pages', 'Send GET /photos for page 1 and page 2');

await check('a case that compares calls: planned on stable data, needs review (with how to turn it on) otherwise', () => {
  const stable = finalizeSheetPlan(crossPlan(true), ep({}), jsonProbe, [], [pagingCase], 'sheet-only', { stable: true, why: 'read-only' });
  assert.equal(stable.plan.cases.length, 1);
  assert.equal(stable.plan.cases[0].crossCall, true);
  const unstable = finalizeSheetPlan(crossPlan(true), ep({}), jsonProbe, [], [pagingCase], 'sheet-only', { stable: false, why: 'POST /photos changes it' });
  assert.equal(unstable.plan.cases.length, 0);
  assert.match(unstable.plan.needsReview![0].reason, /Stable data.*--stable-data list-photos/);
});

await check('no serial mode: the gate rejects test.describe.configure({ mode: serial }) and test.describe.serial (one failure would skip later tests)', () => {
  const body = "test('[happy] list', async ({ ctx }) => {\n  const response = await ctx.api.get('/photos');\n  test.info().annotations.push({ type: 'actual-status', description: String(response.status()) });\n  expect(response.status()).toBe(200);\n  const body = await response.json();\n  expect(Array.isArray(body.items)).toBe(true);\n});\n";
  const head = "import { test, expect } from '../tests/fixtures/ctx';\n\n";
  const opts = { name: 'serial-check', planTypes: ['happy' as const], probeStatus: 200 };
  for (const serial of ["test.describe.configure({ mode: 'serial' });\n", 'test.describe.configure({ mode: "serial", retries: 0 });\n', "test.describe.serial('x', () => {});\n"]) {
    const r = playwrightAdapter.validate(head + serial + body, opts);
    assert.ok(r.fileReasons.some((x) => /serial mode/.test(x)), `serial mode must be rejected: ${serial}`);
  }
  const ok = playwrightAdapter.validate(head + "test.describe.configure({ mode: 'parallel' });\n" + body, opts);
  assert.ok(!ok.fileReasons.some((x) => /serial mode/.test(x)), 'parallel mode is fine');
});

// ---------- the static gate: images, per-test reasons, dropping one test ----------

const IMPORT = "import { test, expect } from '../tests/fixtures/ctx';";
const RECORD = "function recordStatus(status: number) {\n  test.info().annotations.push({ type: 'actual-status', description: String(status) });\n}";
const spec = (tests: string) => `${IMPORT}\n\n${RECORD}\n\ntest.describe('get-thumbnail GET /thumbnail', () => {\n${tests}\n});\n`;
const IMAGE_TEST = `  test('[TC-6] [happy] Download the thumbnail', async ({ ctx }) => {
    const response = await ctx.api.get('/thumbnail', { params: { format: 'png' } });
    recordStatus(response.status());
    expect(response.status()).toBe(200);
    // covers clause 2
    expect(String(response.headers()['content-type'])).toContain('image/png');
    const bytes = await response.body();
    // covers clauses 3, 4
    expect(bytes.subarray(0, 4).toString('hex')).toBe('89504e47');
  });`;
const NO_BODY_CHECK = `  test('[TC-7] [happy] Download again', async ({ ctx }) => {
    const response = await ctx.api.get('/thumbnail');
    recordStatus(response.status());
    expect(response.status()).toBe(200);
  });`;
const BAD_INVALID = `  test('[TC-8] [invalid-input] Unknown format', async ({ ctx }) => {
    const response = await ctx.api.get('/thumbnail', { params: { format: 'bmp' } });
    recordStatus(response.status());
    expect(response.status()).toBe(500);
  });`;
const imageOpts = (titles: string[], types: string[]): ValidateOptions => ({ name: 'get-thumbnail', planTypes: types, probeStatus: 200, probeHasBody: true, probeContentType: 'image/png', requiredTitles: titles });

await check('the gate accepts header, body() and signature checks for an image response', () => {
  const r = validateSpec(spec(IMAGE_TEST), imageOpts(['[TC-6] [happy] Download the thumbnail'], ['happy']));
  assert.equal(r.ok, true, r.reasons.join('\n'));
});

await check('the gate gives each rejected test its own reason and keeps file problems separate', () => {
  const titles = ['[TC-6] [happy] Download the thumbnail', '[TC-7] [happy] Download again', '[TC-8] [invalid-input] Unknown format'];
  const r = validateSpec(spec([IMAGE_TEST, NO_BODY_CHECK, BAD_INVALID].join('\n\n')), imageOpts(titles, ['happy', 'happy', 'invalid-input']));
  assert.equal(r.ok, false);
  assert.deepEqual(r.fileReasons, []);
  assert.deepEqual(Object.keys(r.byTest).sort(), [titles[1], titles[2]]);
  assert.ok(r.byTest[titles[1]].some((x) => /header|body\(\)|signature/i.test(x)), r.byTest[titles[1]].join('\n'));
  assert.ok(r.byTest[titles[2]].some((x) => /4xx|toBeGreaterThanOrEqual\(400\)/.test(x)), r.byTest[titles[2]].join('\n'));
});

await check('pruneFailingTests drops only the rejected tests and keeps the rest of the file', () => {
  const titles = ['[TC-6] [happy] Download the thumbnail', '[TC-7] [happy] Download again', '[TC-8] [invalid-input] Unknown format'];
  const code = spec([IMAGE_TEST, NO_BODY_CHECK, BAD_INVALID].join('\n\n'));
  const o = imageOpts(titles, ['happy', 'happy', 'invalid-input']);
  const pruned = pruneFailingTests(playwrightAdapter, code, o, validateSpec(code, o));
  assert.ok(pruned, 'expected a pruned file');
  assert.deepEqual(pruned!.dropped.map((d) => d.title).sort(), [titles[1], titles[2]]);
  assert.ok(pruned!.code.includes(titles[0]));
  assert.ok(!pruned!.code.includes(titles[1]) && !pruned!.code.includes(titles[2]));
  assert.equal(validateSpec(pruned!.code, { ...o, requiredTitles: [titles[0]], planTypes: ['happy'] }).ok, true);
});

await check('pruneFailingTests gives up when the file itself is broken (an import, code outside the tests)', () => {
  const code = spec(IMAGE_TEST).replace(IMPORT, `${IMPORT}\nimport fs from 'node:fs';`);
  const o = imageOpts(['[TC-6] [happy] Download the thumbnail'], ['happy']);
  const r = validateSpec(code, o);
  assert.equal(r.ok, false);
  assert.ok(r.fileReasons.length > 0);
  assert.equal(pruneFailingTests(playwrightAdapter, code, o, r), null);
});

await check('written coverage: a clause marked asserted needs its "covers clause" comment and an expect', () => {
  assert.deepEqual([...coveredClauses(IMAGE_TEST)].sort(), [2, 3, 4]);
  assert.deepEqual([...coveredClauses('// covers clause 5\n    const x = 1;\n')], []);
  const c = {
    caseId: 'TC-6', id: 'x', type: 'happy', title: '[TC-6] [happy] Download the thumbnail', requestDescription: 'GET', expectedStatus: '200', assertions: ['x'],
    clauses: [
      { n: 1, text: 'Status 200', status: 'asserted', via: 'status' },
      { n: 2, text: 'Content-Type is image/png', status: 'asserted', via: 'assertion' },
      { n: 5, text: 'Cache-Control has max-age', status: 'asserted', via: 'assertion' },
    ],
  } as Plan['cases'][number];
  const out = withWrittenCoverage(playwrightAdapter, spec(IMAGE_TEST), c);
  assert.deepEqual(out.clauses!.map((x) => x.status), ['asserted', 'asserted', 'not-asserted']);
  assert.match(out.clauses![2].reason!, /no assertion was written/);
});

// ---------- traceability: partially covered, needs review, dropped tests ----------

await check('a passed test is partially covered when a clause has no assertion, needs review when the API disagreed', () => {
  assert.equal(passedStatus({ clauses: [{ n: 1, text: 'Status 200', status: 'asserted' }] }).status, 'passed');
  const partial = passedStatus({ clauses: [{ n: 1, text: 'Status 200', status: 'asserted' }, { n: 2, text: 'sorted by title', status: 'not-asserted', reason: 'ordering' }] });
  assert.equal(partial.status, 'partially covered');
  assert.match(partial.reason, /not asserted: clause 2 "sorted by title" \(ordering\)/);
  const review = passedStatus({ clauses: [{ n: 2, text: 'download_url contains /cdn/', status: 'probe-disagrees', expected: 'download_url contains /cdn/', actual: 'download_url is /files/1.png' }] });
  assert.equal(review.status, 'needs review');
  assert.match(review.reason, /expected download_url contains \/cdn\/, actual download_url is \/files\/1\.png/);
});

await check('traceability rows: partially covered, needs review, a dropped test with its own reason, per-case gate reasons', () => {
  const cases = ['TC-1', 'TC-2', 'TC-3', 'TC-4', 'TC-5'].map((id) => ({ id, title: id }));
  const matches = new Map(cases.map((c) => [c.id, { endpointId: c.id === 'TC-5' ? 'other' : 'ep', by: 'column', reason: '' }]));
  const rows = buildTraceRows({
    cases,
    matches,
    endpoints: [
      {
        endpointId: 'ep',
        specFile: 'ep.spec.ts',
        failureReason: null,
        skippedReason: null,
        plan: {
          cases: [
            { caseId: 'TC-1', title: '[TC-1] [happy] a', expectedStatus: '200', source: 'sheet' },
            { caseId: 'TC-2', title: '[TC-2] [happy] b', expectedStatus: '200', source: 'sheet', clauses: [{ n: 2, text: 'sorted', status: 'not-asserted' }] },
            { caseId: 'TC-3', title: '[TC-3] [happy] c', expectedStatus: '200', source: 'sheet', clauses: [{ n: 2, text: 'x has y', status: 'probe-disagrees', expected: 'x has y', actual: 'x is z' }] },
          ],
          notAutomated: [{ caseId: 'TC-4', title: '[TC-4] [happy] d', reason: 'static gate: never call response.json() on an image' }],
        },
      },
      { endpointId: 'other', specFile: null, failureReason: 'static gate: everything', skippedReason: null, caseReasons: { '[TC-5] [happy] e': ['[happy] test "[TC-5] [happy] e": has no body check'] }, plan: { cases: [{ caseId: 'TC-5', title: '[TC-5] [happy] e', expectedStatus: '200', source: 'sheet' }] } },
    ],
    outcomes: ['[TC-1] [happy] a', '[TC-2] [happy] b', '[TC-3] [happy] c'].map((title) => ({ endpointId: 'ep', title, passed: true, actualStatus: 200, error: '' })),
    findings: [],
    ran: true,
  });
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by['TC-1'].status, 'passed');
  assert.equal(by['TC-2'].status, 'partially covered');
  assert.equal(by['TC-3'].status, 'needs review');
  assert.equal(by['TC-4'].status, 'not automated');
  assert.match(by['TC-4'].reason, /never call response\.json\(\) on an image/);
  assert.equal(by['TC-5'].status, 'not automated');
  assert.equal(by['TC-5'].reason, 'static gate: has no body check');
  const t = traceTotals(rows);
  assert.equal(t.passed, 1);
  assert.equal(t.partiallyCovered, 1);
  assert.equal(t.automated, 2, 'partially covered counts as automated, never as passed');
});

await check('Allure labels are added to the raw results by test name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ata-allure-'));
  try {
    writeFileSync(join(dir, 'a-result.json'), JSON.stringify({ name: '[TC-2] [happy] b', labels: [{ name: 'caseId', value: 'TC-2' }] }));
    writeFileSync(join(dir, 'b-result.json'), JSON.stringify({ name: '[TC-1] [happy] a', labels: [] }));
    assert.equal(addAllureLabels(dir, { '[TC-2] [happy] b': [{ name: 'tag', value: 'partially covered' }] }), 1);
    const a = JSON.parse(readFileSync(join(dir, 'a-result.json'), 'utf8'));
    assert.deepEqual(a.labels, [{ name: 'caseId', value: 'TC-2' }, { name: 'tag', value: 'partially covered' }]);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'b-result.json'), 'utf8')).labels, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- options: OpenAPI, flags ----------

await check('the OpenAPI importer records documented 4xx responses (not 401/403) as errorStatuses', () => {
  const spec = {
    openapi: '3.0.0',
    info: { title: 'Demo', version: '1' },
    servers: [{ url: 'https://api.example.test/v1' }],
    paths: {
      '/photos': { get: { operationId: 'listPhotos', parameters: [{ name: 'page', in: 'query', schema: { type: 'integer' }, example: 1 }], responses: { '200': { description: 'ok' }, '400': { description: 'bad' }, '401': { description: 'no' }, '422': { description: 'bad' } } } },
      '/health': { get: { operationId: 'health', responses: { '200': { description: 'ok' } } } },
    },
  };
  const { input } = importOpenApi(JSON.stringify(spec));
  const list = input.endpoints.find((e) => e.path.endsWith('/photos'))!;
  assert.deepEqual(list.errorStatuses, [400, 422]);
  assert.equal(input.endpoints.find((e) => e.path.endsWith('/health'))!.errorStatuses, undefined);
});

await check('--allow-invalid-input and --stable-data take endpoint ids or apply to all', () => {
  const a = parseAgentFlags(['input/x.json', '--allow-invalid-input', 'list-photos,get-thumbnail', '--stable-data']);
  assert.deepEqual(a.allowInvalidInput, ['list-photos', 'get-thumbnail']);
  assert.equal(a.stableData, 'all');
  assert.equal(parseAgentFlags(['--stable-data', 'input/x.json']).stableData, 'all');
  assert.equal(parseAgentFlags(['--stable-data', 'input/x.json']).inputFile, 'input/x.json');
  assert.deepEqual(parseAgentFlags(['input/x.json', '--stable-data=list-photos']).stableData, ['list-photos']);
  const b = parseAgentFlags(['input/x.json']);
  assert.equal(b.allowInvalidInput, null);
  assert.equal(b.stableData, null);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
