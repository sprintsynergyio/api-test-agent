# API Test Agent

An agent that takes a base URL and a list of API endpoints, probes the real API, uses Claude to plan and write Playwright API tests, runs them, reports suspected API bugs, and exports a standalone Playwright framework. Endpoints can also be imported from OpenAPI, Postman, cURL, HAR or ticket text. It is a product under active development. Repo: `sprintsynergyhq/api-test-agent` (the local folder name may differ). History, status and setup are in `docs/HACKATHON-HANDOFF.md`.

## Commands

| Command | What it does |
|---|---|
| `npm run agent <input file>` | full pipeline (probe, plan, generate, run, export, summary) |
| `npm run api:local` / `npm run api:local:fixed` | local shop demo API on :4000, planted bugs on / off |
| `npm run ui` | demo UI on http://localhost:3000 |
| `npm run probe <input file>` | probe only |
| `npm run test:template` | hand-written template tests (must stay 4 passed) |
| `npm run typecheck` | TypeScript check (must stay clean) |
| `npm run allure` | open the last Allure report |
| `npm run -s import <type> < file` | import endpoints from a source file (see Importers) |
| `npm run test:importers` | importer tests (must stay all passed) |

Claude is called through the Claude Code CLI in headless mode (`claude -p`) using the machine's login. There is no API key. `CLAUDE_MODEL` in `.env` optionally overrides the model; `MAX_CLAUDE_CALLS` caps calls per run.

## Pipeline

1. `agent/probe.ts`: one real call per endpoint. Non-2xx is retried once, then the endpoint is marked unusable and skipped.
2. `agent/plan.ts`: Claude returns JSON test cases, validated with zod and against the status rules below; one retry.
3. `agent/generate.ts`: Claude writes one spec per endpoint, copying `tests/template/update-booking.spec.ts`.
4. `agent/validate.ts`: static gate. A candidate that fails it is retried once, then dropped. Nothing unsafe is ever written to `generated/`.
5. `agent/cli.ts`: runs plans and generations 3 at a time (phase by phase), runs Playwright with workers 1, writes `out/summary.json`, generates the Allure report.
6. `agent/export.ts`: writes `frameworks/<name>/` and `out/framework.zip`, then scans every file for the real auth value and fails loudly if found.

`generated/`, `out/` and `reports/` are deleted at the start of every run.

## Rules that must never be broken

1. Never edit files in `generated/` by hand. Fix the instructions in `plan.ts` or `generate.ts` instead.
2. Never change an expected status to make a test pass. A failing test may be a real API bug.
3. Status rules: happy and schema expect the exact 2xx from the probe; invalid-input expects any 4xx; auth expects 401 or 403; a test never expects a 5xx.
4. Finding classification: "suspected API finding" only when the actual status is 500 or higher, or an auth or invalid-input test got a 2xx. Everything else is "needs review". No `actual-status` annotation means never an API finding.
5. A failure must never look like a pass: no empty catches, no default plans, zero specs means "NO TESTS GENERATED" and exit 1.
6. Auth values come only from `.env` or the UI (env `CUSTOM_API_AUTH`, one run only). They must never appear in input files, summaries, reports, attachments, logs or the exported framework. The Claude CLI child process gets no env variable with AUTH in its name. Imported configs must never contain auth values (header values, cookies, tokens): importers drop them, keep only `auth.header` and `auth.valueEnv`, and warn naming what they dropped.
7. `tests/fixtures/ctx.ts` is the only test-side file that reads `process.env` or the input file. Tests use `ctx.api`, `ctx.noAuthApi`, `ctx.createResource(endpointId)`.
8. The UI reads agent output exactly as described in `ui/CONTRACT.md` (console phase headers, per-endpoint OK/FAILED lines, `out/summary.json` shape). Any change to agent output must keep that contract. Do not restyle `ui/` unless asked.
9. The exported framework must stay standalone: no imports from `agent/` or outside its own folder.
10. Never commit `node_modules/`, `out/`, `reports/`, `generated/`, `test-results/`, `frameworks/*` (except `frameworks/.gitkeep`), `.env` or `.DS_Store`. `.gitignore` covers them. Run `git status` before every commit and confirm none of them are listed.

## Static gate (agent/validate.ts) rejects a spec when

- it does not import `test` and `expect` from the ctx fixture, or imports from `@playwright/test` directly
- it contains `process.env`, `http://` or `https://`
- it contains `test.only`, `test.skip`, an empty catch, a catch that does not rethrow, or `.catch(`
- a title does not start with `[happy]`, `[schema]`, `[invalid-input]` or `[auth]`
- a test lacks the `actual-status` annotation before its first assertion
- any assertion expects a status of 500 or higher
- it has fewer tests than plan cases, or fails typecheck

## Input files

`input/endpoints.json` and `input/demo-small.json` (Restful Booker), `input/local-shop.json` (local demo API). Shape: optional `name`, `baseUrl`, `defaultHeaders`, optional `auth { header, valueEnv }`, `endpoints[] { id, method, path, requiresAuth, body?, setup? { endpointId, idField } }`. Do not overwrite the three kit files. `input/import-openapi-local-shop.json` and `input/import-postman-local-shop.json` are imported from the local shop fixtures and must give the same results as `input/local-shop.json`.

## Importers

`agent/import.ts` plus `agent/importers/` (`core.ts` shared, one file per format) turn an existing API description into the input file shape, validated with the same zod schema.

| Type | Source |
|---|---|
| `openapi` | OpenAPI 3.x or Swagger 2.0, JSON or YAML |
| `postman` | Postman collection v2.0 / v2.1 |
| `curl` | one or more curl commands |
| `har` | browser network capture (static assets, analytics and other origins filtered out) |
| `text` | Jira / Confluence text; Claude extracts it, at most 2 calls, outside the run budget |

- Command: `npm run -s import <type> < file`. It reads stdin and prints one JSON object `{ input, skipped, warnings }` on stdout. It writes no file; to make an input file: `npm run -s import openapi < spec.yaml | jq '.input' > input/<name>.json` (keep `-s`: without it npm's banner breaks the JSON). Nothing importable: exit 1, reason on stderr.
- The UI uses the same CLI through `POST /api/import` (Custom API tab, Source). See `ui/CONTRACT.md` section 6.
- Base URL: the most common origin; requests to other origins are skipped. Empty when the source has none, with a warning.
- Path parameters: `{id}`, `:id` and `{{id}}` become `{id}`; in HAR, numeric and UUID segments become `{id}`.
- Bodies: JSON objects only. Form, XML and other bodies are skipped with the reason. OpenAPI uses the example, else builds one from the schema's required fields.
- Setup: a path with a placeholder gets `setup` from the POST on its parent path, with a warning to check `idField`.
- Auth: credentials are dropped (Authorization, Cookie, any header with auth/token/key/secret/session in its name, Postman auth blocks, curl `-u`/`-b`, credential query params, URL userinfo). Those endpoints get `requiresAuth: true` and the input gets `auth { header, valueEnv: "CUSTOM_API_AUTH" }`. Nothing is dropped silently: every skipped item has a reason.
- Tests: `npm run test:importers` (`agent/importers/importers.test.ts`, plain `node:assert` via tsx, no Playwright). Two tests make live Claude calls, so `claude` must be logged in. Fixtures are in `test-fixtures/importers/` and use only the fake credential `importer-secret-test-value`.

## How to verify any change

1. `npm run typecheck`: no errors.
2. `npm run test:template`: 4 passed.
3. Tab 1 `npm run api:local`, then `npm run agent input/local-shop.json`: exactly 2 suspected API findings (create-product with a text price returns 500; delete-product without auth returns 204), every other test passes, contract check clean.
4. `npm run api:local:fixed`, same run: 0 findings, 0 failures.
5. `grep -r "hackathon-demo-token\|YWRtaW46" out/ reports/ frameworks/ input/`: no matches.
6. `npm run test:importers`: all passed, 0 failed.
7. Paste raw command output in your reply, not a summary. Commit after each verified change on branch `main` (`git status` first, rule 10). Pushing to `origin main` is allowed. Never force push.

## Known environment notes

- macOS assumed: `npm run api:local:fixed` uses `FIXED=1 node ...` and Allure 3 uses macOS's `mdls`. On Windows, Allure may not generate (the run continues with `allureReport: null`).
- If port 3000 or 4000 is busy: `lsof -ti :3000 | xargs kill`.
- If `tsx` fails with "The service was stopped", macOS killed a quarantined esbuild binary (folder copied from a zip or download). Fix: `npm ci`.
- Restful Booker is a shared public server that resets its data; a random 404 there is not a code bug.
