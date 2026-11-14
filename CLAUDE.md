# API Test Agent

An agent that takes a base URL and a list of API endpoints, probes the real API, uses Claude to plan and write API tests in Playwright or Pactum (Mocha), runs them, reports suspected API bugs, and exports a standalone test framework. Endpoints can also be imported from OpenAPI, Postman, cURL, HAR or ticket text. It is a product under active development. Repo: `sprintsynergyio/api-test-agent` (the local folder name may differ). History, status and setup are in `docs/HACKATHON-HANDOFF.md`.

## Commands

| Command | What it does |
|---|---|
| `npm run agent <input file>` | full pipeline (probe, plan, generate, run, export, summary) |
| `npm run api:local` / `npm run api:local:fixed` | local shop demo API on :4000, planted bugs on (the two default ones) / off. `BUGS=id,id npm run api:local` turns on exactly those bugs from `local-api/bugs.json` |
| `npm run ui` | demo UI on http://localhost:3000 (with `UI_USERS` set: login required; with `HOSTED=1`: hosted mode, see below) |
| `npm run ui:hash -- <password>` | prints a bcrypt hash for `UI_USERS` |
| `npm run probe <input file>` | probe only |
| `npm run agent -- <input file> --select env=staging,brand=alpha,region=eu` | run with a profile input: picks one value per dimension (or set `AGENT_SELECT`); works for `probe` too |
| `npm run test:config` | input model tests, offline: placeholders, setup steps, query, headers, profiles and selection (must stay all passed) |
| `npm run test:template` | hand-written Playwright template tests (must stay 4 passed) |
| `npm run test:template:pactum` | hand-written Pactum template tests against the local shop API (must stay 4 passing) |
| `npm run typecheck` | TypeScript check (must stay clean) |
| `npm run allure` | open the last Allure report |
| `npm run -s import <type> < file` | import endpoints from a source file (see Importers) |
| `npm run test:importers` | importer tests, offline (must stay all passed; `RUN_LIVE_CLAUDE_TESTS=1` adds the 2 live Claude tests) |
| `npm run test:safety` | safety guard tests: host rules, modes, HTTP layer (must stay all passed) |
| `npm run test:auth` | auth adapter tests, offline against an in-process API: header, query, cookie and login types, roles, token cache and refresh, the guard, redaction (must stay all passed) |
| `npm run test:redact` | redaction tests, offline: every built-in rule, field and strict rules, the probe, both prompts and the evidence attachments (must stay all passed) |
| `npm run test:cleanup` | test data cleanup against a real local API it starts itself: HTTP layer, nested resources, no DELETE endpoint, a failing DELETE, a Playwright run and a Mocha run (must stay all passed) |
| `npm run test:gate` | Playwright static gate tests: per-type status rules, noAuthApi rule, per-type plan coverage (must stay all passed) |
| `npm run test:gate:pactum` | Pactum static gate tests (must stay all passed) |
| `npm run eval -- [--runs N] [--bugs all\|none\|id,id] [--provider anthropic\|openai] [--dry-run]` | eval harness: runs the agent against every planted-bug set and prints detection, false alarm and flakiness rates (see Eval harness); `--provider` sets `LLM_PROVIDER` for the runs and is recorded in score.json |
| `npm run test:eval` | eval harness tests, offline: the scorer, and every planted bug against a real local API (must stay all passed) |
| `npm run test:claude-api` | Messages API and Chat Completions paths of `agent/claude.ts` with a fake fetch, plus `verifyProviderKey`: request shapes, error handling, keys never leak (must stay all passed) |
| `npm run test:settings` | the UI's model settings routes against a fake provider server: verify, save to `.env`, restart reads it, read-only with a login (must stay all passed) |
| `npm run test:ui` | the UI's input validation, run history and evidence routes, offline, plus the page ids they rely on: every auth type and a profile through `/api/validate-input`, field paths for a bad input, `/api/runs` shape, `/api/evidence` path safety and per-login isolation (must stay all passed) |
| `npm run check:contract` | checks `out/summary.json` against `ui/CONTRACT.md`, lists every problem, exit 1 on any |

## Model providers (`agent/claude.ts`)

The model is chosen once per process from the environment (`modelChoice()`), printed as `model: <provider> <model> (API key|Claude Code login)` after the framework line, and written to `summary.model { provider, model, via }`.

| `.env` | Path |
|---|---|
| `LLM_PROVIDER` unset or `anthropic`, no `ANTHROPIC_API_KEY` | the Claude Code CLI in headless mode (`claude -p`) with the machine's login (`via: "cli"`) |
| `anthropic` with `ANTHROPIC_API_KEY` | the Messages API over HTTPS, billed to the key; default model `claude-sonnet-5-5` |
| `LLM_PROVIDER=openai` with `OPENAI_API_KEY` | the Chat Completions API (`max_completion_tokens`, system plus user message); default model `gpt-6.1-sol` (OpenAI's balanced model as of Nov 2026). Without the key the run stops before probing with `LLM_PROVIDER=openai requires OPENAI_API_KEY` |

`LLM_MODEL` overrides the model for either provider; `CLAUDE_MODEL` still works as the old name for the Anthropic model. `ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL` redirect the calls (proxies, the settings test's fake server). `MAX_CLAUDE_CALLS` caps calls per run for every provider. Hosted mode requires the selected provider's key. Both keys are treated like auth values: scrubbed from logs, errors, summaries and exports, and removed from every child process (`claudeEnv`, `agent/frameworks/test-env.ts`). The per-call console line keeps the `[claude]` label for every provider (the UI reads it, `ui/CONTRACT.md`). The prompts were tuned against Claude; `npm run eval -- --provider openai` measures the other provider before anyone standardises on it.

`verifyProviderKey(provider, key, model?)` makes one 5-token request and returns `{ ok, provider, model, error }` with a plain sentence for 401, 402/403, 404, 429 and network failures, never the key. The UI's first-launch card uses it (section 10 of `ui/CONTRACT.md`): `GET /api/settings`, `POST /api/settings/verify`, `POST /api/settings` (verifies, then writes `LLM_PROVIDER`, `LLM_MODEL` and the key line into `.env`, mode 600, other lines kept). The POST routes are 403 whenever `HOSTED=1` or `UI_USERS` is set: a shared server never takes keys from the browser. `ENV_FILE` points the UI server at another `.env` (tests); `SKIP_CLI_DETECT=1` makes it ignore an installed `claude` CLI (tests).

## Frameworks

The output framework is an adapter in `agent/frameworks/` (`types.ts` is the interface, `playwright.ts` and `pactum.ts` the two adapters, `index.ts` picks one). The input file's optional `"framework": "playwright" | "pactum"` decides; missing means playwright. Shared and never framework-aware: importers, probe, plan, status rules, finding classification, summary, safety guard, auth handling. Per adapter: template, generator rules, static gate, runner and results parser, exporter. Every adapter returns normalized results (endpoint id, title, passed, actual status, error, requests sent); `cli.ts` only reads those.

Pactum: tests are Mocha `describe`/`it` files that import `{ ctx, expect, recordStatus }` from `tests-pactum/setup/ctx.ts` and nothing from `pactum`. `ctx.api` and `ctx.noAuthApi` return a response with `status()`, `ok()`, `headers()`, `text()` and `json()`; every request goes through one guarded `send()` that applies rule 11, counts requests and writes redacted evidence to `reports/pactum/evidence/`. `recordStatus(status)` is the Pactum equivalent of the `actual-status` annotation; a Mocha root hook writes it to `reports/pactum/status.json` and skips write endpoints in read-only mode. `expect` is a small matcher set in the setup file with the same names as Playwright's, so the per-type gate rules are shared. Runner: `mocha --config .mocharc.pactum.json` with the JSON reporter to `reports/pactum/results.json`. Export: `frameworks/<name>-pactum/` (no double suffix when the name already ends in `-pactum`). Allure is not wired for Pactum yet; `allureReport` is null on Pactum runs.

## Pipeline

0. `agent/safety.ts`: classifies the base URL's host and sets the safety mode (rule 11) before any request.
1. `agent/probe.ts`: one real call per endpoint. Non-2xx is retried once, then the endpoint is marked unusable and skipped.
2. `agent/plan.ts`: Claude returns JSON test cases, validated with zod and against the status rules below; one retry.
3. `agent/generate.ts`: Claude writes one spec per endpoint, copying the adapter's template (`tests/template/update-booking.spec.ts` or `tests-pactum/template/update-product.spec.ts`).
4. `agent/validate.ts`: static gate (`validateWithRules` shared, framework rules from the adapter). A candidate that fails it is retried once, then dropped. Nothing unsafe is ever written to `generated/`.
5. `agent/cli.ts`: runs plans and generations 3 at a time (phase by phase), runs the adapter's runner one test at a time, writes `out/summary.json` (with `testFramework`), and the Allure report for Playwright.
6. `agent/export.ts` (Playwright) or `agent/frameworks/pactum.ts` (Pactum): writes `frameworks/<name>/` (or `<name>-pactum/`) and `out/framework.zip`, then scans every file for the real auth value and fails loudly if found.

`generated/`, `out/` and `reports/` are deleted at the start of every run.

## Redaction (agent/redact.ts)

Client request and response data is redacted before it reaches Claude or the disk. The real bodies live only in memory for the test run's own assertions.

- Built-in rules, always on: email addresses, phone numbers (with a `+` prefix or separators; a bare run of digits is an id and stays), card numbers (13 to 19 digits that pass the Luhn check, so order numbers and epoch timestamps stay), IBANs, JWTs, `Bearer`/`Basic` values and prefixed API keys (`sk-...`, `ghp_...`), IPv4 and IPv6 addresses, any string in a field named like a credential (token, secret, key, password, authorization, session, cookie, ...), and the value of any header named like one. Keys, status codes, booleans, nulls, timestamps and array lengths are never changed.
- Per input file, optional: `"redaction": { "fields": ["customer.name", "address.*", "items.*.note"], "mode": "strict" }`. `fields` are dot paths (`*` matches one segment, array indexes included) whose values become `<redacted>` wherever they appear in a body. `strict` replaces every string in a response body with `<string:len>` and every number with `<number>` and keeps only the shape, for a client who allows the shape but not the data.
- Response values become tags (`<email>`, `<card>`, `<token>`, `<ip>`). Request sample bodies (from the input file; the generated tests copy them) get valid stand-ins instead (`redacted@example.com`, `+10000000000`, `4111111111111111`), so a test still sends a body the API accepts. Both are idempotent.
- Where it runs: `agent/probe.ts` redacts every probe result before it is written to `out/probes/` or returned (so the plan and generate prompts only ever see redacted probes); `plan.ts` and `generate.ts` show the endpoint config through `promptEndpoint`; `agent/claude.ts` runs the built-in rules once more over every prompt right before it leaves the process (importer text, error messages); `formatExchange` (Playwright attachments) and `writeEvidence` (Pactum evidence files) redact what they write. Counts go to `summary.redaction` and the console (`redaction: standard, N value(s) replaced` after the probe lines; `Redaction: ...` in the summary block). `agent/redact.ts` has no imports and is copied into both exports as `src/redact.ts`.
- Known false positives, accepted: a dotted version such as `1.2.3.4` reads as an IP; a Luhn-valid 13 to 19 digit id reads as a card.

## Test data cleanup

`createResource` (both frameworks) records every resource it makes `{ endpointId, id, params }`. At the end of each Playwright test (the ctx fixture, after `use`) and each Mocha test (the root `afterEach` hook), and after the probe, `cleanupResources` deletes them newest first (a review before its product) through the same guarded clients, so read-only mode and the production guard apply. The DELETE endpoint is the setup step's explicit `cleanup: { endpointId }` when given, else the DELETE whose path is the create endpoint's path plus one placeholder (`POST /products` pairs with `DELETE /products/{id}`; placeholder names may differ). A 2xx or a 404 counts as deleted; anything else is a failure with its reason. Totals go to `summary.cleanup` (`created = deleted + failed + skippedNoDeleteEndpoint`, `failures[]`) and the console; a failed cleanup never fails the run and is never hidden. Not tracked yet: records the generated test bodies create directly in a `[happy]` POST test (ROADMAP Phase 6). `FAIL_DELETE_IDS=5,6` on the local API (test hook, not a planted bug) makes DELETE answer 500 for those ids, for `npm run test:cleanup`.

## Rules that must never be broken

1. Never edit files in `generated/` by hand. Fix the instructions in `plan.ts` or `generate.ts` instead.
2. Never change an expected status to make a test pass. A failing test may be a real API bug.
3. Status rules: happy and schema expect the exact 2xx from the probe; invalid-input expects any 4xx; auth expects 401 or 403; authz (another role tries the request) expects 403 or 404; a test never expects a 5xx.
4. Finding classification: "suspected API finding" only when the actual status is 500 or higher, or an auth, authz or invalid-input test got a 2xx. Everything else is "needs review". No `actual-status` annotation means never an API finding.
5. A failure must never look like a pass: no empty catches, no default plans, zero specs means "NO TESTS GENERATED" and exit 1.
6. Auth values (header, query and cookie values, login credentials, issued tokens) come only from `.env` or the UI (env `CUSTOM_API_AUTH`, one run only). They must never appear in input files, summaries, reports, attachments, logs, the Claude prompts or the exported framework. The Claude CLI child process gets no env variable with AUTH in its name. Imported configs must never contain auth values (header values, cookies, tokens): importers drop them, keep only the credential's name and place (`auth.header` / `auth.param` / `auth.name` and `auth.valueEnv`), and warn naming what they dropped. See Auth below for how values are scrubbed.
7. `tests/fixtures/ctx.ts` (Playwright) and `tests-pactum/setup/ctx.ts` (Pactum) are the only test-side files that read `process.env` or the input file, and they read only the variables the auth section names (`pickAuthEnv`). Tests use `ctx.api`, `ctx.noAuthApi`, `ctx.as(role)`, `ctx.createResource(endpointId)`, `ctx.setup()`. Pactum tests never import `pactum`, so the guard in `send()` covers every request.
8. The UI reads agent output exactly as described in `ui/CONTRACT.md` (console phase headers, per-endpoint OK/FAILED lines, `out/summary.json` shape, the report and evidence files). Any change to agent output must keep that contract, and any change to `ui/` must keep reading the agent through it: the UI validates inputs with the agent's own schema (`agent/config.ts` via tsx) and never changes the agent for its own needs. `ui/index.html` stays one self-contained file: no build step, no framework, no external fonts or scripts.
9. The exported framework must stay standalone: no imports from `agent/` or outside its own folder.
10. Never commit `node_modules/`, `out/`, `reports/`, `generated/`, `test-results/`, `frameworks/*` (except `frameworks/.gitkeep`), `.env` or `.DS_Store`. `.gitignore` covers them. Run `git status` before every commit and confirm none of them are listed.
11. Production safety guard (`agent/safety.ts`). A login request (auth type `login`) is not a data write: it is sent in read-only mode too, through the same guarded path (counted, recorded with credentials and token redacted); in refused mode nothing is sent, the login included. The host is local (localhost, 127.0.0.1, ::1, `.local`, host.docker.internal, 10.x, 172.16 to 172.31.x, 192.168.x), non-production (a whole part, split on "." and "-", is dev, test, qa, staging, stage, sandbox, uat or preprod) or production (everything else). Local and non-production: mode "full". Production without `allowProduction`: "refused", no request is sent, status "refused", exit 1. Production with `allowProduction`: "read-only", only GET, HEAD and OPTIONS endpoints without setup run, the rest are "skipped: read-only mode" and never counted as passed. With `allowWrites` as well: "full" plus the WARNING line. The guard lives in the shared HTTP layer (`agent/http.ts` `createClients`), so it covers probe, `createResource`, the ctx fixture and the exported framework; never bypass it with a client made elsewhere. Nothing may make a production host count as local or non-production. `ui/host-class.mjs` must keep the same rules (checked by `npm run test:safety`).

## Auth (`agent/auth.ts`)

One module with no imports, copied into both exports as `src/auth.ts`, so the agent, both ctx files and both exported frameworks apply auth the same way. The input's `auth` section has a `type`; without one it is the original `{ header, valueEnv }` form.

| Type | Shape | What is sent |
|---|---|---|
| `header` (default) | `{ "header": "Authorization", "valueEnv": "API_AUTH_VALUE" }` | the header with the whole value from env (prefix included, for example `Bearer x`) |
| `query` | `{ "type": "query", "param": "api_key", "valueEnv": "API_KEY" }` | `?api_key=<value>` on every request |
| `cookie` | `{ "type": "cookie", "name": "session", "valueEnv": "SESSION_COOKIE" }` | `Cookie: session=<value>` |
| `login` | `{ "type": "login", "request": { "method": "POST", "path": "/auth/login", "body": { "remember": true }, "headers": {} }, "credentialsEnv": { "username": "ADMIN_USER", "password": "ADMIN_PASSWORD" }, "tokenPath": "data.token", "apply": { "type": "header", "header": "Authorization", "prefix": "Bearer " }, "refresh": { "statuses": [401], "once": true } }` | the login request once per client (credentials from env merged into the body), the token read at `tokenPath` (a dot path) and applied as a header, cookie (`apply.type: "cookie", name`) or query parameter (`apply.type: "query", param`); on a `refresh.statuses` response the login is repeated and the request sent once more |

- Roles: `"roles": { "viewer": { "valueEnv": "VIEWER_KEY" } }` for header, query and cookie; `"roles": { "viewer": { "credentialsEnv": { "username": "VIEWER_USER", "password": "VIEWER_PASSWORD" } } }` for login (same fields as the main `credentialsEnv`). The main section is the role `default`; `default` cannot be a role name. Tests call `ctx.as('viewer')` (an `APIRequestContext` in Playwright, a `Client` in Pactum); the probe and `createResource` use the default role.
- `[authz]`: allowed only for endpoints with `requiresAuth` when the input has at least one extra role. The plan expects `"403|404"`; the gate requires `ctx.as('<role>')` and `expect([403, 404]).toContain(status)` and rejects `ctx.api`, `ctx.noAuthApi` or a 2xx expectation; a 2xx actual status is a suspected API finding (rule 4). Eval bugs can be `detectableBy: "authz"`.
- Secrets: `secretValues` (header, query and cookie values, and login fields whose name looks secret: password, pass, pwd, secret, token, key, ...) plus every issued token are scrubbed from evidence, error text, summaries and exports. A plain username such as `admin` is not scrubbed from every text (it would also hit role names); the login request evidence redacts every credential field instead, and the login response evidence redacts the token at `tokenPath`. Sensitive header names (the auth header, Authorization, Cookie) and the auth query parameter are shown as `<redacted>`.
- Login failures (non-2xx, no JSON, nothing at `tokenPath`, a missing env variable) throw with the reason and role before any test request; nothing falls back to an empty value.
- Playwright creates one set of clients per test, so the login runs once per test (tests stay independent); Pactum's setup file logs in once per Mocha process. The exported frameworks behave the same.
- Importers map OpenAPI `securitySchemes` and Postman auth blocks: apiKey in header, query or cookie to the matching type; http bearer to a header with a warning about the `Bearer ` prefix; oauth2 and openIdConnect to a header with a warning to configure the login type by hand. Values are never imported.
- Not covered yet: OAuth2 client credentials (a form-encoded login body). The UI accepts every type and roles (Build tab, or a saved input) and validates them with the agent's schema; values other than the one-run header, query or cookie value come from `.env`, and the page lists the variable names it will read.
- `input/local-shop-login.json` is the proof input: `POST /auth/login` on the local shop API with users `admin` (writes) and `viewer` (reads only), planted bug `viewer-can-delete`. The demo credentials are in `.env.example` (`LOCAL_API_ADMIN_USER`, `LOCAL_API_ADMIN_PASSWORD`, `LOCAL_API_VIEWER_USER`, `LOCAL_API_VIEWER_PASSWORD`).

## Hosted mode (`HOSTED=1`)

For the UI running on a shared server (the SprintSynergy VPS, `docs/HOSTING.md`). Every rule below can only make the agent stricter; without `HOSTED` and without `UI_USERS` nothing changes for the local demo.

| Variable | Meaning |
|---|---|
| `HOSTED=1` | hosted mode on, for the UI server and the agent it spawns (the agent reads it too: `agent/safety.ts` `isHosted()`) |
| `HOST` | bind address; anything but `127.0.0.1` or `localhost` needs `HOSTED=1`, otherwise the server exits 1. Behind Nginx keep the default |
| `UI_PORT` | UI port (default 3000) |
| `UI_USERS` | `name:bcryptHash,name2:bcryptHash` from `npm run ui:hash -- <password>`. Sets login on, hosted or not. Required with `HOSTED=1` |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | the selected provider's key is required with `HOSTED=1`: the shared server never uses a personal Claude login |
| `HOSTED_RUNS_PER_HOUR` | runs per login per hour (default 5); over it `POST /api/run` is 429 |
| `HOSTED_QUEUE` | runs waiting behind the one in progress (default 5); over it 429 |
| `HOSTED_RUN_TTL_HOURS` | run folders older than this are deleted hourly (default 24) |

Rules in hosted mode (`agent/safety.ts`, mirrored in `ui/host-class.mjs` `safetyMode`, tested by `npm run test:safety`):
- a local or private host (rule 11's "local" class) is refused with `REFUSED: <host> is a local or private address; the hosted agent only tests public non-production hosts.` It would be the server's own network
- a production host never gets full mode: `allowWrites` is ignored, `allowProduction` gives read-only as before
- non-production hosts run in full mode as before
- `HOSTED=1` in the environment applies everywhere (probe, ctx fixture, export, UI); `hosted: false` as an option cannot switch it off

Login and isolation (`ui/server.mjs`), on whenever `UI_USERS` is set:
- `POST /api/login` sets an HttpOnly, SameSite=Strict session cookie (Secure when Nginx sends `X-Forwarded-Proto: https`); sessions live in memory for 12 hours. Every `/api/*` route except session, login and logout, plus `/report` and `/allure`, is 401 without it. Static files stay public
- each run gets `runs/<runId>/` (gitignored): its `input.json`, then a snapshot of `summary.json`, `framework.zip`, `html/`, `allure-report/`, `generated/`, `results.json` and `pactum/` when it ends. `/api/summary`, `/api/spec`, `/api/framework/download`, `/api/evidence`, `/report` and `/allure` serve the caller's latest run (or `?run=<id>` when it is theirs); `/api/runs` lists only the caller's runs. The live stream and stop only reach the run's owner. Local mode (no login) writes the same snapshots for the run history and keeps the newest 20
- runs still execute one at a time (the agent writes fixed paths); a second login's run is queued and starts automatically. One run in progress or queued per login
- `POST /api/inputs/save` is 403 in hosted mode: saved APIs are shared by every login

## Static gate (agent/validate.ts) rejects a spec when

Shared rules (both frameworks) plus the framework rules in each adapter. Pactum adds: must import `ctx`, `expect` and `recordStatus` from the setup file; no `pactum`, `node:assert` or `chai` import; no `.only`, `.skip`, `xit`, `xdescribe` or `this.skip()`.

- it does not import `test` and `expect` from the ctx fixture, or imports from `@playwright/test` directly
- it contains `process.env`, `http://` or `https://`
- it contains `test.only`, `test.skip`, an empty catch, a catch that does not rethrow, or `.catch(`
- a title does not start with `[happy]`, `[schema]`, `[invalid-input]`, `[auth]` or `[authz]`
- a test lacks the `actual-status` annotation before its first assertion
- any assertion expects a status of 500 or higher
- it has fewer tests than plan cases, fewer tests of a type than the plan has cases of that type, or fails typecheck
- a status assertion does not match the test's type, or a required one is missing. The only allowed forms, per type: `[happy]` and `[schema]` exactly `expect(<status>).toBe(<probe status>)`; `[invalid-input]` `toBeGreaterThanOrEqual(400)` and `toBeLessThanOrEqual(499)`, both required; `[auth]` `expect([401, 403]).toContain(<status>)` (or `toBe(401)` / `toBe(403)`). `<status>` is `response.status()` or a variable assigned from it. `.not` on a status is never allowed
- an `[auth]` test mentions `ctx.api` (or destructures `api` from ctx), or does not use `ctx.noAuthApi`
- an `[authz]` test does not use `ctx.as('<role>')`, mentions `ctx.api` or `ctx.noAuthApi`, or asserts anything but `expect([403, 404]).toContain(<status>)` (or `toBe(403)` / `toBe(404)`)

## Eval harness

`local-api/bugs.json` is the catalog of planted bugs in the local shop API (id, description, endpointId, detectableBy). `local-api/server.mjs` reads its ids: `BUGS` unset turns on the catalog's `default` set (the two original demo bugs, so every existing verification step is unchanged), `FIXED=1` turns every bug off, `BUGS=id,id` turns on exactly those. Startup prints `bugs ON: <ids>` or `bugs OFF`. An unknown id exits 1.

The local API also has `POST /auth/login` (users admin and viewer, see Auth) and the planted bug `viewer-can-delete` (`detectableBy: "authz"`).

`npm run eval` (`agent/eval/run.ts`) starts the local API itself on a free port for each bug set (default matrix: all bugs, no bugs, each detectable bug alone), runs the agent N times (default 3) on a copy of `input/local-shop.json` pointed at that port, and scores every run with `agent/eval/score.ts`:

- detected: a "suspected API finding" exists for the bug's endpoint with the bug's type (invalid-input bugs need an invalid-input finding, auth bugs an auth finding, authz bugs an authz finding)
- false alarm: a suspected finding no active bug explains
- flaky: runs in the same bug set whose suspected finding sets differ
- not-yet: bugs with `detectableBy: "none-yet"` (needs a test type the agent does not have); reported, never counted against detection
- a run counts only when its status is `completed`; `no-tests`, `stopped-budget` or `refused` fails the eval (exit 1)

Output goes to `eval-results/<timestamp>/` (gitignored; not under `out/`, which the agent deletes every run): per set `input.json`, `run-N.log`, `run-N.summary.json`, plus `score.json`. Adding a planted bug: add it to `bugs.json`, implement it in `server.mjs` behind `bug("<id>")`, add its probe to `agent/eval/eval.test.ts` (the test fails until every catalog bug has one).

## Input files

`input/endpoints.json` and `input/demo-small.json` (Restful Booker), `input/local-shop.json` (local demo API), `input/local-shop-pactum.json` (the same with `"framework": "pactum"`), `input/local-shop-nested.json` (local demo API with the nested reviews resource, query and headers), `input/local-shop-login.json` (local demo API with the login auth type and a viewer role), `input/example-profile.json` (a profile with placeholder hosts). Shape: optional `name`, optional `framework` ("playwright" or "pactum", default playwright), `baseUrl` or `profile` (below), `defaultHeaders`, optional `auth` (`{ header, valueEnv }` or one of the types in Auth above, with optional `roles`), optional `allowProduction` and `allowWrites` (booleans, false when missing, rule 11), optional `redaction { fields?, mode? }` (see Redaction), `endpoints[] { id, method, path, requiresAuth, body?, query?, headers?, setup? }`. A setup step may carry `cleanup: { endpointId }` naming the DELETE endpoint for what it creates (see Test data cleanup). Do not overwrite the kit files.

- `path` holds `{placeholders}` only, never a query string. `query` is an object of string, number or boolean values (arrays and objects are refused); `headers` are extra headers for this endpoint. The probe, `createResource` and the generated tests send both (`params` and `headers` request options on `ctx.api` in both frameworks). The auth header is added last and never comes from these fields (rule 6).
- `setup` is one `{ endpointId, idField }` (fills the first placeholder, the original shape) or an array of `{ endpointId, idField, param }`, one step per placeholder in order. Steps run in order and each step sees the ids collected so far, so `POST /products/{id}/reviews` creates its review under the product made one step earlier. Tests for a path with more than one placeholder call `ctx.setup()` and get `{ id, reviewId }`; single-placeholder tests keep `ctx.createResource(endpointId)`.
- `profile` describes one API across environments, brands and regions: `{ dimensions: { env: [...], brand: [...], region: [...] }, baseUrl: "https://{brand}-{region}.{env}.example.com", headers: { "X-Brand": "{brand}" }, overrides: [{ when: { region: "eu" }, headers: {...}, baseUrl?: "..." }] }`. `--select env=staging,brand=alpha,region=eu` (or `AGENT_SELECT`) picks exactly one value per dimension; a dimension with a single value is picked on its own; anything else exits 1 listing the dimensions and values. `agent/model.ts` resolves it once in `loadConfig`, so everything downstream (the safety guard included) sees a plain `baseUrl` and `defaultHeaders` (order, later wins: defaultHeaders, profile headers, matching overrides in order). The summary gets `selection` (`ui/CONTRACT.md`), the console prints `selection: env=staging, ... -> https://...`. Exported frameworks keep the profile block in `config/api.json` and read `AGENT_SELECT` at run time, so one export serves every brand and region.
- Real client profiles live only in `profiles/local/` (gitignored, see `profiles/README.md`); `input/example-profile.json` uses placeholder hosts only. Never commit a client host or header value.
- `agent/model.ts` holds the pure helpers (`resolvePath`, `setupSteps`, `queryString`, `resolveProfile`) and has no imports: both exporters copy it as `src/model.ts`. The two Restful Booker files set `allowProduction` and `allowWrites` true: Restful Booker is a public sandbox meant for writes, but its host counts as production. `input/import-openapi-local-shop.json` and `input/import-postman-local-shop.json` are imported from the local shop fixtures (`auth.valueEnv` set to `LOCAL_API_AUTH_VALUE` so they run with `.env`) and must give the same results as `input/local-shop.json`.

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
- The UI uses the same CLI through `POST /api/import` (Import tab, Source). See `ui/CONTRACT.md` section 6. The page's other routes for inputs, run history and evidence are section 11.
- Base URL: the most common origin; requests to other origins are skipped. Empty when the source has none, with a warning.
- Path parameters: `{id}`, `:id` and `{{id}}` become `{id}`; in HAR, numeric and UUID segments become `{id}`.
- Query parameters become the endpoint's `query` object (OpenAPI: required ones always, optional ones only with an example or default; Postman, cURL and HAR: the URL's query, HAR keeps the query of one request per grouped endpoint). Non-credential, non-transport headers become the endpoint's `headers`, with a warning to check the values.
- Bodies: JSON objects only. Form, XML and other bodies are skipped with the reason. OpenAPI uses the example, else builds one from the schema's required fields.
- Setup: each placeholder gets a step from the POST on its parent path (`POST /products` for `{id}`, `POST /products/{id}/reviews` for `{reviewId}`); one placeholder keeps the single-object shape, more give an array with `param`. A warning asks to check `idField`.
- Auth: credentials are dropped (Authorization, Cookie, any header with auth/token/key/secret/session in its name, Postman auth blocks, curl `-u`/`-b`, credential query params, URL userinfo). Those endpoints get `requiresAuth: true` and the input gets an auth section with `valueEnv: "CUSTOM_API_AUTH"`: `{ header, valueEnv }` for a header credential (the most common one wins), `{ type: "query", param, valueEnv }` for a query credential, `{ type: "cookie", name, valueEnv }` for an OpenAPI apiKey cookie. Nothing is dropped silently: every skipped item has a reason.
- Body fields named like credentials (password, pass, pwd, secret, token, ...) are replaced with `<removed>`. The text importer makes at most 2 Claude calls, and never more than `MAX_CLAUDE_CALLS`.
- Tests: `npm run test:importers` (`agent/importers/importers.test.ts`, plain `node:assert` via tsx, no Playwright). Runs offline; the two tests that make live Claude calls run only with `RUN_LIVE_CLAUDE_TESTS=1` (`claude` must be logged in). Fixtures are in `test-fixtures/importers/` and use only the fake credential `importer-secret-test-value`.

## How to verify any change

1. `npm run typecheck`: no errors.
2. `npm run test:template`: 4 passed. `npm run api:local` then `npm run test:template:pactum`: 4 passing, `reports/pactum/status.json` has an `actualStatus` for every test, and `grep -r "hackathon-demo-token" reports/pactum/` finds nothing.
3. Tab 1 `npm run api:local`, then `npm run agent input/local-shop.json`: the line `safety: local host, full mode`, exactly 2 suspected API findings (create-product with a text price returns 500; delete-product without auth returns 204), every other test passes, and `npm run check:contract` is clean. Then the same on a copy of the input with `"framework": "pactum"`: the line `framework: pactum`, the same 2 findings, `check:contract` clean, and the exported `frameworks/<name>-pactum/` (no double suffix when the name already ends in `-pactum`) runs standalone (`npm install`, `.env`, `npm test`) with the same results.
4. `npm run api:local:fixed`, same run: 0 findings, 0 failures.
5. `grep -r "hackathon-demo-token\|YWRtaW46" out/ reports/ frameworks/ input/`: no matches.
6. `npm run test:importers` (offline), `npm run test:safety`, `npm run test:auth`, `npm run test:gate`, `npm run test:gate:pactum`, `npm run test:config`, `npm run test:eval`, `npm run test:claude-api`, `npm run test:settings`, `npm run test:redact` and `npm run test:cleanup`: all passed, 0 failed.
6d. Model setup: with no key in `.env` and `SKIP_CLI_DETECT=1 npm run ui`, the startup line ends with `model: not set up yet (the page will ask for a key)` and the page opens on the "Set up your model" card; Verify with a wrong key shows the 401 sentence, with a real key `Key works`, Save writes the three lines to `.env` (file mode 600) and the header shows `Claude ... via API key`; `npm run agent input/local-shop.json` then prints `model: anthropic claude-sonnet-5-5 (API key)` and the summary has `model`. With `UI_USERS` set the card never shows and the POST routes are 403.
6a. Login auth: `.env` has the four `LOCAL_API_*_USER` / `_PASSWORD` values from `.env.example`. Tab 1 `LOG_REQUESTS=1 npm run api:local`, then `npm run probe input/local-shop-login.json`: all 5 `OK`, and the API log shows exactly one `POST /auth/login` before the probes. `npm run agent input/local-shop-login.json`: every endpoint `OK written`, the 2 default findings plus `[authz] delete-product ...: expected 403|404, got 204` (planted bug `viewer-can-delete` is not in the default set, so run Tab 1 as `BUGS=price-text-500,delete-no-auth,viewer-can-delete npm run api:local` for three findings), `check:contract` clean, and `grep -rE "admin-pass|viewer-pass|Bearer [a-z0-9]{24}" out/ reports/ frameworks/` finds nothing. The same with `"framework": "pactum"` in a copy of the input.
6b. Nested paths: Tab 1 `npm run api:local`, then `npm run probe input/local-shop-nested.json`: all 6 endpoints `OK` (get-review and delete-review go through two setup steps). `npm run agent input/local-shop-nested.json`: every endpoint `OK written`, the same 2 kinds of finding are not expected here (the reviews resource has no planted bug), `check:contract` clean. Profiles: `npm run agent input/example-profile.json` exits 1 asking for `--select`; with `-- --select env=staging,brand=alpha,region=eu` it resolves `https://alpha-eu.staging.example-shop.test` (a non-production host that does not exist, so the probe fails cleanly).
6c. Cleanup and redaction live: Tab 1 `LOG_REQUESTS=1 npm run api:local`, then `npm run agent input/local-shop.json`: the probe phase ends with `redaction: standard, 0 value(s) replaced` and `cleanup: created N, deleted N, failed 0, no delete endpoint 0`; the summary block has `Redaction:` and `Cleanup:` lines with `failed 0`; the API log shows a `DELETE /products/<id>` for every `POST /products` that setup made (the probe's own `POST /products` request and the `[happy]` create test's own record are the known exceptions: they are not made through createResource); `check:contract` clean.
7. Refused: `npm run agent` on a temp copy of `input/local-shop.json` with `baseUrl` `https://api.example.com`: `REFUSED: api.example.com looks like a production host. ...`, status "refused", `requestsSent` 0, exit 1.
8. Read-only: Tab 1 `LOG_REQUESTS=1 npm run api:local`, then `AGENT_FORCE_PRODUCTION=1 npm run agent` on a temp copy of `input/local-shop.json` with `"allowProduction": true`: only list-products runs, the other 4 print `SKIPPED read-only mode` and have `skippedReason`, the API log shows no POST, PUT, PATCH or DELETE, and `requestsSent` equals the number of requests in the log.
9. Hosted: `HOSTED=1 UI_USERS=demo:<hash> ANTHROPIC_API_KEY=<key> npm run ui`, sign in, run `input/local-shop.json`: `REFUSED: localhost is a local or private address ...`, and `LOG_REQUESTS=1 npm run api:local` shows no request. Then a public non-production host runs; `HOST=0.0.0.0 npm run ui` without `HOSTED` exits 1.
10. Paste raw command output in your reply, not a summary. Commit after each verified change on branch `main` (`git status` first, rule 10). Pushing to `origin main` is allowed. Never force push.

## Known environment notes

- macOS assumed: `npm run api:local:fixed` uses `FIXED=1 node ...` (on Windows use `BUGS=` through cross-env or set it in the shell) and Allure 3 uses macOS's `mdls`. On Windows, Allure may not generate (the run continues with `allureReport: null`).
- If port 3000 or 4000 is busy: `lsof -ti tcp:3000 -sTCP:LISTEN | xargs kill` (or `tcp:4000`). Without `-sTCP:LISTEN`, lsof also lists clients connected to the port, such as a browser, and kills them too.
- `AGENT_FORCE_PRODUCTION=1` (testing only) makes every host count as production in the agent, the ctx fixture, the exported framework and the UI server. It can only make the guard stricter.
- The UI server reads `.env` too (dotenv), so `HOSTED`, `UI_USERS` and the provider keys can live there or in the systemd unit. The setup card writes to the same file.
- `LOG_REQUESTS=1 npm run api:local` prints `<METHOD> <path><?query>` for every request the local API receives, to prove what the guard let through and which query parameters were sent.
- If `tsx` fails with "The service was stopped", macOS killed a quarantined esbuild binary (folder copied from a zip or download). Fix: `npm ci`.
- Restful Booker is a shared public server that resets its data; a random 404 there is not a code bug.
