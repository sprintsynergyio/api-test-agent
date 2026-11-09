import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { findingKey, loadCatalog, scoreRun, type Summary, type SummaryFinding } from './score';

// npm run test:eval: the scorer on hand-written summaries, and the planted-bug catalog against a
// real local API started with each bug alone. Plain node:assert via tsx, offline, no Claude.

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

const catalog = loadCatalog();
const TOKEN = 'Bearer hackathon-demo-token';

function summary(findings: SummaryFinding[], extra: Partial<Summary> = {}): Summary {
  return {
    status: 'completed',
    durationSec: 45,
    claudeCalls: { used: 10, budget: 30 },
    totals: { endpoints: 5, testsGenerated: 23, passed: 23 - findings.length, failed: findings.length },
    findings,
    ...extra,
  };
}

const suspected = (endpointId: string, type: string, actualStatus: number): SummaryFinding => ({
  endpointId,
  testTitle: `[${type}] ${endpointId} something`,
  type,
  actualStatus,
  classification: 'suspected API finding',
});
const needsReview = (endpointId: string, type: string): SummaryFinding => ({
  endpointId,
  testTitle: `[${type}] ${endpointId} something`,
  type,
  actualStatus: 404,
  classification: 'needs review',
});

// Scorer

await check('catalog has the 7 bugs, 5 detectable, default = the two demo bugs', () => {
  assert.equal(catalog.bugs.length, 7);
  assert.equal(catalog.bugs.filter((b) => b.detectableBy !== 'none-yet').length, 5);
  assert.deepEqual(catalog.default, ['price-text-500', 'delete-no-auth']);
});

await check('scorer: both demo bugs detected, no false alarm', () => {
  const s = scoreRun(summary([suspected('create-product', 'invalid-input', 500), suspected('delete-product', 'auth', 204)]), catalog.default, catalog);
  assert.equal(s.detectable, 2);
  assert.equal(s.detected, 2);
  assert.deepEqual(s.falseAlarms, []);
  assert.deepEqual(s.bugs.map((b) => b.outcome), ['detected', 'detected']);
  assert.equal(s.claudeCalls, 10);
  assert.equal(s.durationSec, 45);
});

await check('scorer: nothing found means every detectable bug is missed', () => {
  const s = scoreRun(summary([]), catalog.default, catalog);
  assert.equal(s.detected, 0);
  assert.deepEqual(s.bugs.map((b) => b.outcome), ['missed', 'missed']);
  assert.equal(s.suspectedFindings, 0);
});

await check('scorer: a finding on an endpoint with no active bug of that type is a false alarm', () => {
  const s = scoreRun(summary([suspected('create-product', 'invalid-input', 500), suspected('update-product', 'auth', 200)]), ['price-text-500'], catalog);
  assert.equal(s.detected, 1);
  assert.equal(s.falseAlarms.length, 1);
  assert.equal(s.falseAlarms[0].endpointId, 'update-product');
});

await check('scorer: wrong type on the right endpoint does not count as detection', () => {
  // delete-no-auth is an auth bug; an invalid-input finding on delete-product is not evidence for it.
  const s = scoreRun(summary([suspected('delete-product', 'invalid-input', 500)]), ['delete-no-auth'], catalog);
  assert.equal(s.detected, 0);
  assert.equal(s.falseAlarms.length, 1);
});

await check('scorer: "needs review" findings never count, as detection or as false alarm', () => {
  const s = scoreRun(summary([needsReview('delete-product', 'auth'), needsReview('list-products', 'happy')]), ['delete-no-auth'], catalog);
  assert.equal(s.detected, 0);
  assert.deepEqual(s.falseAlarms, []);
  assert.equal(s.suspectedFindings, 0);
});

await check('scorer: none-yet bugs are expected misses, excluded from the detectable count', () => {
  const s = scoreRun(summary([]), ['update-not-persisted', 'list-wrong-type', 'delete-no-auth'], catalog);
  assert.equal(s.detectable, 1);
  assert.equal(s.expectedMisses, 2);
  assert.deepEqual(
    s.bugs.map((b) => [b.id, b.outcome]),
    [
      ['update-not-persisted', 'expected-miss'],
      ['list-wrong-type', 'expected-miss'],
      ['delete-no-auth', 'missed'],
    ],
  );
});

await check('scorer: with no active bugs every suspected finding is a false alarm', () => {
  const s = scoreRun(summary([suspected('create-product', 'invalid-input', 500)]), [], catalog);
  assert.equal(s.detectable, 0);
  assert.equal(s.falseAlarms.length, 1);
});

await check('scorer: unknown bug id throws', () => {
  assert.throws(() => scoreRun(summary([]), ['no-such-bug'], catalog), /unknown bug id/);
});

await check('findingKey ignores order and needs-review entries', () => {
  const a = summary([suspected('delete-product', 'auth', 204), suspected('create-product', 'invalid-input', 500), needsReview('x', 'happy')]);
  const b = summary([suspected('create-product', 'invalid-input', 500), suspected('delete-product', 'auth', 204)]);
  assert.equal(findingKey(a), findingKey(b));
  assert.equal(findingKey(a), 'create-product:invalid-input|delete-product:auth');
});

// The planted bugs, against the real server

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

type Api = { port: number; proc: ChildProcess; startLine: string };

function startApi(env: Record<string, string>): Promise<Api> {
  return new Promise(async (resolve, reject) => {
    const port = await freePort();
    const proc = spawn('node', ['local-api/server.mjs'], { env: { ...process.env, PORT: String(port), FIXED: '', BUGS: undefined, ...env } as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => reject(new Error(`API did not start: ${out}`)), 10_000);
    proc.stdout.on('data', (d) => {
      out += d;
      if (/Local shop API running/.test(out)) {
        clearTimeout(timer);
        resolve({ port, proc, startLine: out.trim().split('\n')[0] });
      }
    });
    proc.stderr.on('data', (d) => (out += d));
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`exit ${code}: ${out.trim()}`));
    });
  });
}

function stop(api: Api): Promise<void> {
  return new Promise((resolve) => {
    api.proc.once('exit', () => resolve());
    api.proc.kill('SIGTERM');
  });
}

async function call(api: Api, method: string, path: string, body?: unknown, auth = true) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth) headers.Authorization = TOKEN;
  const res = await fetch(`http://127.0.0.1:${api.port}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

const good = { name: 'Test Shoe', price: 10, category: 'shoes', inStock: true };

// For each bug id: what differs with the bug on versus off, checked on two real servers.
type Probe = (api: Api) => Promise<unknown>;
const probes: Record<string, { probe: Probe; withBug: unknown; withoutBug: unknown }> = {
  'price-text-500': { probe: (api) => call(api, 'POST', '/products', { ...good, price: 'ten' }).then((r) => r.status), withBug: 500, withoutBug: 400 },
  'delete-no-auth': {
    probe: async (api) => {
      const created = await call(api, 'POST', '/products', good);
      return (await call(api, 'DELETE', `/products/${created.json.id}`, undefined, false)).status;
    },
    withBug: 204,
    withoutBug: 401,
  },
  'update-no-auth': {
    probe: async (api) => {
      const created = await call(api, 'POST', '/products', good);
      return (await call(api, 'PUT', `/products/${created.json.id}`, good, false)).status;
    },
    withBug: 200,
    withoutBug: 401,
  },
  'create-accepts-missing-name': { probe: (api) => call(api, 'POST', '/products', { price: 10, category: 'shoes', inStock: true }).then((r) => r.status), withBug: 201, withoutBug: 400 },
  'get-bad-id-500': { probe: (api) => call(api, 'GET', '/products/not-a-number').then((r) => r.status), withBug: 500, withoutBug: 400 },
  'update-not-persisted': {
    probe: async (api) => {
      const created = await call(api, 'POST', '/products', good);
      const put = await call(api, 'PUT', `/products/${created.json.id}`, { ...good, name: 'Renamed' });
      const get = await call(api, 'GET', `/products/${created.json.id}`);
      return `put ${put.status} ${put.json.name}, get ${get.json.name}`;
    },
    withBug: 'put 200 Renamed, get Test Shoe',
    withoutBug: 'put 200 Renamed, get Renamed',
  },
  'list-wrong-type': { probe: (api) => call(api, 'GET', '/products').then((r) => (Array.isArray(r.json) ? 'array' : typeof r.json)), withBug: 'object', withoutBug: 'array' },
};

await check('every catalog bug has a probe in this test file', () => {
  assert.deepEqual(Object.keys(probes).sort(), catalog.bugs.map((b) => b.id).sort());
});

await check('BUGS unset: startup line shows the two default bugs ON (same as before)', async () => {
  const api = await startApi({});
  try {
    assert.match(api.startLine, /\(bugs ON: price-text-500,delete-no-auth\)/);
    assert.equal(await probes['price-text-500'].probe(api), 500);
    assert.equal(await probes['delete-no-auth'].probe(api), 204);
    assert.equal(await probes['update-no-auth'].probe(api), 401);
  } finally {
    await stop(api);
  }
});

await check('FIXED=1: bugs OFF, every bug behaves correctly', async () => {
  const api = await startApi({ FIXED: '1' });
  try {
    assert.match(api.startLine, /\(bugs OFF\)/);
    for (const [id, p] of Object.entries(probes)) assert.deepEqual(await p.probe(api), p.withoutBug, id);
  } finally {
    await stop(api);
  }
});

await check('BUGS=all ids: every bug is on at once', async () => {
  const api = await startApi({ BUGS: catalog.bugs.map((b) => b.id).join(',') });
  try {
    for (const [id, p] of Object.entries(probes)) assert.deepEqual(await p.probe(api), p.withBug, id);
  } finally {
    await stop(api);
  }
});

for (const bug of catalog.bugs) {
  await check(`BUGS=${bug.id} alone: only that behaviour changes`, async () => {
    const api = await startApi({ BUGS: bug.id });
    try {
      assert.match(api.startLine, new RegExp(`\\(bugs ON: ${bug.id}\\)`));
      for (const [id, p] of Object.entries(probes)) {
        assert.deepEqual(await p.probe(api), id === bug.id ? p.withBug : p.withoutBug, `${id} while ${bug.id} is on`);
      }
    } finally {
      await stop(api);
    }
  });
}

await check('BUGS with an unknown id: exit 1 with a message', async () => {
  await assert.rejects(startApi({ BUGS: 'price-text-500,no-such-bug' }), /exit 1: Unknown bug id\(s\) in BUGS: no-such-bug/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
