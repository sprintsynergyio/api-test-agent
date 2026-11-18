import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { validateSpec, type ValidateOptions } from './validate';

// npm run test:gate: the static gate's per-type rules. Plain node:assert, offline, no Claude.
// Every "rejects" case is a test that would PASS against a broken API if the gate let it through.

let failed = 0;
let passed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`ok    ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}\n      ${String((err as Error)?.message ?? err).split('\n').join('\n      ')}`);
  }
}

const IMPORT = "import { test, expect } from '../tests/fixtures/ctx';";
const RECORD = `function recordStatus(status: number) {
  test.info().annotations.push({ type: 'actual-status', description: String(status) });
}`;

function spec(tests: string): string {
  return `${IMPORT}\n\n${RECORD}\n\ntest.describe('delete-product DELETE /products/{id}', () => {\n${tests}\n});\n`;
}

const HAPPY = `  test('[happy] delete-product deletes a product', async ({ ctx }) => {
    const id = await ctx.createResource('create-product');
    const response = await ctx.api.delete(\`/products/\${id}\`);
    recordStatus(response.status());
    expect(response.status()).toBe(204);
  });`;

const SCHEMA = `  test('[schema] delete-product returns an empty body', async ({ ctx }) => {
    const id = await ctx.createResource('create-product');
    const response = await ctx.api.delete(\`/products/\${id}\`);
    recordStatus(response.status());
    expect(response.status()).toBe(204);
    expect(await response.text()).toBe('');
  });`;

const INVALID = `  test('[invalid-input] delete-product rejects a non-existent id', async ({ ctx }) => {
    const response = await ctx.api.delete('/products/does-not-exist');
    recordStatus(response.status());
    expect(response.status()).toBeGreaterThanOrEqual(400);
    expect(response.status()).toBeLessThanOrEqual(499);
  });`;

const AUTH = `  test('[auth] delete-product rejects a request without auth', async ({ ctx }) => {
    const id = await ctx.createResource('create-product');
    const response = await ctx.noAuthApi.delete(\`/products/\${id}\`);
    recordStatus(response.status());
    expect([401, 403]).toContain(response.status());
  });`;

const AUTHZ = `  test('[authz] delete-product rejects a viewer deleting another role\\'s product', async ({ ctx }) => {
    const id = await ctx.createResource('create-product');
    const response = await ctx.as('viewer').delete(\`/products/\${id}\`);
    recordStatus(response.status());
    expect([403, 404]).toContain(response.status());
  });`;

const ALL_TYPES = ['happy', 'schema', 'invalid-input', 'auth'];
const opts = (planTypes: string[] = ALL_TYPES, probeStatus: number | null = 204) => ({ name: 'gate-test', planTypes, probeStatus });

function rejects(name: string, code: string, reasonPart: string, o: ValidateOptions = opts()) {
  check(`rejects ${name}`, () => {
    const result = validateSpec(code, o);
    assert.equal(result.ok, false, 'expected the gate to reject');
    assert.ok(
      result.reasons.some((r) => r.includes(reasonPart)),
      `expected a reason containing "${reasonPart}", got:\n${result.reasons.join('\n')}`,
    );
  });
}

function accepts(name: string, code: string, o: ValidateOptions = opts()) {
  check(`accepts ${name}`, () => {
    const result = validateSpec(code, o);
    assert.deepEqual(result.reasons, []);
    assert.equal(result.ok, true);
  });
}

// --- accepted ---

accepts('the template-style file with one test per type', spec([HAPPY, SCHEMA, INVALID, AUTH].join('\n\n')));

// The template imports '../fixtures/ctx' from tests/template/; a generated file would import '../tests/fixtures/ctx'.
accepts(
  'the real template test file (import path as generated/ would have it)',
  readFileSync('tests/template/update-booking.spec.ts', 'utf8').replace("'../fixtures/ctx'", "'../tests/fixtures/ctx'"),
  opts(ALL_TYPES, 200),
);

accepts(
  'a status kept in a variable',
  spec(`  test('[happy] delete-product deletes a product', async ({ ctx }) => {
    const id = await ctx.createResource('create-product');
    const response = await ctx.api.delete(\`/products/\${id}\`);
    const status = response.status();
    recordStatus(status);
    expect(status).toBe(204);
  });`),
  opts(['happy']),
);

accepts(
  'an auth test that expects exactly 401',
  spec(`  test('[auth] delete-product rejects a request without auth', async ({ ctx }) => {
    const response = await ctx.noAuthApi.delete('/products/1');
    recordStatus(response.status());
    expect(response.status()).toBe(401);
  });`),
  opts(['auth']),
);

// --- rejected: wrong expectation for the type ---

rejects(
  'an invalid-input test that expects 200',
  spec(`  test('[invalid-input] delete-product rejects a bad id', async ({ ctx }) => {
    const response = await ctx.api.delete('/products/abc');
    recordStatus(response.status());
    expect(response.status()).toBe(200);
  });`),
  'must be toBeGreaterThanOrEqual(400), toBeLessThanOrEqual(499)',
  opts(['invalid-input']),
);

rejects(
  'an invalid-input test with only the lower bound',
  spec(`  test('[invalid-input] delete-product rejects a bad id', async ({ ctx }) => {
    const response = await ctx.api.delete('/products/abc');
    recordStatus(response.status());
    expect(response.status()).toBeGreaterThanOrEqual(400);
  });`),
  'must assert the status is between 400 and 499',
  opts(['invalid-input']),
);

rejects(
  'an auth test that only checks the status is below 500',
  spec(`  test('[auth] delete-product rejects a request without auth', async ({ ctx }) => {
    const response = await ctx.noAuthApi.delete('/products/1');
    recordStatus(response.status());
    expect(response.status()).toBeLessThan(500);
  });`),
  'must be expect([401, 403]).toContain(response.status())',
  opts(['auth']),
);

rejects(
  'an auth test with 200 in the allowed list',
  spec(`  test('[auth] delete-product rejects a request without auth', async ({ ctx }) => {
    const response = await ctx.noAuthApi.delete('/products/1');
    recordStatus(response.status());
    expect([200, 401, 403]).toContain(response.status());
  });`),
  'must be expect([401, 403]).toContain(response.status())',
  opts(['auth']),
);

rejects(
  'a happy test that expects a status other than the probe status',
  spec(`  test('[happy] delete-product deletes a product', async ({ ctx }) => {
    const response = await ctx.api.delete('/products/1');
    recordStatus(response.status());
    expect(response.status()).toBe(200);
  });`),
  'must be exactly toBe(204)',
  opts(['happy']),
);

rejects(
  'a happy test with no status assertion at all',
  spec(`  test('[happy] delete-product deletes a product', async ({ ctx }) => {
    const response = await ctx.api.delete('/products/1');
    recordStatus(response.status());
    expect(await response.text()).toBe('');
  });`),
  'must assert expect(response.status()).toBe(204)',
  opts(['happy']),
);

rejects(
  'a schema test that uses .not on the status',
  spec(`  test('[schema] delete-product returns an empty body', async ({ ctx }) => {
    const response = await ctx.api.delete('/products/1');
    recordStatus(response.status());
    expect(response.status()).not.toBe(500);
  });`),
  'must be exactly toBe(204)',
  opts(['schema']),
);

// --- authz: another role must be rejected ---

accepts('an authz test that uses ctx.as and expects 403 or 404', spec(AUTHZ), opts(['authz']));
accepts('a file with one test of each of the five types', spec([HAPPY, SCHEMA, INVALID, AUTH, AUTHZ].join('\n\n')), opts([...ALL_TYPES, 'authz']));

rejects(
  'an authz test that sends the request with ctx.api (the default role)',
  spec(AUTHZ.replace("ctx.as('viewer')", 'ctx.api')),
  'uses ctx.api, the default role',
  opts(['authz']),
);

rejects(
  'an authz test that expects 2xx',
  spec(AUTHZ.replace('expect([403, 404]).toContain(response.status());', 'expect(response.status()).toBe(204);')),
  'must be expect([403, 404]).toContain(response.status())',
  opts(['authz']),
);

rejects(
  'an authz test that allows 401 (that is an auth test)',
  spec(AUTHZ.replace('[403, 404]', '[401, 403, 404]')),
  'must be expect([403, 404]).toContain(response.status())',
  opts(['authz']),
);

rejects(
  'an authz test that uses ctx.noAuthApi',
  spec(AUTHZ.replace("ctx.as('viewer')", 'ctx.noAuthApi')),
  'uses ctx.noAuthApi; that is an [auth] test',
  opts(['authz']),
);

rejects('a file with no authz test when the plan has one', spec([HAPPY, AUTH].join('\n\n')), 'the plan has 1 [authz] case(s) but the file has 0 [authz] test(s)', opts(['happy', 'auth', 'authz']));

// --- rejected: auth test that still sends the token ---

rejects(
  'an auth test that sends the request with ctx.api',
  spec(`  test('[auth] delete-product rejects a request without auth', async ({ ctx }) => {
    const response = await ctx.api.delete('/products/1');
    recordStatus(response.status());
    expect([401, 403]).toContain(response.status());
  });`),
  'uses ctx.api',
  opts(['auth']),
);

rejects(
  'an auth test that destructures api from ctx',
  spec(`  test('[auth] delete-product rejects a request without auth', async ({ ctx }) => {
    const { api } = ctx;
    const response = await api.delete('/products/1');
    recordStatus(response.status());
    expect([401, 403]).toContain(response.status());
  });`),
  'uses ctx.api',
  opts(['auth']),
);

// --- rejected: plan coverage per type ---

rejects(
  'a file with four happy tests when the plan has one of each type',
  spec([HAPPY, HAPPY.replace('deletes a product', 'deletes again'), HAPPY.replace('deletes a product', 'deletes a third'), HAPPY.replace('deletes a product', 'deletes a fourth')].join('\n\n')),
  'the plan has 1 [auth] case(s) but the file has 0 [auth] test(s)',
);

// --- existing rules still apply ---

rejects('a file importing from @playwright/test', spec(HAPPY).replace(IMPORT, "import { test, expect } from '@playwright/test';"), '@playwright/test', opts(['happy']));
rejects('a file with process.env', spec(HAPPY.replace("'create-product'", 'process.env.X as string')), 'process.env', opts(['happy']));
rejects('a file with test.only', spec(HAPPY.replace("test('[happy]", "test.only('[happy]")), 'test.only', opts(['happy']));
rejects(
  'a test that records the status after its first expect',
  spec(`  test('[happy] delete-product deletes a product', async ({ ctx }) => {
    const response = await ctx.api.delete('/products/1');
    expect(response.status()).toBe(204);
    recordStatus(response.status());
  });`),
  'records actual-status after its first assertion',
  opts(['happy']),
);

// Untrusted generated code (PR A): only the ctx file may be imported, and nothing may reach the machine.
// The first case is the hostile spec from the review: it passed the old gate with {"ok":true}.
const HOSTILE = `import { test, expect } from '../tests/fixtures/ctx';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
execSync('id > /tmp/pwned.txt');
const leak = readFileSync('.env', 'utf8');
${RECORD}
test.describe('delete-product DELETE /products/{id}', () => {
${HAPPY.replace("recordStatus(response.status());", "recordStatus(response.status());\n    await ctx.api.post('/exfil', { data: { leak } });")}
});
`;
rejects('the hostile review spec (child_process, fs, .env read, exfil)', HOSTILE, 'may only import the ctx file', opts(['happy']));
rejects('the hostile review spec: child_process is named', HOSTILE, 'child_process', opts(['happy']));
const withLine = (line: string) => spec(HAPPY.replace('recordStatus(response.status());', `recordStatus(response.status());\n    ${line}`));
const UNSAFE: [string, string, string][] = [
  ['require()', "const cp = require('child_process');", 'calls require()'],
  ['a dynamic import()', "const fs = await import('fs');", 'dynamic import()'],
  ['eval()', "eval('1 + 1');", 'calls eval()'],
  ['new Function', "const f = new Function('return 1');", 'Function'],
  ['Function()', "const f = Function('return 1');", 'Function'],
  ['the constructor chain', "const f = (() => 0).constructor.constructor('return 1');", 'constructor'],
  ['a string timer', "setTimeout('1 + 1', 0);", 'string to a timer'],
  ['globalThis', 'const g = globalThis;', 'global object'],
  ['process.cwd()', 'const d = process.cwd();', 'uses process'],
  ['process.mainModule', 'const m = (process as any).mainModule;', 'uses process'],
  ['fetch()', "await fetch('/x');", 'outside ctx'],
  ['WebSocket', "const w = new WebSocket('ws://x');", 'outside ctx'],
  ['an fs module name', "const n = 'fs';", 'Node built-in module'],
  ['a net module name', "const n = 'net';", 'Node built-in module'],
  ['a node: module name', "const n = 'node:os';", 'node: module'],
  ['execSync', 'const run = execSync;', 'child_process'],
];
for (const [what, line, reason] of UNSAFE) rejects(`a test with ${what}`, withLine(line), reason, opts(['happy']));
rejects('a static import of another module', `import { readFileSync } from 'fs';\n${spec(HAPPY)}`, 'imports "fs"', opts(['happy']));
rejects('a side-effect import', `import './evil';\n${spec(HAPPY)}`, 'imports "./evil"', opts(['happy']));
rejects('an export-from of another module', `${spec(HAPPY)}export { x } from 'http';\n`, 'imports "http"', opts(['happy']));
rejects('a test that takes the Playwright request fixture', spec(HAPPY.replace('async ({ ctx })', 'async ({ ctx, request })')), 'fixtures other than ctx', opts(['happy']));
accepts('a test using ctx.api.fetch and a body field named process', withLine("const r2 = await ctx.api.fetch('/products', { method: 'GET' });\n    const body = { process: 1 };\n    void body.process; void r2;"), opts(['happy']));


// --- [happy] and [schema] must assert on the body (not only the status) unless the probe had no body ---

const get200 = (title: string, lines: string) => spec(`  test('${title}', async ({ ctx }) => {
    const response = await ctx.api.get('/products');
    recordStatus(response.status());
    expect(response.status()).toBe(200);
${lines}
  });`);
const opts200 = (probeHasBody = true) => ({ name: 'gate-test', planTypes: ['happy'], probeStatus: 200, probeHasBody });
rejects('a 200 [happy] test that only checks the status', get200('[happy] lists products', ''), 'must assert something about the response body', opts200());
rejects('a 200 [schema] test that only checks the status', get200('[schema] lists products', ''), 'must assert something about the response body', { ...opts200(), planTypes: ['schema'] });
rejects(
  'a 200 [happy] test whose only body check is toBeDefined()',
  get200('[happy] lists products', '    const body = await response.json();\n    expect(body).toBeDefined();'),
  'must assert something about the response body',
  opts200(),
);
rejects(
  'a 200 [happy] test that asserts on a value unrelated to the body',
  get200('[happy] lists products', "    const x = 'a';\n    expect(x).toBe('a');"),
  'must assert something about the response body',
  opts200(),
);
accepts('a 200 [happy] test with a body type check', get200('[happy] lists products', '    const body = (await response.json()) as unknown[];\n    expect(Array.isArray(body)).toBe(true);'), opts200());
accepts('a 200 [happy] test with a typed body variable', get200('[happy] lists products', '    const body: Record<string, unknown> = await response.json();\n    expect(typeof body.id).toBe(\'number\');'), opts200());
accepts('a 200 [happy] test asserting on response.json() directly', get200('[happy] lists products', "    expect(await response.json()).toHaveProperty('id');"), opts200());
accepts('a 200 [happy] test with status only when the probe got no body', get200('[happy] lists products', ''), opts200(false));
accepts('a 204 [happy] test with status only (no-content status)', spec(HAPPY), opts(['happy'], 204));

// --- [schema] tests must assert every required field of the documented response schema ---
const schemaOpts = { ...opts200(), planTypes: ['schema'], requiredFields: ['id', 'name'] };
rejects(
  'a [schema] test that skips a documented required field',
  get200('[schema] lists products', "    const body = (await response.json()) as Record<string, unknown>;\n    expect(typeof body.id).toBe('number');"),
  'missing: name',
  schemaOpts,
);
rejects(
  'a [schema] test that names a required field only in a comment-free variable, not an assertion',
  get200('[schema] lists products', "    const body = (await response.json()) as Record<string, unknown>;\n    const n = body.name;\n    expect(typeof body.id).toBe('number');"),
  'missing: name',
  schemaOpts,
);
accepts(
  'a [schema] test asserting every required field (dot, bracket and toHaveProperty forms)',
  get200('[schema] lists products', "    const body = (await response.json()) as Record<string, unknown>;\n    expect(typeof body['id']).toBe('number');\n    expect(body).toHaveProperty('name');\n    expect(typeof body.name).toBe('string');"),
  schemaOpts,
);
accepts(
  'required fields do not apply to [happy] tests',
  get200('[happy] lists products', "    const body = (await response.json()) as Record<string, unknown>;\n    expect(typeof body.id).toBe('number');"),
  { ...schemaOpts, planTypes: ['happy'] },
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

export {};
// Keep tsx happy when the file is run directly or imported.
void pathToFileURL;
