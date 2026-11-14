import { readFileSync } from 'node:fs';
import type { Config } from '../config';
import { allAuthEnvNames } from '../auth';

// Pieces both exporters share.

// agent/model.ts has no imports, so it is copied as it is (src/model.ts).
export function modelSource(): string {
  const src = readFileSync('agent/model.ts', 'utf8');
  if (/^\s*import\s/m.test(src)) throw new Error('framework export: agent/model.ts must not import anything');
  return src;
}

// config/api.json for an exported framework: the validated config without the agent-only fields and
// never an auth value. With a profile, the resolved baseUrl and selection are left out so the one
// export serves every environment, brand and region (AGENT_SELECT picks one at run time).
// The safety flags are always written, so a team can see and change them.
export function exportedConfig(name: string, config: Config): Record<string, unknown> {
  const { name: _inputName, framework: _framework, allowProduction, allowWrites, selection: _selection, baseUrl, ...rest } = config;
  return {
    name,
    ...(config.profile ? {} : { baseUrl }),
    ...rest,
    allowProduction: allowProduction === true,
    allowWrites: allowWrites === true,
  };
}

// agent/redact.ts has no imports either, so it is copied as it is (src/redact.ts).
export function redactSource(): string {
  const src = readFileSync('agent/redact.ts', 'utf8');
  if (/^\s*import\s/m.test(src)) throw new Error('framework export: agent/redact.ts must not import anything');
  return src;
}

// CI files
// Both exports ship a GitHub Actions workflow and an Azure Pipelines file. Every auth value stays a
// CI secret named after the env variable in config/api.json (valueEnv, credentialsEnv, clientIdEnv,
// clientSecretEnv); the files never hold a value. AGENT_SELECT is passed through for profiles.

export type CiOptions = { testCommand: string; reportDir: string; reportLabel: string };

function secretNames(config: Config): string[] {
  return allAuthEnvNames(config.auth);
}

function githubWorkflow(config: Config, opts: CiOptions): string {
  const names = secretNames(config);
  const envLines = names.map((n) => `          ${n}: \${{ secrets.${n} }}`).join('\n');
  const selectLine = config.profile ? `          AGENT_SELECT: \${{ vars.AGENT_SELECT }}\n` : '';
  return `# API tests in GitHub Actions.
# Add every secret listed under env (Settings > Secrets and variables > Actions) with the value the team
# uses for the API under test. The workflow never prints them; the reports are redacted before upload.
${config.profile ? '# AGENT_SELECT (a repository variable, for example env=staging,brand=alpha,region=eu) picks the profile values.\n' : ''}name: API tests

on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:

jobs:
  api-tests:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - run: npm ci

      - name: Run API tests
        run: ${opts.testCommand}
        env:
${envLines || '          CI: "true"'}
${selectLine}
      - name: Upload report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: ${opts.reportLabel}
          path: ${opts.reportDir}
          if-no-files-found: warn
`;
}

function azurePipeline(config: Config, opts: CiOptions): string {
  const names = secretNames(config);
  const envLines = names.map((n) => `      ${n}: $(${n})`).join('\n');
  const selectLine = config.profile ? `      AGENT_SELECT: $(AGENT_SELECT)\n` : '';
  return `# API tests in Azure Pipelines.
# Create every variable listed under env as a secret pipeline variable (Pipelines > Edit > Variables,
# "Keep this value secret") or in a variable group. Secret variables are not passed to scripts on their
# own, which is why each one is mapped under env below. The reports are redacted before publishing.
${config.profile ? '# AGENT_SELECT (for example env=staging,brand=alpha,region=eu) picks the profile values.\n' : ''}trigger:
  branches:
    include:
      - main

pr:
  branches:
    include:
      - '*'

pool:
  vmImage: ubuntu-latest

steps:
  - task: NodeTool@0
    inputs:
      versionSpec: '20.x'
    displayName: Use Node 20

  - script: npm ci
    displayName: Install

  - script: ${opts.testCommand}
    displayName: Run API tests
    env:
${envLines || '      CI: "true"'}
${selectLine}
  - task: PublishPipelineArtifact@1
    condition: always()
    inputs:
      targetPath: ${opts.reportDir}
      artifact: ${opts.reportLabel}
    displayName: Publish report
`;
}

export function ciFiles(config: Config, opts: CiOptions): Record<string, string> {
  return {
    '.github/workflows/api-tests.yml': githubWorkflow(config, opts),
    'azure-pipelines.yml': azurePipeline(config, opts),
  };
}

// The README section both exports print: which secrets to create, by their exact names.
export function ciReadmeSection(config: Config, testCommand: string, reportDir: string): string {
  const names = secretNames(config);
  const secrets = names.length
    ? `Create these secrets in the CI system, one per line of \`.env.example\`, with the values the team uses for the API under test:\n\n${names.map((n) => `- \`${n}\``).join('\n')}\n`
    : 'This API needs no auth value, so there are no secrets to create.\n';
  return `## Run in CI

Two ready-made pipeline files are included. Both install with \`npm ci\` on Node 20, run \`${testCommand}\`, and upload \`${reportDir}\` as a build artifact whether the tests pass or fail.

- \`.github/workflows/api-tests.yml\` for GitHub Actions (Settings > Secrets and variables > Actions)
- \`azure-pipelines.yml\` for Azure Pipelines (Pipelines > Edit > Variables, mark each one secret)

${secrets}${config.profile ? '\nThe profile needs `AGENT_SELECT` as well (a plain variable, for example `env=staging,brand=alpha,region=eu`).\n' : ''}
The files hold variable names only; the values live in the CI secret store and never in the repository.`;
}
