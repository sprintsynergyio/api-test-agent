import { spawn, spawnSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { apiName, type Config } from '../config';
import { validateWithRules, type GateRules } from '../validate';
import { exportedConfig, modelSource } from './shared-export';
import type { ExportEndpoint, ExportFinding, FrameworkAdapter, FrameworkInfo, RunResult, TestOutcome } from './types';

// The Pactum adapter: Mocha + Pactum tests that import only from tests-pactum/setup/ctx.ts.
// Shared with Playwright: probe, plan, status rules, finding classification, summary, safety guard.

const MOCHA_CONFIG = '.mocharc.pactum.json';
const REPORT_DIR = 'reports/pactum';
const RESULTS_FILE = join(REPORT_DIR, 'results.json');
const STATUS_FILE = join(REPORT_DIR, 'status.json');
const CTX_FILE = 'tests-pactum/setup/ctx.ts';
const TEMPLATE_FILE = 'tests-pactum/template/update-product.spec.ts';
const IMPORT_LINE = "import { ctx, expect, recordStatus } from '../tests-pactum/setup/ctx';";
const FRAMEWORKS_DIR = 'frameworks';
const ZIP_FILE = 'out/framework.zip';
const ALLOWED_PACKAGES = new Set(['pactum', 'dotenv', 'dotenv/config']);
const TYPES = ['happy', 'schema', 'invalid-input', 'auth'] as const;

// ---- static gate ----

const PACTUM_RULES: GateRules = {
  testFn: 'it',
  statusRecorders: ['recordStatus'],
  frameworkRules(code) {
    const reasons: string[] = [];
    const imp = code.match(/import\s*\{([^}]*)\}\s*from\s*['"](?:\.\.?\/)+(?:tests-pactum\/)?setup\/ctx(?:\.ts)?['"]/);
    const imported = imp ? imp[1].split(',').map((s) => s.trim()) : [];
    for (const name of ['ctx', 'expect', 'recordStatus']) {
      if (!imported.includes(name)) reasons.push(`does not import ${name} from the setup file (tests-pactum/setup/ctx)`);
    }
    if (/from\s*['"]pactum['"]|require\(\s*['"]pactum['"]\s*\)/.test(code)) reasons.push('imports pactum directly instead of the setup file');
    if (/from\s*['"](?:node:)?assert['"]|from\s*['"]chai['"]|require\(\s*['"](?:node:)?assert['"]\s*\)/.test(code)) {
      reasons.push('imports an assertion library instead of expect from the setup file');
    }
    if (/\b(?:it|describe|context)\.only\b/.test(code)) reasons.push('contains .only');
    if (/\b(?:it|describe|context)\.skip\b|\bxit\(|\bxdescribe\(/.test(code)) reasons.push('contains .skip');
    if (/\bthis\.skip\(/.test(code)) reasons.push('contains this.skip()');
    return reasons;
  },
};

// ---- runner ----

function runMocha(inputFile: string): Promise<number | null> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('node_modules/.bin/mocha', ['--config', MOCHA_CONFIG, 'generated/**/*.spec.ts'], {
      env: { ...process.env, INPUT_FILE: inputFile },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', reject);
    child.on('close', resolvePromise);
  });
}

type MochaTest = { title: string; fullTitle: string; file?: string; err?: { message?: string; stack?: string } };
type MochaJson = { tests?: MochaTest[]; passes?: MochaTest[]; failures?: MochaTest[]; pending?: MochaTest[] };
type StatusEntry = { file: string; title: string; state: string; actualStatus: number | null; requestsSent: number };

function readOutcomes(cleanError: (text: string) => string): { outcomes: TestOutcome[]; loadErrors: string[]; requestsSent: number } {
  const report = JSON.parse(readFileSync(RESULTS_FILE, 'utf8')) as MochaJson;
  const statuses: StatusEntry[] = existsSync(STATUS_FILE) ? (JSON.parse(readFileSync(STATUS_FILE, 'utf8')) as StatusEntry[]) : [];
  const requestsSent = statuses.reduce((n, s) => n + (Number.isInteger(s.requestsSent) ? s.requestsSent : 0), 0);
  const passedTitles = new Set((report.passes ?? []).map((t) => `${t.file ?? ''}|${t.title}`));
  const pendingTitles = new Set((report.pending ?? []).map((t) => `${t.file ?? ''}|${t.title}`));
  const outcomes: TestOutcome[] = [];
  const loadErrors: string[] = [];
  for (const t of report.tests ?? []) {
    const key = `${t.file ?? ''}|${t.title}`;
    if (pendingTitles.has(key)) continue;
    const file = basename(t.file ?? '');
    // A failure with no title and a load error message is Mocha reporting that a file could not load.
    if (!file.endsWith('.spec.ts')) {
      loadErrors.push(cleanError(t.err?.message ?? `could not load ${t.file ?? 'a spec file'}`).split('\n')[0]);
      continue;
    }
    const status = statuses.find((s) => s.file === file && s.title === t.title);
    outcomes.push({
      endpointId: file.replace(/\.spec\.ts$/, ''),
      title: t.title,
      passed: passedTitles.has(key),
      actualStatus: status && Number.isInteger(status.actualStatus) ? status.actualStatus : null,
      error: cleanError(t.err?.message ?? '').slice(0, 300),
    });
  }
  return { outcomes, loadErrors, requestsSent };
}

// ---- exporter ----

function pinnedVersions(): Record<string, string> {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { devDependencies: Record<string, string> };
  const pick = ['pactum', 'mocha', '@types/mocha', 'dotenv', 'tsx', 'typescript', '@types/node'];
  return Object.fromEntries(
    pick.map((dep) => {
      const v = pkg.devDependencies[dep];
      if (!v) throw new Error(`framework export: ${dep} is missing from this project's package.json`);
      return [dep, v.replace(/^[\^~]/, '')];
    }),
  );
}

// agent/safety.ts has no imports, so it is copied as it is.
function safetySource(): string {
  const src = readFileSync('agent/safety.ts', 'utf8');
  if (/^\s*import\s/m.test(src)) throw new Error('framework export: agent/safety.ts must not import anything');
  return src.replace(/^\/\/ No imports: the framework export[^\n]*\n\/\/[^\n]*\n\/\/[^\n]*\n/m, '');
}

// Standalone copy of tests-pactum/setup/ctx.ts: imports ./safety and reads config/api.json.
function ctxSource(): string {
  const src = readFileSync(CTX_FILE, 'utf8');
  const importLine = "from '../../agent/safety';";
  const inputLine = /^const INPUT_FILE = .*\/\/ EXPORT-INPUT$/m;
  if (!src.includes(importLine) || !inputLine.test(src)) throw new Error(`framework export: ${CTX_FILE} no longer has the expected import and INPUT_FILE lines`);
  const modelLine = "from '../../agent/model';";
  if (!src.includes(modelLine)) throw new Error(`framework export: ${CTX_FILE} no longer imports agent/model as expected`);
  return src
    .replace(importLine, "from './safety';")
    .replace(modelLine, "from './model';")
    .replace(inputLine, "const INPUT_FILE = fileURLToPath(new URL('../config/api.json', import.meta.url));")
    .replace("import { join } from 'node:path';", "import { join } from 'node:path';\nimport { fileURLToPath } from 'node:url';")
    .replace(/^\/\/ The Pactum equivalent of tests\/fixtures\/ctx\.ts: the ONLY/m, '// The ONLY');
}

const MOCHARC = `{
  "import": "tsx",
  "require": "src/ctx.ts",
  "extension": ["ts"],
  "timeout": 60000,
  "spec": "tests/**/*.spec.ts",
  "reporter": "spec"
}
`;

const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "preserve",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "types": ["node", "mocha"]
  },
  "include": ["**/*.ts"],
  "exclude": ["node_modules"]
}
`;

function countByType(spec: string): Record<(typeof TYPES)[number], number> {
  const counts = { happy: 0, schema: 0, 'invalid-input': 0, auth: 0 };
  for (const m of spec.matchAll(/\bit\(\s*(['"`])\[(happy|schema|invalid-input|auth)\]/g)) counts[m[2] as (typeof TYPES)[number]]++;
  return counts;
}

function readme(name: string, config: Config, endpoints: ExportEndpoint[], specs: Map<string, string>, findings: ExportFinding[]): string {
  const rows = endpoints
    .filter((e) => e.specFile)
    .map((e) => {
      const c = countByType(specs.get(e.endpoint.id) ?? '');
      return `| ${e.endpoint.id} | ${e.endpoint.method} | \`${e.endpoint.path}\` | ${TYPES.map((t) => c[t]).join(' | ')} |`;
    });
  const missing = endpoints.filter((e) => !e.specFile);
  const envStep = config.auth
    ? `2. \`cp .env.example .env\` and set \`${config.auth.valueEnv}\` to the value of the \`${config.auth.header}\` header.`
    : '2. No auth is needed for this API, so there is no .env to fill in.';
  const cell = (v: unknown) => String(v).replace(/\|/g, '\\|');
  const findingRows = findings.map((f) => `| ${cell(f.endpointId)} | ${cell(f.testTitle)} | ${cell(f.expectedStatus ?? 'n/a')} | ${cell(f.actualStatus ?? 'n/a')} |`);

  return `# ${name} API tests (Pactum)

Pactum + Mocha API tests for \`${config.baseUrl}\`, generated by the API Test Agent.
Standalone project: Node 20+ and npm are all you need.

## What the suite covers

| Endpoint | Method | Path | happy | schema | invalid-input | auth |
|---|---|---|---|---|---|---|
${rows.join('\n')}
${missing.length ? `\nNot covered (no spec was generated): ${missing.map((e) => `${e.endpoint.id} (${e.failureReason ?? 'unknown'})`).join('; ')}.\n` : ''}
Case types: **happy** valid request succeeds and returns the values sent; **schema** response fields are present with the right types; **invalid-input** bad input is rejected with a 4xx; **auth** a request without the auth header is rejected with 401 or 403.

## How to run

1. \`npm install\`
${envStep}
3. \`npm test\`
4. \`npm run test:json\` writes \`reports/pactum/results.json\` (Mocha JSON) next to \`reports/pactum/status.json\` (the real status of every request under test) and \`reports/pactum/evidence/\` (one JSON per request and response, auth header redacted).

The API config (base URL, headers, endpoints) is in \`config/api.json\`. Tests import \`ctx\`, \`expect\` and \`recordStatus\` from \`src/ctx.ts\`, the only file that reads the environment; they never import pactum directly, so every request goes through the production safety guard.

## Production safety

Before any test runs, the base URL is checked (\`src/safety.ts\`). \`localhost\`, private IP addresses and \`.local\` hosts are local; hosts with a part such as \`dev\`, \`test\`, \`qa\`, \`staging\`, \`stage\`, \`sandbox\`, \`uat\` or \`preprod\` are non-production; everything else is production.

- Production host and \`allowProduction\` false in \`config/api.json\`: the run is refused and no request is sent.
- \`allowProduction\` true: read-only mode. Only GET, HEAD and OPTIONS are sent; tests of other endpoints, and of endpoints that create a resource first, are skipped, never passed.
- \`allowProduction\` and \`allowWrites\` both true: every request is sent. Only do this when changing real data is acceptable.

## Suspected API findings from the generating run

${
  findingRows.length
    ? `These tests failed because the API answered with a status that breaks REST rules. They are expected to keep failing until the API is fixed.

| Endpoint | Test | Expected status | Actual status |
|---|---|---|---|
${findingRows.join('\n')}`
    : 'None. Every test passed against the API when this suite was generated.'
}
`;
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(dir, full).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

function checkSelfContained(dir: string, files: string[]): string[] {
  const problems: string[] = [];
  const root = resolve(dir);
  for (const file of files.filter((f) => f.endsWith('.ts'))) {
    const text = readFileSync(join(dir, file), 'utf8');
    const specifiers = [
      ...text.matchAll(/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g),
      ...text.matchAll(/import\s*['"]([^'"]+)['"]/g),
      ...text.matchAll(/new URL\(\s*['"]([^'"]+)['"]/g),
    ].map((m) => m[1]);
    for (const spec of specifiers) {
      if (spec.startsWith('.')) {
        const target = resolve(dirname(join(root, file)), spec);
        if (target !== root && !target.startsWith(root + sep)) problems.push(`${file} imports ${spec}, outside the framework folder`);
      } else if (!spec.startsWith('node:') && !builtinModules.includes(spec) && !ALLOWED_PACKAGES.has(spec)) {
        problems.push(`${file} imports ${spec}, which is not a framework dependency`);
      }
    }
    if (/\bagent\//.test(text)) problems.push(`${file} references agent/`);
  }
  return problems;
}

export function exportPactumFramework(opts: {
  config: Config;
  inputFile: string;
  authValue: string | undefined;
  endpoints: ExportEndpoint[];
  findings: ExportFinding[];
}): FrameworkInfo {
  const { config, inputFile, authValue, endpoints, findings } = opts;
  const base = apiName(config, inputFile);
  const name = base.endsWith('-pactum') ? base : `${base}-pactum`;
  const dir = join(FRAMEWORKS_DIR, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'tests'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'config'), { recursive: true });
  const write = (file: string, content: string) => writeFileSync(join(dir, file), content);

  write(
    'package.json',
    JSON.stringify(
      {
        name: `${name}-api-tests`,
        private: true,
        type: 'module',
        scripts: {
          test: 'mocha',
          'test:json': 'mocha --reporter json --reporter-option output=reports/pactum/results.json',
          typecheck: 'tsc -p tsconfig.json',
        },
        devDependencies: pinnedVersions(),
      },
      null,
      2,
    ) + '\n',
  );
  write('.mocharc.json', MOCHARC);
  write('tsconfig.json', TSCONFIG);
  write('config/api.json', JSON.stringify(exportedConfig(name, config), null, 2) + '\n');
  write('src/model.ts', modelSource());
  write('src/safety.ts', safetySource());
  write('src/ctx.ts', ctxSource());
  if (config.auth) write('.env.example', `${config.auth.valueEnv}=\n`);
  write('.gitignore', 'node_modules/\n.env\nreports/\n');

  const specs = new Map<string, string>();
  for (const e of endpoints) {
    if (!e.specFile) continue;
    const code = readFileSync(join('generated', e.specFile), 'utf8');
    const rewritten = code.replace(/(from\s*['"])\.\.\/tests-pactum\/setup\/ctx(?:\.ts)?(['"])/g, '$1../src/ctx$2');
    if (rewritten === code) throw new Error(`framework export: could not rewrite the setup import in ${e.specFile}`);
    specs.set(e.endpoint.id, rewritten);
    write(join('tests', e.specFile), rewritten);
  }
  write('README.md', readme(name, config, endpoints, specs, findings));

  const files = listFiles(dir);
  const problems = checkSelfContained(dir, files);
  if (authValue) {
    for (const file of files) {
      if (readFileSync(join(dir, file), 'utf8').includes(authValue)) problems.push(`${file} contains the auth value`);
    }
  }
  if (problems.length) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`FRAMEWORK EXPORT FAILED, folder deleted: ${problems.join('; ')}`);
  }

  mkdirSync(dirname(ZIP_FILE), { recursive: true });
  rmSync(ZIP_FILE, { force: true });
  const zip = spawnSync('zip', ['-r', '-q', resolve(ZIP_FILE), name], { cwd: FRAMEWORKS_DIR, encoding: 'utf8' });
  if (zip.error || zip.status !== 0 || !existsSync(ZIP_FILE)) {
    throw new Error(`FRAMEWORK EXPORT FAILED: zip exited with ${zip.status}: ${zip.error?.message ?? zip.stderr}`);
  }
  return { name, dir, zip: ZIP_FILE, files, specCount: specs.size };
}

// ---- adapter ----

export const pactumAdapter: FrameworkAdapter = {
  name: 'pactum',
  label: 'Pactum API tests in TypeScript with Mocha',
  templateFile: TEMPLATE_FILE,
  ctxFile: CTX_FILE,
  contextFiles: [],
  importLine: IMPORT_LINE,
  generatorRules(endpoint, plan, probe) {
    return [
      "Copy the template's structure: Mocha describe and it (both are globals, do not import them), every test title starts with its type tag ([happy], [schema], [invalid-input], [auth]), and every test calls recordStatus(response.status()) before its first expect.",
      'Requests: ctx.api.get(path, options?), ctx.api.post(path, body, options?), ctx.api.put(path, body, options?), ctx.api.patch(path, body, options?), ctx.api.delete(path, options?). options is { params?: query parameters, headers?: extra headers }. Each returns a response with status(), ok(), headers(), text() and json(). Never import pactum, node:assert or chai; expect comes from the setup file.',
      `Status assertions, exactly in the template's style and no other form (the static gate rejects anything else): happy and schema expect(response.status()).toBe(${probe.status}); invalid-input expect(response.status()).toBeGreaterThanOrEqual(400) and expect(response.status()).toBeLessThanOrEqual(499); auth expect([401, 403]).toContain(response.status()). Never use .not on a status, and never assert a status from a different request than the one under test.`,
      'Auth tests send the request under test with ctx.noAuthApi and never mention ctx.api (resources they need come from ctx.createResource).',
      'Response bodies may be empty or not JSON (see the probe). Only call response.json() when the probe shows a JSON body for that status; cast it, for example (await response.json()) as Record<string, unknown>.',
      'No process.env, no .only, no .skip, no this.skip(), no try/catch, no .catch().',
      `One test per plan case: ${plan.cases.length} tests in total.`,
    ];
  },
  validate: (code, opts) => validateWithRules(code, opts, PACTUM_RULES),
  async run(inputFile, { cleanError }): Promise<RunResult> {
    rmSync(REPORT_DIR, { recursive: true, force: true });
    await runMocha(inputFile);
    if (!existsSync(RESULTS_FILE)) throw new Error(`Mocha did not write ${RESULTS_FILE}`);
    const read = readOutcomes(cleanError);
    return { ...read, htmlReport: null, allureReport: null, allureReason: 'Allure is not wired for Pactum yet (ROADMAP Phase 2 gap)' };
  },
  exportFramework: exportPactumFramework,
};
