# API Test Agent

An agent that takes a base URL and a list of API endpoints, probes the real API, uses Claude to plan and write API tests in Playwright or Pactum (Mocha), runs them, reports suspected API bugs, and exports a standalone test framework. Endpoints can also be imported from OpenAPI, Postman, cURL, HAR or ticket text. It is a product under active development. Repo: `sprintsynergyio/api-test-agent` (the local folder name may differ). History, status and setup are in `docs/HACKATHON-HANDOFF.md`.

## Commands

| Command | What it does |
|---|---|
| `npm run agent <input file>` | full pipeline (probe, plan, generate, run, export, summary) |
| `npm run api:local` / `npm run api:local:fixed` | local shop demo API on :4000, planted bugs on (the two default ones) / off. `BUGS=id,id npm run api:local` turns on exactly those bugs from `local-api/bugs.json` |
| `npm run ui` | demo UI on http://localhost:3000 |
| `npm run probe <input file>` | probe only |
| `npm run test:template` | hand-written Playwright template tests (must stay 4 passed) |
| `npm run test:template:pactum` | hand-written Pactum template tests against the local shop API (must stay 4 passing) |
| `npm run typecheck` | TypeScript check (must stay clean) |
| `npm run allure` | open the last Allure report |
| `npm run -s import <type> < file` | import endpoints from a source file (see Importers) |
| `npm run test:importers` | importer tests, offline (must stay all passed; `RUN_LIVE_CLAUDE_TESTS=1` adds the 2 live Claude tests) |
| `npm run test:safety` | safety guard tests: host rules, modes, HTTP layer (must stay all passed) |
| `npm run test:gate` | Playwright static gate tests: per-type status rules, noAuthApi rule, per-type plan coverage (must stay all passed) |
| `npm run test:gate:pactum` | Pactum static gate tests (must stay all passed) |
| `npm run eval -- [--runs N] [--bugs all\|none\|id,id] [--dry-run]` | eval harness: runs the agent against every planted-bug set and prints detection, false alarm and flakiness rates (see Eval harness) |
| `npm run test:eval` | eval harness tests, offline: the scorer, and every planted bug against a real local API (must stay all passed) |
| `npm run check:contract` | checks `out/summary.json` against `ui/CONTRACT.md`, lists every problem, exit 1 on any |

Claude is called through the Claude Code CLI in headless mode (`claude -p`) using the machine's login. There is no API key. `CLAUDE_MODEL` in `.env` optionally overrides the model; `MAX_CLAUDE_CALLS` caps calls per run.

## Frameworks

The output framework is an adapter in `agent/frameworks/` (`types.ts` is the interface, `playwright.ts` and `pactum.ts` the two adapters, `index.ts` picks one). The input file's optional `"framework": "playwright" | "pactum"` decides; missing means playwright. Shared and never framework-aware: importers, probe, plan, status rules, finding classification, summary, safety guard, auth handling. Per adapter: template, generator rules, static gate, runner and results parser, exporter. Every adapter returns normalized results (endpoint id, title, passed, actual status, error, requests sent); `cli.ts` only reads those.

Pactum: tests are Mocha `describe`/`it` files that import `{ ctx, expect, recordStatus }` from `tests-pactum/setup/ctx.ts` and nothing from `pactum`. `ctx.api` and `ctx.noAuthApi` return a response with `status()`, `ok()`, `headers()`, `text()` and `json()`; every request goes through one guarded `send()` that applies rule 11, counts requests and writes redacted evidence to `reports/pactum/evidence/`. `recordStatus(status)` is the Pactum equivalent of the `actual-status` annotation; a Mocha root hook writes it to `reports/pactum/status.json` and skips write endpoints in read-only mode. `expect` is a small matcher set in the setup file with the same names as Playwright's, so the per-type gate rules are shared. Runner: `mocha --config .mocharc.pactum.json` with the JSON reporter to `reports/pactum/results.json`. Export: `frameworks/<name>-pactum/`. Allure is not wired for Pactum yet; `allureReport` is null on Pactum runs.

## Pipeline

0. `agent/safety.ts`: classifies the base URL's host and sets the safety mode (rule 11) before any request.
1. `agent/probe.ts`: one real call per endpoint. Non-2xx is retried once, then the endpoint is marked unusable and skipped.
2. `agent/plan.ts`: Claude returns JSON test cases, validated with zod and against the status rules below; one retry.
3. `agent/generate.ts`: Claude writes one spec per endpoint, copying the adapter's template (`tests/template/update-booking.spec.ts` or `tests-pactum/template/update-product.spec.ts`).
4. `agent/validate.ts`: static gate (`validateWithRules` shared, framework rules from the adapter). A candidate that fails it is retried once, then dropped. Nothing unsafe is ever written to `generated/`.
5. `agent/cli.ts`: runs plans and generations 3 at a time (phase by phase), runs the adapter's runner one test at a time, writes `out/summary.json` (with `testFramework`), and the Allure report for Playwright.
6. `agent/export.ts` (Playwright) or `agent/frameworks/pactum.ts` (Pactum): writes `frameworks/<name>/` (or `<name>-pactum/`) and `out/framework.zip`, then scans every file for the real auth value and fails loudly if found.

`generated/`, `out/` and `reports/` are deleted at the start of every run.

## Rules that must never be broken

1. Never edit files in `generated/` by hand. Fix the instructions in `plan.ts` or `generate.ts` instead.
2. Never change an expected status to make a test pass. A failing test may be a real API bug.
3. Status rules: happy and schema expect the exact 2xx from the probe; invalid-input expects any 4xx; auth expects 401 or 403; a test never expects a 5xx.
4. Finding classification: "suspected API finding" only when the actual status is 500 or higher, or an auth or invalid-input test got a 2xx. Everything else is "needs review". No `actual-status` annotation means never an API finding.
5. A failure must never look like a pass: no empty catches, no default plans, zero specs means "NO TESTS GENERATED" and exit 1.
6. Auth values come only from `.env` or the UI (env `CUSTOM_API_AUTH`, one run only). They must never appear in input files, summaries, reports, attachments, logs or the exported framework. The Claude CLI child process gets no env variable with AUTH in its name. Imported configs must never contain auth values (header values, cookies, tokens): importers drop them, keep only `auth.header` and `auth.valueEnv`, and warn naming what they dropped.
7. `tests/fixtures/ctx.ts` (Playwright) and `tests-pactum/setup/ctx.ts` (Pactum) are the only test-side files that read `process.env` or the input file. Tests use `ctx.api`, `ctx.noAuthApi`, `ctx.createResource(endpointId)`. Pactum tests never import `pactum`, so the guard in `send()` covers every request.
8. The UI reads agent output exactly as described in `ui/CONTRACT.md` (console phase headers, per-endpoint OK/FAILED lines, `out/summary.json` shape). Any change to agent output must keep that contract. Do not restyle `ui/` unless asked.
9. The exported framework must stay standalone: no imports from `agent/` or outside its own folder.
10. Never commit `node_modules/`, `out/`, `reports/`, `generated/`, `test-results/`, `frameworks/*` (except `frameworks/.gitkeep`), `.env` or `.DS_Store`. `.gitignore` covers them. Run `git status` before every commit and confirm none of them are listed.
11. Production safety guard (`agent/safety.ts`). The host is local (localhost, 127.0.0.1, ::1, `.local`, host.docker.internal, 10.x, 172.16 to 172.31.x, 192.168.x), non-production (a whole part, split on "." and "-", is dev, test, qa, staging, stage, sandbox, uat or preprod) or production (everything else). Local and non-production: mode "full". Production without `allowProduction`: "refused", no request is sent, status "refused", exit 1. Production with `allowProduction`: "read-only", only GET, HEAD and OPTIONS endpoints without setup run, the rest are "skipped: read-only mode" and never counted as passed. With `allowWrites` as well: "full" plus the WARNING line. The guard lives in the shared HTTP layer (`agent/http.ts` `createClients`), so it covers probe, `createResource`, the ctx fixture and the exported framework; never bypass it with a client made elsewhere. Nothing may make a production host count as local or non-production. `ui/host-class.mjs` must keep the same rules (checked by `npm run test:safety`).

## Static gate (agent/validate.ts) rejects a spec when

Shared rules (both frameworks) plus the framework rules in each adapter. Pactum adds: must import `ctx`, `expect` and `recordStatus` from the setup file; no `pactum`, `node:assert` or `chai` import; no `.only`, `.skip`, `xit`, `xdescribe` or `this.skip()`.

- it does not import `test` and `expect` from the ctx fixture, or imports from `@playwright/test` directly
- it contains `process.env`, `http://` or `https://`
- it contains `test.only`, `test.skip`, an empty catch, a catch that does not rethrow, or `.catch(`
- a title does not start with `[happy]`, `[schema]`, `[invalid-input]` or `[auth]`
- a test lacks the `actual-status` annotation before its first assertion
- any assertion expects a status of 500 or higher
- it has fewer tests than plan cases, fewer tests of a type than the plan has cases of that type, or fails typecheck
- a status assertion does not match the test's type, or a required one is missing. The only allowed forms, per type: `[happy]` and `[schema]` exactly `expect(<status>).toBe(<probe status>)`; `[invalid-input]` `toBeGreaterThanOrEqual(400)` and `toBeLessThanOrEqual(499)`, both required; `[auth]` `expect([401, 403]).toContain(<status>)` (or `toBe(401)` / `toBe(403)`). `<status>` is `response.status()` or a variable assigned from it. `.not` on a status is never allowed
- an `[auth]` test mentions `ctx.api` (or destructures `api` from ctx), or does not use `ctx.noAuthApi`

## Eval harness

`local-api/bugs.json` is the catalog of planted bugs in the local shop API (id, description, endpointId, detectableBy). `local-api/server.mjs` reads its ids: `BUGS` unset turns on the catalog's `default` set (the two original demo bugs, so every existing verification step is unchanged), `FIXED=1` turns every bug off, `BUGS=id,id` turns on exactly those. Startup prints `bugs ON: <ids>` or `bugs OFF`. An unknown id exits 1.

`npm run eval` (`agent/eval/run.ts`) starts the local API itself on a free port for each bug set (default matrix: all bugs, no bugs, each detectable bug alone), runs the agent N times (default 3) on a copy of `input/local-shop.json` pointed at that port, and scores every run with `agent/eval/score.ts`:

- detected: a "suspected API finding" exists for the bug's endpoint with the bug's type (invalid-input bugs need an invalid-input finding, auth bugs an auth finding)
- false alarm: a suspected finding no active bug explains
- flaky: runs in the same bug set whose suspected finding sets differ
- not-yet: bugs with `detectableBy: "none-yet"` (needs a test type the agent does not have); reported, never counted against detection
- a run counts only when its status is `completed`; `no-tests`, `stopped-budget` or `refused` fails the eval (exit 1)

Output goes to `eval-results/<timestamp>/` (gitignored; not under `out/`, which the agent deletes every run): per set `input.json`, `run-N.log`, `run-N.summary.json`, plus `score.json`. Adding a planted bug: add it to `bugs.json`, implement it in `server.mjs` behind `bug("<id>")`, add its probe to `agent/eval/eval.test.ts` (the test fails until every catalog bug has one).

## Input files

`input/endpoints.json` and `input/demo-small.json` (Restful Booker), `input/local-shop.json` (local demo API). Shape: optional `name`, optional `framework` ("playwright" or "pactum", default playwright), `baseUrl`, `defaultHeaders`, optional `auth { header, valueEnv }`, optional `allowProduction` and `allowWrites` (booleans, false when missing, rule 11), `endpoints[] { id, method, path, requiresAuth, body?, setup? { endpointId, idField } }`. Do not overwrite the three kit files. The two Restful Booker files set `allowProduction` and `allowWrites` true: Restful Booker is a public sandbox meant for writes, but its host counts as production. `input/import-openapi-local-shop.json` and `input/import-postman-local-shop.json` are imported from the local shop fixtures (`auth.valueEnv` set to `LOCAL_API_AUTH_VALUE` so they run with `.env`) and must give the same results as `input/local-shop.json`.

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
- Body fields named like credentials (password, pass, pwd, secret, token, ...) are replaced with `<removed>`. The text importer makes at most 2 Claude calls, and never more than `MAX_CLAUDE_CALLS`.
- Tests: `npm run test:importers` (`agent/importers/importers.test.ts`, plain `node:assert` via tsx, no Playwright). Runs offline; the two tests that make live Claude calls run only with `RUN_LIVE_CLAUDE_TESTS=1` (`claude` must be logged in). Fixtures are in `test-fixtures/importers/` and use only the fake credential `importer-secret-test-value`.

## How to verify any change

1. `npm run typecheck`: no errors.
2. `npm run test:template`: 4 passed. `npm run api:local` then `npm run test:template:pactum`: 4 passing, `reports/pactum/status.json` has an `actualStatus` for every test, and `grep -r "hackathon-demo-token" reports/pactum/` finds nothing.
3. Tab 1 `npm run api:local`, then `npm run agent input/local-shop.json`: the line `safety: local host, full mode`, exactly 2 suspected API findings (create-product with a text price returns 500; delete-product without auth returns 204), every other test passes, and `npm run check:contract` is clean. Then the same on a copy of the input with `"framework": "pactum"`: the line `framework: pactum`, the same 2 findings, `check:contract` clean, and the exported `frameworks/<name>-pactum/` runs standalone (`npm install`, `.env`, `npm test`) with the same results.
4. `npm run api:local:fixed`, same run: 0 findings, 0 failures.
5. `grep -r "hackathon-demo-token\|YWRtaW46" out/ reports/ frameworks/ input/`: no matches.
6. `npm run test:importers` (offline), `npm run test:safety`, `npm run test:gate`, `npm run test:gate:pactum` and `npm run test:eval`: all passed, 0 failed.
7. Refused: `npm run agent` on a temp copy of `input/local-shop.json` with `baseUrl` `https://api.example.com`: `REFUSED: api.example.com looks like a production host. ...`, status "refused", `requestsSent` 0, exit 1.
8. Read-only: Tab 1 `LOG_REQUESTS=1 npm run api:local`, then `AGENT_FORCE_PRODUCTION=1 npm run agent` on a temp copy of `input/local-shop.json` with `"allowProduction": true`: only list-products runs, the other 4 print `SKIPPED read-only mode` and have `skippedReason`, the API log shows no POST, PUT, PATCH or DELETE, and `requestsSent` equals the number of requests in the log.
9. Paste raw command output in your reply, not a summary. Commit after each verified change on branch `main` (`git status` first, rule 10). Pushing to `origin main` is allowed. Never force push.

## Known environment notes

- macOS assumed: `npm run api:local:fixed` uses `FIXED=1 node ...` (on Windows use `BUGS=` through cross-env or set it in the shell) and Allure 3 uses macOS's `mdls`. On Windows, Allure may not generate (the run continues with `allureReport: null`).
- If port 3000 or 4000 is busy: `lsof -ti tcp:3000 -sTCP:LISTEN | xargs kill` (or `tcp:4000`). Without `-sTCP:LISTEN`, lsof also lists clients connected to the port, such as a browser, and kills them too.
- `AGENT_FORCE_PRODUCTION=1` (testing only) makes every host count as production in the agent, the ctx fixture, the exported framework and the UI server. It can only make the guard stricter.
- `LOG_REQUESTS=1 npm run api:local` prints `<METHOD> <path>` for every request the local API receives, to prove what the guard let through.
- If `tsx` fails with "The service was stopped", macOS killed a quarantined esbuild binary (folder copied from a zip or download). Fix: `npm ci`.
- Restful Booker is a shared public server that resets its data; a random 404 there is not a code bug.
