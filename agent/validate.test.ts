import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { validateSpec } from './validate';

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

const ALL_TYPES = ['happy', 'schema', 'invalid-input', 'auth'];
const opts = (planTypes: string[] = ALL_TYPES, probeStatus: number | null = 204) => ({ name: 'gate-test', planTypes, probeStatus });

function rejects(name: string, code: string, reasonPart: string, o = opts()) {
  check(`rejects ${name}`, () => {
    const result = validateSpec(code, o);
    assert.equal(result.ok, false, 'expected the gate to reject');
    assert.ok(
      result.reasons.some((r) => r.includes(reasonPart)),
      `expected a reason containing "${reasonPart}", got:\n${result.reasons.join('\n')}`,
    );
  });
}

function accepts(name: string, code: string, o = opts()) {
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
  'must be toBeGreaterThanOrEqual(400) or toBeLessThanOrEqual(499)',
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

export {};
// Keep tsx happy when the file is run directly or imported.
void pathToFileURL;
