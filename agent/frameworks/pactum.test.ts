import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pactumAdapter } from './pactum';

// npm run test:gate:pactum: the Pactum static gate. Offline, no Claude, no API. Same shape as
// agent/validate.test.ts: every "rejects" case would pass against a broken API if it got through.

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

const IMPORT = "import { ctx, expect, recordStatus } from '../tests-pactum/setup/ctx';";
const spec = (tests: string) => `${IMPORT}\n\ndescribe('delete-product DELETE /products/{id}', () => {\n${tests}\n});\n`;

const HAPPY = `  it('[happy] delete-product deletes a product', async () => {
    const id = await ctx.createResource('create-product');
    const response = await ctx.api.delete(\`/products/\${id}\`);
    recordStatus(response.status());
    expect(response.status()).toBe(204);
  });`;
const SCHEMA = `  it('[schema] delete-product returns an empty body', async () => {
    const id = await ctx.createResource('create-product');
    const response = await ctx.api.delete(\`/products/\${id}\`);
    recordStatus(response.status());
    expect(response.status()).toBe(204);
    expect(await response.text()).toBe('');
  });`;
const INVALID = `  it('[invalid-input] delete-product rejects a non-existent id', async () => {
    const response = await ctx.api.delete('/products/does-not-exist');
    recordStatus(response.status());
    expect(response.status()).toBeGreaterThanOrEqual(400);
    expect(response.status()).toBeLessThanOrEqual(499);
  });`;
const AUTH = `  it('[auth] delete-product rejects a request without auth', async () => {
    const id = await ctx.createResource('create-product');
    const response = await ctx.noAuthApi.delete(\`/products/\${id}\`);
    recordStatus(response.status());
    expect([401, 403]).toContain(response.status());
  });`;

const AUTHZ = `  it('[authz] delete-product rejects a viewer deleting another role\\'s product', async () => {
    const id = await ctx.createResource('create-product');
    const response = await ctx.as('viewer').delete(\`/products/\${id}\`);
    recordStatus(response.status());
    expect([403, 404]).toContain(response.status());
  });`;

const ALL = ['happy', 'schema', 'invalid-input', 'auth'];
const opts = (planTypes: string[] = ALL, probeStatus: number | null = 204) => ({ name: 'pactum-gate-test', planTypes, probeStatus });

function rejects(name: string, code: string, reasonPart: string, o = opts()) {
  check(`rejects ${name}`, () => {
    const r = pactumAdapter.validate(code, o);
    assert.equal(r.ok, false, 'expected the gate to reject');
    assert.ok(r.reasons.some((x) => x.includes(reasonPart)), `expected a reason containing "${reasonPart}", got:\n${r.reasons.join('\n')}`);
  });
}
function accepts(name: string, code: string, o = opts()) {
  check(`accepts ${name}`, () => {
    const r = pactumAdapter.validate(code, o);
    assert.deepEqual(r.reasons, []);
    assert.equal(r.ok, true);
  });
}

accepts('the template-style file with one test per type', spec([HAPPY, SCHEMA, INVALID, AUTH].join('\n\n')));
accepts(
  'the real Pactum template (import path as generated/ would have it)',
  readFileSync(pactumAdapter.templateFile, 'utf8').replace("'../setup/ctx'", "'../tests-pactum/setup/ctx'"),
  opts(ALL, 200),
);

accepts('an authz test that uses ctx.as and expects 403 or 404', spec(AUTHZ), opts(['authz']));
accepts('a file with one test of each of the five types', spec([HAPPY, SCHEMA, INVALID, AUTH, AUTHZ].join('\n\n')), opts([...ALL, 'authz']));
rejects('an authz test that sends the request with ctx.api', spec(AUTHZ.replace("ctx.as('viewer')", 'ctx.api')), 'uses ctx.api, the default role', opts(['authz']));
rejects('an authz test that expects 2xx', spec(AUTHZ.replace('expect([403, 404]).toContain(response.status());', 'expect(response.status()).toBe(204);')), 'must be expect([403, 404]).toContain(response.status())', opts(['authz']));
rejects('an authz test that uses ctx.noAuthApi', spec(AUTHZ.replace("ctx.as('viewer')", 'ctx.noAuthApi')), 'uses ctx.noAuthApi; that is an [auth] test', opts(['authz']));
rejects('a file that imports pactum directly', `import { spec } from 'pactum';\n${spec(HAPPY)}`, 'imports pactum directly', opts(['happy']));
rejects('a file that requires pactum', `const pactum = require('pactum');\n${spec(HAPPY)}`, 'imports pactum directly', opts(['happy']));
rejects('a file that imports node:assert', `import assert from 'node:assert';\n${spec(HAPPY)}`, 'assertion library', opts(['happy']));
rejects('a file missing recordStatus in the import', spec(HAPPY).replace(IMPORT, "import { ctx, expect } from '../tests-pactum/setup/ctx';"), 'does not import recordStatus', opts(['happy']));
rejects('a file with it.only', spec(HAPPY.replace("it('[happy]", "it.only('[happy]")), 'contains .only', opts(['happy']));
rejects('a file with describe.skip', spec(HAPPY).replace("describe('", "describe.skip('"), 'contains .skip', opts(['happy']));
rejects('a file with this.skip()', spec(HAPPY.replace('recordStatus(response.status());', 'this.skip();\n    recordStatus(response.status());')), 'this.skip()', opts(['happy']));
rejects('a file with process.env', spec(HAPPY.replace("'create-product'", 'process.env.X as string')), 'process.env', opts(['happy']));
rejects('a file with a hardcoded host', spec(HAPPY.replace('`/products/${id}`', "'http://localhost:4000/products/1'")), 'http://', opts(['happy']));
rejects(
  'a test without recordStatus',
  spec(`  it('[happy] delete-product deletes a product', async () => {
    const response = await ctx.api.delete('/products/1');
    expect(response.status()).toBe(204);
  });`),
  'does not record the actual-status',
  opts(['happy']),
);
rejects(
  'a test that records the status after its first expect',
  spec(`  it('[happy] delete-product deletes a product', async () => {
    const response = await ctx.api.delete('/products/1');
    expect(response.status()).toBe(204);
    recordStatus(response.status());
  });`),
  'records actual-status after its first assertion',
  opts(['happy']),
);
rejects(
  'an invalid-input test that expects 200',
  spec(`  it('[invalid-input] delete-product rejects a bad id', async () => {
    const response = await ctx.api.delete('/products/abc');
    recordStatus(response.status());
    expect(response.status()).toBe(200);
  });`),
  'must be toBeGreaterThanOrEqual(400) or toBeLessThanOrEqual(499)',
  opts(['invalid-input']),
);
rejects(
  'an auth test that only checks the status is below 500',
  spec(`  it('[auth] delete-product rejects a request without auth', async () => {
    const response = await ctx.noAuthApi.delete('/products/1');
    recordStatus(response.status());
    expect(response.status()).toBeLessThan(500);
  });`),
  'must be expect([401, 403]).toContain(response.status())',
  opts(['auth']),
);
rejects(
  'an auth test that sends the request with ctx.api',
  spec(`  it('[auth] delete-product rejects a request without auth', async () => {
    const response = await ctx.api.delete('/products/1');
    recordStatus(response.status());
    expect([401, 403]).toContain(response.status());
  });`),
  'uses ctx.api',
  opts(['auth']),
);
rejects(
  'a happy test that expects a status other than the probe status',
  spec(`  it('[happy] delete-product deletes a product', async () => {
    const response = await ctx.api.delete('/products/1');
    recordStatus(response.status());
    expect(response.status()).toBe(200);
  });`),
  'must be exactly toBe(204)',
  opts(['happy']),
);
rejects(
  'a test that expects a 5xx',
  spec(`  it('[happy] delete-product deletes a product', async () => {
    const response = await ctx.api.delete('/products/1');
    recordStatus(response.status());
    expect(response.status()).toBe(500);
  });`),
  'expects a status of 500 or higher',
  opts(['happy'], 500),
);
rejects('four happy tests when the plan has one of each type', spec([HAPPY, HAPPY.replace('deletes a product', 'again'), HAPPY.replace('deletes a product', 'third'), HAPPY.replace('deletes a product', 'fourth')].join('\n\n')), 'the plan has 1 [auth] case(s) but the file has 0 [auth] test(s)');
rejects(
  'a catch that swallows the error',
  spec(`  it('[happy] delete-product deletes a product', async () => {
    let response = await ctx.api.delete('/products/1');
    try { response = await ctx.api.delete('/products/1'); } catch (e) { }
    recordStatus(response.status());
    expect(response.status()).toBe(204);
  });`),
  'empty catch',
  opts(['happy']),
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
