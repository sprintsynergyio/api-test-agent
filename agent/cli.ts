import 'dotenv/config';
import { claudeCommand } from './claude-bin';
import { redactHomeFolders } from './home-paths';
import { responseSchemaIssues } from './response-schema';
import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { extraRoles, pickAuthEnv, secretValues } from './auth';
import { BudgetExceeded, claudeBudget, claudeCallsUsed, claudeEnv, describeModelChoice, fakeModelEnabled, hostedWithoutApiKeyProblem, modelChoice, promptRedaction, redact, usingApiKey } from './claude';
import { CHECKPOINT_FILE, endpointHash, hashOf, inputHash, loadCheckpoint, newCheckpoint, reusable, saveCheckpoint, type Checkpoint, type ScopeMode } from './checkpoint';
import { parseAgentFlags, type AgentFlags } from './flags';
import { apiName, DEFAULT_TEST_CASE_MODE, loadConfig, selectionLine, takeSelectFlag, type Config, type Endpoint, type TestCaseMode } from './config';
import { atlassianSecrets, isLinkSource, loadLinkCases, redactSecrets } from './atlassian';
import { loadSheetFile, prepareSheetCases, type MatchResult, type ParsedSheet, type SheetCase } from './test-cases';
import { loadTestData, type TestData } from './test-data';
import { matchCases } from './match-cases';
import { buildTraceRows, coverageGaps, traceCsv, traceTotals, traceXlsx, type TraceRow } from './traceability';
import { testTypeOf } from './model';
import { frameworkFor, outcomeKind, type FrameworkAdapter, type FrameworkInfo, type TestOutcome } from './frameworks';
import { generateEndpoint } from './generate';
import { dataStability, planEndpoint, type Plan, type Stability } from './plan';
import { addCleanup, cleanupLine, emptyCleanup, type CleanupTotals } from './http';
import { probeAll, type ProbeResult } from './probe';
import { resolveHostAddresses } from './resolve-host';
import { EXIT_ERROR, runExitCode, type FailOn } from './exit-codes';
import { assessSafety, endpointAllowed, PRODUCTION_WRITES_WARNING, READ_ONLY_SKIP, refusalMessage, type Safety } from './safety';

// Full pipeline: probe, plan, generate, run tests, summarize.
// Console output and out/summary.json follow ui/CONTRACT.md. The output framework (Playwright or
// Pactum) is an adapter (agent/frameworks/); this file never knows which one runs.

// Plans and generations in flight at once; --concurrency N sets it per run.
let CONCURRENCY = 3;
const SUMMARY_FILE = 'out/summary.json';
const CLAUDE_NOT_FOUND = "claude CLI not found on PATH. Run 'which claude' in the terminal that starts the agent or UI.";

type EndpointState = {
  endpoint: Endpoint;
  // Whole spec rejected by the gate: the reasons of each planned test, by title (traceability).
  caseReasons?: Record<string, string[]>;
  // Test case sheet runs: hash of this endpoint's sheet cases and the mode (checkpoint).
  casesHash?: string;
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

type Reused = { probes: number; plans: number; specs: number };
type Scope = { mode: ScopeMode; endpoints: string[] | null; reused: Reused; concurrency: number; testWorkers: number };

let budgetHit = false;

// Test case sheet run (agent/test-cases.ts): the parsed sheet, the mode, and each case's endpoint.
type SheetRun = { file: string; mode: TestCaseMode; sheet: ParsedSheet; matches: Map<string, MatchResult>; byEndpoint: Map<string, SheetCase[]> };
let sheetRun: SheetRun | null = null;
const TRACE_CSV = 'out/traceability.csv';
const TRACE_XLSX = 'out/traceability.xlsx';
export const BUDGET_HINT = 'stopped at budget: run again with --resume to continue';

// Set by main(): every stage change is written to out/checkpoint.json right away.
let checkpoint: Checkpoint | null = null;
function record(s: EndpointState) {
  if (!checkpoint) return;
  const stage = s.specFile ? 'generated' : s.failureReason ? 'failed' : s.plan ? 'planned' : s.probe ? 'probed' : 'failed';
  checkpoint.endpoints[s.endpoint.id] = {
    hash: endpointHash(s.endpoint),
    stage,
    ...(s.probe ? { probe: s.probe } : {}),
    ...(s.plan ? { plan: s.plan } : {}),
    ...(s.specFile ? { specFile: s.specFile } : {}),
    ...(s.failureReason ? { failureReason: s.failureReason } : {}),
    ...(s.skippedReason ? { skippedReason: s.skippedReason } : {}),
    ...(s.casesHash ? { casesHash: s.casesHash } : {}),
  };
  saveCheckpoint(checkpoint);
}

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

// Whether each endpoint's data stays put during the run (cross-call checks): set in main.
const STABILITY = new Map<string, Stability>();
const stabilityOf = (id: string): Stability | undefined => STABILITY.get(id);

function casesLine(plan: Plan): string {
  if (!sheetRun) return `${plan.cases.length} cases`;
  const sheet = plan.cases.filter((c) => c.source === 'sheet').length;
  const agent = plan.cases.filter((c) => c.source === 'agent').length;
  const review = plan.needsReview?.length ?? 0;
  return `${plan.cases.length} cases (${sheet} from the sheet, ${agent} agent suggestion${agent === 1 ? '' : 's'}${review ? `, ${review} need${review === 1 ? 's' : ''} review` : ''})`;
}

async function planPhase(states: EndpointState[], roles: string[]) {
  await forEachLimited(states, CONCURRENCY, async (s) => {
    const id = s.endpoint.id;
    if (s.skippedReason) {
      console.log(`${id} SKIPPED read-only mode`);
      return;
    }
    if (s.plan) {
      console.log(`${id} OK ${casesLine(s.plan)} (from checkpoint)`);
      return;
    }
    if (s.failureReason) {
      console.log(`${id} FAILED skipped: ${oneLine(s.failureReason)}`);
      return;
    }
    if (budgetHit) {
      // Not recorded as a failure in the checkpoint: --resume picks these up from their last good stage.
      s.failureReason = 'skipped: budget reached';
      console.log(`${id} FAILED ${s.failureReason}`);
      return;
    }
    try {
      const sheetOptions = sheetRun ? { sheetCases: sheetRun.byEndpoint.get(id) ?? [], testCaseMode: sheetRun.mode } : {};
      const result = await planEndpoint(s.endpoint, s.probe!, { roles, ...sheetOptions, stability: stabilityOf(id) });
      if (result.ok) {
        s.plan = result.plan;
        console.log(`${id} OK ${casesLine(result.plan)}`);
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
    record(s);
  });
}

async function generatePhase(fw: FrameworkAdapter, states: EndpointState[]) {
  await forEachLimited(states, CONCURRENCY, async (s) => {
    const id = s.endpoint.id;
    if (s.skippedReason) {
      console.log(`${id} SKIPPED read-only mode`);
      return;
    }
    if (s.specFile) {
      console.log(`${id} OK written generated/${s.specFile} (from checkpoint)`);
      return;
    }
    if (!s.plan) {
      console.log(`${id} FAILED skipped: no plan (${oneLine(s.failureReason ?? 'unknown')})`);
      return;
    }
    if (budgetHit) {
      // Not recorded as a failure in the checkpoint: --resume picks these up from their last good stage.
      s.failureReason = 'skipped: budget reached';
      console.log(`${id} FAILED ${s.failureReason}`);
      return;
    }
    try {
      const result = await generateEndpoint(fw, s.endpoint, s.plan, s.probe!, { stability: stabilityOf(id) });
      if (result.ok) {
        s.specFile = basename(result.specFile);
        s.plan = result.plan;
        const dropped = result.plan.notAutomated?.length ?? 0;
        console.log(`${id} OK written ${result.specFile}${dropped ? ` (${dropped} test${dropped === 1 ? '' : 's'} dropped by the static gate, the rest kept)` : ''}`);
      } else {
        s.failureReason = `static gate: ${result.reasons.join(' | ')}`;
        if (result.byTitle && Object.keys(result.byTitle).length) s.caseReasons = result.byTitle;
        console.log(`${id} FAILED ${oneLine(s.failureReason)}`);
      }
    } catch (err) {
      if (!(err instanceof BudgetExceeded)) throw err;
      budgetHit = true;
      s.failureReason = 'budget reached during generation';
      console.log(`${id} FAILED ${s.failureReason}`);
    }
    record(s);
  });
}

const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

// Error text goes into summary.json and the UI: show paths relative to the project folder,
// and never a home folder like /Users/<name>/.
const PROJECT_ROOTS = [...new Set([process.cwd(), realpathSync(process.cwd())])];
function relativePaths(text: string): string {
  let out = text;
  for (const root of PROJECT_ROOTS) out = out.split(root + sep).join('');
  return redactHomeFolders(out);
}

function cleanError(text: string, secrets: string[]): string {
  return relativePaths(redact(stripAnsi(text), secrets));
}

// Every plan and spec needs a model. Check the provider setup (and, on the CLI path, that claude starts
// with the same child environment as the real calls) before probing, so a missing key or CLI ends the
// run with one clear message.
function claudeCliProblem(): string | null {
  const hosted = hostedWithoutApiKeyProblem();
  if (hosted) return hosted;
  if (fakeModelEnabled() || usingApiKey()) return null;
  const claude = claudeCommand();
  const res = spawnSync(claude.command, [...claude.prefixArgs, '--version'], { env: claudeEnv(), encoding: 'utf8', timeout: 30_000, windowsHide: true });
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
  redactionReplaced: number;
  cleanup: CleanupTotals;
  scope: Scope;
  exitCode: number;
  failOn: FailOn;
  frameworkError?: string | null;
  testCases?: Record<string, unknown> | null;
}) {
  const { status, inputFile, config, startedAt, states, outcomes, findings, framework, allureReport, secrets, safety, requestsSent, testFramework, redactionReplaced, cleanup, scope, exitCode, failOn } = o;
  const choice = modelChoice();
  const summary = {
    // Bumped when a field changes meaning or is removed (adding a field does not bump it). ui/CONTRACT.md.
    schemaVersion: 1,
    status,
    testFramework,
    model: { provider: choice.provider, model: choice.model, via: choice.via },
    inputFile,
    baseUrl: config.baseUrl,
    selection: config.selection ?? null,
    safety: { hostClass: safety.hostClass, mode: safety.mode, allowProduction: safety.allowProduction, allowWrites: safety.allowWrites },
    requestsSent,
    redaction: { mode: config.redaction?.mode === 'strict' ? 'strict' : 'standard', fields: config.redaction?.fields?.length ?? 0, replaced: redactionReplaced },
    cleanup: {
      created: cleanup.created,
      createdByTests: cleanup.createdByTests,
      deleted: cleanup.deleted,
      failed: cleanup.failed,
      skippedNoDeleteEndpoint: cleanup.skippedNoDeleteEndpoint,
      failures: cleanup.failures.map((f) => cleanError(f, secrets)),
    },
    startedAt: startedAt.toISOString(),
    durationSec: Math.round((Date.now() - startedAt.getTime()) / 1000),
    claudeCalls: { used: claudeCallsUsed(), budget: claudeBudget() },
    // Scale (Phase 9): how this run was scoped. resumable: out/checkpoint.json can continue it.
    scope: {
      mode: scope.mode,
      endpoints: scope.endpoints,
      reused: scope.reused,
      resumable: budgetHit && checkpoint !== null,
      fakeModel: fakeModelEnabled(),
      concurrency: scope.concurrency,
      testWorkers: scope.testWorkers,
    },
    // passed counts real passes only. failed: failed tests and known issues whose test passed
    // (unexpected pass). skipped: tests that did not run, while running (blocked by the precondition
    // check) or by the sheet (skipped for missing test data, manual), with their reason codes in
    // skippedByCode. knownIssues: Known issue tests that failed as expected. None of them is passed.
    totals: {
      endpoints: states.length,
      testsGenerated: outcomes.length,
      passed: outcomes.filter((o) => outcomeKind(o) === 'passed').length,
      failed: outcomes.filter((o) => outcomeKind(o) === 'failed' || outcomeKind(o) === 'unexpected-pass').length,
      skipped: skippedTests(states, outcomes).length,
      knownIssues: outcomes.filter((o) => outcomeKind(o) === 'known-issue').length,
      skippedByCode: countBy(skippedTests(states, outcomes).map((x) => x.reasonCode)),
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
        passed: mine.filter((o) => outcomeKind(o) === 'passed').length,
        failed: mine.filter((o) => outcomeKind(o) === 'failed' || outcomeKind(o) === 'unexpected-pass').length,
        skipped: skippedTests([s], mine).length,
        knownIssues: mine.filter((o) => outcomeKind(o) === 'known-issue').length,
        failureReason: s.failureReason === null ? null : cleanError(oneLine(s.failureReason), secrets),
        skippedReason: s.skippedReason,
        // Where the probe response breaks the documented response schema; null without a schema, or
        // when the probe status is not the documented one.
        responseSchemaIssues: schemaIssuesFor(s),
      };
    }),
    findings,
    // Tests that did not run, each with its reason code, and the known issues (failed as expected, with
    // the Jira key in the reason). Listed in full, never hidden.
    skippedTests: skippedTests(states, outcomes).map((x) => ({ ...x, reason: cleanError(x.reason, secrets) })),
    knownIssues: outcomes.filter((o) => outcomeKind(o) === 'known-issue').map((o) => ({ endpointId: o.endpointId, testTitle: o.title, reason: cleanError(o.reason ?? '', secrets), actualStatus: o.actualStatus, error: o.error })),
    framework,
    // Why the standalone framework is missing when its export failed; the rest of the summary still holds.
    frameworkError: o.frameworkError ? cleanError(o.frameworkError, secrets) : null,
    allureReport,
    // Test case sheet runs: what happened to every sheet case (ui/CONTRACT.md section 15); null without a sheet.
    testCases: o.testCases ?? null,
    // The process exit code (README "Exit codes") and the --fail-on setting that produced it.
    exitCode,
    failOn,
  };
  mkdirSync('out', { recursive: true });
  writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2) + '\n');
  return summary;
}

// Tests that did not run: blocked by the precondition check while running, or skipped / manual by the
// sheet and the test data (the plan's coded placeholders).
function skippedTests(states: EndpointState[], outcomes: TestOutcome[]): { endpointId: string; testTitle: string; reasonCode: string; reason: string; when: 'run' | 'plan' }[] {
  const ids = new Set(states.map((s) => s.endpoint.id));
  const run = outcomes.filter((o) => outcomeKind(o) === 'blocked' && ids.has(o.endpointId)).map((o) => ({ endpointId: o.endpointId, testTitle: o.title, reasonCode: o.reasonCode ?? 'DATA_NOT_ON_ENV', reason: o.reason ?? '', when: 'run' as const }));
  const plan = states.flatMap((s) =>
    (s.specFile ? (s.plan?.needsReview ?? []) : [])
      .filter((n) => n.code && n.code !== 'SPEC_UNCLEAR')
      .map((n) => ({ endpointId: s.endpoint.id, testTitle: n.title ?? n.caseId, reasonCode: n.code!, reason: n.reason, when: 'plan' as const })),
  );
  return [...run, ...plan];
}

function countBy(keys: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = (out[k] ?? 0) + 1;
  return out;
}

function schemaIssuesFor(s: EndpointState): string[] | null {
  const doc = s.endpoint.responseSchema;
  if (!doc || !s.probe || s.probe.status !== doc.status) return null;
  return responseSchemaIssues(doc.schema, s.probe.body);
}

// Rule 4: a 5xx, or a 2xx where a rejection was expected (auth, authz, invalid-input), is an API finding.
function classify(type: string, actual: number | null): Finding['classification'] {
  if (actual === null) return 'needs review';
  if (actual >= 500) return 'suspected API finding';
  if ((type === 'auth' || type === 'authz' || type === 'invalid-input') && actual >= 200 && actual < 300) return 'suspected API finding';
  return 'needs review';
}

function toFinding(o: TestOutcome, plan: Plan | undefined): Finding {
  const type = testTypeOf(o.title) ?? 'unknown';
  // A known issue whose test passed: the bug may be fixed. Never an API finding, always needs review.
  if (outcomeKind(o) === 'unexpected-pass') {
    const planCase = plan?.cases.find((c) => c.title === o.title);
    return { endpointId: o.endpointId, testTitle: o.title, type, expectedStatus: planCase?.expectedStatus ?? null, actualStatus: o.actualStatus, classification: 'needs review', error: o.error };
  }
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

// Decide what this run covers: a fresh run, a resume of the last checkpoint, or only the changed
// endpoints. Returns the checkpoint to continue (fresh: a new one) and the mode that was really applied.
function resolveScope(flags: AgentFlags, config: Config, fw: FrameworkAdapter, inputFile: string, extra?: unknown): { mode: ScopeMode; cp: Checkpoint; prev: Checkpoint | null } {
  let mode: ScopeMode = flags.resume ? 'resume' : flags.onlyNew ? 'only-new' : 'fresh';
  let prev: Checkpoint | null = null;
  if (mode !== 'fresh') {
    prev = loadCheckpoint();
    if (!prev) {
      console.log(`${mode}: no ${CHECKPOINT_FILE} found, starting fresh`);
      mode = 'fresh';
    } else if (prev.inputFile !== inputFile || prev.framework !== fw.name) {
      console.log(`${mode}: ${CHECKPOINT_FILE} belongs to ${prev.inputFile} (${prev.framework}), starting fresh`);
      prev = null;
      mode = 'fresh';
    } else if (mode === 'resume' && prev.inputHash !== inputHash(config, extra)) {
      console.log(`resume: ${inputFile} changed since the checkpoint, starting fresh (use --only-new to regenerate only the changed endpoints)`);
      prev = null;
      mode = 'fresh';
    }
  }
  if (mode === 'fresh') {
    for (const dir of ['generated', 'out', 'reports', 'test-results']) rmSync(dir, { recursive: true, force: true });
    return { mode, cp: newCheckpoint(config, inputFile, fw.name, extra), prev: null };
  }
  // Resume or only-new: keep generated/ and out/, start the reports over.
  for (const dir of ['reports', 'test-results', 'generated/.candidate']) rmSync(dir, { recursive: true, force: true });
  const cp = prev!;
  cp.inputHash = inputHash(config, extra);
  // Specs of endpoints that changed or were removed must not run again.
  const current = new Set(config.endpoints.map((e) => e.id));
  for (const [id, entry] of Object.entries(cp.endpoints)) {
    const endpoint = config.endpoints.find((e) => e.id === id);
    const stale = !endpoint || !current.has(id) || entry.hash !== endpointHash(endpoint);
    if (stale) {
      if (entry.specFile) rmSync(join('generated', entry.specFile), { force: true });
      delete cp.endpoints[id];
    }
  }
  return { mode, cp, prev };
}

async function main() {
  const flags = parseAgentFlags(takeSelectFlag(process.argv.slice(2)));
  if (flags.budget !== null) process.env.MAX_CLAUDE_CALLS = String(flags.budget);
  CONCURRENCY = flags.concurrency;
  const inputFile = flags.inputFile;
  const startedAt = new Date();
  const config = loadConfig(inputFile);
  const fw = frameworkFor(config);
  // --allow-invalid-input / --stable-data [ids]: the same as the per-endpoint options in the input.
  for (const [flag, list, key] of [['--allow-invalid-input', flags.allowInvalidInput, 'allowInvalidInput'], ['--stable-data', flags.stableData, 'stableData']] as const) {
    if (!list) continue;
    if (list !== 'all') {
      const unknown = list.filter((id) => !config.endpoints.some((e) => e.id === id));
      if (unknown.length) throw new Error(`${flag}: not in ${inputFile}: ${unknown.join(', ')}`);
    }
    for (const e of config.endpoints) if (list === 'all' || list.includes(e.id)) e[key] = true;
  }
  if (flags.endpoints) {
    const unknown = flags.endpoints.filter((id) => !config.endpoints.some((e) => e.id === id));
    if (unknown.length) throw new Error(`--endpoints: not in ${inputFile}: ${unknown.join(', ')}`);
  }
  // The test case sheet: --test-cases (a file, or a Jira / Confluence link or JQL), else the input's
  // testCases.link, else testCases.file (relative to the input file).
  const cfgSheet = config.testCases?.file ? (isAbsolute(config.testCases.file) ? config.testCases.file : join(dirname(inputFile), config.testCases.file)) : null;
  const sheetSource = flags.testCases ?? config.testCases?.link ?? cfgSheet;
  const sheetIsLink = sheetSource !== null && isLinkSource(sheetSource);
  const sheetFile = sheetSource;
  const sheetMode: TestCaseMode = flags.testCasesMode ?? config.testCases?.mode ?? DEFAULT_TEST_CASE_MODE;
  let sheet: ParsedSheet | null = null;
  if (sheetSource) {
    try {
      sheet = sheetIsLink ? await loadLinkCases(sheetSource) : await loadSheetFile(sheetSource);
    } catch (err) {
      throw new Error(`test case ${sheetIsLink ? 'link' : 'sheet'}: ${redactSecrets((err as Error).message, atlassianSecrets())}`);
    }
  } else if (flags.testCasesMode) throw new Error('--test-cases-mode needs a test case sheet (--test-cases <file or link> or testCases in the input)');
  // The per-environment test data file: --test-data, else the input's testData (relative to the input).
  // Its values fill the sheet's [NAME] placeholders; the test run reads it (TEST_DATA_FILE) for the
  // Required data precondition check.
  const testDataFile = flags.testData ?? (config.testData ? (isAbsolute(config.testData) ? config.testData : join(dirname(inputFile), config.testData)) : null);
  const testData: TestData | null = testDataFile ? loadTestData(testDataFile) : null;
  if (testDataFile) process.env.TEST_DATA_FILE = resolve(testDataFile);
  else delete process.env.TEST_DATA_FILE;
  if (testData) console.log(`test data: ${relativePaths(testDataFile!)}${testData.environment ? ` (${testData.environment})` : ''}: ${Object.keys(testData.values).length} value(s)${testData.lookup ? `, required data looked up with ${testData.lookup.endpointId}` : ''}`);
  if (testData?.lookup && !config.endpoints.some((e) => e.id === testData.lookup!.endpointId && e.method === 'GET')) throw new Error(`test data file: lookup.endpointId "${testData.lookup.endpointId}" is not a GET endpoint in ${inputFile}`);
  if (sheet) {
    const prepared = prepareSheetCases(sheet.cases, testData);
    sheet = { ...sheet, cases: prepared.cases, warnings: [...sheet.warnings, ...prepared.notes.map((message) => ({ row: null, caseId: null, message }))] };
  }
  const sheetDisplay = sheetSource ? (sheetIsLink ? sheetSource : relativePaths(isAbsolute(sheetSource) ? sheetSource : relative('.', sheetSource)).split(sep).join('/')) : null;
  const { mode, cp } = resolveScope(flags, config, fw, inputFile, sheet ? { sheet: sheet.hash, mode: sheetMode, ...(testData ? { testData: hashOf(testData) } : {}) } : undefined);
  let inScope = flags.endpoints ? config.endpoints.filter((e) => flags.endpoints!.includes(e.id)) : config.endpoints;
  const scope: Scope = { mode, endpoints: flags.endpoints, reused: { probes: 0, plans: 0, specs: 0 }, concurrency: flags.concurrency, testWorkers: flags.testWorkers };

  // Safety guard first: a refused run sends no request and needs neither an auth value nor Claude.
  // AGENT_FORCE_PRODUCTION=1 (testing only) treats every host as production; it reaches the probe and,
  // through the environment, the Playwright run.
  const forceProduction = process.env.AGENT_FORCE_PRODUCTION === '1';
  // The host name is resolved once: a name that points at this machine or a private network is marked,
  // and refused in hosted mode, before any request (agent/safety.ts, resolved option).
  const safety = assessSafety(config, { forceProduction, resolved: await resolveHostAddresses(config.baseUrl) });
  if (safety.mode === 'refused') {
    const message = refusalMessage(safety);
    console.log(message);
    writeSummary({
      status: 'refused',
      inputFile,
      config,
      startedAt,
      states: inScope.map((endpoint) => ({ endpoint, specFile: null, failureReason: message, skippedReason: null })),
      outcomes: [],
      findings: [],
      framework: null,
      allureReport: null,
      secrets: [],
      safety,
      requestsSent: 0,
      testFramework: fw.name,
      redactionReplaced: 0,
      cleanup: emptyCleanup(),
      scope,
      exitCode: EXIT_ERROR,
      failOn: flags.failOn,
    });
    console.log(`Summary written to ${SUMMARY_FILE}`);
    process.exitCode = EXIT_ERROR;
    return;
  }

  // Only the environment variables the auth section names (agent/auth.ts); a missing one is reported
  // by name before any request. secrets: every secret credential value (passwords, keys, header
  // values; not plain usernames), plus the tokens the probe logins produce.
  const authEnv = pickAuthEnv(config.auth, process.env);
  const secrets = secretValues(config.auth, authEnv);
  // Jira / Confluence tokens never reach a summary, error or log line either.
  for (const sec of atlassianSecrets()) if (!secrets.includes(sec)) secrets.push(sec);
  const roles = extraRoles(config.auth);

  const claudeProblem = claudeCliProblem();
  if (claudeProblem) {
    console.log(claudeProblem);
    const blocked: EndpointState[] = inScope.map((endpoint) => ({ endpoint, specFile: null, failureReason: claudeProblem, skippedReason: null }));
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
      redactionReplaced: 0,
      cleanup: emptyCleanup(),
      scope,
      exitCode: EXIT_ERROR,
      failOn: flags.failOn,
    });
    console.log('NO TESTS GENERATED');
    console.log(`Summary written to ${SUMMARY_FILE}`);
    process.exitCode = EXIT_ERROR;
    return;
  }

  console.log('=== PROBING ===');
  console.log(`safety: ${safety.hostClass} host, ${safety.mode} mode`);
  if (safety.resolvesToLocal?.length) console.log(`safety note: ${safety.host} resolves to a local or private address (${safety.resolvesToLocal.join(', ')}); it keeps its ${safety.hostClass} rules`);
  console.log(`framework: ${fw.name}`);
  console.log(describeModelChoice());
  if (fakeModelEnabled()) console.log('model: FAKE_MODEL=1 test mode, no model is called');
  const selected = selectionLine(config);
  if (selected) console.log(selected);
  if (flags.endpoints) console.log(`endpoints: ${flags.endpoints.join(', ')}`);
  if (safety.hostClass === 'production' && safety.mode === 'full') console.log(PRODUCTION_WRITES_WARNING);

  // Test case sheet: match every case to an endpoint (column or steps first, the model for the rest),
  // then, in sheet-only mode, keep only the endpoints that have cases.
  const outOfScope = new Map<string, string>();
  if (sheet && sheetFile) {
    const refs = config.endpoints.map((e) => ({ id: e.id, method: e.method, path: e.path }));
    let matched: Awaited<ReturnType<typeof matchCases>>;
    try {
      matched = await matchCases(sheet.cases, refs, { useModel: true });
    } catch (err) {
      throw new Error(`test case sheet: ${(err as Error).message}`);
    }
    if (matched.budgetHit) budgetHit = true;
    const byEndpoint = new Map<string, SheetCase[]>();
    for (const c of sheet.cases) {
      const m = matched.results.get(c.id);
      if (m?.endpointId) byEndpoint.set(m.endpointId, [...(byEndpoint.get(m.endpointId) ?? []), c]);
    }
    sheetRun = { file: sheetDisplay ?? sheetFile, mode: sheetMode, sheet, matches: matched.results, byEndpoint };
    const results = [...matched.results.values()];
    const count = (by: string) => results.filter((r) => r.by === by).length;
    const unmatched = sheet.cases.filter((c) => !matched.results.get(c.id)?.endpointId);
    console.log(`test cases: ${sheet.cases.length} from ${sheetRun.file} (${sheet.format}, ${sheetMode}): ${sheet.cases.length - unmatched.length} matched (${count('column')} by the Endpoint column, ${count('steps')} by the steps, ${count('ai')} by the AI), ${unmatched.length} not matched`);
    for (const w of sheet.warnings.slice(0, 20)) console.log(`  sheet warning${w.row ? ` row ${w.row}` : ''}: ${w.message}`);
    if (sheet.warnings.length > 20) console.log(`  ... ${sheet.warnings.length - 20} more sheet warnings`);
    for (const c of unmatched) console.log(`  not matched: ${c.id}: ${oneLine(matched.results.get(c.id)?.reason ?? 'unknown')}`);
    if (flags.endpoints) {
      for (const id of byEndpoint.keys()) if (!flags.endpoints.includes(id)) outOfScope.set(id, `endpoint ${id} is not in --endpoints for this run`);
    }
    if (sheetMode === 'sheet-only') {
      inScope = inScope.filter((e) => byEndpoint.has(e.id));
      console.log(`test cases: sheet-only, ${inScope.length} endpoint${inScope.length === 1 ? '' : 's'} with cases in scope${inScope.length ? `: ${inScope.map((e) => e.id).join(', ')}` : ''}`);
    }
  }
  const casesHashFor = (id: string) => (sheetRun ? hashOf({ mode: sheetRun.mode, cases: sheetRun.byEndpoint.get(id) ?? [] }) : undefined);

  // What the checkpoint already holds for the endpoints in scope.
  for (const e of inScope) STABILITY.set(e.id, dataStability(e, inScope));
  const states: EndpointState[] = inScope.map((endpoint) => {
    const casesHash = casesHashFor(endpoint.id);
    const found = reusable(cp, endpoint, mode);
    // A changed set of sheet cases for this endpoint keeps the probe and plans again.
    const entry = found && found.casesHash !== casesHash ? (found.probe ? { ...found, stage: 'probed' as const, plan: undefined, specFile: undefined } : null) : found;
    const skippedReason = endpointAllowed(safety, endpoint) ? null : READ_ONLY_SKIP;
    if (entry && !skippedReason) {
      // A recorded failure is retried from its last good stage: with a plan, generate again; with a
      // usable probe, plan again; otherwise probe again. Only a usable probe counts as done.
      const probe = entry.probe && entry.probe.usable ? entry.probe : undefined;
      const plan = probe && (entry.stage === 'planned' || entry.stage === 'generated' || entry.stage === 'failed') ? entry.plan : undefined;
      const specFile = plan && entry.stage === 'generated' ? (entry.specFile ?? null) : null;
      if (probe) scope.reused.probes++;
      if (plan) scope.reused.plans++;
      if (specFile) scope.reused.specs++;
      return { endpoint, casesHash, probe, plan, specFile, failureReason: null, skippedReason: null };
    }
    return { endpoint, casesHash, specFile: null, failureReason: null, skippedReason };
  });
  checkpoint = cp;
  if (mode !== 'fresh') console.log(`${mode}: ${scope.reused.specs} of ${inScope.length} endpoints already done (reusing ${scope.reused.probes} probes, ${scope.reused.plans} plans, ${scope.reused.specs} specs)`);

  const toProbe = new Set(states.filter((s) => !s.probe && !s.skippedReason).map((s) => s.endpoint.id));
  for (const s of states) if (s.probe) console.log(`${s.endpoint.id} OK ${s.probe.status} (from checkpoint)`);
  let requestsSent = 0;
  let redactionReplaced = 0;
  const cleanup = emptyCleanup();
  if (toProbe.size > 0 || mode === 'fresh') {
    const only = mode === 'fresh' && !flags.endpoints && sheetRun?.mode !== 'sheet-only' ? undefined : toProbe;
    const probeRun = await probeAll(config, authEnv, { forceProduction, only });
    for (const sec of probeRun.secrets) if (!secrets.includes(sec)) secrets.push(sec);
    requestsSent += probeRun.requestsSent;
    redactionReplaced += probeRun.redaction.replaced;
    addCleanup(cleanup, probeRun.cleanup);
    for (const s of states) {
      if (!s.probe && probeRun.results.has(s.endpoint.id)) s.probe = probeRun.results.get(s.endpoint.id);
    }
  }
  for (const s of states) {
    if (s.probe && !s.probe.usable && !s.specFile) s.failureReason = `probe not usable: ${s.probe.status ?? s.probe.error}`;
    const schemaIssues = schemaIssuesFor(s);
    if (schemaIssues?.length) console.log(`${s.endpoint.id}: probe response differs from the documented schema: ${schemaIssues.slice(0, 3).join('; ')}${schemaIssues.length > 3 ? ` (+${schemaIssues.length - 3} more)` : ''}`);
    if (!s.skippedReason) record(s);
  }

  console.log('=== PLANNING ===');
  await planPhase(states, roles);

  console.log('=== GENERATING ===');
  await generatePhase(fw, states);
  rmSync('generated/.candidate', { recursive: true, force: true });
  if (budgetHit) {
    console.log('STOPPED: budget reached');
    console.log(BUDGET_HINT);
  }

  const written = states.filter((s) => s.specFile);
  let status: RunStatus = budgetHit ? 'stopped-budget' : 'completed';
  let outcomes: TestOutcome[] = [];
  let allureReport: string | null = null;
  let htmlReport: string | null = null;

  if (written.length === 0) {
    status = 'no-tests';
  } else {
    console.log('=== RUNNING TESTS ===');
    if (flags.testWorkers > 1) console.log(`test workers: ${flags.testWorkers} (tests share the target API; use 1 if data-dependent tests interfere)`);
    const run = await fw.run(inputFile, {
      secrets,
      reportName: `${apiName(config, inputFile)} API tests`,
      cleanError: (t) => cleanError(t, secrets),
      specFiles: written.map((s) => `generated/${s.specFile!}`),
      workers: flags.testWorkers,
      extraLabels: coverageLabels(written),
    });
    for (const n of run.notes ?? []) console.log(n);
    outcomes = run.outcomes;
    requestsSent += run.requestsSent;
    redactionReplaced += run.redactionReplaced;
    addCleanup(cleanup, run.cleanup);
    for (const e of run.loadErrors) console.log(`${fw.name} error: ${e}`);
    for (const s of written) {
      // A spec of needs-review placeholders only has nothing that runs.
      if (s.plan && s.plan.cases.length === 0) continue;
      if (!outcomes.some((o) => o.endpointId === s.endpoint.id)) {
        s.failureReason = 'spec produced no test results (failed to load)';
      }
    }
    htmlReport = run.htmlReport;
    allureReport = run.allureReport;
    if (!run.allureReport) console.log(`allure report not generated: ${run.allureReason ?? 'unknown reason'}`);
  }

  // Only real failures and unexpected passes are findings: a blocked test or a known issue that failed
  // as expected is listed separately (summary.skippedTests, summary.knownIssues), never as passed.
  const findings = outcomes
    .filter((o) => outcomeKind(o) === 'failed' || outcomeKind(o) === 'unexpected-pass')
    .map((o) => toFinding(o, states.find((s) => s.endpoint.id === o.endpointId)?.plan));

  // The prompt-level pass (agent/claude.ts) counts what the structured redaction did not already hide.
  redactionReplaced += promptRedaction.replaced;
  const untested = states.filter((s) => s.failureReason !== null && !s.skippedReason).length;
  // Test case sheet: the back-map, one row per sheet case, then the agent's suggestions.
  let traceRows: TraceRow[] = [];
  let testCases: Record<string, unknown> | null = null;
  if (sheetRun) {
    traceRows = buildTraceRows({
      cases: sheetRun.sheet.cases,
      matches: sheetRun.matches,
      endpoints: states.map((s) => ({ endpointId: s.endpoint.id, specFile: s.specFile, plan: s.plan, failureReason: s.failureReason === null ? null : cleanError(oneLine(s.failureReason), secrets), skippedReason: s.skippedReason, caseReasons: s.caseReasons })),
      outOfScope: new Map([...outOfScope, ...[...sheetRun.byEndpoint.keys()].filter((id) => !states.some((s) => s.endpoint.id === id) && !outOfScope.has(id)).map((id) => [id, `endpoint ${id} is not in this run`] as [string, string])]),
      outcomes,
      findings,
      ran: written.length > 0,
    }).map((r) => ({ ...r, reason: cleanError(r.reason, secrets) }));
    mkdirSync('out', { recursive: true });
    writeFileSync(TRACE_CSV, traceCsv(traceRows));
    writeFileSync(TRACE_XLSX, traceXlsx(traceRows));
    testCases = {
      file: sheetRun.file,
      mode: sheetRun.mode,
      format: sheetRun.sheet.format,
      // A Jira, Confluence or Zephyr Scale link: what was read (null for a sheet file).
      source: sheetRun.sheet.source ? { kind: sheetRun.sheet.source.kind, label: sheetRun.sheet.source.label, steps: sheetRun.sheet.source.steps } : null,
      columns: sheetRun.sheet.columns,
      ...traceTotals(traceRows),
      warnings: sheetRun.sheet.warnings.map((w) => `${w.row ? `row ${w.row}: ` : ''}${w.message}`),
      traceability: { csv: TRACE_CSV, xlsx: TRACE_XLSX },
      cases: traceRows.filter((r) => r.source === 'sheet').map((r) => ({ id: r.id, title: r.title, endpoint: r.endpoint || null, testFile: r.testFile || null, status: r.status, reasonCode: r.reasonCode ?? null, reason: r.reason, coverage: r.coverage || null, asserted: r.asserted ?? 0, clauses: r.clauses ?? 0, jira: r.jira ?? null, confluence: r.confluence ?? null })),
    };
  }
  const summaryInput = { status, inputFile, config, startedAt, states, outcomes, findings, allureReport, secrets, safety, requestsSent, testFramework: fw.name, redactionReplaced, cleanup, scope, failOn: flags.failOn, testCases };
  const skippedCount = skippedTests(states, outcomes).length;
  let exitCode = runExitCode({ status, findings: findings.length, untestedEndpoints: untested, exportFailed: false, failOn: flags.failOn, skipped: skippedCount });
  // The summary is written before the export, so a failed export never loses the run's results.
  let summary = writeSummary({ ...summaryInput, framework: null, exitCode });

  let framework: FrameworkInfo | null = null;
  let frameworkError: string | null = null;
  if (status !== 'no-tests') {
    try {
      // AGENT_TEST_EXPORT_FAIL=1 (testing only) makes the export fail, to prove the summary survives it.
      if (process.env.AGENT_TEST_EXPORT_FAIL === '1') throw new Error('FRAMEWORK EXPORT FAILED: AGENT_TEST_EXPORT_FAIL=1 (testing only)');
      framework = fw.exportFramework({
        config,
        inputFile,
        secrets,
        // The export README lists endpoints without a spec with their reason, read-only skips included.
        endpoints: states.map((s) => ({ ...s, failureReason: s.failureReason ?? s.skippedReason })),
        findings: findings.filter((f) => f.classification === 'suspected API finding'),
        extraFiles: sheetRun ? [{ path: 'traceability.csv', content: traceCsv(traceRows) }] : [],
        testData,
      });
    } catch (err) {
      frameworkError = (err as Error).message;
      console.log(`framework export failed: ${cleanError(oneLine(frameworkError), secrets)}`);
    }
    exitCode = runExitCode({ status, findings: findings.length, untestedEndpoints: untested, exportFailed: frameworkError !== null, failOn: flags.failOn, skipped: skippedCount });
    summary = writeSummary({ ...summaryInput, framework, frameworkError, exitCode });
  }
  process.exitCode = exitCode;

  console.log('=== SUMMARY ===');
  if (status === 'no-tests') {
    console.log('NO TESTS GENERATED');
    for (const s of states) console.log(`  ${s.endpoint.id}: ${oneLine(s.failureReason ?? s.skippedReason ?? 'unknown')}`);
    if (budgetHit) console.log(BUDGET_HINT);
    if (testCases) console.log(testCasesLine(testCases));
    console.log(`Summary written to ${SUMMARY_FILE}`);
    process.exitCode = EXIT_ERROR;
    return;
  }
  const t = summary.totals;
  const api = findings.filter((f) => f.classification === 'suspected API finding');
  const review = findings.filter((f) => f.classification === 'needs review');
  console.log(`Status: ${status}`);
  if (status === 'stopped-budget') console.log(BUDGET_HINT);
  console.log(`Framework: ${fw.name}`);
  console.log(`Scope: ${mode}${flags.endpoints ? `, endpoints ${flags.endpoints.join(', ')}` : ''}${scope.reused.probes ? `, reused ${scope.reused.probes} probes, ${scope.reused.plans} plans, ${scope.reused.specs} specs` : ''}`);
  console.log(`Endpoints: ${t.endpoints}, specs written: ${written.length}, tests: ${t.testsGenerated}, passed: ${t.passed}, failed: ${t.failed}, skipped: ${t.skipped}, known issues: ${t.knownIssues}`);
  console.log(`Claude calls: ${summary.claudeCalls.used}/${summary.claudeCalls.budget}, duration: ${summary.durationSec}s`);
  console.log(`Safety: ${safety.hostClass} host, ${safety.mode} mode, requests sent: ${requestsSent}`);
  console.log(`Redaction: ${summary.redaction.mode}, ${summary.redaction.replaced} value(s) replaced before Claude and in evidence`);
  console.log(cleanupLine(cleanup).replace(/^cleanup/, 'Cleanup'));
  for (const f of summary.cleanup.failures) console.log(`  cleanup failed: ${f}`);
  for (const s of summary.endpoints.filter((e) => e.skippedReason)) console.log(`  skipped: ${s.id}: ${s.skippedReason}`);
  for (const s of summary.endpoints.filter((e) => e.failureReason)) console.log(`  not tested: ${s.id}: ${s.failureReason}`);
  console.log(`${api.length} suspected API finding${api.length === 1 ? '' : 's'}`);
  for (const f of api) console.log(`  - ${f.testTitle}: expected ${f.expectedStatus}, got ${f.actualStatus}`);
  if (review.length) {
    console.log(`${review.length} need${review.length === 1 ? 's' : ''} review`);
    for (const f of review) console.log(`  - ${f.testTitle}: ${/^UNEXPECTED PASS/.test(f.error) ? oneLine(f.error) : `expected ${f.expectedStatus}, got ${f.actualStatus ?? 'no status'}`}`);
  }
  if (summary.knownIssues.length) {
    console.log(`${summary.knownIssues.length} known issue${summary.knownIssues.length === 1 ? '' : 's'} (failed as expected, not counted as passed)`);
    for (const k of summary.knownIssues) console.log(`  - ${k.testTitle}: ${oneLine(k.reason)}`);
  }
  if (summary.skippedTests.length) {
    console.log(`${summary.skippedTests.length} skipped (did not run, not counted as passed${flags.failOn === 'skipped' ? '; --fail-on skipped' : ''})`);
    for (const k of summary.skippedTests) console.log(`  - ${k.testTitle}: ${oneLine(k.reason)}`);
  }
  if (testCases) {
    console.log(testCasesLine(testCases));
    for (const r of traceRows.filter((x) => x.source === 'sheet' && x.status !== 'passed')) console.log(`  ${r.id} ${r.status}: ${r.reason}`);
  }
  console.log(`Summary written to ${SUMMARY_FILE}${htmlReport ? `, report in ${htmlReport}` : ''}`);
  if (allureReport) console.log(`allure report written to ${allureReport}`);
  if (framework) console.log(`framework written to ${framework.dir} (${framework.files.length} files)`);
  console.log(`Exit code: ${exitCode}${flags.failOn === 'none' ? ' (--fail-on none)' : ''}`);
}

// Allure labels for sheet cases whose test cannot prove the whole expected result: "partially covered"
// (a clause has no assertion) and "needs review" (the probe disagreed with the sheet).
function coverageLabels(states: EndpointState[]): Record<string, { name: string; value: string }[]> {
  const out: Record<string, { name: string; value: string }[]> = {};
  for (const s of states) {
    for (const c of s.plan?.cases ?? []) {
      // A known issue: tagged with its Jira key, so the Allure report shows it is expected to fail.
      if (c.knownIssue) {
        const key = /\b[A-Z][A-Z0-9]+-\d+\b/.exec(c.knownIssue)?.[0];
        out[c.title] = [{ name: 'tag', value: 'known issue' }, ...(key ? [{ name: 'issue', value: key }] : [])];
        continue;
      }
      const { missing, disagrees } = coverageGaps(c);
      if (!missing.length && !disagrees.length) continue;
      const status = disagrees.length ? 'needs review' : 'partially covered';
      out[c.title] = [
        { name: 'tag', value: status },
        { name: 'coverage', value: disagrees.length ? 'needs-review' : 'partial' },
        ...(missing.length ? [{ name: 'notAsserted', value: missing.map((m) => `clause ${m.n}`).join(', ') }] : []),
      ];
    }
  }
  return out;
}

function testCasesLine(t: Record<string, unknown>): string {
  const cov = t.assertionCoverage as { asserted: number; clauses: number; percent: number | null } | undefined;
  const covText = cov && cov.percent !== null ? `; assertion coverage ${cov.percent}% (${cov.asserted} of ${cov.clauses} expected-result clauses asserted)` : '';
  const extra = [
    [t.skipped, 'skipped'],
    [t.manual, 'manual'],
    [t.blocked, 'blocked'],
    [t.knownIssues, 'known issue(s)'],
    [t.unexpectedPasses, 'unexpected pass(es)'],
  ]
    .filter(([n]) => Number(n) > 0)
    .map(([n, label]) => `, ${n} ${label}`)
    .join('');
  return `Test cases: ${t.rows} in the sheet: ${t.passed} passed, ${t.partiallyCovered ?? 0} partially covered, ${t.failed} failed, ${t.needsReview} need review, ${t.notAutomated} not automated${extra}; ${t.agentSuggestions} agent suggestion(s)${covText}; traceability in ${TRACE_CSV} and ${TRACE_XLSX}`;
}

main().catch((err) => {
  console.error(`agent FAILED ${redact((err as Error).message)}`);
  process.exit(EXIT_ERROR);
});
