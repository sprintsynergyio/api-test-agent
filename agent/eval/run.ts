import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { findingKey, loadCatalog, scoreRun, type BugCatalog, type Score, type Summary } from './score';

// npm run eval -- [--runs N] [--bugs all|none|id,id] [--dry-run]
//
// For every bug set in the matrix: start the local shop API on a free port with exactly those bugs,
// run the agent on a copy of input/local-shop.json pointed at that port, N times, score each run.
// Output: one table on stdout, eval-results/<timestamp>/ with every summary.json, run log and score.json.
// Exit 1 when any run produced no summary.json or did not end with status "completed". Nothing is swallowed.

const INPUT_TEMPLATE = 'input/local-shop.json';
const SUMMARY_FILE = 'out/summary.json';
// Not under out/: the agent deletes out/ at the start of every run.
const EVAL_ROOT = 'eval-results';
const API_START_TIMEOUT_MS = 10_000;

type Args = { runs: number; bugSets: string[][] | null; dryRun: boolean };

function usage(): never {
  console.error('usage: npm run eval -- [--runs N] [--bugs all|none|id,id] [--dry-run]');
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { runs: 3, bugSets: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--runs') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) usage();
      args.runs = n;
    } else if (a === '--bugs') {
      const v = argv[++i];
      if (!v) usage();
      args.bugSets = [v === 'none' ? [] : v === 'all' ? ['all'] : v.split(',').map((s) => s.trim()).filter(Boolean)];
    } else usage();
  }
  return args;
}

// Default matrix: every bug on, no bug on, then each detectable bug alone.
function matrix(catalog: BugCatalog, requested: string[][] | null): { label: string; bugs: string[] }[] {
  const all = catalog.bugs.map((b) => b.id);
  if (requested) {
    return requested.map((set) => {
      const bugs = set[0] === 'all' ? all : set;
      const unknown = bugs.filter((id) => !all.includes(id));
      if (unknown.length) throw new Error(`unknown bug id(s): ${unknown.join(', ')}. Known: ${all.join(', ')}`);
      return { label: bugs.length ? bugs.join(',') : 'none', bugs };
    });
  }
  const detectable = catalog.bugs.filter((b) => b.detectableBy !== 'none-yet').map((b) => b.id);
  return [
    { label: 'all', bugs: all },
    { label: 'none', bugs: [] },
    ...detectable.map((id) => ({ label: id, bugs: [id] })),
  ];
}

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

function startApi(port: number, bugs: string[]): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['local-api/server.mjs'], {
      env: { ...process.env, PORT: String(port), BUGS: bugs.join(','), FIXED: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`local API did not start within ${API_START_TIMEOUT_MS / 1000}s: ${out}`));
    }, API_START_TIMEOUT_MS);
    child.stdout.on('data', (d) => {
      out += d;
      if (/Local shop API running/.test(out)) {
        clearTimeout(timer);
        console.log(`  api: ${out.trim().split('\n')[0]}`);
        resolve(child);
      }
    });
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`local API exited with code ${code}: ${out.trim()}`));
    });
  });
}

function stopApi(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
  });
}

function runAgent(inputFile: string, logFile: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn('node_modules/.bin/tsx', ['agent/cli.ts', inputFile], {
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    child.on('error', reject);
    child.on('close', (code) => {
      writeFileSync(logFile, log);
      resolve(code);
    });
  });
}

type RunRecord = { set: string; run: number; exitCode: number | null; score: Score | null; key: string | null; error?: string };

function pct(n: number, d: number): string {
  return d === 0 ? 'n/a' : `${Math.round((n / d) * 100)}%`;
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

function printTable(records: RunRecord[], sets: { label: string; bugs: string[] }[], catalog: BugCatalog) {
  const rows = sets.map((set) => {
    const recs = records.filter((r) => r.set === set.label);
    const scored = recs.filter((r) => r.score && !r.error).map((r) => r.score!);
    const detectable = scored.reduce((a, s) => a + s.detectable, 0);
    const detected = scored.reduce((a, s) => a + s.detected, 0);
    const findings = scored.reduce((a, s) => a + s.suspectedFindings, 0);
    const falseAlarms = scored.reduce((a, s) => a + s.falseAlarms.length, 0);
    const keys = new Set(recs.map((r) => r.key ?? `error:${r.error}`));
    const calls = scored.length ? (scored.reduce((a, s) => a + s.claudeCalls, 0) / scored.length).toFixed(1) : 'n/a';
    const secs = scored.length ? Math.round(scored.reduce((a, s) => a + s.durationSec, 0) / scored.length) : 'n/a';
    const expectedMisses = scored.length ? scored[0].expectedMisses : set.bugs.filter((id) => catalog.bugs.find((b) => b.id === id)?.detectableBy === 'none-yet').length;
    return {
      set: set.label,
      runs: `${scored.length}/${recs.length}`,
      detection: `${pct(detected, detectable)} (${detected}/${detectable})`,
      falseAlarm: `${pct(falseAlarms, findings)} (${falseAlarms}/${findings})`,
      flaky: keys.size > 1 ? `yes (${keys.size} different)` : 'no',
      expectedMiss: String(expectedMisses),
      calls: String(calls),
      secs: String(secs),
    };
  });
  const cols: [keyof (typeof rows)[number], string][] = [
    ['set', 'bug set'],
    ['runs', 'runs ok'],
    ['detection', 'detection'],
    ['falseAlarm', 'false alarms'],
    ['flaky', 'flaky'],
    ['expectedMiss', 'not-yet'],
    ['calls', 'claude calls'],
    ['secs', 'sec/run'],
  ];
  const widths = cols.map(([k, h]) => Math.max(h.length, ...rows.map((r) => r[k].length)));
  console.log(cols.map(([, h], i) => pad(h, widths[i])).join('  '));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(cols.map(([k], i) => pad(r[k], widths[i])).join('  '));

  const all = records.filter((r) => r.score && !r.error).map((r) => r.score!);
  const detectable = all.reduce((a, s) => a + s.detectable, 0);
  const detected = all.reduce((a, s) => a + s.detected, 0);
  const findings = all.reduce((a, s) => a + s.suspectedFindings, 0);
  const falseAlarms = all.reduce((a, s) => a + s.falseAlarms.length, 0);
  console.log(`\noverall: detection ${pct(detected, detectable)} (${detected}/${detectable}), false alarms ${pct(falseAlarms, findings)} (${falseAlarms}/${findings}), runs scored ${all.length}/${records.length}`);
  console.log('not-yet = planted bugs that need test types the agent does not have yet; they never count against detection.');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const catalog = loadCatalog();
  const sets = matrix(catalog, args.bugSets);

  console.log(`eval matrix (${sets.length} bug set(s), ${args.runs} run(s) each):`);
  for (const set of sets) console.log(`  ${pad(set.label, 28)} BUGS=${set.bugs.join(',') || '(none)'}`);
  if (args.dryRun) {
    console.log('dry run: nothing started.');
    return;
  }
  if (!existsSync(INPUT_TEMPLATE)) throw new Error(`${INPUT_TEMPLATE} is missing`);
  const template = JSON.parse(readFileSync(INPUT_TEMPLATE, 'utf8')) as { baseUrl: string; name?: string };
  const authEnv = (template as { auth?: { valueEnv: string } }).auth?.valueEnv;
  if (authEnv && !process.env[authEnv]) throw new Error(`environment variable ${authEnv} is not set (needed by ${INPUT_TEMPLATE}); add it to .env`);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const evalDir = join(EVAL_ROOT, stamp);
  mkdirSync(evalDir, { recursive: true });
  const records: RunRecord[] = [];

  for (const set of sets) {
    console.log(`\n=== bug set: ${set.label} ===`);
    const port = await freePort();
    const api = await startApi(port, set.bugs);
    try {
      const setDir = join(evalDir, set.label.replace(/[^a-z0-9-]+/g, '_'));
      mkdirSync(setDir, { recursive: true });
      const inputFile = join(setDir, 'input.json');
      writeFileSync(inputFile, JSON.stringify({ ...template, name: 'eval-local-shop', baseUrl: `http://127.0.0.1:${port}` }, null, 2) + '\n');

      for (let run = 1; run <= args.runs; run++) {
        const label = `${set.label} run ${run}/${args.runs}`;
        console.log(`--- ${label} ---`);
        const exitCode = await runAgent(inputFile, join(setDir, `run-${run}.log`));
        const record: RunRecord = { set: set.label, run, exitCode, score: null, key: null };
        if (!existsSync(SUMMARY_FILE)) {
          record.error = `agent exited ${exitCode} and wrote no ${SUMMARY_FILE} (see ${join(setDir, `run-${run}.log`)})`;
          console.log(`  FAILED ${record.error}`);
        } else {
          copyFileSync(SUMMARY_FILE, join(setDir, `run-${run}.summary.json`));
          const summary = JSON.parse(readFileSync(SUMMARY_FILE, 'utf8')) as Summary;
          record.score = scoreRun(summary, set.bugs, catalog);
          record.key = findingKey(summary);
          // Only a completed run counts. no-tests, stopped-budget or refused is a failed run.
          if (summary.status !== 'completed') {
            record.error = `agent status "${summary.status}" (see ${join(setDir, `run-${run}.log`)})`;
            console.log(`  FAILED ${record.error}`);
          }
          const s = record.score;
          console.log(
            `  status ${s.status}, detected ${s.detected}/${s.detectable}, false alarms ${s.falseAlarms.length}, not-yet ${s.expectedMisses}, calls ${s.claudeCalls}, ${s.durationSec}s`,
          );
          for (const b of s.bugs) console.log(`    ${pad(b.outcome, 13)} ${b.id}${b.findings.length ? `  <- ${b.findings.join(' ; ')}` : ''}`);
          for (const f of s.falseAlarms) console.log(`    FALSE ALARM   ${f.endpointId} [${f.type}] ${f.testTitle} (actual ${f.actualStatus})`);
        }
        records.push(record);
      }
    } finally {
      await stopApi(api);
    }
  }

  writeFileSync(join(evalDir, 'score.json'), JSON.stringify({ runs: args.runs, sets, records }, null, 2) + '\n');
  console.log(`\nwritten ${evalDir}/score.json\n`);
  printTable(records, sets, catalog);

  const failed = records.filter((r) => !r.score || r.error);
  if (failed.length) {
    console.error(`\n${failed.length} run(s) did not complete. See the run logs under ${evalDir}.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`eval FAILED ${(err as Error).message}`);
  process.exit(1);
});
