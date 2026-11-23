import { zipFolder } from './zip';
import { builtinModules } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { allAuthEnvNames, describeAuth } from './auth';
import { apiName, type Config } from './config';
import { ciFiles, ciReadmeSection, exportedConfig, modelSource, redactSource } from './frameworks/shared-export';

// Writes the generated suite as a standalone Playwright project in frameworks/<name>/ and zips it.

const FRAMEWORKS_DIR = 'frameworks';
const ZIP_FILE = 'out/framework.zip';
const ALLOWED_PACKAGES = new Set(['@playwright/test', 'dotenv', 'dotenv/config', 'allure-js-commons']);
const TYPES = ['happy', 'schema', 'invalid-input', 'auth', 'authz'] as const;

import type { ExportEndpoint, ExportFinding, ExportOptions, FrameworkInfo } from './frameworks/types';
import { buildClientLayer, clientLayerFiles, type ClientLayer } from './client-layer';
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

// Self-contained copy of agent/http.ts: same logic, with the Config type inlined. It imports
// ./auth, ./model and ./safety, which are copied next to it.
function httpSource(): string {
  const src = readFileSync('agent/http.ts', 'utf8');
  const importLine = "import type { Config } from './config';";
  const modelLine = "import { isBinaryContentType, joinUrl, parseTestTitle, pathParams, queryString, resolvePath, setupSteps, testTypeOf } from './model';";
  if (!src.includes(modelLine)) throw new Error('framework export: agent/http.ts no longer imports model helpers as expected');
  if (!src.includes(importLine)) throw new Error('framework export: agent/http.ts no longer imports Config as expected');
  if (!src.includes("} from './auth';")) throw new Error('framework export: agent/http.ts no longer imports ./auth as expected');
  return src
    .replace(
      importLine,
      `export type Config = {
  name?: string;
  baseUrl: string;
  defaultHeaders: Record<string, string>;
  auth?: AuthConfig;
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
    pathParams?: Record<string, string>;
  }[];
};`,
    )
    .replace(modelLine, "import { isBinaryContentType, joinUrl, parseTestTitle, pathParams, queryString, resolvePath, setupSteps, testTypeOf, type Profile, type Query, type Selection, type Setup } from './model';")
    .replace("  type AuthRequest,\n} from './auth';", "  type AuthConfig,\n  type AuthRequest,\n} from './auth';")
    .replace("import { redactHeaders, redactText, redactValue, type RedactionCounter } from './redact';", "import { redactHeaders, redactText, redactValue, type RedactionConfig, type RedactionCounter } from './redact';")
    .replace(/^\/\/ Shared HTTP logic for the ctx fixture and the agent\./m, '// HTTP clients and createResource for the ctx fixture.');
}

// agent/auth.ts has no imports, so it is copied as it is (src/auth.ts).
export function authSource(): string {
  const src = readFileSync('agent/auth.ts', 'utf8');
  if (/^\s*import\s/m.test(src)) throw new Error('framework export: agent/auth.ts must not import anything');
  return src;
}

// agent/test-data.ts imports only node:fs, so it is copied as it is (the fixture imports ./test-data).
export function testDataSource(): string {
  const src = readFileSync('agent/test-data.ts', 'utf8');
  const imports = src.match(/^import .*$/gm) ?? [];
  if (imports.some((l) => !/from 'node:fs';$/.test(l))) throw new Error('framework export: agent/test-data.ts must import only node:fs');
  return src;
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
import { pickAuthEnv } from '../../src/auth';
import { applyProfile } from '../../src/model';
import { endpointAllowed, READ_ONLY_SKIP } from '../../src/safety';
import { existsSync } from 'node:fs';
import { loadTestData, requiredDataVerdict, type TestData } from '../../src/test-data';

// The only test-side file that reads process.env (src/global-setup.ts checks the host once before
// the run). The API config comes from config/api.json.

export type Ctx = {
  baseUrl: string;
  api: APIRequestContext;
  noAuthApi: APIRequestContext;
  // A client authenticated as another role from auth.roles (for [authz] tests).
  as: (role: string) => APIRequestContext;
  createResource: (endpointId: string) => Promise<string>;
  // Runs this spec's endpoint setup steps and returns every path placeholder value.
  setup: () => Promise<Record<string, string>>;
  // Skips the test with DATA_NOT_ON_ENV when data it needs is not on this environment (README).
  requireData: (names: string[]) => Promise<void>;
};

const configFile = fileURLToPath(new URL('../../config/api.json', import.meta.url));
// Test data for this environment: TEST_DATA_FILE, else config/test-data.json when it exists.
const defaultTestData = fileURLToPath(new URL('../../config/test-data.json', import.meta.url));
let testData: TestData | null | undefined;

export const test = base.extend<{ ctx: Ctx }>({
  ctx: async ({}, use, testInfo) => {
    // With a profile, AGENT_SELECT (env=staging,brand=alpha,...) picks the base URL and headers.
    const config = applyProfile(JSON.parse(readFileSync(configFile, 'utf8')), process.env.AGENT_SELECT) as Config;

    // Only the environment variables the auth section names leave this file (src/auth.ts). A missing
    // one throws with its name (copy .env.example to .env). Without an auth section, api and
    // noAuthApi are the same.
    const authEnv = pickAuthEnv(config.auth, process.env);

    await labels(...reportLabels(config.name ?? 'api', testInfo.titlePath, testInfo.file));

    // The safety guard: refused on a production host without allowProduction, writes blocked in
    // read-only mode. AGENT_FORCE_PRODUCTION=1 (testing only) treats every host as production.
    const clients = await createClients(config, authEnv, { forceProduction: process.env.AGENT_FORCE_PRODUCTION === '1' });
    // A spec is named after its endpoint. In read-only mode a write endpoint's tests are skipped, never passed.
    const endpoint = config.endpoints.find((e) => \`\${e.id}.spec.ts\` === testInfo.file.split(/[\\\\/]/).pop());
    if (endpoint && !endpointAllowed(clients.safety, endpoint)) {
      await disposeClients(clients);
      testInfo.skip(true, READ_ONLY_SKIP);
    }

    // Every request and response is attached to the test (Playwright report and Allure), login
    // requests included, with every credential value and token scrubbed and the redaction rules applied.
    const redaction = { replaced: 0 };
    const recordedClients = recordClients(config, clients, async (exchange) => {
      const { name, body } = formatExchange(config, exchange, clients.secrets(), redaction);
      await testInfo.attach(name, { body, contentType: 'application/json' });
    });

    await use({
      baseUrl: config.baseUrl,
      api: recordedClients.api,
      noAuthApi: recordedClients.noAuthApi,
      as: (role) => recordedClients.as(role),
      createResource: (endpointId) => createResource(config, recordedClients, endpointId),
      setup: async () => {
        if (!endpoint) throw new Error('ctx.setup: no endpoint in config/api.json is named after this spec file');
        return runSetup(config, recordedClients, endpoint);
      },
      requireData: async (names) => {
        if (testData === undefined) {
          const file = process.env.TEST_DATA_FILE || (existsSync(defaultTestData) ? defaultTestData : '');
          testData = file ? loadTestData(file) : null;
        }
        const lookup = testData?.lookup;
        if (!lookup || !names.length) return;
        const e = config.endpoints.find((x) => x.id === lookup.endpointId);
        let verdict: string | null;
        if (!e || e.method !== 'GET' || /\\{[^}]+\\}/.test(e.path)) {
          verdict = 'ENV_UNAVAILABLE: the data lookup ' + lookup.endpointId + ' must be a GET endpoint in config/api.json without path parameters';
        } else {
          try {
            const client = e.requiresAuth ? recordedClients.api : recordedClients.noAuthApi;
            const res = await client.fetch(e.path, { method: 'GET', params: { ...(e.query ?? {}), ...(lookup.query ?? {}) } as Record<string, string | number | boolean>, headers: e.headers });
            verdict = requiredDataVerdict(names, e.id, testData?.environment, { status: res.status(), text: await res.text() });
          } catch (err) {
            verdict = requiredDataVerdict(names, e.id, testData?.environment, { status: null, text: '', error: String((err as Error).message ?? err).split('\\n')[0] });
          }
        }
        testInfo.skip(verdict !== null, verdict ?? '');
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
  const counts = { happy: 0, schema: 0, 'invalid-input': 0, auth: 0, authz: 0 };
  for (const m of spec.matchAll(/\btest\(\s*(['"`])(?:\[[^\]\n]{1,64}\]\s+)?\[(happy|schema|invalid-input|auth|authz)\]/g)) {
    counts[m[2] as (typeof TYPES)[number]]++;
  }
  return counts;
}

// The README section for the clients layout: where a path or a sample body is changed.
function clientLayerReadme(layer: ClientLayer | null): string {
  if (!layer) return '';
  const rows = layer.classes.map((c) => `| \`${c.className}\` | \`src/clients/${c.file}.ts\` | ${c.hasData ? `\`src/data/${c.file}.ts\`` : 'none'} | ${c.methods.map((m) => `\`${m.name}\``).join(', ')} |`);
  return `
## Client layer

The tests do not write paths or request bodies themselves. Each resource has a client class with one method per endpoint, and a data file with the sample request bodies:

| Class | File | Sample bodies | Methods |
|---|---|---|---|
${rows.join('\n')}

A test sends its request like this: \`new ${layer.classes[0].className}(ctx.api).${layer.classes[0].methods[0].name}(...)\`. The class is given \`ctx.api\`, \`ctx.noAuthApi\` (no credentials) or \`ctx.as('<role>')\`, so every request still goes through the checked clients in \`tests/fixtures/ctx.ts\`.

- A path or a default query value changed in the API: change it once in the client class.
- A sample body changed: change it once in the data file. Every test that sends a valid body picks it up; an invalid-input test starts from the same body and changes only its own field.
- A new endpoint: add a method to the class (and a body function to the data file), then write its tests.
`;
}

function readme(name: string, config: Config, endpoints: ExportEndpoint[], specs: Map<string, string>, findings: ExportFinding[], layer: ClientLayer | null = null): string {
  const rows = endpoints
    .filter((e) => e.specFile)
    .map((e) => {
      const c = countByType(specs.get(e.endpoint.id) ?? '');
      return `| ${e.endpoint.id} | ${e.endpoint.method} | \`${e.endpoint.path}\` | ${TYPES.map((t) => c[t]).join(' | ')} |`;
    });
  const missing = endpoints.filter((e) => !e.specFile);
  const envStep = config.auth
    ? `2. \`cp .env.example .env\` and fill in ${allAuthEnvNames(config.auth).map((n) => `\`${n}\``).join(', ')}. Auth: ${describeAuth(config.auth)}`
    : '2. No auth is needed for this API, so there is no .env to fill in.';
  const cell = (v: unknown) => String(v).replace(/\|/g, '\\|');
  const findingRows = findings.map(
    (f) => `| ${cell(f.endpointId)} | ${cell(f.testTitle)} | ${cell(f.expectedStatus ?? 'n/a')} | ${cell(f.actualStatus ?? 'n/a')} |`,
  );

  return `# ${name} API tests

Playwright API tests for \`${config.baseUrl}\`, generated by the API Test Agent.
Standalone project: Node 22+ and npm are all you need. No browsers are installed or used.

## What the suite covers

| Endpoint | Method | Path | happy | schema | invalid-input | auth | authz |
|---|---|---|---|---|---|---|---|
${rows.join('\n')}
${missing.length ? `\nNot covered (no spec was generated): ${missing.map((e) => `${e.endpoint.id} (${e.failureReason ?? 'unknown'})`).join('; ')}.\n` : ''}
Case types: **happy** valid request succeeds and returns the values sent; **schema** response fields are present with the right types; **invalid-input** bad input is rejected with a 4xx; **auth** a request without credentials is rejected with 401 or 403; **authz** the same request as another role (\`ctx.as('<role>')\`) is rejected with 403 or 404.

## How to run

1. \`npm install\`
${envStep}
3. \`npm test\`
4. \`npm run report\` to open the HTML report.

The API config (base URL, headers, endpoints) is in \`config/api.json\`.
${clientLayerReadme(layer)}
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

${ciReadmeSection(config, 'npm test', 'playwright-report')}

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

export function exportFramework(opts: ExportOptions): FrameworkInfo {
  const { config, inputFile, secrets, endpoints, findings } = opts;
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
  write('src/auth.ts', authSource());
  write('src/redact.ts', redactSource());
  write('src/http.ts', httpSource());
  write('src/safety.ts', safetySource());
  write('src/test-data.ts', testDataSource());
  if (opts.testData) write('config/test-data.json', JSON.stringify(opts.testData, null, 2) + '\n');
  write('src/global-setup.ts', GLOBAL_SETUP_SOURCE);
  write('tests/fixtures/ctx.ts', CTX_SOURCE);
  if (config.auth) write('.env.example', allAuthEnvNames(config.auth).map((n) => `${n}=\n`).join(''));
  write('.gitignore', 'node_modules/\n.env\nplaywright-report/\ntest-results/\nallure-results/\nallure-report/\n');
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
  for (const [file, content] of Object.entries(ciFiles(config, { testCommand: 'npm test', reportDir: 'playwright-report', reportLabel: 'playwright-report' }))) write(file, content);

  // The clients layout: the client classes and sample bodies go to src/clients and src/data. They are
  // built again from the config (the same code and the same input as during the run, so the same
  // files), never copied from generated/.
  const layer = config.layout === 'clients' ? buildClientLayer(config) : null;
  if (layer) {
    mkdirSync(join(dir, 'src', 'clients'), { recursive: true });
    for (const f of clientLayerFiles(layer)) {
      mkdirSync(dirname(join(dir, 'src', f.path)), { recursive: true });
      write(join('src', f.path), f.content);
    }
  }

  const specs = new Map<string, string>();
  for (const e of endpoints) {
    if (!e.specFile) continue;
    const code = readFileSync(join('generated', e.specFile), 'utf8');
    let rewritten = code.replace(/(from\s*['"])\.\.\/tests\/fixtures\/ctx(?:\.ts)?(['"])/g, '$1./fixtures/ctx$2');
    if (rewritten === code) throw new Error(`framework export: could not rewrite the fixture import in ${e.specFile}`);
    if (layer) {
      const before = rewritten;
      rewritten = rewritten.replace(/(from\s*['"])\.\.\/generated\/(clients|data)\//g, '$1../src/$2/');
      if (rewritten === before) throw new Error(`framework export: ${e.specFile} does not import its client class`);
    }
    specs.set(e.endpoint.id, rewritten);
    write(join('tests', e.specFile), rewritten);
  }
  write('README.md', readme(name, config, endpoints, specs, findings, layer));
  for (const f of opts.extraFiles ?? []) if (/^[\w.-]+$/.test(f.path)) write(f.path, f.content);

  const files = listFiles(dir);

  const problems = checkSelfContained(dir, files);
  for (const file of files) {
    const text = readFileSync(join(dir, file), 'utf8');
    for (const secret of secrets) if (secret && text.includes(secret)) problems.push(`${file} contains an auth value`);
  }
  if (problems.length) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`FRAMEWORK EXPORT FAILED, folder deleted: ${problems.join('; ')}`);
  }

  mkdirSync(dirname(ZIP_FILE), { recursive: true });
  rmSync(ZIP_FILE, { force: true });
  try {
    zipFolder(dir, name, resolve(ZIP_FILE));
  } catch (err) {
    throw new Error(`FRAMEWORK EXPORT FAILED: could not write ${ZIP_FILE}: ${(err as Error).message}`);
  }

  return { name, dir, zip: ZIP_FILE, files, specCount: specs.size };
}
