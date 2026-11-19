// Exit codes of `npm run agent` (documented in the README, section "Exit codes"), in the style of the
// other SprintSynergy tools:
//   0  the run completed and nothing fails it under --fail-on
//   1  findings: at least one failed test (a suspected API finding, or a failure that needs review)
//      and --fail-on finding (the default); with --fail-on skipped, also any sheet case or test that did
//      not run (skipped, blocked by missing data, manual)
//   2  tool or setup error: bad input or flags, a refused host, no model, no tests generated, a budget
//      stop, an endpoint that could not be tested, a failed framework export, or a crash
export const EXIT_OK = 0;
export const EXIT_FINDINGS = 1;
export const EXIT_ERROR = 2;

export type FailOn = 'none' | 'finding' | 'skipped';
export const FAIL_ON_VALUES: FailOn[] = ['none', 'finding', 'skipped'];

// skipped: tests and sheet cases that did not run (skipped, blocked, manual). Known issues that failed as
// expected never change the exit code; a known issue whose test passed is a finding (needs review).
export function runExitCode(o: { status: string; findings: number; untestedEndpoints: number; exportFailed: boolean; failOn: FailOn; skipped?: number }): number {
  if (o.status !== 'completed' || o.untestedEndpoints > 0 || o.exportFailed) return EXIT_ERROR;
  if ((o.failOn === 'finding' || o.failOn === 'skipped') && o.findings > 0) return EXIT_FINDINGS;
  if (o.failOn === 'skipped' && (o.skipped ?? 0) > 0) return EXIT_FINDINGS;
  return EXIT_OK;
}
