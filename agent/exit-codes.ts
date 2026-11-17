// Exit codes of `npm run agent` (documented in the README, section "Exit codes"), in the style of the
// other SprintSynergy tools:
//   0  the run completed and nothing fails it under --fail-on
//   1  findings: at least one failed test (a suspected API finding, or a failure that needs review)
//      and --fail-on finding (the default)
//   2  tool or setup error: bad input or flags, a refused host, no model, no tests generated, a budget
//      stop, an endpoint that could not be tested, a failed framework export, or a crash
export const EXIT_OK = 0;
export const EXIT_FINDINGS = 1;
export const EXIT_ERROR = 2;

export type FailOn = 'none' | 'finding';
export const FAIL_ON_VALUES: FailOn[] = ['none', 'finding'];

export function runExitCode(o: { status: string; findings: number; untestedEndpoints: number; exportFailed: boolean; failOn: FailOn }): number {
  if (o.status !== 'completed' || o.untestedEndpoints > 0 || o.exportFailed) return EXIT_ERROR;
  if (o.failOn === 'finding' && o.findings > 0) return EXIT_FINDINGS;
  return EXIT_OK;
}
