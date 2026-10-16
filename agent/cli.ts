import 'dotenv/config';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, sep } from 'node:path';
import { BudgetExceeded, claudeBudget, claudeCallsUsed, redact } from './claude';
import { loadConfig, type Endpoint } from './config';
import { exportFramework, type FrameworkInfo } from './export';
import { generateEndpoint } from './generate';
import { planEndpoint, type Plan } from './plan';
import { probeAll, type ProbeResult } from './probe';

// Full pipeline: probe, plan, generate, run tests, summarize.
// Console output and out/summary.json follow ui/CONTRACT.md.

const CONCURRENCY = 3;
const RESULTS_FILE = 'reports/results.json';
const SUMMARY_FILE = 'out/summary.json';

type EndpointState = {
  endpoint: Endpoint;
  probe?: ProbeResult;
  plan?: Plan;
  specFile: string | null;
  failureReason: string | null;
};

type Finding = {
  endpointId: string;
  testTitle: string;
  type: string;
  expectedStatus: string | null;
  actualStatus: number | null;
  classification: 'suspected API finding' | 'needs review';
  error: string;
};

type TestOutcome = { endpointId: string; title: string; passed: boolean; actualStatus: number | null; error: string };

let budgetHit = false;

async function forEachLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ');
}

async function planPhase(states: EndpointState[]) {
  await forEachLimited(states, CONCURRENCY, async (s) => {
    const id = s.endpoint.id;
    if (budgetHit) {
      s.failureReason = 'skipped: budget reached';
      console.log(`${id} FAILED ${s.failureReason}`);
      return;
    }
    try {
      const result = await planEndpoint(s.endpoint, s.probe!);
      if (result.ok) {
        s.plan = result.plan;
        console.log(`${id} OK ${result.plan.cases.length} cases`);
      } else {
        s.failureReason = result.reason;
        console.log(`${id} FAILED ${oneLine(result.reason)}`);
      }
    } catch (err) {
      if (!(err instanceof BudgetExceeded)) throw err;
      budgetHit = true;
      s.failureReason = 'budget reached during planning';
      console.log(`${id} FAILED ${s.failureReason}`);
    }
  });
}

async function generatePhase(states: EndpointState[]) {
  await forEachLimited(states, CONCURRENCY, async (s) => {
    const id = s.endpoint.id;
    if (!s.plan) {
      console.log(`${id} FAILED skipped: no plan (${oneLine(s.failureReason ?? 'unknown')})`);
      return;
    }
    if (budgetHit) {
      s.failureReason = 'skipped: budget reached';
      console.log(`${id} FAILED ${s.failureReason}`);
      return;
    }
    try {
      const result = await generateEndpoint(s.endpoint, s.plan, s.probe!);
      if (result.ok) {
        s.specFile = basename(result.specFile);
        console.log(`${id} OK written ${result.specFile}`);
      } else {
        s.failureReason = `static gate: ${result.reasons.join(' | ')}`;
        console.log(`${id} FAILED ${oneLine(s.failureReason)}`);
      }
    } catch (err) {
      if (!(err instanceof BudgetExceeded)) throw err;
      budgetHit = true;
      s.failureReason = 'budget reached during generation';
      console.log(`${id} FAILED ${s.failureReason}`);
    }
  });
}

function runPlaywright(inputFile: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn('node_modules/.bin/playwright', ['test', '-c', 'playwright.generated.config.ts'], {
      env: { ...process.env, INPUT_FILE: inputFile },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', reject);
    child.on('close', resolve);
  });
}

const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

// Error text goes into summary.json and the UI: show paths relative to the project folder,
// and never a home folder like /Users/<name>/.
const PROJECT_ROOTS = [...new Set([process.cwd(), realpathSync(process.cwd())])];
function relativePaths(text: string): string {
  let out = text;
  for (const root of PROJECT_ROOTS) out = out.split(root + sep).join('');
  return out.replace(/(?:\/private)?\/(?:Users|home)\/[^/\s]+\//g, '~/');
}

function cleanError(text: string, secrets: string[]): string {
  return relativePaths(redact(stripAnsi(text), secrets));
}

type JsonSuite = { suites?: JsonSuite[]; specs?: JsonSpec[] };
type JsonAnnotation = { type: string; description?: string };
type JsonSpec = {
  title: string;
  file: string;
  tests: {
    status: string;
    annotations?: JsonAnnotation[];
    results: { status: string; annotations?: JsonAnnotation[]; errors?: { message?: string }[]; error?: { message?: string } }[];
  }[];
};

function readOutcomes(secrets: string[]): { outcomes: TestOutcome[]; loadErrors: string[] } {
  const report = JSON.parse(readFileSync(RESULTS_FILE, 'utf8')) as { suites?: JsonSuite[]; errors?: { message?: string }[] };
  const outcomes: TestOutcome[] = [];
  const walk = (suite: JsonSuite) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests) {
        if (t.status === 'skipped') continue;
        const last = t.results[t.results.length - 1];
        const annotations = [...(t.annotations ?? []), ...(last?.annotations ?? [])];
        const statusNote = annotations.find((a) => a.type === 'actual-status')?.description;
        const actual = statusNote !== undefined && /^\d{3}$/.test(statusNote) ? Number(statusNote) : null;
        const message = last?.errors?.[0]?.message ?? last?.error?.message ?? '';
        outcomes.push({
          endpointId: basename(spec.file).replace(/\.spec\.ts$/, ''),
          title: spec.title,
          passed: t.status === 'expected' || t.status === 'flaky',
          actualStatus: actual,
          error: cleanError(message, secrets).slice(0, 300),
        });
      }
    }
    (suite.suites ?? []).forEach(walk);
  };
  (report.suites ?? []).forEach(walk);
  const loadErrors = (report.errors ?? []).map((e) => cleanError(e.message ?? '', secrets).split('\n')[0]);
  return { outcomes, loadErrors };
}

function classify(type: string, actual: number | null): Finding['classification'] {
  if (actual === null) return 'needs review';
  if (actual >= 500) return 'suspected API finding';
  if ((type === 'auth' || type === 'invalid-input') && actual >= 200 && actual < 300) return 'suspected API finding';
  return 'needs review';
}

function toFinding(o: TestOutcome, plan: Plan | undefined): Finding {
  const type = o.title.match(/^\[(happy|schema|invalid-input|auth)\]/)?.[1] ?? 'unknown';
  const planCase = plan?.cases.find((c) => c.title === o.title) ?? plan?.cases.find((c) => c.type === type);
  return {
    endpointId: o.endpointId,
    testTitle: o.title,
    type,
    expectedStatus: planCase?.expectedStatus ?? null,
    actualStatus: o.actualStatus,
    classification: classify(type, o.actualStatus),
    error: o.error,
  };
}

async function main() {
  const inputFile = process.argv[2] || 'input/endpoints.json';
  const startedAt = new Date();
  const config = loadConfig(inputFile);
  const authValue = config.auth ? process.env[config.auth.valueEnv] : undefined;
  if (config.auth && !authValue) {
    throw new Error(`Missing auth value: environment variable ${config.auth.valueEnv} is not set (required by ${inputFile}).`);
  }
  const secrets = authValue ? [authValue] : [];

  for (const dir of ['generated', 'out', 'reports', 'test-results']) rmSync(dir, { recursive: true, force: true });

  console.log('=== PROBING ===');
  const probes = await probeAll(config, authValue);
  const states: EndpointState[] = config.endpoints.map((endpoint, i) => ({
    endpoint,
    probe: probes[i],
    specFile: null,
    failureReason: null,
  }));
  for (const s of states) {
    if (s.probe && !s.probe.usable) s.failureReason = `probe not usable: ${s.probe.status ?? s.probe.error}`;
  }

  console.log('=== PLANNING ===');
  await planPhase(states);

  console.log('=== GENERATING ===');
  await generatePhase(states);
  rmSync('generated/.candidate', { recursive: true, force: true });
  if (budgetHit) console.log('STOPPED: budget reached');

  const written = states.filter((s) => s.specFile);
  let status: 'completed' | 'stopped-budget' | 'no-tests' = budgetHit ? 'stopped-budget' : 'completed';
  let outcomes: TestOutcome[] = [];

  if (written.length === 0) {
    status = 'no-tests';
  } else {
    console.log('=== RUNNING TESTS ===');
    await runPlaywright(inputFile);
    if (!existsSync(RESULTS_FILE)) throw new Error(`Playwright did not write ${RESULTS_FILE}`);
    const read = readOutcomes(secrets);
    outcomes = read.outcomes;
    for (const e of read.loadErrors) console.log(`Playwright error: ${e}`);
    for (const s of written) {
      if (!outcomes.some((o) => o.endpointId === s.endpoint.id)) {
        s.failureReason = 'spec produced no test results (failed to load)';
      }
    }
  }

  const findings = outcomes
    .filter((o) => !o.passed)
    .map((o) => toFinding(o, states.find((s) => s.endpoint.id === o.endpointId)?.plan));

  let framework: FrameworkInfo | null = null;
  if (status !== 'no-tests') {
    framework = exportFramework({
      config,
      inputFile,
      authValue,
      endpoints: states,
      findings: findings.filter((f) => f.classification === 'suspected API finding'),
    });
  }

  const summary = {
    status,
    inputFile,
    baseUrl: config.baseUrl,
    startedAt: startedAt.toISOString(),
    durationSec: Math.round((Date.now() - startedAt.getTime()) / 1000),
    claudeCalls: { used: claudeCallsUsed(), budget: claudeBudget() },
    totals: {
      endpoints: states.length,
      testsGenerated: outcomes.length,
      passed: outcomes.filter((o) => o.passed).length,
      failed: outcomes.filter((o) => !o.passed).length,
    },
    endpoints: states.map((s) => {
      const mine = outcomes.filter((o) => o.endpointId === s.endpoint.id);
      return {
        id: s.endpoint.id,
        method: s.endpoint.method,
        path: s.endpoint.path,
        requiresAuth: s.endpoint.requiresAuth,
        probeStatus: s.probe?.status ?? null,
        casesPlanned: s.plan?.cases.length ?? 0,
        specWritten: s.specFile !== null,
        specFile: s.specFile,
        passed: mine.filter((o) => o.passed).length,
        failed: mine.filter((o) => !o.passed).length,
        failureReason: s.failureReason === null ? null : cleanError(oneLine(s.failureReason), secrets),
      };
    }),
    findings,
    framework,
  };
  mkdirSync('out', { recursive: true });
  writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2) + '\n');

  console.log('=== SUMMARY ===');
  if (status === 'no-tests') {
    console.log('NO TESTS GENERATED');
    for (const s of states) console.log(`  ${s.endpoint.id}: ${oneLine(s.failureReason ?? 'unknown')}`);
    console.log(`Summary written to ${SUMMARY_FILE}`);
    process.exitCode = 1;
    return;
  }
  const t = summary.totals;
  const api = findings.filter((f) => f.classification === 'suspected API finding');
  const review = findings.filter((f) => f.classification === 'needs review');
  console.log(`Status: ${status}`);
  console.log(`Endpoints: ${t.endpoints}, specs written: ${written.length}, tests: ${t.testsGenerated}, passed: ${t.passed}, failed: ${t.failed}`);
  console.log(`Claude calls: ${summary.claudeCalls.used}/${summary.claudeCalls.budget}, duration: ${summary.durationSec}s`);
  for (const s of summary.endpoints.filter((e) => e.failureReason)) console.log(`  not tested: ${s.id}: ${s.failureReason}`);
  console.log(`${api.length} suspected API finding${api.length === 1 ? '' : 's'}`);
  for (const f of api) console.log(`  - ${f.testTitle}: expected ${f.expectedStatus}, got ${f.actualStatus}`);
  if (review.length) {
    console.log(`${review.length} need${review.length === 1 ? 's' : ''} review`);
    for (const f of review) console.log(`  - ${f.testTitle}: expected ${f.expectedStatus}, got ${f.actualStatus ?? 'no status'}`);
  }
  console.log(`Summary written to ${SUMMARY_FILE}, report in reports/html`);
  if (framework) console.log(`framework written to ${framework.dir} (${framework.files.length} files)`);
}

main().catch((err) => {
  console.error(`agent FAILED ${redact((err as Error).message)}`);
  process.exit(1);
});
