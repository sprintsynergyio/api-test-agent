import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from './config';
import { createClients, disposeClients, MAX_429_RETRIES, retryAfterMs, RETRY_BASE_MS } from './http';
import { probeAll } from './probe';

// npm run test:http: 429 handling in the shared HTTP layer. Retry-After (seconds or an HTTP date) or
// 1 s, 2 s, 4 s back-off, at most 3 retries, every retry counted as a request, the 429 returned as the
// actual status when it never clears, no retry of a write that answered anything but 429. Against an
// in-process server, then the Pactum setup file against the real local shop API (RATE_LIMIT_FIRST).
// Plain node:assert via tsx, offline, no Claude.

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`ok    ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}\n      ${String((err as Error)?.stack ?? err).split('\n').slice(0, 6).join('\n      ')}`);
  }
}

// the in-process API
// GET /items answers 429 the first `limited` times, then 200. Retry-After is sent when `retryAfter`
// is set. POST /items answers 429 the first `limitedWrites` times, then 201. POST /broken is 500.

const seen: string[] = [];
let limited = 0;
let limitedWrites = 0;
let retryAfter: string | undefined;

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://x');
  seen.push(`${req.method} ${url.pathname}`);
  const reply = (status: number, data?: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(data === undefined ? '' : JSON.stringify(data));
  };
  const tooMany = () => reply(429, { error: 'too many requests' }, retryAfter ? { 'Retry-After': retryAfter } : {});
  if (url.pathname === '/items' && req.method === 'GET') {
    if (limited > 0) {
      limited--;
      return tooMany();
    }
    return reply(200, [{ id: 1 }]);
  }
  if (url.pathname === '/items' && req.method === 'POST') {
    if (limitedWrites > 0) {
      limitedWrites--;
      return tooMany();
    }
    return reply(201, { id: 9 });
  }
  if (url.pathname === '/broken' && req.method === 'POST') return reply(500, { error: 'boom' });
  return reply(404, { error: 'not found' });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

function config(): Config {
  return {
    baseUrl: base,
    selection: null,
    defaultHeaders: { Accept: 'application/json', 'Content-Type': 'application/json' },
    auth: undefined,
    endpoints: [
      { id: 'list-items', method: 'GET', path: '/items', requiresAuth: false },
      { id: 'create-item', method: 'POST', path: '/items', requiresAuth: false, body: { name: 'x' } },
    ],
  };
}

function reset(opts: { limited?: number; limitedWrites?: number; retryAfter?: string } = {}) {
  seen.length = 0;
  limited = opts.limited ?? 0;
  limitedWrites = opts.limitedWrites ?? 0;
  retryAfter = opts.retryAfter;
}

// retryAfterMs

await check('retryAfterMs: Retry-After seconds, HTTP date, else 1 s / 2 s / 4 s, capped at 60 s', () => {
  assert.equal(retryAfterMs('2', 0), 2000);
  assert.equal(retryAfterMs('0', 2), 0);
  const inThree = new Date(Date.now() + 3000).toUTCString();
  const ms = retryAfterMs(inThree, 0);
  assert.ok(ms > 1500 && ms <= 3000, `HTTP date gives the wait until then, got ${ms}`);
  assert.equal(retryAfterMs(new Date(Date.now() - 5000).toUTCString(), 0), 0, 'a date in the past means now');
  assert.equal(retryAfterMs(undefined, 0), RETRY_BASE_MS);
  assert.equal(retryAfterMs(undefined, 1), RETRY_BASE_MS * 2);
  assert.equal(retryAfterMs(undefined, 2), RETRY_BASE_MS * 4);
  assert.equal(retryAfterMs(undefined, 0, 10), 10, 'tests shorten the base');
  assert.equal(retryAfterMs('999', 0), 60_000, 'capped');
  assert.equal(retryAfterMs('nonsense', 1, 10), 20, 'an unreadable header falls back to the back-off');
  assert.equal(MAX_429_RETRIES, 3);
});

// the HTTP layer

await check('a 429 that clears is retried with the back-off; every attempt counts as a request sent', async () => {
  reset({ limited: 2 });
  const clients = await createClients(config(), {}, { retryBaseMs: 5 });
  try {
    const started = Date.now();
    const res = await clients.api.get('/items');
    assert.equal(res.status(), 200);
    assert.deepEqual(seen, ['GET /items', 'GET /items', 'GET /items']);
    assert.equal(clients.counter.sent, 3, 'two retries counted');
    assert.ok(Date.now() - started >= 15, 'waited 5 ms then 10 ms');
  } finally {
    await disposeClients(clients);
  }
});

await check('Retry-After is honoured over the back-off', async () => {
  reset({ limited: 1, retryAfter: '0' });
  const clients = await createClients(config(), {}, { retryBaseMs: 5000 });
  try {
    const started = Date.now();
    assert.equal((await clients.api.get('/items')).status(), 200);
    assert.ok(Date.now() - started < 2000, 'Retry-After: 0 means no wait, the 5 s base was not used');
    assert.equal(clients.counter.sent, 2);
  } finally {
    await disposeClients(clients);
  }
});

await check('after 3 retries the 429 is returned as the actual status, never thrown and never a pass', async () => {
  reset({ limited: 10, retryAfter: '0' });
  const clients = await createClients(config(), {});
  try {
    const res = await clients.api.get('/items');
    assert.equal(res.status(), 429);
    assert.equal(seen.length, 1 + MAX_429_RETRIES, 'the first try plus three retries');
    assert.equal(clients.counter.sent, 4);
    assert.equal(limited, 6, 'the server was not asked again after the cap');
  } finally {
    await disposeClients(clients);
  }
});

await check('a write that answered 429 is sent again (the server did not process it); a write that answered 500 is not', async () => {
  reset({ limitedWrites: 1, retryAfter: '0' });
  const clients = await createClients(config(), {});
  try {
    assert.equal((await clients.api.post('/items', { data: { name: 'x' } })).status(), 201);
    assert.deepEqual(seen, ['POST /items', 'POST /items']);
    seen.length = 0;
    assert.equal((await clients.api.post('/broken', { data: {} })).status(), 500);
    assert.deepEqual(seen, ['POST /broken'], 'one request only');
    assert.equal(clients.counter.sent, 3);
  } finally {
    await disposeClients(clients);
  }
});

await check('probe: an endpoint still 429 after the retries is unusable with the reason "rate limited"', async () => {
  reset({ limited: 10, retryAfter: '0' });
  const silent = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  let run;
  try {
    run = await probeAll(config(), {});
  } finally {
    console.log = silent;
    rmSync('out', { recursive: true, force: true });
  }
  const probe = run.results.get('list-items')!;
  assert.equal(probe.status, 429);
  assert.equal(probe.usable, false);
  assert.match(probe.error ?? '', /^rate limited/);
  assert.ok(lines.some((l) => /^list-items FAILED rate limited/.test(l)), lines.join('\n'));
  assert.equal(seen.filter((s) => s === 'GET /items').length, 4, 'the probe did not add its own retry on top');
  assert.ok(run.results.get('create-item')!.usable, 'the other endpoint is unaffected');
});

server.close();

// the Pactum setup file against the real local shop API

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function startApi(env: Record<string, string>): Promise<{ port: number; log: () => string[]; stop: () => void }> {
  const port = await freePort();
  let out = '';
  const child: ChildProcess = spawn('node', ['local-api/server.mjs'], { env: { ...process.env, PORT: String(port), LOG_REQUESTS: '1', ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  child.stdout!.on('data', (d) => (out += String(d)));
  for (let i = 0; i < 50 && !out.includes('running on'); i++) await sleep(100);
  if (!out.includes('running on')) throw new Error(`local API did not start: ${out}`);
  return { port, log: () => out.split('\n').filter((l) => /^(GET|POST|PUT|PATCH|DELETE) /.test(l)), stop: () => child.kill() };
}

const MOCHA_SPEC = `import { ctx, expect, recordStatus } from '../tests-pactum/setup/ctx';

describe('list-products GET /products', () => {
  it('[happy] list-products returns the list after the rate limit clears', async () => {
    const response = await ctx.api.get('/products');
    recordStatus(response.status());
    expect(response.status()).toBe(200);
  });
});
`;

await check('Pactum setup file: RATE_LIMIT_FIRST=2 on the local shop API, the test still sees 200 after 3 requests', async () => {
  const api = await startApi({ RATE_LIMIT_FIRST: '2' });
  const dir = mkdtempSync(join(tmpdir(), 'http-test-'));
  const inputFile = join(dir, 'local-shop-pactum.json');
  const cfg = JSON.parse(readFileSync('input/local-shop.json', 'utf8')) as Record<string, unknown>;
  writeFileSync(inputFile, JSON.stringify({ ...cfg, baseUrl: `http://localhost:${api.port}`, framework: 'pactum' }, null, 2));
  try {
    rmSync('generated', { recursive: true, force: true });
    rmSync('reports', { recursive: true, force: true });
    mkdirSync('generated', { recursive: true });
    writeFileSync('generated/list-products.spec.ts', MOCHA_SPEC);
    const res = spawnSync('node_modules/.bin/mocha', ['--config', '.mocharc.pactum.json', 'generated/**/*.spec.ts'], {
      env: { ...process.env, INPUT_FILE: inputFile, LOCAL_API_AUTH_VALUE: 'Bearer hackathon-demo-token' },
      encoding: 'utf8',
      timeout: 120_000,
    });
    assert.equal(res.status, 0, `mocha exited ${res.status}:\n${res.stdout}\n${res.stderr}`);
    await sleep(500);
    const entries = JSON.parse(readFileSync('reports/pactum/status.json', 'utf8')) as { actualStatus: number; requestsSent: number }[];
    assert.equal(entries[0].actualStatus, 200);
    assert.equal(entries[0].requestsSent, 3, 'two 429s and the 200, all counted');
    assert.deepEqual(api.log(), ['GET /products', 'GET /products', 'GET /products']);
  } finally {
    api.stop();
    rmSync('generated', { recursive: true, force: true });
    rmSync('reports', { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
