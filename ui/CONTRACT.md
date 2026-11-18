# UI contract with the agent

The UI (ui/server.mjs + ui/index.html) runs `node_modules/.bin/tsx agent/cli.ts input/ui-run.json`
and expects exactly this from agent/cli.ts.

## 1. Console output

Phase header lines, exactly:

    === PROBING ===
    === PLANNING ===
    === GENERATING ===
    === RUNNING TESTS ===
    === SUMMARY ===

Inside PROBING, PLANNING and GENERATING, one line per endpoint that starts with the endpoint id,
then OK or FAILED, then detail:

    create-product OK 201
    create-product OK 5 cases
    create-product OK written generated/create-product.spec.ts
    update-product FAILED static gate: contains process.env

In read-only mode (section 7) an endpoint that is not run prints, in each of the three phases:

    create-product SKIPPED read-only mode

Right after "=== PROBING ===" the agent prints the safety line, and for a production host with
writes allowed a warning line:

    safety: local host, full mode
    WARNING: write requests enabled against a production host

At the end of the probe phase, after the per-endpoint lines, two more lines report what the redaction
layer replaced and what the probe's own setup data cleanup did (section 9). The UI ignores both:

    redaction: standard, 3 value(s) replaced
    cleanup: created 3, deleted 3, failed 0, no delete endpoint 0

A refused run prints one line, no phase headers, and exits 1:

    REFUSED: api.example.com looks like a production host. Set allowProduction to run read-only tests.

Exit code 0 when the pipeline completed (even with failing tests), non-zero otherwise.

## 2. out/summary.json

    {
      "status": "completed" | "stopped-budget" | "no-tests" | "refused",
      "inputFile": "input/local-shop.json",
      "baseUrl": "http://localhost:4000",
      "safety": { "hostClass": "local", "mode": "full", "allowProduction": false, "allowWrites": false },
      "requestsSent": 61,
      "startedAt": "2026-10-17T10:00:00.000Z",
      "durationSec": 74,
      "claudeCalls": { "used": 10, "budget": 30 },
      "totals": { "endpoints": 5, "testsGenerated": 23, "passed": 21, "failed": 2 },
      "endpoints": [
        {
          "id": "create-product", "method": "POST", "path": "/products", "requiresAuth": true,
          "probeStatus": 201, "casesPlanned": 5, "specWritten": true,
          "specFile": "create-product.spec.ts", "passed": 4, "failed": 1, "failureReason": null,
          "skippedReason": null
        }
      ],
      "findings": [
        {
          "endpointId": "create-product",
          "testTitle": "[invalid-input] create-product rejects price sent as text",
          "type": "invalid-input", "expectedStatus": "4xx", "actualStatus": 500,
          "classification": "suspected API finding",
          "error": "first 300 characters of the Playwright error"
        }
      ]
    }

Since Phase 2 the summary also has a top-level "testFramework": "playwright" | "pactum", the adapter that
generated and ran the tests (the input file's optional "framework" field, default playwright). On a
pactum run there is no reports/html folder (htmlReport is null) and allureReport is "reports/allure-report"
when the Allure report was built from the Mocha results and the status file (null with the reason in the
console otherwise); the console says "framework: pactum" right after the safety line. Everything else in the summary has the same shape for both frameworks.

Since Phase 4 the summary also has a top-level "selection": null | { "<dimension>": "<value>", ... }. It is
null for an input file with a plain baseUrl (every UI run). For an input file with a profile block
(environments, brands, regions) it is the selection the run used, and baseUrl is the resolved base URL
for that selection; the console then prints "selection: env=staging, brand=alpha -> https://..." right
after the framework line. The UI does not read it.

Since Phase 5 a finding's "type" can also be "authz" (a request by another auth role that should have
been rejected). Rule 4 for it is the same as for auth and invalid-input: a 2xx actual status is a
"suspected API finding", a 403 or 404 is a pass, anything else "needs review". The expectedStatus string
for it is "403|404". Inputs with auth types other than the fixed header (query, cookie, login) and with
auth.roles are CLI only for now: the UI's input check still accepts only auth { header, valueEnv }.

Since Phase 8 the summary also has a top-level "model": { "provider": "anthropic" | "openai", "model": "<id>",
"via": "api" | "cli" }: which model provider wrote the plans and specs and whether it was reached through an
API key or the Claude Code login. The console prints "model: <provider> <model> (API key|Claude Code login)"
right after the framework line. The "[claude]" per-call lines keep their label for every provider.
The UI shows the current choice from GET /api/settings (section 10); it does not read this field.

probeStatus is null when the probe failed. specFile is null when no spec was written.
classification is "suspected API finding" or "needs review".
skippedReason is null, or "skipped: read-only mode" for an endpoint the safety guard did not run (section 7).
safety and requestsSent are described in section 7.

## 3. Files the UI reads

- generated/<endpointId>.spec.ts (code viewer)
- reports/html/ (Playwright HTML report, served at /report/)

## 4. Additions for the framework export and custom APIs

Input file changes:
- optional top-level "name" (lowercase letters, numbers, dashes). Used as the framework folder name.
- "auth" is optional. Without it, ctx.api and ctx.noAuthApi behave the same, and no endpoint may have requiresAuth true.
- When auth.valueEnv is "CUSTOM_API_AUTH", the UI passes the value to the agent process in the
  CUSTOM_API_AUTH environment variable for that run only. It is never written to disk. This is the
  only auth value the page ever takes; every other auth type and every role reads `.env` (section 11).

out/summary.json gets one more top-level field:

    "framework": {
      "name": "local-shop",
      "dir": "frameworks/local-shop",
      "zip": "out/framework.zip",
      "files": ["package.json", "playwright.config.ts", "tests/fixtures/ctx.ts", "tests/create-product.spec.ts", "..."],
      "specCount": 5
    }

framework is null when no spec was written. files are paths relative to dir.

New UI routes:
- POST /api/run body may include "authValue" (string)
- POST /api/inputs/save { name, json } writes input/<name>.json (kit files protected, auth values refused)
- GET /api/framework/download streams out/framework.zip

## 5. Allure report

out/summary.json gets "allureReport": "reports/allure-report" when the Allure HTML report was generated
for this run, or null when it was not. The UI shows an "Open Allure report" button only when it is set,
and serves the folder at /allure/. Both frameworks produce it: Playwright through allure-playwright,
Pactum from the Mocha JSON results and reports/pactum/status.json (one Allure result per test, the
redacted evidence files attached).

## 6. Importers

New UI route:

    POST /api/import  { "type": "postman" | "openapi" | "curl" | "har" | "text", "content": "<source text>" }

The server runs `node_modules/.bin/tsx agent/import.ts <type>` with `content` on stdin (no environment
variable with AUTH in its name). It writes nothing to disk and never logs the content; it logs only
the type, the counts, and the `[claude]` call lines of a text import.

Responses:

- 200: exactly the JSON that agent/import.ts prints:

      {
        "input": { "name": "...", "baseUrl": "http://localhost:4000", "defaultHeaders": { ... },
                   "auth": { "header": "Authorization", "valueEnv": "CUSTOM_API_AUTH" },
                   "endpoints": [ { "id": "get-products-id", "method": "GET", "path": "/products/{id}",
                                    "requiresAuth": false, "setup": { "endpointId": "post-products", "idField": "id" } } ] },
        "skipped": [ { "item": "Track event (POST https://analytics.example.com/track)", "reason": "origin ... differs from the base URL ..." } ],
        "warnings": [ "Auth value removed. Enter it in the auth field before running." ]
      }

  `input` has the input file shape (section 4), except that `baseUrl` may be "" when the source has
  none; the user must fill it in before running. `name` and `auth` are optional. `auth.valueEnv` is
  always "CUSTOM_API_AUTH". No credential value ever appears in the response.
- 400 `{ "error" }`: unknown type, or content missing or not a string
- 413 `{ "error" }`: content over 5 MB
- 422 `{ "error" }`: the importer failed (nothing importable, not valid JSON or YAML, Claude call
  failed); `error` is the importer's message
- 504 `{ "error" }`: the import timed out (7 minutes)

The Custom API tab shows the result as a preview; "Use these endpoints" puts the checked endpoints
into the Saved API JSON editor, and the run goes through POST /api/run as before (section 4).

## 7. Production safety guard

Input files may set two optional booleans, both false when missing: "allowProduction" and "allowWrites".
The base URL's host is classified by agent/safety.ts (ui/host-class.mjs has the same rules for the UI):

- "local": localhost, 127.0.0.1, ::1, hosts ending in .local, host.docker.internal, 10.x, 172.16 to 172.31.x, 192.168.x
- "non-production": the host split on "." and "-" has a part equal to dev, test, qa, staging, stage, sandbox, uat or preprod
- "production": everything else (whole parts only, so latest.example.com and contest.io are production)

| Host | allowProduction | allowWrites | safety.mode | What runs |
|---|---|---|---|---|
| local or non-production | any | any | "full" | everything |
| production | false | any | "refused" | nothing; status "refused", requestsSent 0, exit 1 |
| production | true | false | "read-only" | GET, HEAD and OPTIONS endpoints without setup; the rest are skipped |
| production | true | true | "full" | everything, with the WARNING line |

summary.json:

- "safety": { "hostClass", "mode", "allowProduction", "allowWrites" }, on every run.
- "requestsSent": the number of requests the shared HTTP layer sent during the run (probe, setup and tests).
- "status" may be "refused". Then every endpoint has failureReason set to the refusal message,
  totals are 0, framework and allureReport are null.
- A skipped endpoint has skippedReason "skipped: read-only mode", probeStatus null, casesPlanned 0,
  specWritten false, passed 0 and failed 0. It is never counted as passed.

The guard is enforced in agent/http.ts, so it also covers createResource and the ctx fixture: in
read-only mode a POST, PUT, PATCH or DELETE throws ReadOnlyBlocked before it is sent, and a refused
config cannot create clients at all. AGENT_FORCE_PRODUCTION=1 (testing only) treats every host as
production; nothing makes a production host count as local or non-production.

UI server:

- POST /api/run answers 400 { "error": "<refusal message>" } for a production host without
  allowProduction true, before the agent is started.
- POST /api/inputs/save removes allowProduction and allowWrites before writing: production consent is
  given per run in the UI, never stored by the UI.
- GET /host-class.mjs serves ui/host-class.mjs to the page.

`npm run check:contract` checks out/summary.json against sections 2, 4, 5, 7 and 9, including testFramework, selection and model.

## 8. Login and hosted mode (additive)

Nothing in sections 1 to 7 changes. When `UI_USERS` is set (login on) and/or `HOSTED=1`:

- GET /api/session: `{ loginRequired, hosted, user, runsPerHour }`. `user` is null before login. The page shows
  the Sign in card while `loginRequired` is true and `user` is null, and the rest of the page only after.
- POST /api/login `{ user, password }`: 200 `{ user }` plus the session cookie, or 401 `{ error }`.
  POST /api/logout clears it.
- With login on, every `/api/*` route except session, login and logout, and `/report` and `/allure`,
  answers 401 `{ "error": "Login required" }` without a valid cookie. The page reloads to the Sign in card on a 401.
- GET /api/state gains `yours` (the run in progress is this login's), `queued` (jobs waiting), `position`
  (this login's place in the queue or null), `hosted`, `user`. `startedAt`, `exitCode` and `hasSummary`
  describe this login's run only; `hasSummary` means this login has a finished run with a summary.
- POST /api/run with login on: 202 `{ started: true, runId }`, or 202 `{ queued: true, position, runId }`
  when another login's run is in progress; 409 when this login already has a run in progress or queued;
  429 `{ error }` over the hourly limit or when the queue is full; 400 with the local-address refusal
  message for a local or private host in hosted mode. Stream events `start` and `done` carry `runId`.
- /api/summary, /api/spec, /api/framework/download, /report and /allure serve this login's latest finished
  run, or `?run=<runId>` when that run is this login's. Another login's run is a 404.
- POST /api/stop by another login: 403. POST /api/inputs/save in hosted mode: 403.
- Hosted mode hides the "Allow write requests" checkbox: a production host is always read-only there.

## 9. Redaction and cleanup (additive)

On every run the summary also has:

- "redaction": { "mode": "standard" | "strict", "fields": <count of listed fields>, "replaced": <count> }.
  replaced counts every value the redaction layer (agent/redact.ts) replaced before it reached Claude
  (probe bodies, prompts) or the disk (probe files, evidence attachments). The console prints
  "Redaction: <mode>, N value(s) replaced before Claude and in evidence" in the summary block.
- "cleanup": { "created", "createdByTests", "deleted", "failed", "skippedNoDeleteEndpoint", "failures": [ "<reason>", ... ] }.
  created counts every resource made on the target API during the run (probe and tests): what
  createResource or a setup step made, plus every record a 2xx POST sent by the test code itself (or
  the probe) created on a POST endpoint that has a paired DELETE; createdByTests is how many of created
  came from such direct POSTs. deleted, failed and skippedNoDeleteEndpoint add up to created; failures
  has one line per failed deletion. A failed cleanup never fails the run and is never hidden: the console
  prints "Cleanup: created N (M by test code), deleted N, failed N, no delete endpoint N" (the bracket
  only when M > 0) and one "  cleanup failed: ..." line each.

Playwright reports carry the same numbers per test as annotations "redaction" (a count) and "cleanup"
(the totals as JSON); reports/pactum/status.json has redactionReplaced and cleanup per entry. The UI
does not read either field yet.

## 10. Model settings (additive, local mode only)

The first-launch setup card lets a person on their own machine pick the model provider and save a key.
Shared servers never take keys from the browser: with `HOSTED=1` or `UI_USERS` set the two POST routes
answer 403 and the page hides the card.

- GET /api/settings: `{ provider, model, hasKey, via, configured, editable, providers }`. `provider` is the
  current LLM_PROVIDER (default anthropic), `model` the model the next run will use, `hasKey` whether the
  provider's key is set in the environment, `via` "api" or "cli", `configured` whether a run can start
  (a key, or for anthropic the `claude` CLI found at server start), `editable` whether the POST routes are
  allowed, `providers` the list of `{ id, label, defaultModel, keyEnv }`. The key itself is never returned.
- POST /api/settings/verify `{ provider, key, model? }`: one minimal request to the provider. 200
  `{ ok, provider, model, error }`; `error` is a plain sentence naming the usual cause (wrong key, billing,
  model not found, rate limit, network) and never contains the key.
- POST /api/settings `{ provider, key, model? }`: verifies, then writes `LLM_PROVIDER=`, `LLM_MODEL=` and the
  provider's key line into `.env` (every other line kept, file created from `.env.example` when missing,
  mode 600) and reloads them for the next run. 200 with the same shape as GET, 400 when the key fails
  verification (with the verify error), 403 when not editable.
- The page shows the card when `configured` is false and `editable` is true, and a one-line status with a
  "Change" link otherwise.


## 11. Input validation, run history and evidence (additive)

The page accepts every auth type, roles, profiles and redaction settings. It no longer has a server-side
auth check of its own: the UI validates an input with the agent's own zod schema (`agent/config.ts`
through tsx) and resolves profiles with `agent/model.ts`, so the page and the CLI agree on what is valid.
The agent is unchanged; the UI reads the artifacts the agent already writes.

- POST /api/validate-input `{ json, selection? }`: 200 always (a bad input is a 200 with `ok: false`).
  `{ ok, problems: [{ path, message }], baseUrl, hostClass, mode, selection, dimensions, framework,
  auth: { type, roles, envNames, envMissing, oneRunValue }, redaction: { mode, fields }, endpoints, name }`.
  `path` is a dot path with array indexes (`endpoints[0].path`, `auth.roles.viewer.valueEnv`, `(root)` for
  text that is not JSON, `profile` when a selection is missing). `dimensions` is the profile's dimension
  map when the input has a profile. `baseUrl`, `hostClass` and `mode` are the resolved base URL and the
  safety guard's answer for it (same rules as `agent/safety.ts`, hosted and AGENT_FORCE_PRODUCTION
  included); they are null while problems remain. `envNames` are the `.env` variables the auth section
  reads, `envMissing` those the server's environment lacks (names only, never values), `oneRunValue` true
  when `valueEnv` is `CUSTOM_API_AUTH` for a header, query or cookie auth (the one value the page may type
  in, passed to that run only).
- POST /api/run now takes `{ json, authValue?, selection? }`. `selection` is the `--select` text
  (`env=staging,brand=alpha`) and reaches the agent as `AGENT_SELECT`. A failing validation is 400
  `{ error, problems }` with the same `problems` shape. A `oneRunValue` input without `authValue` is 400.
  In local mode the answer is now 202 `{ started: true, runId }` too, and every run (login or not) gets
  `runs/<runId>/` with its `input.json` and, when it ends, a snapshot of `summary.json`, `framework.zip`,
  `html/`, `allure-report/`, `generated/`, `results.json` (the Playwright JSON report) and `pactum/`
  (status and evidence files). Local mode keeps the newest 20 run folders; login mode keeps its TTL.
- GET /api/runs: the last 20 finished runs the caller may see (every run in local mode, this login's runs
  with login on), newest first: `[{ id, finishedAt, exitCode, status, inputFile, name, baseUrl,
  testFramework, findings, tests, failed, durationSec }]`. `findings` counts suspected API findings; fields
  are null when the run wrote no summary. `?run=<id>` on /api/summary, /api/spec, /api/framework/download,
  /report and /allure now also works in local mode for a listed run.
- GET /api/evidence?test=<test title>[&run=<id>]: `{ test, exchanges: [{ name, request: { method, path,
  role?, headers?, body? }, response: { status, headers?, body } | { error }, file? }] }`, the request and
  response pairs the agent recorded for that test, already redacted by the agent: decoded from the
  Playwright JSON report's inline attachments (the Allure metadata attachment is skipped), or read from
  `pactum/status.json` and its evidence files (`file` names the evidence file). An unknown title gives an
  empty list.
- GET /api/evidence?file=<relative path>[&run=<id>]: streams one evidence file. Only `reports/` of the live
  run, or `results.json` and `pactum/` of a run snapshot, with a `.json`, `.txt` or `.html` name; anything
  else (`..`, `input.json`, another run) is 403, a missing file 404. With login on, a run that is not the
  caller's is a 404 like the other `?run=` routes.
- All three routes are 401 without a session when login is on.

Page ids the tests rely on (`npm run test:ui`): `fwToggle` (framework), `cAuth` (auth type select, values
none, header, query, cookie, login), `profileBox` and `profileDims`, `redactMode` and `redactFields`,
`findings` (finding cards with `data-act="evidence" | "jira" | "md"` buttons), `runsBody` (run history),
`strip` (summary strip), plus every id section 10 and the settings test use.

## 12. Scope, checkpoint and resume (additive)

On every run the summary also has:

- "scope": { "mode": "fresh" | "resume" | "only-new", "endpoints": [ "<id>", ... ] | null,
  "reused": { "probes": <count>, "plans": <count>, "specs": <count> }, "resumable": <boolean>,
  "fakeModel": <boolean>, "concurrency": <count>, "testWorkers": <count> }.
  mode says how the run was scoped: "fresh" (the default, everything regenerated), "resume" (the last run
  of the same input continued from out/checkpoint.json) or "only-new" (only endpoints whose definition
  changed were regenerated). endpoints is the --endpoints list when one was given, else null; the
  summary's "endpoints" array then holds only those. reused counts the probes, plans and specs taken from
  the checkpoint. resumable is true only on a run the budget stopped (status "stopped-budget", or
  "no-tests" when it stopped before the first spec) whose checkpoint can be continued with --resume; the
  console prints "stopped at budget: run again with --resume to continue" right after "STOPPED: budget
  reached" and again in the summary block. fakeModel is true only for FAKE_MODEL=1 test runs (never in
  hosted mode); such a run proves the pipeline, not the model, and the UI may label it.
- Per-endpoint console lines keep their shape. An endpoint taken from the checkpoint prints
  "<id> OK <status> (from checkpoint)", "<id> OK <n> cases (from checkpoint)" or
  "<id> OK written generated/<id>.spec.ts (from checkpoint)" in the matching phase.
- Right after the model line the agent may print "resume: N of M endpoints already done (reusing P probes,
  Q plans, N specs)" (or "only-new: ..."), "endpoints: a, b" for a restricted run, and in the summary block
  "Scope: <mode>[, endpoints a, b][, reused P probes, Q plans, N specs]".

out/checkpoint.json itself (agent/checkpoint.ts) is not read by the UI.

## 13. Exit codes and export result (additive)

The agent's exit code is 0 (completed, nothing fails it), 1 (findings: at least one failed test, with
`--fail-on finding`, the default) or 2 (tool or setup error: bad input or flags, refused host, no model,
no tests, budget stop, an endpoint that could not be tested, a failed framework export, or a crash). The
"done" event carries it; the page shows 0 and 1 as a completed run.

`out/summary.json` also has `exitCode` (the same number), `failOn` ("finding" or "none") and
`frameworkError` (null, or why the export failed; `framework` is then null). The summary is written
before the framework export and rewritten after it, so a failed export never loses the run's results.
The console's summary block ends with `Exit code: <n>`.

## 14. Schema version, response schemas (additive)

`out/summary.json` starts with `schemaVersion: 1`. It is raised only when a field changes meaning or is
removed; new fields do not raise it, so a reader can accept any summary whose `schemaVersion` it knows.

An endpoint in the input may carry `responseSchema: { status, schema }`: the documented success response
(the OpenAPI importer fills it in; `schema` is a JSON Schema subset with `type`, `nullable`, `properties`,
`required`, `items` and `enum`). Each summary endpoint then has `responseSchemaIssues`: `null` without a
schema or when the probe status is not the documented one, else a list (at most 20) of
`"<path>: <what>"` lines where the probe response breaks the schema (`[]` when it matches). The console
prints one line per endpoint with issues.

## 14a. Coverage, images and test options (additive, extends section 15)

Sheet cases: a test that passed while some clause of the case's expected result has no assertion is
`partially covered`, never `passed`; a test whose probe contradicted a clause of the sheet is `needs review`
with `expected ..., actual ...` in the reason. Both are in `summary.testCases.cases[].status`, the
traceability files and the UI card.

- `summary.testCases.partiallyCovered`: count of `partially covered` cases (missing in older summaries;
  treat as 0). `automated` counts passed, partially covered and failed cases. The case statuses are
  `passed`, `partially covered`, `failed`, `needs review`, `not automated`.
- The SUMMARY line reads `Test cases: <rows> in the sheet: <p> passed, <c> partially covered, <f> failed,
  <r> need review, <u> not automated; ...`.
- Allure: such tests also carry `tag=partially covered` (or `tag=needs review`), `coverage=partial` (or
  `needs-review`) and `notAsserted=clause <n>, ...`.
- GENERATING may read `<id> OK written generated/<id>.spec.ts (<n> test(s) dropped by the static gate, the
  rest kept)`; each dropped sheet case is `not automated` with `static gate: <its own reasons>`.
- Plans in the checkpoint and summary may carry, per case, `statusCodes` (the sheet's 4xx list),
  `crossCall` (compares several calls; serial file), and `clauses: [{ n, text, status: asserted |
  not-asserted | probe-disagrees, via?, check?, reason?, expected?, actual? }]`, and per plan
  `notAutomated: [{ caseId?, title, reason }]`.
- Probe results (`out/probes/<id>.json`) may carry `binary: { bytes, signature, signatureHex }` for a body
  that is not text (no `body`/`bodyText` then) and `responseHeaders` (content-type, cache-control,
  content-length, content-disposition, etag, last-modified).
- Input endpoints may carry `errorStatuses: [400-499]`, `allowInvalidInput: true` and `stableData: true`.
  The UI's **Test options** set the last two per endpoint in the run's JSON. The CLI flags
  `--allow-invalid-input [ids]` and `--stable-data [ids]` do the same (no ids: every endpoint; an unknown
  id is a setup error, exit 2).
- `baseUrl` may have a path; endpoint paths are joined after it everywhere.

## 15. Test case sheets (additive)

A run may automate the team's test case sheet: `--test-cases <file>` (and `--test-cases-mode sheet-only |
sheet-plus-agent`), or `testCases: { file, mode? }` in the input (file relative to the input file). The
default mode is `sheet-plus-agent`. A sheet that cannot be read is a setup error: `test case sheet: <why>`
and exit 2.

Test titles: a sheet case is `[<ID>] [<type>] <Title>`, an agent suggestion next to a sheet is
`[agent] [<type>] ...`, and a case marked needs review is `[<ID>] [needs-review] <Title>` (Playwright
`test.fixme` with a `needs-review` annotation holding the reason, Pactum a pending `it`). The type tag
keeps every gate rule of section 1. Allure results carry `caseId=<ID>` and `tag=<ID>` plus
`tag=test-case-sheet`, or `tag=agent-suggestion`.

Console, after the PROBING header lines:

```
test cases: <n> from <file or link> (<csv|tsv|xlsx|jira|confluence|zephyr>, <mode>): <x> matched (<a> by the Endpoint column, <b> by the steps, <c> by the AI), <y> not matched
  sheet warning row <r>: <message>          (at most 20)
  not matched: <ID>: <reason>
test cases: sheet-only, <k> endpoints with cases in scope: <ids>     (sheet-only only)
```

The model's matching call prints `[claude] match test-cases ...` like every call. PLANNING lines read
`<id> OK <n> cases (<s> from the sheet, <a> agent suggestions[, <r> needs review])`. The SUMMARY ends with
`Test cases: <rows> in the sheet: <p> passed, <f> failed, <r> need review, <u> not automated; <a> agent
suggestion(s); traceability in out/traceability.csv and out/traceability.xlsx`, then one line per case that
did not pass.

`out/summary.json` gets `testCases`: `null` without a sheet, else

```
{ file, mode, format, columns: { <field>: <header> }, rows, automated, passed, failed, needsReview,
  notAutomated, agentSuggestions, warnings: [string], traceability: { csv, xlsx },
  cases: [{ id, title, endpoint|null, testFile|null, status, reason }] }
```

`status` is `passed`, `failed`, `needs review` or `not automated`; `cases` lists every sheet row in sheet
order. `out/traceability.csv` (CRLF, cells starting with `= + - @` prefixed with `'`) and
`out/traceability.xlsx` have the columns ID, Title, Endpoint, Test file, Status, Reason, with agent
suggestions after the sheet rows (ID `agent`). The exported framework holds `traceability.csv`.

UI server routes:
- `POST /api/test-cases/preview` `{ name, content | base64, json? }`: the parsed sheet,
  `{ format, columns: { <field>: { label, header } }, ignored, count, matched, rows: [{ id, row, title,
  endpoint, matchedBy, expected, warnings }], warnings, rowWarnings }`, or 400 with `error`.
- `GET /api/test-cases/template`: `input/test-cases-template.csv` as a download.
- `POST /api/run` accepts `testCases: { name, content | base64, mode }`. The server checks the sheet with
  the agent's parser, saves it as `runs/<id>/test-cases.<ext>` and passes `--test-cases`. Without an upload,
  an input's `testCases.file` must be a sheet inside `input/`; anything else is a 400.
- `GET /api/traceability?format=csv|xlsx[&run=<id>]`: the run's traceability file (404 without one).
  Run snapshots keep `traceability.csv` and `traceability.xlsx`.

### 15a. Test cases from a link (additive)

`--test-cases` also takes a Jira issue, filter or search link, a Confluence page link, a Zephyr Scale test
case link, `jql: <JQL>`, plain JQL, or `zephyr: <keys | project = KEY>`; the input may hold
`testCases: { link, mode? }` instead of `file` (one of the two). The agent reads the cases live
(agent/atlassian.ts) with the credentials in `.env` (`ATLASSIAN_BASE_URL`, `ATLASSIAN_EMAIL`,
`ATLASSIAN_API_TOKEN`, optional `ATLASSIAN_DEPLOYMENT`, `CONFLUENCE_BASE_URL`, `XRAY_CLIENT_ID`,
`XRAY_CLIENT_SECRET`, `XRAY_BASE_URL`, `ZEPHYR_API_TOKEN`, `ZEPHYR_BASE_URL`) and then treats them exactly
as sheet rows. A link that cannot be read is a setup error: `test case link: <why>` and exit 2. The console
line reads `test cases: <n> from <link> (<jira|confluence|zephyr>, <mode>): ...`.

`summary.testCases` then has `file: <the link as given>`, `format: "jira" | "confluence" | "zephyr"` and
`source: { kind, label, steps }` (`steps`: `"Xray Cloud"`, `"Xray Data Center"`, `"Zephyr Scale Cloud"`,
`"Zephyr Scale Data Center"` or null); for a sheet file `source` is null. `columns` names where each field
came from (`"Jira key"`, `"Description (\"Expected result\" part)"`, a custom field name, ...).

UI server routes:
- `GET /api/atlassian`: `{ configured, baseUrl, confluenceUrl, deployment, email, hasToken, xray, zephyr,
  error, editable }`. Never a token or secret.
- `POST /api/atlassian` `{ baseUrl, email?, token?, confluenceUrl?, xrayClientId?, xrayClientSecret?,
  zephyrToken? }` (personal machine only, else 403). An empty secret field keeps the saved value. The
  credentials are checked first with one read (`/rest/api/3/myself` on Cloud, `/rest/api/2/myself` on Data
  Center); 400 with a plain `error` when that fails, nothing written. On success the values are written to
  `.env` (mode 600) and the answer is the GET shape plus `user` (the display name).
- `POST /api/test-cases/preview` also accepts `{ link, json? }` (or `content` that is one URL): the same
  preview shape plus `source: { kind, label, steps }`, or 400 with `error`.
- `POST /api/run` accepts `testCases: { link, mode }`. The server checks the link without a request (set up,
  on the configured site) and passes `--test-cases <link>`; an input's `testCases.link` works the same way.

Safety: only the configured Atlassian site, the Confluence site and the Xray / Zephyr Scale API hosts
(vendor hosts, or loopback) are called; any other link host is refused before a request; redirects are not
followed; HTTPS unless loopback; 1000 cases, 100 per page, 10 MB per response, 2500 requests and 30 s per
request; 429 and 503 retried 3 times after `Retry-After` (at most 60 s). Every message is redacted of the
tokens, which are also removed from the test runner's and the model CLI's environment.
