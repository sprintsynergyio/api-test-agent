import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { endpointHash, inputHash, loadCheckpoint, newCheckpoint, reusable, saveCheckpoint, type Checkpoint } from './checkpoint';
import { loadConfig } from './config';
import { parseAgentFlags } from './flags';

// npm run test:checkpoint: the scale work. Flags, the checkpoint file (atomic writes, hashes, what a
// resume may reuse), then the whole pipeline with FAKE_MODEL=1 against the real local shop API started
// here on a free port: fresh run, budget stop and resume, only-new after one endpoint changes,
// --endpoints, a changed input with --resume, concurrency, and parallel test workers. Offline: the fake
// model answers every prompt locally, no model is called.

let failed = 0;
let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`ok    ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}\n      ${String((err as Error)?.stack ?? err).split('\n').slice(0, 8).join('\n      ')}`);
  }
}

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

type Api = { port: number; child: ChildProcess; log: () => string };

async function startApi(): Promise<Api> {
  const port = await freePort();
  let log = '';
  const child = spawn('node', ['local-api/server.mjs'], { env: { ...process.env, PORT: String(port), LOG_REQUESTS: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
  child.stdout!.on('data', (d) => (log += d));
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/products`);
      if (res.ok) return { port, child, log: () => log };
    } catch {
      // not up yet
    }
    await sleep(100);
  }
  child.kill();
  throw new Error('local API did not start');
}

// ---------- flags ----------

await check('flags: defaults', () => {
  const f = parseAgentFlags(['input/x.json']);
  assert.equal(f.inputFile, 'input/x.json');
  assert.equal(f.resume, false);
  assert.equal(f.onlyNew, false);
  assert.equal(f.endpoints, null);
  assert.equal(f.budget, null);
  assert.equal(f.concurrency, 3);
  assert.equal(f.testWorkers, 1);
});

await check('flags: every flag, both spellings', () => {
  const f = parseAgentFlags(['--resume', 'input/x.json', '--budget', '12', '--concurrency=5', '--test-workers', '4', '--endpoints', 'a, b']);
  assert.equal(f.resume, true);
  assert.equal(f.budget, 12);
  assert.equal(f.concurrency, 5);
  assert.equal(f.testWorkers, 4);
  assert.deepEqual(f.endpoints, ['a', 'b']);
});

await check('flags: bad values and unknown flags are errors, never a silent fresh run', () => {
  assert.throws(() => parseAgentFlags(['--budget', '0']), /--budget needs a whole number/);
  assert.throws(() => parseAgentFlags(['--concurrency', '9']), /between 1 and 8/);
  assert.throws(() => parseAgentFlags(['--resum']), /unknown flag --resum/);
  assert.throws(() => parseAgentFlags(['--resume', '--only-new']), /cannot be combined/);
  assert.throws(() => parseAgentFlags(['a.json', 'b.json']), /expected one input file/);
});

// ---------- checkpoint file ----------

const tmp = mkdtempSync(join(tmpdir(), 'checkpoint-test-'));
const config = loadConfig('input/local-shop.json');

await check('checkpoint: saved atomically, no temp file left, loads back', () => {
  const file = join(tmp, 'cp.json');
  const cp = newCheckpoint(config, 'input/local-shop.json', 'playwright');
  cp.endpoints['list-products'] = { hash: endpointHash(config.endpoints[0]), stage: 'probed' };
  saveCheckpoint(cp, file);
  assert.deepEqual(readdirSync(tmp).filter((f) => f.endsWith('.tmp')), []);
  const back = loadCheckpoint(file)!;
  assert.equal(back.inputHash, inputHash(config));
  assert.equal(back.endpoints['list-products'].stage, 'probed');
});

await check('checkpoint: a half-written file is an error, not an empty checkpoint', () => {
  const file = join(tmp, 'broken.json');
  writeFileSync(file, '{"version":1,"inputHash":"abc","endpoints":{"a":{"ha');
  assert.throws(() => loadCheckpoint(file), /not valid JSON/);
  writeFileSync(file, JSON.stringify({ version: 99 }));
  assert.throws(() => loadCheckpoint(file), /unknown shape/);
  assert.equal(loadCheckpoint(join(tmp, 'missing.json')), null);
});

await check('hashes: an endpoint hash changes with its body, not with another endpoint', () => {
  const e = config.endpoints.find((x) => x.id === 'create-product')!;
  const h1 = endpointHash(e);
  assert.equal(endpointHash({ ...e }), h1);
  assert.notEqual(endpointHash({ ...e, body: { ...(e.body as object), name: 'other' } }), h1);
  assert.notEqual(endpointHash({ ...e, path: '/items' }), h1);
  const i1 = inputHash(config);
  assert.notEqual(inputHash({ ...config, baseUrl: 'http://localhost:1' }), i1);
});

await check('reusable: generated needs its spec file; a changed endpoint is never reused; fresh reuses nothing', () => {
  const e = config.endpoints.find((x) => x.id === 'get-product')!;
  const cp: Checkpoint = newCheckpoint(config, 'input/local-shop.json', 'playwright');
  cp.endpoints[e.id] = { hash: endpointHash(e), stage: 'generated', specFile: 'does-not-exist.spec.ts', plan: { endpointId: e.id, cases: [] } as never };
  assert.equal(reusable(cp, e, 'fresh'), null);
  const r = reusable(cp, e, 'resume')!;
  assert.equal(r.stage, 'planned', 'a missing spec file drops the entry back to planned');
  assert.equal(reusable(cp, { ...e, path: '/changed' }, 'resume'), null);
  assert.equal(reusable(null, e, 'resume'), null);
});

// ---------- the pipeline with the fake model ----------

const api = await startApi();
const inputFile = join(tmp, 'local-shop.json');
const nestedFile = join(tmp, 'local-shop-nested.json');
const retarget = (src: string, dst: string) => writeFileSync(dst, readFileSync(src, 'utf8').replace('http://localhost:4000', `http://127.0.0.1:${api.port}`));
retarget('input/local-shop.json', inputFile);
retarget('input/local-shop-nested.json', nestedFile);

type Summary = {
  status: string;
  claudeCalls: { used: number; budget: number };
  scope: { mode: string; endpoints: string[] | null; reused: { probes: number; plans: number; specs: number }; resumable: boolean; fakeModel: boolean; concurrency: number; testWorkers: number };
  totals: { endpoints: number; testsGenerated: number; passed: number; failed: number };
  endpoints: { id: string; specWritten: boolean }[];
  cleanup: { created: number; deleted: number; failed: number };
  safety: { mode: string };
};

function agent(args: string[], env: Record<string, string> = {}): { out: string; code: number | null; summary: Summary } {
  const res = spawnSync('node_modules/.bin/tsx', ['agent/cli.ts', ...args], {
    encoding: 'utf8',
    env: { ...process.env, FAKE_MODEL: '1', LOCAL_API_AUTH_VALUE: 'Bearer hackathon-demo-token', ...env },
    timeout: 240_000,
  });
  const out = `${res.stdout}${res.stderr}`;
  if (!existsSync('out/summary.json')) throw new Error(`no summary written; output:\n${out.slice(-1500)}`);
  return { out, code: res.status, summary: JSON.parse(readFileSync('out/summary.json', 'utf8')) as Summary };
}

const stages = () => Object.fromEntries(Object.entries(loadCheckpoint()!.endpoints).map(([k, v]) => [k, v.stage]));

await check('pipeline: fresh FAKE_MODEL run completes with 5 specs, a checkpoint and a clean contract', () => {
  const r = agent([inputFile]);
  assert.equal(r.summary.status, 'completed', r.out.slice(-800));
  assert.equal(r.summary.totals.endpoints, 5);
  assert.equal(r.summary.endpoints.filter((e) => e.specWritten).length, 5);
  assert.equal(r.summary.claudeCalls.used, 10, 'one plan and one generate per endpoint');
  assert.equal(r.summary.claudeCalls.budget, 60, 'the default budget is 60');
  assert.deepEqual(r.summary.scope.mode, 'fresh');
  assert.equal(r.summary.scope.fakeModel, true);
  assert.match(r.out, /model: FAKE_MODEL=1 test mode/);
  assert.deepEqual(stages(), { 'list-products': 'generated', 'create-product': 'generated', 'get-product': 'generated', 'update-product': 'generated', 'delete-product': 'generated' });
  const contract = spawnSync('node_modules/.bin/tsx', ['agent/check-contract.ts'], { encoding: 'utf8' });
  assert.equal(contract.status, 0, contract.stdout + contract.stderr);
});

await check('pipeline: --budget 3 stops, says how to resume, keeps the checkpoint, and is not a pass', () => {
  const r = agent([inputFile, '--budget', '3']);
  assert.equal(r.code, 1, 'a run with no specs exits 1');
  assert.equal(r.summary.status, 'no-tests');
  assert.equal(r.summary.claudeCalls.used, 3);
  assert.equal(r.summary.claudeCalls.budget, 3);
  assert.equal(r.summary.scope.resumable, true);
  assert.match(r.out, /STOPPED: budget reached/);
  assert.match(r.out, /stopped at budget: run again with --resume to continue/);
  const st = stages();
  assert.equal(Object.values(st).filter((s) => s === 'planned').length, 3, `3 plans landed before the stop: ${JSON.stringify(st)}`);
  assert.equal(Object.values(st).includes('generated'), false);
});

await check('pipeline: --resume finishes the stopped run with only the missing calls', () => {
  const r = agent([inputFile, '--resume']);
  assert.equal(r.summary.status, 'completed', r.out.slice(-800));
  assert.equal(r.summary.scope.mode, 'resume');
  assert.equal(r.summary.scope.reused.probes, 5);
  assert.equal(r.summary.scope.reused.plans, 3);
  assert.equal(r.summary.scope.reused.specs, 0);
  assert.equal(r.summary.claudeCalls.used, 7, '2 plans and 5 specs: 3 + 7 = 10, the same as a fresh run');
  assert.match(r.out, /resume: 0 of 5 endpoints already done \(reusing 5 probes, 3 plans, 0 specs\)/);
  assert.match(r.out, /list-products OK 200 \(from checkpoint\)/);
  assert.equal(r.summary.endpoints.filter((e) => e.specWritten).length, 5);
});

await check('pipeline: --resume on a finished run makes no model call and still runs the tests', () => {
  const r = agent([inputFile, '--resume']);
  assert.equal(r.summary.status, 'completed');
  assert.equal(r.summary.claudeCalls.used, 0);
  assert.equal(r.summary.scope.reused.specs, 5);
  assert.equal(r.summary.totals.testsGenerated > 0, true);
});

await check('pipeline: --only-new regenerates exactly the endpoint whose body changed', () => {
  const before = Object.fromEntries(readdirSync('generated').filter((f) => f.endsWith('.spec.ts')).map((f) => [f, statSync(join('generated', f)).mtimeMs]));
  const text = JSON.parse(readFileSync(inputFile, 'utf8'));
  text.endpoints.find((e: { id: string }) => e.id === 'update-product').body.name = 'Trail Runner Shoe V3';
  writeFileSync(inputFile, JSON.stringify(text, null, 2));
  const r = agent([inputFile, '--only-new']);
  assert.equal(r.summary.status, 'completed', r.out.slice(-800));
  assert.equal(r.summary.scope.mode, 'only-new');
  assert.equal(r.summary.claudeCalls.used, 2, 'one plan and one spec for update-product');
  assert.deepEqual(r.summary.scope.reused, { probes: 4, plans: 4, specs: 4 });
  assert.match(r.out, /\[claude\] plan update-product/);
  assert.doesNotMatch(r.out, /\[claude\] plan get-product/);
  const after = Object.fromEntries(readdirSync('generated').filter((f) => f.endsWith('.spec.ts')).map((f) => [f, statSync(join('generated', f)).mtimeMs]));
  assert.equal(after['update-product.spec.ts'] > before['update-product.spec.ts'], true, 'update-product was rewritten');
  assert.equal(after['get-product.spec.ts'], before['get-product.spec.ts'], 'get-product was kept');
  assert.match(readFileSync('generated/update-product.spec.ts', 'utf8'), /Trail Runner Shoe V3/);
});

await check('pipeline: --resume after the input changed starts fresh and says so', () => {
  const text = JSON.parse(readFileSync(inputFile, 'utf8'));
  text.defaultHeaders['X-Run'] = 'changed';
  writeFileSync(inputFile, JSON.stringify(text, null, 2));
  const r = agent([inputFile, '--resume']);
  assert.match(r.out, /resume: .* changed since the checkpoint, starting fresh/);
  assert.equal(r.summary.scope.mode, 'fresh');
  assert.equal(r.summary.claudeCalls.used, 10);
});

await check('pipeline: --endpoints restricts probing, planning, generation and the test run', () => {
  const r = agent([inputFile, '--endpoints', 'get-product,list-products']);
  assert.equal(r.summary.status, 'completed', r.out.slice(-800));
  assert.deepEqual(r.summary.scope.endpoints, ['get-product', 'list-products']);
  assert.deepEqual(r.summary.endpoints.map((e) => e.id), ['list-products', 'get-product']);
  assert.equal(r.summary.claudeCalls.used, 4);
  assert.deepEqual(readdirSync('generated').filter((f) => f.endsWith('.spec.ts')).sort(), ['get-product.spec.ts', 'list-products.spec.ts']);
  assert.match(r.out, /endpoints: get-product, list-products/);
  const bad = spawnSync('node_modules/.bin/tsx', ['agent/cli.ts', inputFile, '--endpoints', 'nope'], { encoding: 'utf8', env: { ...process.env, FAKE_MODEL: '1' } });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr + bad.stdout, /--endpoints: not in .*: nope/);
});

await check('pipeline: --concurrency bounds the calls in flight', () => {
  const stats = join(tmp, 'stats.json');
  agent([inputFile, '--concurrency', '1'], { FAKE_MODEL_STATS_FILE: stats, FAKE_MODEL_DELAY_MS: '150' });
  const one = JSON.parse(readFileSync(stats, 'utf8'));
  assert.equal(one.maxInFlight, 1);
  const r = agent([inputFile, '--concurrency', '5'], { FAKE_MODEL_STATS_FILE: stats, FAKE_MODEL_DELAY_MS: '150' });
  const five = JSON.parse(readFileSync(stats, 'utf8'));
  assert.equal(five.maxInFlight, 5, `5 endpoints, concurrency 5: all five plans overlap (${JSON.stringify(five)})`);
  assert.equal(r.summary.scope.concurrency, 5);
});

await check('pipeline: --test-workers 4 on the nested input passes with cleanup failed 0 and the same counts as 1 worker', async () => {
  const one = agent([nestedFile]);
  assert.equal(one.summary.status, 'completed', one.out.slice(-800));
  const four = agent([nestedFile, '--test-workers', '4']);
  assert.equal(four.summary.status, 'completed', four.out.slice(-800));
  assert.match(four.out, /Running \d+ tests using 4 workers/);
  assert.equal(four.summary.scope.testWorkers, 4);
  assert.equal(four.summary.totals.failed, 0);
  assert.equal(four.summary.cleanup.failed, 0);
  assert.deepEqual(four.summary.cleanup, one.summary.cleanup, 'parallel workers change nothing about what gets cleaned');
  // spawnSync blocks the event loop, so the API's stdout arrives only once we yield.
  await sleep(500);
  const log = api.log();
  const deletes = (log.match(/^DELETE \/products\/\d+\/reviews\/\d+$/gm) ?? []).length;
  assert.equal(deletes > 0, true, 'review records made by tests are deleted');
});

await check('pipeline: FAKE_MODEL is refused in hosted mode before any request', () => {
  // A non-production public host: hosted mode would allow it, so the fake-model refusal is what stops the run.
  const hostedInput = join(tmp, 'hosted.json');
  writeFileSync(hostedInput, readFileSync('input/local-shop.json', 'utf8').replace('http://localhost:4000', 'https://shop.staging.example.test'));
  const r = agent([hostedInput], { HOSTED: '1', UI_USERS: 'x:y', ANTHROPIC_API_KEY: 'sk-ant-fake-not-used' });
  assert.equal(r.code, 1);
  assert.equal(r.summary.status, 'no-tests');
  assert.equal(r.summary.safety.mode, 'full');
  assert.match(r.out, /FAKE_MODEL=1 is a test mode and is refused in hosted mode/);
  assert.doesNotMatch(r.out, /=== PROBING ===/);
});

api.child.kill();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
