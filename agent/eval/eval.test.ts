import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeBin } from '../node-bin';
import { preflight } from './preflight';
import { findingKey, loadCatalog, runValidity, scoreRun, type Summary, type SummaryFinding } from './score';

// npm run test:eval: the scorer on hand-written summaries, the planted-bug catalog against a real
// local API started with each bug alone, the preflight against that API, and the eval runner itself
// with FAKE_MODEL=1. Plain node:assert via tsx, offline, no Claude.

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
const TOKEN = 'Bearer local-shop-demo-token';

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

await check('catalog has the 8 bugs, 6 detectable, default = the two demo bugs', () => {
  assert.equal(catalog.bugs.length, 8);
  assert.equal(catalog.bugs.filter((b) => b.detectableBy !== 'none-yet').length, 6);
  assert.equal(catalog.bugs.find((b) => b.id === 'viewer-can-delete')?.detectableBy, 'authz');
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

await check('scorer: an authz finding on delete-product detects viewer-can-delete; an auth finding does not', () => {
  const hit = scoreRun(summary([suspected('delete-product', 'authz', 204)]), ['viewer-can-delete'], catalog);
  assert.equal(hit.bugs[0].outcome, 'detected');
  assert.equal(hit.falseAlarms.length, 0);
  const miss = scoreRun(summary([suspected('delete-product', 'auth', 204)]), ['viewer-can-delete'], catalog);
  assert.equal(miss.bugs[0].outcome, 'missed');
  assert.equal(miss.falseAlarms.length, 1);
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
    const proc = spawn(process.execPath, ['local-api/server.mjs'], { env: { ...process.env, PORT: String(port), FIXED: '', BUGS: undefined, ...env } as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
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

async function call(api: Api, method: string, path: string, body?: unknown, auth: boolean | string = true) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth === true) headers.Authorization = TOKEN;
  else if (typeof auth === 'string') headers.Authorization = auth;
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
  'viewer-can-delete': {
    // A viewer logs in (POST /auth/login) and tries to delete a product the admin created.
    probe: async (api) => {
      const created = await call(api, 'POST', '/products', good);
      const login = await call(api, 'POST', '/auth/login', { username: 'viewer', password: 'viewer-pass' }, false);
      assert.equal(login.status, 200, 'viewer login');
      return (await call(api, 'DELETE', `/products/${created.json.id}`, undefined, `Bearer ${login.json.data.token}`)).status;
    },
    withBug: 204,
    withoutBug: 403,
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

// Run validity: only a run that tested every endpoint may be scored

const tested = (id: string) => ({ id, specWritten: true, failureReason: null, skippedReason: null });
const FIVE = ['list-products', 'create-product', 'get-product', 'update-product', 'delete-product'];

await check('validity: completed with every endpoint tested is valid', () => {
  assert.deepEqual(runValidity(summary([], { endpoints: FIVE.map(tested) })), { valid: true });
});

await check('validity: the 20 Nov 2026 case (4 of 5 endpoints answered 401) is invalid and names them', () => {
  const endpoints = FIVE.map((id) => (id === 'list-products' ? tested(id) : { id, specWritten: false, failureReason: 'probe not usable: 401', skippedReason: null }));
  const v = runValidity(summary([], { endpoints }));
  assert.equal(v.valid, false);
  assert.match((v as { reason: string }).reason, /^4 of 5 endpoint\(s\) not tested/);
  for (const id of FIVE.slice(1)) assert.match((v as { reason: string }).reason, new RegExp(`${id}: probe not usable: 401`));
});

await check('validity: one endpoint dropped by the gate, or skipped, makes the run invalid', () => {
  const dropped = runValidity(summary([], { endpoints: [...FIVE.slice(0, 4).map(tested), { id: 'delete-product', specWritten: false, failureReason: 'spec rejected by the gate', skippedReason: null }] }));
  assert.equal(dropped.valid, false);
  const skipped = runValidity(summary([], { endpoints: [...FIVE.slice(0, 4).map(tested), { id: 'delete-product', specWritten: false, failureReason: null, skippedReason: 'skipped: read-only mode' }] }));
  assert.equal(skipped.valid, false);
  assert.match((skipped as { reason: string }).reason, /delete-product: skipped: read-only mode/);
});

await check('validity: a status other than completed is invalid whatever the endpoints say', () => {
  for (const status of ['stopped-budget', 'no-tests', 'refused']) {
    const v = runValidity(summary([], { status, endpoints: FIVE.map(tested) }));
    assert.deepEqual(v, { valid: false, reason: `agent status "${status}"` });
  }
});

await check('validity: a summary without an endpoint list is invalid, never assumed fine', () => {
  assert.equal(runValidity(summary([])).valid, false);
  assert.equal(runValidity(summary([], { endpoints: [] })).valid, false);
});

// Preflight and the runner, against the local API with the login input (admin plus the viewer role)

const DEMO_ENV = { LOCAL_API_ADMIN_USER: 'admin', LOCAL_API_ADMIN_PASSWORD: 'admin-pass', LOCAL_API_VIEWER_USER: 'viewer', LOCAL_API_VIEWER_PASSWORD: 'viewer-pass' };
const tmp = mkdtempSync(join(tmpdir(), 'eval-test-'));

function loginInputFor(api: Api): string {
  const template = JSON.parse(readFileSync('input/local-shop-login.json', 'utf8'));
  const file = join(tmp, `input-${api.port}.json`);
  writeFileSync(file, JSON.stringify({ ...template, baseUrl: `http://127.0.0.1:${api.port}` }));
  return file;
}

await check('the eval input has a second role, so [authz] tests can be written', () => {
  const template = JSON.parse(readFileSync('input/local-shop-login.json', 'utf8'));
  assert.deepEqual(Object.keys(template.auth.roles), ['viewer']);
  assert.match(readFileSync('agent/eval/run.ts', 'utf8'), /INPUT_TEMPLATE = 'input\/local-shop-login\.json'/);
});

await check('preflight: demo credentials, every endpoint usable and the viewer can log in', async () => {
  const api = await startApi({ FIXED: '1' });
  try {
    assert.deepEqual(await preflight(loginInputFor(api), DEMO_ENV), []);
  } finally {
    await stop(api);
  }
});

await check('preflight: a wrong admin password is reported for every endpoint that needs it', async () => {
  const api = await startApi({ FIXED: '1' });
  try {
    const problems = await preflight(loginInputFor(api), { ...DEMO_ENV, LOCAL_API_ADMIN_PASSWORD: 'not-the-password' });
    assert.ok(problems.length >= 4, problems.join(' | '));
    assert.ok(problems.some((p) => /^create-product: .*role default.*401/.test(p)), problems.join(' | '));
    assert.ok(!problems.join(' ').includes('not-the-password'));
  } finally {
    await stop(api);
  }
});

await check('preflight: a wrong viewer password is reported for the role, the endpoints stay fine', async () => {
  const api = await startApi({ FIXED: '1' });
  try {
    const problems = await preflight(loginInputFor(api), { ...DEMO_ENV, LOCAL_API_VIEWER_PASSWORD: 'not-the-password' });
    assert.equal(problems.length, 1, problems.join(' | '));
    assert.match(problems[0], /^role "viewer": .*401/);
  } finally {
    await stop(api);
  }
});

type RunnerResult = { code: number | null; out: string; score: { input: string; records: { set: string; run: number; score: unknown; error?: string }[] } | null };

function runEval(args: string[], env: Record<string, string>): Promise<RunnerResult> {
  const resultsDir = mkdtempSync(join(tmp, 'results-'));
  return new Promise((resolve, reject) => {
    const child = spawn(...nodeBin('tsx', ['agent/eval/run.ts', ...args]), {
      env: { ...process.env, ...DEMO_ENV, FAKE_MODEL: '1', HOSTED: '', UI_USERS: '', EVAL_RESULTS_DIR: resultsDir, FORCE_COLOR: '0', ...env } as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('close', (code) => {
      const stamps = readdirSync(resultsDir);
      const file = stamps.length ? join(resultsDir, stamps[0], 'score.json') : null;
      resolve({ code, out, score: file ? JSON.parse(readFileSync(file, 'utf8')) : null });
    });
  });
}

// FAKE_MODEL proves the harness (roles reach an [authz] test, the scorer sees its finding), nothing
// about how well a real model finds bugs.
await check('runner (fake model): viewer-can-delete alone is detected through the viewer role, exit 0', async () => {
  const r = await runEval(['--runs', '1', '--bugs', 'viewer-can-delete'], {});
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /preflight ok: 5 endpoint\(s\) usable/);
  assert.match(r.out, /detected 1\/1, false alarms 0/);
  assert.match(r.out, /detected\s+viewer-can-delete\s+<- \[authz\]/);
  assert.equal(r.score?.input, 'input/local-shop-login.json');
  assert.ok(r.score?.records.every((rec) => rec.score !== null && !rec.error));
});

await check('runner (fake model): wrong credentials stop at the preflight, no run, no score, exit 1', async () => {
  const r = await runEval(['--runs', '2', '--bugs', 'viewer-can-delete'], { LOCAL_API_ADMIN_PASSWORD: 'not-the-password' });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /INVALID preflight failed, no run started/);
  assert.doesNotMatch(r.out, /=== viewer-can-delete run 1\/2 ===/);
  assert.doesNotMatch(r.out, /detected \d+\/\d+/);
  assert.match(r.out, /overall: no valid run, so there is no score \(runs scored 0\/2\)/);
  assert.equal(r.score?.records.length, 2);
  assert.ok(r.score?.records.every((rec) => rec.score === null && /preflight failed/.test(rec.error ?? '')));
  assert.ok(!r.out.includes('not-the-password'));
});

await check('runner (fake model): a run that stops at the budget is invalid, gets no score, exit 1', async () => {
  const r = await runEval(['--runs', '1', '--bugs', 'none'], { MAX_CLAUDE_CALLS: '7' });
  assert.equal(r.code, 1, r.out);
  // 5 plans then 2 of 5 specs: stopped-budget. (no-tests if the budget ends before the first spec.)
  assert.match(r.out, /INVALID invalid run, not scored: agent status "(stopped-budget|no-tests)"/);
  assert.doesNotMatch(r.out, /detected \d+\/\d+/);
  assert.equal(r.score?.records[0].score, null);
});

rmSync(tmp, { recursive: true, force: true });
// The runner tests ran the agent in this folder with the fake model. Leave none of its output behind:
// a later suite (test:ui reads the live run's report files) must not find a fake run's results, and
// nobody should open them as if they were real. The agent deletes these folders at the start of
// every run anyway, so nothing of an earlier real run was still there to lose.
for (const dir of ['out', 'generated', 'reports', join('frameworks', 'eval-local-shop')]) rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
