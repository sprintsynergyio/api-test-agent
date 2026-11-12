import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from './config';
import { cleanupResources, createClients, createResource, deleteEndpointFor, disposeClients } from './http';

// npm run test:cleanup: test data cleanup against the real local shop API (started here on a free port).
// Proves, from the API's own request log, that what createResource made is deleted afterwards, in the
// agent's HTTP layer, in a Playwright spec and in a Mocha (Pactum) spec; that a resource without a DELETE
// endpoint is counted, and that a failed deletion is reported, never hidden.

let failed = 0;
let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`ok    ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}\n      ${String((err as Error)?.stack ?? err).split('\n').slice(0, 6).join('\n      ')}`);
  }
}

const AUTH = 'Bearer hackathon-demo-token';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

type Api = { port: number; log: () => string[]; stop: () => void };

async function startApi(env: Record<string, string> = {}): Promise<Api> {
  const port = await freePort();
  let out = '';
  const child: ChildProcess = spawn('node', ['local-api/server.mjs'], { env: { ...process.env, PORT: String(port), LOG_REQUESTS: '1', ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  child.stdout!.on('data', (d) => (out += String(d)));
  for (let i = 0; i < 50; i++) {
    if (out.includes('running on')) break;
    await sleep(100);
  }
  if (!out.includes('running on')) throw new Error(`local API did not start: ${out}`);
  return {
    port,
    log: () => out.split('\n').filter((l) => /^(GET|POST|PUT|PATCH|DELETE) /.test(l)),
    stop: () => child.kill(),
  };
}

function shopConfig(port: number, extra: Partial<Config> = {}): Config {
  const base = JSON.parse(readFileSync('input/local-shop.json', 'utf8')) as Config;
  return { ...base, baseUrl: `http://localhost:${port}`, selection: null, ...extra };
}

async function get(port: number, path: string): Promise<number> {
  const res = await fetch(`http://localhost:${port}${path}`);
  return res.status;
}

// --- the HTTP layer on its own ---

await check('deleteEndpointFor: by path, by explicit cleanup, or none', async () => {
  const cfg = shopConfig(1);
  assert.equal(deleteEndpointFor(cfg, 'create-product')?.id, 'delete-product');
  const nested = { ...JSON.parse(readFileSync('input/local-shop-nested.json', 'utf8')), selection: null } as Config;
  assert.equal(deleteEndpointFor(nested, 'create-review')?.id, 'delete-review', 'nested resource: parent placeholders may differ in name');
  assert.equal(deleteEndpointFor(nested, 'create-product'), undefined, 'no DELETE /products/{id} in the nested input');
  const explicit: Config = {
    ...cfg,
    endpoints: [
      ...cfg.endpoints.filter((e) => e.id !== 'delete-product'),
      { id: 'remove-product', method: 'DELETE', path: '/products/{productId}', requiresAuth: true },
      { id: 'get-with-cleanup', method: 'GET', path: '/products/{id}', requiresAuth: false, setup: { endpointId: 'create-product', idField: 'id', cleanup: { endpointId: 'remove-product' } } },
    ],
  };
  assert.equal(deleteEndpointFor(explicit, 'create-product')?.id, 'remove-product');
});

await check('createResource then cleanupResources: 3 created, 3 DELETEs in the API log, products gone', async () => {
  const api = await startApi();
  try {
    const cfg = shopConfig(api.port);
    const clients = await createClients(cfg, AUTH);
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(await createResource(cfg, clients, 'create-product'));
    assert.equal(clients.created.length, 3);
    const totals = await cleanupResources(cfg, clients);
    await disposeClients(clients);
    assert.deepEqual(totals, { created: 3, deleted: 3, failed: 0, skippedNoDeleteEndpoint: 0, failures: [] });
    assert.equal(clients.created.length, 0, 'the list is emptied');
    const deletes = api.log().filter((l) => l.startsWith('DELETE '));
    assert.deepEqual(deletes, [...ids].reverse().map((id) => `DELETE /products/${id}`), 'newest first');
    for (const id of ids) assert.equal(await get(api.port, `/products/${id}`), 404);
  } finally {
    api.stop();
  }
});

await check('nested: the review is deleted before its product, both through the guard', async () => {
  const api = await startApi();
  try {
    const nested = { ...JSON.parse(readFileSync('input/local-shop-nested.json', 'utf8')), selection: null } as Config;
    nested.baseUrl = `http://localhost:${api.port}`;
    nested.endpoints.push({ id: 'delete-product', method: 'DELETE', path: '/products/{id}', requiresAuth: true });
    const clients = await createClients(nested, AUTH);
    const reviewId = await createResource(nested, clients, 'create-review');
    assert.equal(clients.created.length, 2, 'the product the review needed is recorded too');
    const totals = await cleanupResources(nested, clients);
    await disposeClients(clients);
    assert.deepEqual(totals, { created: 2, deleted: 2, failed: 0, skippedNoDeleteEndpoint: 0, failures: [] });
    const deletes = api.log().filter((l) => l.startsWith('DELETE '));
    assert.equal(deletes.length, 2);
    assert.ok(deletes[0].includes(`/reviews/${reviewId}`), `review first, got ${deletes[0]}`);
    assert.ok(/^DELETE \/products\/\d+$/.test(deletes[1]), `product second, got ${deletes[1]}`);
  } finally {
    api.stop();
  }
});

await check('a resource with no DELETE endpoint is counted as skippedNoDeleteEndpoint', async () => {
  const api = await startApi();
  try {
    const cfg = shopConfig(api.port);
    cfg.endpoints = cfg.endpoints.filter((e) => e.id !== 'delete-product');
    const clients = await createClients(cfg, AUTH);
    await createResource(cfg, clients, 'create-product');
    const totals = await cleanupResources(cfg, clients);
    await disposeClients(clients);
    assert.deepEqual(totals, { created: 1, deleted: 0, failed: 0, skippedNoDeleteEndpoint: 1, failures: [] });
    assert.equal(api.log().filter((l) => l.startsWith('DELETE ')).length, 0);
  } finally {
    api.stop();
  }
});

await check('a failing DELETE is counted as failed with its reason, the rest still deleted', async () => {
  // Seed data holds ids 1 to 3, so the three products made here get 4, 5 and 6.
  const api = await startApi({ FAIL_DELETE_IDS: '5' });
  try {
    const cfg = shopConfig(api.port);
    const clients = await createClients(cfg, AUTH);
    for (let i = 0; i < 3; i++) await createResource(cfg, clients, 'create-product');
    const totals = await cleanupResources(cfg, clients);
    await disposeClients(clients);
    assert.equal(totals.created, 3);
    assert.equal(totals.deleted, 2);
    assert.equal(totals.failed, 1);
    assert.deepEqual(totals.failures, ['DELETE /products/5 returned 500']);
    assert.equal(await get(api.port, '/products/5'), 200, 'the failed one is still there');
  } finally {
    api.stop();
  }
});

await check('read-only mode: nothing is created, so nothing is cleaned', async () => {
  const api = await startApi();
  try {
    const cfg = shopConfig(api.port, { allowProduction: true });
    const clients = await createClients(cfg, AUTH, { forceProduction: true });
    await assert.rejects(() => createResource(cfg, clients, 'create-product'), /read-only/);
    const totals = await cleanupResources(cfg, clients);
    await disposeClients(clients);
    assert.deepEqual(totals, { created: 0, deleted: 0, failed: 0, skippedNoDeleteEndpoint: 0, failures: [] });
    assert.equal(api.log().length, 0);
  } finally {
    api.stop();
  }
});

// --- the two test runners end to end ---

const PW_SPEC = `import { test, expect } from '../tests/fixtures/ctx';

function recordStatus(status: number) {
  test.info().annotations.push({ type: 'actual-status', description: String(status) });
}

test.describe('get-product GET /products/{id}', () => {
  test('[happy] get-product returns the created product', async ({ ctx }) => {
    const id = await ctx.createResource('create-product');
    const extra = await ctx.createResource('create-product');
    const third = await ctx.createResource('create-product');
    const response = await ctx.api.get(\`/products/\${id}\`);
    recordStatus(response.status());
    expect(response.status()).toBe(200);
    expect(extra).not.toBe(third);
  });
});
`;

const MOCHA_SPEC = `import { ctx, expect, recordStatus } from '../tests-pactum/setup/ctx';

describe('get-product GET /products/{id}', () => {
  it('[happy] get-product returns the created product', async () => {
    const id = await ctx.createResource('create-product');
    await ctx.createResource('create-product');
    await ctx.createResource('create-product');
    const response = await ctx.api.get(\`/products/\${id}\`);
    recordStatus(response.status());
    expect(response.status()).toBe(200);
  });
});
`;

function writeInput(port: number, framework: 'playwright' | 'pactum'): string {
  const dir = mkdtempSync(join(tmpdir(), 'cleanup-test-'));
  const cfg = shopConfig(port);
  const file = join(dir, `local-shop-${framework}.json`);
  writeFileSync(file, JSON.stringify({ ...cfg, selection: undefined, framework }, null, 2));
  return file;
}

await check('Playwright run: the spec creates 3 products, the fixture deletes them, the annotation reports it', async () => {
  const api = await startApi();
  const inputFile = writeInput(api.port, 'playwright');
  try {
    rmSync('generated', { recursive: true, force: true });
    rmSync('reports', { recursive: true, force: true });
    mkdirSync('generated', { recursive: true });
    writeFileSync('generated/get-product.spec.ts', PW_SPEC);
    const res = spawnSync('node_modules/.bin/playwright', ['test', '-c', 'playwright.generated.config.ts'], {
      env: { ...process.env, INPUT_FILE: inputFile, LOCAL_API_AUTH_VALUE: AUTH },
      encoding: 'utf8',
      timeout: 120_000,
    });
    assert.equal(res.status, 0, `playwright exited ${res.status}:\n${res.stdout}\n${res.stderr}`);
    await sleep(500); // spawnSync blocks the event loop, so the API's log lines arrive only now
    const report = JSON.parse(readFileSync('reports/results.json', 'utf8'));
    const t = report.suites[0].specs?.[0]?.tests?.[0] ?? report.suites[0].suites[0].specs[0].tests[0];
    const annotations = [...(t.annotations ?? []), ...(t.results[0].annotations ?? [])];
    const cleanup = JSON.parse(annotations.find((a: { type: string }) => a.type === 'cleanup').description);
    assert.deepEqual(cleanup, { created: 3, deleted: 3, failed: 0, skippedNoDeleteEndpoint: 0, failures: [] });
    const deletes = api.log().filter((l) => l.startsWith('DELETE '));
    assert.equal(deletes.length, 3, `API log: ${api.log().join(', ')}`);
    assert.equal(api.log().filter((l) => l.startsWith('POST ')).length, 3);
  } finally {
    api.stop();
    rmSync('generated', { recursive: true, force: true });
    rmSync('reports', { recursive: true, force: true });
    rmSync('test-results', { recursive: true, force: true });
  }
});

await check('Mocha run: the spec creates 3 products, the root hook deletes them, status.json reports it', async () => {
  const api = await startApi();
  const inputFile = writeInput(api.port, 'pactum');
  try {
    rmSync('generated', { recursive: true, force: true });
    rmSync('reports', { recursive: true, force: true });
    mkdirSync('generated', { recursive: true });
    writeFileSync('generated/get-product.spec.ts', MOCHA_SPEC);
    const res = spawnSync('node_modules/.bin/mocha', ['--config', '.mocharc.pactum.json', 'generated/**/*.spec.ts'], {
      env: { ...process.env, INPUT_FILE: inputFile, LOCAL_API_AUTH_VALUE: AUTH },
      encoding: 'utf8',
      timeout: 120_000,
    });
    assert.equal(res.status, 0, `mocha exited ${res.status}:\n${res.stdout}\n${res.stderr}`);
    await sleep(500);
    assert.ok(existsSync('reports/pactum/status.json'));
    const entries = JSON.parse(readFileSync('reports/pactum/status.json', 'utf8'));
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].cleanup, { created: 3, deleted: 3, failed: 0, skippedNoDeleteEndpoint: 0, failures: [] });
    assert.equal(entries[0].requestsSent, 7, '3 creates, 1 get, 3 deletes');
    const deletes = api.log().filter((l) => l.startsWith('DELETE '));
    assert.equal(deletes.length, 3, `API log: ${api.log().join(', ')}`);
  } finally {
    api.stop();
    rmSync('generated', { recursive: true, force: true });
    rmSync('reports', { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
