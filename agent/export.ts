import { spawnSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { apiName, type Config } from './config';
import { exportedConfig, modelSource, redactSource } from './frameworks/shared-export';

// Writes the generated suite as a standalone Playwright project in frameworks/<name>/ and zips it.

const FRAMEWORKS_DIR = 'frameworks';
const ZIP_FILE = 'out/framework.zip';
const ALLOWED_PACKAGES = new Set(['@playwright/test', 'dotenv', 'dotenv/config', 'allure-js-commons']);
const TYPES = ['happy', 'schema', 'invalid-input', 'auth'] as const;

import type { ExportEndpoint, ExportFinding, FrameworkInfo } from './frameworks/types';
export type { ExportEndpoint, ExportFinding, FrameworkInfo };


function pinnedVersions(): Record<string, string> {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { devDependencies: Record<string, string> };
  const pick = ['@playwright/test', 'dotenv', 'typescript', '@types/node', 'allure', 'allure-playwright', 'allure-js-commons'];
  return Object.fromEntries(
    pick.map((dep) => {
      const v = pkg.devDependencies[dep];
      if (!v) throw new Error(`framework export: ${dep} is missing from this project's package.json`);
      return [dep, v.replace(/^[\^~]/, '')];
    }),
  );
}

// Self-contained copy of agent/http.ts: same logic, with the Config type inlined.
function httpSource(): string {
  const src = readFileSync('agent/http.ts', 'utf8');
  const importLine = "import type { Config } from './config';";
  const modelLine = "import { pathParams, queryString, resolvePath, setupSteps } from './model';";
  if (!src.includes(modelLine)) throw new Error('framework export: agent/http.ts no longer imports model helpers as expected');
  if (!src.includes(importLine)) throw new Error('framework export: agent/http.ts no longer imports Config as expected');
  return src
    .replace(
      importLine,
      `export type Config = {
  name?: string;
  baseUrl: string;
  defaultHeaders: Record<string, string>;
  auth?: { header: string; valueEnv: string };
  allowProduction?: boolean;
  allowWrites?: boolean;
  profile?: Profile;
  selection: Selection | null;
  redaction?: RedactionConfig;
  endpoints: {
    id: string;
    method: string;
    path: string;
    requiresAuth: boolean;
    body?: Record<string, unknown>;
    query?: Query;
    headers?: Record<string, string>;
    setup?: Setup | Setup[];
  }[];
};`,
    )
    .replace(modelLine, "import { pathParams, queryString, resolvePath, setupSteps, type Profile, type Query, type Selection, type Setup } from './model';")
    .replace("import { redactHeaders, redactText, redactValue, type RedactionCounter } from './redact';", "import { redactHeaders, redactText, redactValue, type RedactionConfig, type RedactionCounter } from './redact';")
    .replace(/^\/\/ Shared HTTP logic for the ctx fixture and the agent\./m, '// HTTP clients and createResource for the ctx fixture.');
}

// agent/safety.ts has no imports, so it is copied as it is (src/http.ts imports it as ./safety).
function safetySource(): string {
  const src = readFileSync('agent/safety.ts', 'utf8');
  if (/^\s*import\s/m.test(src)) throw new Error('framework export: agent/safety.ts must not import anything');
  return src.replace(/^\/\/ No imports: the framework export[^\n]*\n\/\/[^\n]*\n\/\/[^\n]*\n/m, '');
}

// Runs once before any test. On a production host without allowProduction the run stops here,
// before any request is sent.
const GLOBAL_SETUP_SOURCE = `import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyProfile } from './model';
import { assessSafety, refusalMessage } from './safety';

const configFile = fileURLToPath(new URL('../config/api.json', import.meta.url));

export default function globalSetup() {
  // With a profile, AGENT_SELECT (env=staging,brand=alpha,...) picks the base URL and headers.
  const config = applyProfile(JSON.parse(readFileSync(configFile, 'utf8')), process.env.AGENT_SELECT);
  // AGENT_FORCE_PRODUCTION=1 (testing only) treats every host as production.
  const safety = assessSafety(config, { forceProduction: process.env.AGENT_FORCE_PRODUCTION === '1' });
  if (safety.mode === 'refused') throw new Error(refusalMessage(safety));
  console.log(\`safety: \${safety.hostClass} host, \${safety.mode} mode\`);
}
`;

const CTX_SOURCE = `import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type APIRequestContext } from '@playwright/test';
import { labels } from 'allure-js-commons';
import {
  cleanupResources,
  createClients,
  createResource,
  disposeClients,
  formatExchange,
  recordClients,
  reportLabels,
  runSetup,
  type Config,
} from '../../src/http';
import { applyProfile } from '../../src/model';
import { endpointAllowed, READ_ONLY_SKIP } from '../../src/safety';

// The only test-side file that reads process.env (src/global-setup.ts checks the host once before
// the run). The API config comes from config/api.json.

export type Ctx = {
  baseUrl: string;
  api: APIRequestContext;
  noAuthApi: APIRequestContext;
  createResource: (endpointId: string) => Promise<string>;
  // Runs this spec's endpoint setup steps and returns every path placeholder value.
  setup: () => Promise<Record<string, string>>;
};

const configFile = fileURLToPath(new URL('../../config/api.json', import.meta.url));

export const test = base.extend<{ ctx: Ctx }>({
  ctx: async ({}, use, testInfo) => {
    // With a profile, AGENT_SELECT (env=staging,brand=alpha,...) picks the base URL and headers.
    const config = applyProfile(JSON.parse(readFileSync(configFile, 'utf8')), process.env.AGENT_SELECT) as Config;

    // No auth section: api and noAuthApi are the same. With one, the value must be set.
    const authValue = config.auth ? process.env[config.auth.valueEnv] : undefined;
    if (config.auth && !authValue) {
      throw new Error(
        \`Missing auth value: environment variable \${config.auth.valueEnv} is not set. Copy .env.example to .env and fill it in.\`,
      );
    }

    await labels(...reportLabels(config.name ?? 'api', testInfo.titlePath, testInfo.file));

    // The safety guard: refused on a production host without allowProduction, writes blocked in
    // read-only mode. AGENT_FORCE_PRODUCTION=1 (testing only) treats every host as production.
    const clients = await createClients(config, authValue, { forceProduction: process.env.AGENT_FORCE_PRODUCTION === '1' });
    // A spec is named after its endpoint. In read-only mode a write endpoint's tests are skipped, never passed.
    const endpoint = config.endpoints.find((e) => \`\${e.id}.spec.ts\` === testInfo.file.split(/[\\\\/]/).pop());
    if (endpoint && !endpointAllowed(clients.safety, endpoint)) {
      await disposeClients(clients);
      testInfo.skip(true, READ_ONLY_SKIP);
    }

    // Every request and response is attached to the test (Playwright report and Allure), redacted.
    const recordedClients = recordClients(config, clients, authValue, async (exchange) => {
      const { name, body } = formatExchange(config, exchange, authValue);
      await testInfo.attach(name, { body, contentType: 'application/json' });
    });

    await use({
      baseUrl: config.baseUrl,
      api: recordedClients.api,
      noAuthApi: recordedClients.noAuthApi,
      createResource: (endpointId) => createResource(config, recordedClients, endpointId),
      setup: async () => {
        if (!endpoint) throw new Error('ctx.setup: no endpoint in config/api.json is named after this spec file');
        return runSetup(config, recordedClients, endpoint);
      },
    });

    // Delete what this test's createResource and setup calls made on the API (reported as an annotation).
    const cleanup = await cleanupResources(config, recordedClients);
    testInfo.annotations.push({ type: 'cleanup', description: JSON.stringify(cleanup) });
    await disposeClients(clients);
  },
});

export { expect };
`;

const PLAYWRIGHT_CONFIG = `import 'dotenv/config';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  // Production safety check, once before any test (see src/safety.ts and config/api.json).
  globalSetup: './src/global-setup.ts',
  // The tests share one live API, so they run one at a time.
  workers: 1,
  timeout: 60_000,
  reporter: [['list'], ['html', { open: 'never' }], ['allure-playwright', { resultsDir: 'allure-results' }]],
});
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
    "types": ["node"]
  },
  "include": ["**/*.ts"],
  "exclude": ["node_modules"]
}
`;

function countByType(spec: string): Record<(typeof TYPES)[number], number> {
  const counts = { happy: 0, schema: 0, 'invalid-input': 0, auth: 0 };
  for (const m of spec.matchAll(/\btest\(\s*(['"`])\[(happy|schema|invalid-input|auth)\]/g)) {
    counts[m[2] as (typeof TYPES)[number]]++;
  }
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
  const findingRows = findings.map(
    (f) => `| ${cell(f.endpointId)} | ${cell(f.testTitle)} | ${cell(f.expectedStatus ?? 'n/a')} | ${cell(f.actualStatus ?? 'n/a')} |`,
  );

  return `# ${name} API tests

Playwright API tests for \`${config.baseUrl}\`, generated by the API Test Agent.
Standalone project: Node 20+ and npm are all you need. No browsers are installed or used.

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
4. \`npm run report\` to open the HTML report.

The API config (base URL, headers, endpoints) is in \`config/api.json\`.

## Production safety

Before any test runs, the base URL is checked (\`src/safety.ts\`). \`localhost\`, private IP addresses and \`.local\` hosts are local; hosts with a part such as \`dev\`, \`test\`, \`qa\`, \`staging\`, \`stage\`, \`sandbox\`, \`uat\` or \`preprod\` are non-production; everything else is production.

- Production host and \`allowProduction\` false in \`config/api.json\`: the run is refused and no request is sent.
- \`allowProduction\` true: read-only mode. Only GET, HEAD and OPTIONS are sent; tests of other endpoints, and of endpoints that create a resource first, are skipped, never passed.
- \`allowProduction\` and \`allowWrites\` both true: every request is sent. Only do this when changing real data is acceptable.

## Allure report

\`npm test\` also writes raw Allure results to \`allure-results/\`. Then:

1. \`npm run allure:generate\` builds the HTML report in \`allure-report/\` (Allure 3, no Java needed).
2. \`npm run allure:open\` serves it and opens it in the browser.

Tests are grouped by epic (the API), feature (the endpoint) and story (the case type). Auth and invalid-input tests have severity critical, the rest normal. Every request and response a test makes is attached to it as JSON, with the auth header shown as \`<redacted>\`.

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

// Every import must stay inside the framework folder or be one of its own dependencies.
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

export function exportFramework(opts: {
  config: Config;
  inputFile: string;
  authValue: string | undefined;
  endpoints: ExportEndpoint[];
  findings: ExportFinding[];
}): FrameworkInfo {
  const { config, inputFile, authValue, endpoints, findings } = opts;
  const name = apiName(config, inputFile);
  const dir = join(FRAMEWORKS_DIR, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'tests', 'fixtures'), { recursive: true });
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
          test: 'playwright test',
          report: 'playwright show-report',
          'allure:generate': 'allure generate allure-results --output allure-report',
          'allure:open': 'allure open allure-report',
        },
        devDependencies: pinnedVersions(),
      },
      null,
      2,
    ) + '\n',
  );
  write('playwright.config.ts', PLAYWRIGHT_CONFIG);
  write('tsconfig.json', TSCONFIG);
  // The validated config holds only the env variable name, never an auth value.
  // name is set to the framework name so the fixture can use it as the Allure epic.
  // The safety flags are always written, so a team can see and change them.
  write('config/api.json', JSON.stringify(exportedConfig(name, config), null, 2) + '\n');
  write('src/model.ts', modelSource());
  write('src/redact.ts', redactSource());
  write('src/http.ts', httpSource());
  write('src/safety.ts', safetySource());
  write('src/global-setup.ts', GLOBAL_SETUP_SOURCE);
  write('tests/fixtures/ctx.ts', CTX_SOURCE);
  if (config.auth) write('.env.example', `${config.auth.valueEnv}=\n`);
  write('.gitignore', 'node_modules/\n.env\nplaywright-report/\ntest-results/\nallure-results/\nallure-report/\n');

  const specs = new Map<string, string>();
  for (const e of endpoints) {
    if (!e.specFile) continue;
    const code = readFileSync(join('generated', e.specFile), 'utf8');
    const rewritten = code.replace(/(from\s*['"])\.\.\/tests\/fixtures\/ctx(?:\.ts)?(['"])/g, '$1./fixtures/ctx$2');
    if (rewritten === code) throw new Error(`framework export: could not rewrite the fixture import in ${e.specFile}`);
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
