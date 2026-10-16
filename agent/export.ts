import { spawnSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { Config, Endpoint } from './config';

// Writes the generated suite as a standalone Playwright project in frameworks/<name>/ and zips it.

const FRAMEWORKS_DIR = 'frameworks';
const ZIP_FILE = 'out/framework.zip';
const ALLOWED_PACKAGES = new Set(['@playwright/test', 'dotenv', 'dotenv/config']);
const TYPES = ['happy', 'schema', 'invalid-input', 'auth'] as const;

export type FrameworkInfo = { name: string; dir: string; zip: string; files: string[]; specCount: number };

export type ExportEndpoint = { endpoint: Endpoint; specFile: string | null; failureReason: string | null };
export type ExportFinding = { endpointId: string; testTitle: string; expectedStatus: string | null; actualStatus: number | null };

export function frameworkName(config: Config, inputFile: string): string {
  const fromFile = basename(inputFile).replace(/\.json$/, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  const name = config.name ?? fromFile;
  return name === 'ui-run' ? 'custom-api' : name;
}

function pinnedVersions(): Record<string, string> {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { devDependencies: Record<string, string> };
  const pick = ['@playwright/test', 'dotenv', 'typescript', '@types/node'];
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
  if (!src.includes(importLine)) throw new Error('framework export: agent/http.ts no longer imports Config as expected');
  return src
    .replace(
      importLine,
      `export type Config = {
  name?: string;
  baseUrl: string;
  defaultHeaders: Record<string, string>;
  auth?: { header: string; valueEnv: string };
  endpoints: {
    id: string;
    method: string;
    path: string;
    requiresAuth: boolean;
    body?: Record<string, unknown>;
    setup?: { endpointId: string; idField: string };
  }[];
};`,
    )
    .replace(/^\/\/ Shared HTTP logic for the ctx fixture and the agent\./m, '// HTTP clients and createResource for the ctx fixture.');
}

const CTX_SOURCE = `import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type APIRequestContext } from '@playwright/test';
import { createClients, createResource, disposeClients, type Config } from '../../src/http';

// The only file that reads process.env. The API config comes from config/api.json.

export type Ctx = {
  baseUrl: string;
  api: APIRequestContext;
  noAuthApi: APIRequestContext;
  createResource: (endpointId: string) => Promise<string>;
};

const configFile = fileURLToPath(new URL('../../config/api.json', import.meta.url));

export const test = base.extend<{ ctx: Ctx }>({
  ctx: async ({}, use) => {
    const config = JSON.parse(readFileSync(configFile, 'utf8')) as Config;

    // No auth section: api and noAuthApi are the same. With one, the value must be set.
    const authValue = config.auth ? process.env[config.auth.valueEnv] : undefined;
    if (config.auth && !authValue) {
      throw new Error(
        \`Missing auth value: environment variable \${config.auth.valueEnv} is not set. Copy .env.example to .env and fill it in.\`,
      );
    }

    const clients = await createClients(config, authValue);

    await use({
      baseUrl: config.baseUrl,
      api: clients.api,
      noAuthApi: clients.noAuthApi,
      createResource: (endpointId) => createResource(config, clients, endpointId),
    });

    await disposeClients(clients);
  },
});

export { expect };
`;

const PLAYWRIGHT_CONFIG = `import 'dotenv/config';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  // The tests share one live API, so they run one at a time.
  workers: 1,
  timeout: 60_000,
  reporter: [['list'], ['html', { open: 'never' }]],
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
  const name = frameworkName(config, inputFile);
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
        scripts: { test: 'playwright test', report: 'playwright show-report' },
        devDependencies: pinnedVersions(),
      },
      null,
      2,
    ) + '\n',
  );
  write('playwright.config.ts', PLAYWRIGHT_CONFIG);
  write('tsconfig.json', TSCONFIG);
  // The validated config holds only the env variable name, never an auth value.
  write('config/api.json', JSON.stringify(config, null, 2) + '\n');
  write('src/http.ts', httpSource());
  write('tests/fixtures/ctx.ts', CTX_SOURCE);
  if (config.auth) write('.env.example', `${config.auth.valueEnv}=\n`);
  write('.gitignore', 'node_modules/\n.env\nplaywright-report/\ntest-results/\n');

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
