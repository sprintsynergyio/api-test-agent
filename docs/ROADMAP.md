# API Test Agent: Roadmap

From a working hackathon agent to a complete API automation product that writes, runs and maintains API test suites in **Playwright** or **Pactum**, from any API description, safely.

We work through the phases in order, one step at a time. A phase is done only when every line in its "Proof" list passes with raw output pasted. Each phase is one to three Claude Code prompts.

---

## Where we are today

| Area | Status |
|---|---|
| Pipeline: probe, plan, generate, static gate, run, summary | Done, proven |
| Findings: planted bugs caught, real bugs in Restful Booker, 0 false alarms with bugs fixed | Done, proven |
| Standalone Playwright framework export + zip | Done, proven |
| Playwright HTML + Allure reports with request/response evidence | Done, proven |
| Web UI: saved APIs, custom API form, live pipeline, findings | Done, proven |
| Web UI refresh (Phase 9 PR A): new look, framework toggle, every auth type and roles in the form, profile selects, redaction options, findings with request and response evidence, Jira and Markdown copy, run history, validation through the agent's schema (`npm run test:ui`) | Built and proven offline; a visual pass on the Mac and a live run from the page pending |
| Importers: OpenAPI, Postman, cURL, HAR, Jira/Confluence text | Done, reviewed (Phase 0) |
| Pactum output | Adapter built, proven offline against the local shop (Phase 2 PR); live agent run pending; UI toggle done (Phase 9 PR A) |
| Eval harness | In progress: harness built (`npm run eval`, 7 planted bugs, scorer + offline tests); score pending the first live run |
| Safety guard against production hosts | Done, proven (Phase 1) |
| Input model: nested paths, query, endpoint headers, env/brand/region profiles | Built and proven offline (Phase 4a PR); live agent run on `input/local-shop-nested.json` pending |
| Real-world auth: header, query, cookie, login flow with refresh, roles, `[authz]` tests | Built and proven offline (Phase 5 PR: `npm run test:auth`, both frameworks and exports against the local shop login); live agent run on `input/local-shop-login.json` pending; UI form done (Phase 9 PR A); OAuth2 client credentials not yet |

---

## Phase 0: Foundation check (done, commit 80560d6)

**Goal:** confirm the importer work is safe and correct, and bring CLAUDE.md up to date.

**Deliverables**
- Plain English report of what each importer does, plus its tests passing.
- Importers never write auth values (headers, cookies, tokens) into input files; they drop them and warn.
- An imported OpenAPI file gives the same results as the hand-written local-shop file.
- CLAUDE.md updated: product name, branch `main`, importers section, rule against committing build output.

**Proof**
1. Importer tests pass.
2. `grep` finds no real token in fixtures or generated input files.
3. `npm run agent input/import-openapi-local-shop.json`: the same 2 findings as local-shop.
4. Every CLAUDE.md verification step passes.

---

## Phase 1: Production safety guard (done, commit "Phase 1: production safety guard")

**Goal:** the agent can never send write requests to a real system by accident. Importing a real spec makes this essential.

**Deliverables**
- Safe-host check: `localhost`, `127.0.0.1`, and hosts containing `dev`, `test`, `qa`, `staging`, `sandbox` count as safe. Anything else is treated as production.
  - As built (CLAUDE.md rule 11): local also covers `::1`, `.local`, `host.docker.internal` and private IPv4 ranges; non-production also covers `stage`, `uat` and `preprod`, and matches whole host parts only (split on `.` and `-`), so `latest.example.com` and `contest.io` are production.
- On a production host the agent refuses to run unless the input has `"allowProduction": true`, and even then it runs in **read-only mode** by default (GET, HEAD, OPTIONS only) unless `"allowWrites": true` is also set.
- UI: base URL shown and editable after import, a red warning for production hosts, a checkbox to confirm, and a read-only toggle.
- Summary records the safety mode used for every run.

**Proof**
1. An input pointing at `https://api.example.com` is refused with a clear message and no request is sent (check with a request counter on a fake server).
2. With `allowProduction` only: GET tests run, POST/PUT/PATCH/DELETE tests are skipped and listed as "skipped: read-only mode", never shown as passed.
3. local-shop still gives the same 2 findings.

---

## Phase 2: Framework adapter + Pactum (in progress)

Status: adapter interface, Pactum setup file with the guard, template, gate, runner, parser and exporter are built and proven offline (template green against the local shop, exported framework runs standalone, refusal works standalone). Still open: the first live agent run in Pactum mode (needs the Claude login), Allure for Pactum, and the UI framework toggle.

**Goal:** one agent, two output frameworks. The user picks Playwright or Pactum; everything else stays shared.

**Design: shared vs per framework**

| Shared (one copy) | Per framework (adapter) |
|---|---|
| Importers, probe, plan, status rules | Template test |
| Finding classification | Generator instructions |
| Summary contract, UI, safety guard | Static gate rules |
| Auth value handling | Runner command + results parser |
| | Exporter (standalone project skeleton) |
| | Report wiring (HTML / Allure) |

Every adapter must produce **normalized results**: test title, type tag, pass/fail, actual status, error, request/response evidence. The findings logic only reads normalized results, so it never needs to know which framework ran.

**Pactum specifics**
- Runner: Pactum with Mocha. Base URL and auth set once in a shared setup file, the Pactum equivalent of the ctx fixture.
- Tests record the actual status for every request (through a small helper, the equivalent of the `actual-status` annotation).
- Reports: Mocha JSON for the parser, Allure through the Allure Mocha reporter.
- Static gate for Pactum: imports only from the shared setup file, no hardcoded hosts, no `process.env` in tests, no `.only` / `.skip`, type tags in titles, no expected status of 500 or more.
- Exported Pactum framework is standalone, with `npm test` and Allure scripts.

**UI:** a **Framework: Playwright / Pactum** toggle next to Generate tests. Subtitle becomes "From endpoints to a running API test suite". The framework card shows which framework was exported.

**Proof**
1. local-shop in **Playwright**: same 2 findings as today.
2. local-shop in **Pactum**: the same 2 findings, every other test passing.
3. Bugs fixed, both frameworks: 0 findings, 0 failures.
4. Both exported frameworks run standalone in a temp folder with the same results.
5. No auth value in any output of either framework.

---

## Phase 3: Eval harness (quality numbers you can quote). In progress: harness built, score pending first live run

Built before Phase 2 so the Pactum proof can be "same eval score as Playwright", not just "same 2 findings". As built: one local API with a 7-bug catalog (`local-api/bugs.json`, 5 detectable today, 2 marked none-yet) instead of three or four APIs; `npm run eval` runs one framework (Playwright) until Phase 2 adds the adapter.

**Goal:** measure how good the agent is, and stop any later change from quietly making it worse.

**Deliverables**
- Three or four small local APIs with a catalog of planted bugs, each bug labelled by type: 5xx on bad input, missing auth check, wrong status code, schema drift, data not persisted, wrong field type, broken pagination.
- `npm run eval`: runs the agent on every API in both frameworks, three times each, and reports:
  - **detection rate**: planted bugs found / planted bugs
  - **false alarm rate**: findings that are not planted bugs
  - **flakiness**: results that differ between the three runs
  - cost: Claude calls and duration
- The eval score goes in the README, and every later phase must not lower it.

**Proof**
1. `npm run eval` prints the score table.
2. Introducing a deliberate generator bug lowers the score (the harness catches regressions).

**Pitch-ready after this phase:** "Import your spec, choose Playwright or Pactum, safe by default, catches X% of planted bugs with Y false alarms."

---

## Phase 4a: Input model for real APIs (built, live run pending)

Pulled forward from Phases 4 and 5 because the first real client (multi-brand, multi-region, multi-env ecommerce) cannot be described without it.

- Paths with more than one placeholder, filled by ordered setup steps (`setup` may be an array with `param`), `ctx.setup()` in both ctx files.
- Per-endpoint `query` and `headers`, sent by the probe, createResource and the tests (`params` and `headers` request options); importers fill them from OpenAPI, Postman, cURL and HAR.
- `profile` block: dimensions (env, brand, region, ...), templated baseUrl and headers, overrides; `--select` / `AGENT_SELECT` picks one value per dimension; the safety guard classifies the resolved host; summary gets `selection`; exported frameworks keep the profile and resolve it at run time.
- Real client profiles live in `profiles/local/` (gitignored). `input/example-profile.json` has placeholder hosts only.

**Proof so far:** `npm run test:config` (28 checks), probe on `input/local-shop-nested.json` against the local shop with the reviews resource, both exported frameworks run standalone with nested setup, a profile export refuses the production selection and runs the local one. Pending: the live agent run on the nested input.

## Phase 4: Spec-driven depth

**Goal:** use the information in OpenAPI specs to write stronger tests, not just status checks.

**Deliverables**
- Response schema validation against the spec (Playwright via a JSON schema validator, Pactum via its built-in JSON schema expectation).
- Boundary tests from the spec: min/max length, min/max values, enums, required vs optional, formats (email, date, uuid).
- Query parameter tests: pagination, filters, sorting.
- A new `[contract]` test type: the response matches the documented schema.

**Proof:** new planted bugs (schema drift, enum not enforced, max length not enforced) are caught; eval score does not drop.

---

## Phase 5: Real-world auth (built, live run pending)

**Goal:** test the APIs real teams have, which rarely use a fixed header.

**Deliverables**
- Login flow: call a login endpoint, read the token from the response, use it for the run. Built: `auth.type: "login"` (agent/auth.ts), token cached per client, one refresh on a configured status.
- API key in a header, query parameter or cookie. Built: `auth.type: "header" | "query" | "cookie"`.
- OAuth2 client credentials. Not built: a client-credentials grant is a login request with a form body; the login type takes JSON bodies only. The importers warn when a spec declares oauth2.
- Roles: two users (for example admin and customer). New `[authz]` tests: a customer cannot read or change another customer's data, a customer cannot call admin endpoints. Built: `auth.roles`, `ctx.as(role)` in both frameworks, the `[authz]` case type with its own plan and gate rules, finding classification and eval scoring.

**Proof so far:** the local shop API has `POST /auth/login` with admin and viewer users and the planted bug `viewer-can-delete`; throwaway `[authz]` specs catch it in both frameworks (actual status 204 recorded); both exports run standalone with the login flow; `npm run test:auth` covers every type, caching, refresh, the guard and redaction; no credential or token in any output. Pending: the live agent run (`npm run agent input/local-shop-login.json`) and the UI, which still accepts only the header type.

---

## Phase 6: Flow tests and test data

**Goal:** test behaviour across endpoints, where the important bugs hide.

**Deliverables**
- `[flow]` tests: create, read, update, read again, delete, confirm it is gone.
- Test data generation from the schema (realistic but fake values).
- Cleanup: every resource a test creates is deleted afterwards, even when the test fails. **Done (PR 7, Nov 2026):** `createResource` records what it makes, each test's fixture (Playwright) or root hook (Mocha) deletes it through the matching DELETE endpoint, the probe cleans its own setup data, totals go to `summary.cleanup`. Still open: deletion of resources the generated test bodies create directly (a `[happy]` POST test's own record is not tracked).
- Redaction before Claude: **Done (PR 7, Nov 2026):** `agent/redact.ts`, built-in rules always on, `redaction: { fields, mode }` per input, final pass in `callClaude`, evidence files redacted.
- Environment profiles (dev, staging) with separate base URLs and auth variables.

**Proof:** planted "update not persisted" and "delete does not delete" bugs are caught; after a run, the API has no leftover test data.

---

## Phase 7: CI and incremental updates

**Goal:** the generated suite lives in the client's pipeline and stays current.

**Deliverables**
- Exported frameworks include CI files for GitHub Actions and Azure DevOps.
- Update mode: given a new spec version, generate tests only for new or changed endpoints, and never overwrite tests a human has edited (generated files carry a marker; edited files lose it).
- Findings exported as a Jira-ready bug draft with the request/response evidence.

**Proof:** a spec with one new endpoint produces one new spec file and leaves the others untouched; the CI file runs green in a sample repository.

---

## Phase 8: Team setup (built, live check pending)

For a team that clones the repo and runs it on their own machines. Model provider adapter (Claude via API key or Claude Code login, OpenAI via Chat Completions), a first-launch settings card in the UI that verifies a key and writes it to `.env` (local machines only; shared servers refuse it), `docs/TEAM-SETUP.md`, `npm run eval -- --provider` to compare providers. Not yet: Grok or other providers, per-login keys on a shared server, a Docker image.

## Not in scope (for now)

- Performance and load testing.
- Consumer-driven contract testing (Pact broker style).
- GraphQL and gRPC.
- Running against production with writes enabled as a default.

---

## Pitch summary (for the client)

**The problem:** API test coverage depends on how much time engineers have. Every endpoint needs the same baseline checks, and new endpoints often ship with few tests.

**What the agent does:** give it your OpenAPI spec, Postman collection, cURL commands, HAR file or even a Jira description. It calls the real API, plans test cases, writes a complete test suite in **Playwright or Pactum**, runs it, and reports suspected bugs with request and response evidence. You keep a standalone test project you can commit and run in CI.

**Why it is trustworthy:**
1. Every generated file passes a static safety gate before it is saved.
2. Bugs are only reported with clear evidence (a 500, or a success where a rejection was expected).
3. Auth values are never written to any file or report.
4. It refuses to write to production systems by default.
5. Quality is measured on a catalog of planted bugs, and every change is checked against that score.

**What to show:**
1. Import a spec, pick a framework, run it, and watch it find bugs live.
2. Real bugs it found in a public API nobody planted.
3. The exported project running on its own.
4. The eval score.

**Before pitching:** agree with the client who owns the agent and the generated code, and how it may be used, since it was first built at the client's hackathon.
