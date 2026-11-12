import { spawn, spawnSync } from 'node:child_process';
import { testEnv } from './test-env';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { exportFramework } from '../export';
import { validateSpec } from '../validate';
import type { FrameworkAdapter, RunResult, TestOutcome } from './types';

// The Playwright adapter: the original pipeline's runner, results parser, Allure step and exporter,
// moved here unchanged in behaviour.

const RESULTS_FILE = 'reports/results.json';
const ALLURE_RESULTS = 'reports/allure-results';
const ALLURE_REPORT = 'reports/allure-report';
const HTML_REPORT = 'reports/html';

function runPlaywright(inputFile: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn('node_modules/.bin/playwright', ['test', '-c', 'playwright.generated.config.ts'], {
      // The tests read their auth value from .env through the ctx file; the Claude API key never reaches them.
      env: testEnv(inputFile),
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', reject);
    child.on('close', resolve);
  });
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

function readOutcomes(cleanError: (text: string) => string): { outcomes: TestOutcome[]; loadErrors: string[]; requestsSent: number } {
  const report = JSON.parse(readFileSync(RESULTS_FILE, 'utf8')) as { suites?: JsonSuite[]; errors?: { message?: string }[] };
  const outcomes: TestOutcome[] = [];
  let requestsSent = 0;
  const walk = (suite: JsonSuite) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests) {
        const last = t.results[t.results.length - 1];
        // The ctx fixture records how many requests each test sent (one annotation per test).
        const sent = (last?.annotations ?? []).find((a) => a.type === 'requests-sent') ?? (t.annotations ?? []).find((a) => a.type === 'requests-sent');
        if (sent?.description && /^\d+$/.test(sent.description)) requestsSent += Number(sent.description);
        if (t.status === 'skipped') continue;
        const annotations = [...(t.annotations ?? []), ...(last?.annotations ?? [])];
        const statusNote = annotations.find((a) => a.type === 'actual-status')?.description;
        const actual = statusNote !== undefined && /^\d{3}$/.test(statusNote) ? Number(statusNote) : null;
        const message = last?.errors?.[0]?.message ?? last?.error?.message ?? '';
        outcomes.push({
          endpointId: basename(spec.file).replace(/\.spec\.ts$/, ''),
          title: spec.title,
          passed: t.status === 'expected' || t.status === 'flaky',
          actualStatus: actual,
          error: cleanError(message).slice(0, 300),
        });
      }
    }
    (suite.suites ?? []).forEach(walk);
  };
  (report.suites ?? []).forEach(walk);
  const loadErrors = (report.errors ?? []).map((e) => cleanError(e.message ?? '').split('\n')[0]);
  return { outcomes, loadErrors, requestsSent };
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}

// Builds the Allure HTML report from the raw results. Never fails the run: returns the reason instead.
function generateAllure(reportName: string, secrets: string[], cleanError: (text: string) => string): { dir: string | null; reason?: string } {
  if (!existsSync(ALLURE_RESULTS)) return { dir: null, reason: `${ALLURE_RESULTS} was not written` };
  const res = spawnSync(
    'node_modules/.bin/allure',
    ['generate', ALLURE_RESULTS, '--output', ALLURE_REPORT, '--report-name', reportName],
    { encoding: 'utf8', timeout: 120_000 },
  );
  if (res.error || res.status !== 0) {
    const detail = res.error?.message ?? `${res.stderr}${res.stdout}`.trim().split('\n')[0];
    return { dir: null, reason: cleanError(`allure exited with ${res.status}: ${detail}`) };
  }
  if (!existsSync(join(ALLURE_REPORT, 'index.html'))) return { dir: null, reason: `${ALLURE_REPORT}/index.html is missing` };
  for (const dir of [ALLURE_RESULTS, ALLURE_REPORT]) {
    for (const file of filesUnder(dir)) {
      if (secrets.some((s) => s && readFileSync(file).includes(s))) {
        rmSync(ALLURE_RESULTS, { recursive: true, force: true });
        rmSync(ALLURE_REPORT, { recursive: true, force: true });
        return { dir: null, reason: `auth value found in ${file}, Allure output deleted` };
      }
    }
  }
  return { dir: ALLURE_REPORT };
}

export const playwrightAdapter: FrameworkAdapter = {
  name: 'playwright',
  label: 'Playwright API tests in TypeScript',
  templateFile: 'tests/template/update-booking.spec.ts',
  ctxFile: 'tests/fixtures/ctx.ts',
  contextFiles: ['agent/http.ts'],
  importLine: "import { test, expect } from '../tests/fixtures/ctx';",
  generatorRules(endpoint, plan, probe) {
    return [
      'Copy the template\'s structure: one test.describe block, every test title starts with its type tag ([happy], [schema], [invalid-input], [auth], [authz]), and every test records test.info().annotations.push({ type: \'actual-status\', description: String(response.status()) }) (or a helper like recordStatus) before its first expect.',
      `Status assertions, exactly in the template's style and no other form (the static gate rejects anything else): happy and schema expect(response.status()).toBe(${probe.status}); invalid-input expect(response.status()).toBeGreaterThanOrEqual(400) and expect(response.status()).toBeLessThanOrEqual(499); auth expect([401, 403]).toContain(response.status()); authz expect([403, 404]).toContain(response.status()). Never use .not on a status, and never assert a status from a different request than the one under test.`,
      'Auth tests send the request under test with ctx.noAuthApi and never mention ctx.api (resources they need come from ctx.createResource).',
      "Authz tests send the request under test with ctx.as('<role>') (the role named in the plan case; it is an APIRequestContext like ctx.api) and never mention ctx.api or ctx.noAuthApi; resources they need come from ctx.createResource, which uses the default role.",
      'Response bodies may be empty or not JSON (see the probe). Only call response.json() when the probe shows a JSON body for that status.',
      'No process.env, no test.only, no test.skip, no try/catch, no .catch(). Do not import from @playwright/test.',
      `One test per plan case: ${plan.cases.length} tests in total.`,
    ];
  },
  validate: validateSpec,
  async run(inputFile, { secrets, reportName, cleanError }): Promise<RunResult> {
    await runPlaywright(inputFile);
    if (!existsSync(RESULTS_FILE)) throw new Error(`Playwright did not write ${RESULTS_FILE}`);
    const read = readOutcomes(cleanError);
    const allure = generateAllure(reportName, secrets, cleanError);
    return { ...read, htmlReport: HTML_REPORT, allureReport: allure.dir, allureReason: allure.reason };
  },
  exportFramework,
};
