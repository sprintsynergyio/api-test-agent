import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, sep } from 'node:path';
import { BudgetExceeded, claudeBudget, claudeCallsUsed, claudeEnv, redact } from './claude';
import { apiName, loadConfig, type Config, type Endpoint } from './config';
import { frameworkFor, type FrameworkAdapter, type FrameworkInfo, type TestOutcome } from './frameworks';
import { generateEndpoint } from './generate';
import { planEndpoint, type Plan } from './plan';
import { probeAll, type ProbeResult } from './probe';
import { assessSafety, endpointAllowed, PRODUCTION_WRITES_WARNING, READ_ONLY_SKIP, refusalMessage, type Safety } from './safety';

// Full pipeline: probe, plan, generate, run tests, summarize.
// Console output and out/summary.json follow ui/CONTRACT.md. The output framework (Playwright or
// Pactum) is an adapter (agent/frameworks/); this file never knows which one runs.

const CONCURRENCY = 3;
const SUMMARY_FILE = 'out/summary.json';
const CLAUDE_NOT_FOUND = "claude CLI not found on PATH. Run 'which claude' in the terminal that starts the agent or UI.";

type EndpointState = {
  endpoint: Endpoint;
  probe?: ProbeResult;
  plan?: Plan;
  specFile: string | null;
  failureReason: string | null;
  skippedReason: string | null; // READ_ONLY_SKIP: never planned, generated, run or counted as passed
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

type RunStatus = 'completed' | 'stopped-budget' | 'no-tests' | 'refused';

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
    if (s.skippedReason) {
      console.log(`${id} SKIPPED read-only mode`);
      return;
    }
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

async function generatePhase(fw: FrameworkAdapter, states: EndpointState[]) {
  await forEachLimited(states, CONCURRENCY, async (s) => {
    const id = s.endpoint.id;
    if (s.skippedReason) {
      console.log(`${id} SKIPPED read-only mode`);
      return;
    }
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
      const result = await generateEndpoint(fw, s.endpoint, s.plan, s.probe!);
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

// Every plan and spec needs the claude CLI. Check that it starts, with the same child environment as
// the real calls, before probing, so a missing CLI ends the run with one clear message.
function claudeCliProblem(): string | null {
  const res = spawnSync('claude', ['--version'], { env: claudeEnv(), encoding: 'utf8', timeout: 30_000 });
  if ((res.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return CLAUDE_NOT_FOUND;
  if (res.error || res.status !== 0) {
    const detail = res.error ? res.error.message : `exit code ${res.status}`;
    return `claude CLI could not be started (${redact(detail)}). Run 'which claude' in the terminal that starts the agent or UI.`;
  }
  return null;
}

function writeSummary(o: {
  status: RunStatus;
  inputFile: string;
  config: Config;
  startedAt: Date;
  states: EndpointState[];
  outcomes: TestOutcome[];
  findings: Finding[];
  framework: FrameworkInfo | null;
  allureReport: string | null;
  secrets: string[];
  safety: Safety;
  requestsSent: number;
  testFramework: string;
}) {
  const { status, inputFile, config, startedAt, states, outcomes, findings, framework, allureReport, secrets, safety, requestsSent, testFramework } = o;
  const summary = {
    status,
    testFramework,
    inputFile,
    baseUrl: config.baseUrl,
    safety: { hostClass: safety.hostClass, mode: safety.mode, allowProduction: safety.allowProduction, allowWrites: safety.allowWrites },
    requestsSent,
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
        skippedReason: s.skippedReason,
      };
    }),
    findings,
    framework,
    allureReport,
  };
  mkdirSync('out', { recursive: true });
  writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2) + '\n');
  return summary;
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
  const fw = frameworkFor(config);
  for (const dir of ['generated', 'out', 'reports', 'test-results']) rmSync(dir, { recursive: true, force: true });

  // Safety guard first: a refused run sends no request and needs neither an auth value nor Claude.
  // AGENT_FORCE_PRODUCTION=1 (testing only) treats every host as production; it reaches the probe and,
  // through the environment, the Playwright run.
  const forceProduction = process.env.AGENT_FORCE_PRODUCTION === '1';
  const safety = assessSafety(config, { forceProduction });
  if (safety.mode === 'refused') {
    const message = refusalMessage(safety);
    console.log(message);
    writeSummary({
      status: 'refused',
      inputFile,
      config,
      startedAt,
      states: config.endpoints.map((endpoint) => ({ endpoint, specFile: null, failureReason: message, skippedReason: null })),
      outcomes: [],
      findings: [],
      framework: null,
      allureReport: null,
      secrets: [],
      safety,
      requestsSent: 0,
      testFramework: fw.name,
    });
    console.log(`Summary written to ${SUMMARY_FILE}`);
    process.exitCode = 1;
    return;
  }

  const authValue = config.auth ? process.env[config.auth.valueEnv] : undefined;
  if (config.auth && !authValue) {
    throw new Error(`Missing auth value: environment variable ${config.auth.valueEnv} is not set (required by ${inputFile}).`);
  }
  const secrets = authValue ? [authValue] : [];

  const claudeProblem = claudeCliProblem();
  if (claudeProblem) {
    console.log(claudeProblem);
    const blocked: EndpointState[] = config.endpoints.map((endpoint) => ({ endpoint, specFile: null, failureReason: claudeProblem, skippedReason: null }));
    writeSummary({
      status: 'no-tests',
      inputFile,
      config,
      startedAt,
      states: blocked,
      outcomes: [],
      findings: [],
      framework: null,
      allureReport: null,
      secrets,
      safety,
      requestsSent: 0,
      testFramework: fw.name,
    });
    console.log('NO TESTS GENERATED');
    console.log(`Summary written to ${SUMMARY_FILE}`);
    process.exitCode = 1;
    return;
  }

  console.log('=== PROBING ===');
  console.log(`safety: ${safety.hostClass} host, ${safety.mode} mode`);
  console.log(`framework: ${fw.name}`);
  if (safety.hostClass === 'production' && safety.mode === 'full') console.log(PRODUCTION_WRITES_WARNING);
  const probeRun = await probeAll(config, authValue, { forceProduction });
  let requestsSent = probeRun.requestsSent;
  const states: EndpointState[] = config.endpoints.map((endpoint) => ({
    endpoint,
    probe: probeRun.results.get(endpoint.id),
    specFile: null,
    failureReason: null,
    skippedReason: endpointAllowed(safety, endpoint) ? null : READ_ONLY_SKIP,
  }));
  for (const s of states) {
    if (s.probe && !s.probe.usable) s.failureReason = `probe not usable: ${s.probe.status ?? s.probe.error}`;
  }

  console.log('=== PLANNING ===');
  await planPhase(states);

  console.log('=== GENERATING ===');
  await generatePhase(fw, states);
  rmSync('generated/.candidate', { recursive: true, force: true });
  if (budgetHit) console.log('STOPPED: budget reached');

  const written = states.filter((s) => s.specFile);
  let status: RunStatus = budgetHit ? 'stopped-budget' : 'completed';
  let outcomes: TestOutcome[] = [];
  let allureReport: string | null = null;
  let htmlReport: string | null = null;

  if (written.length === 0) {
    status = 'no-tests';
  } else {
    console.log('=== RUNNING TESTS ===');
    const run = await fw.run(inputFile, { secrets, reportName: `${apiName(config, inputFile)} API tests`, cleanError: (t) => cleanError(t, secrets) });
    outcomes = run.outcomes;
    requestsSent += run.requestsSent;
    for (const e of run.loadErrors) console.log(`${fw.name} error: ${e}`);
    for (const s of written) {
      if (!outcomes.some((o) => o.endpointId === s.endpoint.id)) {
        s.failureReason = 'spec produced no test results (failed to load)';
      }
    }
    htmlReport = run.htmlReport;
    allureReport = run.allureReport;
    if (!run.allureReport) console.log(`allure report not generated: ${run.allureReason ?? 'unknown reason'}`);
  }

  const findings = outcomes
    .filter((o) => !o.passed)
    .map((o) => toFinding(o, states.find((s) => s.endpoint.id === o.endpointId)?.plan));

  let framework: FrameworkInfo | null = null;
  if (status !== 'no-tests') {
    framework = fw.exportFramework({
      config,
      inputFile,
      authValue,
      // The export README lists endpoints without a spec with their reason, read-only skips included.
      endpoints: states.map((s) => ({ ...s, failureReason: s.failureReason ?? s.skippedReason })),
      findings: findings.filter((f) => f.classification === 'suspected API finding'),
    });
  }

  const summary = writeSummary({ status, inputFile, config, startedAt, states, outcomes, findings, framework, allureReport, secrets, safety, requestsSent, testFramework: fw.name });

  console.log('=== SUMMARY ===');
  if (status === 'no-tests') {
    console.log('NO TESTS GENERATED');
    for (const s of states) console.log(`  ${s.endpoint.id}: ${oneLine(s.failureReason ?? s.skippedReason ?? 'unknown')}`);
    console.log(`Summary written to ${SUMMARY_FILE}`);
    process.exitCode = 1;
    return;
  }
  const t = summary.totals;
  const api = findings.filter((f) => f.classification === 'suspected API finding');
  const review = findings.filter((f) => f.classification === 'needs review');
  console.log(`Status: ${status}`);
  console.log(`Framework: ${fw.name}`);
  console.log(`Endpoints: ${t.endpoints}, specs written: ${written.length}, tests: ${t.testsGenerated}, passed: ${t.passed}, failed: ${t.failed}`);
  console.log(`Claude calls: ${summary.claudeCalls.used}/${summary.claudeCalls.budget}, duration: ${summary.durationSec}s`);
  console.log(`Safety: ${safety.hostClass} host, ${safety.mode} mode, requests sent: ${requestsSent}`);
  for (const s of summary.endpoints.filter((e) => e.skippedReason)) console.log(`  skipped: ${s.id}: ${s.skippedReason}`);
  for (const s of summary.endpoints.filter((e) => e.failureReason)) console.log(`  not tested: ${s.id}: ${s.failureReason}`);
  console.log(`${api.length} suspected API finding${api.length === 1 ? '' : 's'}`);
  for (const f of api) console.log(`  - ${f.testTitle}: expected ${f.expectedStatus}, got ${f.actualStatus}`);
  if (review.length) {
    console.log(`${review.length} need${review.length === 1 ? 's' : ''} review`);
    for (const f of review) console.log(`  - ${f.testTitle}: expected ${f.expectedStatus}, got ${f.actualStatus ?? 'no status'}`);
  }
  console.log(`Summary written to ${SUMMARY_FILE}${htmlReport ? `, report in ${htmlReport}` : ''}`);
  if (allureReport) console.log(`allure report written to ${allureReport}`);
  if (framework) console.log(`framework written to ${framework.dir} (${framework.files.length} files)`);
}

main().catch((err) => {
  console.error(`agent FAILED ${redact((err as Error).message)}`);
  process.exit(1);
});
