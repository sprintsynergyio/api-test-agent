// Command line flags of `npm run agent -- <input> [flags]`. --select is handled first by
// takeSelectFlag (agent/config.ts); everything else is parsed here. Unknown flags are an error, so a
// typo never silently runs a full-price fresh run.

export type AgentFlags = {
  inputFile: string;
  // Continue the last run of the same input from out/checkpoint.json.
  resume: boolean;
  // Regenerate only the endpoints whose definition changed since the checkpoint.
  onlyNew: boolean;
  // Restrict the run to these endpoint ids.
  endpoints: string[] | null;
  // Model calls allowed in this run (MAX_CLAUDE_CALLS for this process).
  budget: number | null;
  // Plans and generations in flight at once.
  concurrency: number;
  // Test workers (Playwright --workers; Pactum runs one at a time and says so).
  testWorkers: number;
  // What makes the exit code 1: any finding (default), any finding or test that did not run (skipped,
  // blocked, manual), or nothing (everything is reported, exit 0).
  failOn: FailOn;
  // A test case sheet, or a Jira / Confluence link or JQL, to automate (overrides the input file's
  // testCases), and the mode.
  testCases: string | null;
  testCasesMode: TestCaseMode | null;
  // The per-environment test data file (overrides the input file's testData).
  testData: string | null;
  // Test options per endpoint (agent/config.ts allowInvalidInput and stableData): a list of endpoint
  // ids, 'all', or null to keep what the input file says.
  allowInvalidInput: EndpointList;
  stableData: EndpointList;
};

export type EndpointList = string[] | 'all' | null;

function endpointList(name: string, raw: string): string[] | 'all' {
  const v = raw.trim();
  if (v === 'all') return 'all';
  const ids = v.split(',').map((s) => s.trim()).filter(Boolean);
  if (!ids.length) throw new Error(`${name} needs "all" or a comma-separated list of endpoint ids`);
  return ids;
}

import { FAIL_ON_VALUES, type FailOn } from './exit-codes';
import { TEST_CASE_MODES, type TestCaseMode } from './config';

export const DEFAULT_CONCURRENCY = 3;
export const MAX_CONCURRENCY = 8;
export const MAX_TEST_WORKERS = 16;

function intFlag(name: string, raw: string | undefined, min: number, max: number): number {
  const n = Number(raw);
  if (raw === undefined || !Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} needs a whole number between ${min} and ${max}, got "${raw ?? ''}"`);
  }
  return n;
}

export function parseAgentFlags(argv: string[], defaultInput = 'input/endpoints.json'): AgentFlags {
  const flags: AgentFlags = {
    inputFile: defaultInput,
    resume: false,
    onlyNew: false,
    endpoints: null,
    budget: null,
    concurrency: DEFAULT_CONCURRENCY,
    testWorkers: 1,
    failOn: 'finding',
    testCases: null,
    testCasesMode: null,
    testData: null,
    allowInvalidInput: null,
    stableData: null,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const name = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg;
    const inline = arg.startsWith('--') && eq > 0 ? arg.slice(eq + 1) : undefined;
    const value = () => {
      if (inline !== undefined) return inline;
      if (i + 1 >= argv.length) throw new Error(`${name} needs a value`);
      return argv[++i];
    };
    switch (name) {
      case '--resume':
        flags.resume = true;
        break;
      case '--only-new':
        flags.onlyNew = true;
        break;
      case '--endpoints': {
        const ids = value().split(',').map((s) => s.trim()).filter(Boolean);
        if (ids.length === 0) throw new Error('--endpoints needs a comma-separated list of endpoint ids');
        flags.endpoints = ids;
        break;
      }
      case '--budget':
        flags.budget = intFlag('--budget', value(), 1, 100_000);
        break;
      case '--concurrency':
        flags.concurrency = intFlag('--concurrency', value(), 1, MAX_CONCURRENCY);
        break;
      case '--test-workers':
        flags.testWorkers = intFlag('--test-workers', value(), 1, MAX_TEST_WORKERS);
        break;
      case '--fail-on': {
        const v = value();
        if (!(FAIL_ON_VALUES as string[]).includes(v)) throw new Error(`--fail-on must be one of ${FAIL_ON_VALUES.join(', ')}, got "${v}"`);
        flags.failOn = v as FailOn;
        break;
      }
      case '--test-data': {
        const v = value().trim();
        if (!v) throw new Error('--test-data needs a test data .json file');
        flags.testData = v;
        break;
      }
      case '--test-cases': {
        const v = value().trim();
        if (!v) throw new Error('--test-cases needs a .csv, .tsv or .xlsx test case sheet, or a Jira / Confluence link or JQL');
        flags.testCases = v;
        break;
      }
      case '--test-cases-mode': {
        const v = value();
        if (!(TEST_CASE_MODES as readonly string[]).includes(v)) throw new Error(`--test-cases-mode must be one of ${TEST_CASE_MODES.join(', ')}, got "${v}"`);
        flags.testCasesMode = v as TestCaseMode;
        break;
      }
      // Without ids (the next argument is another flag, a file path or missing): every endpoint.
      case '--allow-invalid-input':
      case '--stable-data': {
        const next = argv[i + 1];
        const bare = inline === undefined && (next === undefined || next.startsWith('--') || /[\\/]|\.(json|ya?ml|csv|xlsx)$/i.test(next));
        const list = bare ? 'all' : endpointList(name, value());
        if (name === '--allow-invalid-input') flags.allowInvalidInput = list;
        else flags.stableData = list;
        break;
      }
      default:
        if (arg.startsWith('--')) throw new Error(`unknown flag ${arg}. Known flags: --resume, --only-new, --endpoints a,b, --budget N, --concurrency N, --test-workers N, --fail-on none|finding|skipped, --test-cases <sheet|link>, --test-cases-mode sheet-only|sheet-plus-agent, --test-data <file>, --select k=v`);
        positional.push(arg);
    }
  }
  if (positional.length > 1) throw new Error(`expected one input file, got: ${positional.join(' ')}`);
  if (positional[0]) flags.inputFile = positional[0];
  if (flags.resume && flags.onlyNew) throw new Error('--resume and --only-new cannot be combined: --resume continues a stopped run, --only-new regenerates changed endpoints');
  return flags;
}
