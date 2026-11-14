import type { Config, Endpoint } from '../config';
import type { CleanupTotals } from '../http';
import type { Plan } from '../plan';
import type { ProbeResult } from '../probe';
import type { ValidateOptions, ValidationResult } from '../validate';

// One agent, several output frameworks. Everything the pipeline shares (importers, probe, plan, status
// rules, finding classification, summary, safety guard, auth handling) knows nothing about the framework.
// Everything that differs lives behind this interface: template, generator rules, static gate, runner,
// results parser, exporter. The findings logic only ever reads normalized TestOutcome values.

export type FrameworkName = 'playwright' | 'pactum';

export type TestOutcome = {
  endpointId: string;
  title: string;
  passed: boolean;
  actualStatus: number | null;
  error: string;
};

export type RunOptions = { secrets: string[]; reportName: string; cleanError: (text: string) => string; specFiles?: string[]; workers?: number };

export type RunResult = {
  // One-line notes for the console (for example that a flag was ignored).
  notes?: string[];
  outcomes: TestOutcome[];
  // Errors that stopped a spec file from loading at all (never counted as passed).
  loadErrors: string[];
  // Requests the tests sent, for summary.requestsSent.
  requestsSent: number;
  // Values redacted in the tests' evidence, for summary.redaction.
  redactionReplaced: number;
  // What the tests created on the API and what cleanup deleted, for summary.cleanup.
  cleanup: CleanupTotals;
  // Folder of the framework's own HTML report, or null when it has none.
  htmlReport: string | null;
  // "reports/allure-report" when the Allure report was generated, else null with the reason.
  allureReport: string | null;
  allureReason?: string;
};

export type FrameworkInfo = { name: string; dir: string; zip: string; files: string[]; specCount: number };
export type ExportEndpoint = { endpoint: Endpoint; specFile: string | null; failureReason: string | null };
export type ExportFinding = { endpointId: string; testTitle: string; expectedStatus: string | null; actualStatus: number | null };

export type ExportOptions = {
  config: Config;
  inputFile: string;
  // Every credential value and token seen in the run; none may appear in the exported files.
  secrets: string[];
  endpoints: ExportEndpoint[];
  findings: ExportFinding[];
};

export type FrameworkAdapter = {
  name: FrameworkName;
  // Shown in the generator's system prompt ("Playwright API tests in TypeScript").
  label: string;
  // The hand-written example the generator copies.
  templateFile: string;
  // The test-side file generated tests import from (shown to the generator).
  ctxFile: string;
  // Other files shown to the generator for context (e.g. agent/http.ts for Playwright).
  contextFiles: string[];
  // The import line a generated file must use.
  importLine: string;
  // The framework-specific part of the generate prompt rules.
  generatorRules(endpoint: Endpoint, plan: Plan, probe: ProbeResult): string[];
  // The static gate.
  validate(code: string, opts: ValidateOptions): ValidationResult;
  // Runs the generated specs and returns normalized results. secrets are scrubbed from error text.
  // specFiles: the spec files in scope (paths under generated/); every spec in generated/ when omitted.
  // workers: parallel test workers (--test-workers); 1 when omitted. An adapter that cannot run tests
  // in parallel says so in RunResult.notes and runs them one at a time.
  run(inputFile: string, opts: RunOptions): Promise<RunResult>;
  // Writes the standalone project and zip.
  exportFramework(opts: ExportOptions): FrameworkInfo;
};
