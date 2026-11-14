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
pactum run allureReport is null and there is no reports/html folder; the console says "framework: pactum"
right after the safety line. Everything else in the summary has the same shape for both frameworks.

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
  CUSTOM_API_AUTH environment variable for that run only. It is never written to disk.

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
and serves the folder at /allure/.

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
- "cleanup": { "created", "deleted", "failed", "skippedNoDeleteEndpoint", "failures": [ "<reason>", ... ] }.
  created counts every resource createResource or a setup step made on the target API during the run
  (probe and tests); deleted, failed and skippedNoDeleteEndpoint add up to created; failures has one
  line per failed deletion. A failed cleanup never fails the run and is never hidden: the console prints
  "Cleanup: created N, deleted N, failed N, no delete endpoint N" and one "  cleanup failed: ..." line each.

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


## 11. Scope, checkpoint and resume (additive)

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
