# Changelog

All notable changes to this project. Dates are the day the change reached `main`.

## Unreleased

- Test cases from Jira, Confluence, Xray and Zephyr Scale links: paste an issue, filter or search link, JQL, a Confluence page link or `zephyr: ...` in the UI (**Jira or Confluence link**) or pass it to `--test-cases` / `testCases.link`; Jira Cloud `search/jql` and Data Center search, Xray Cloud GraphQL and Data Center steps, Zephyr Scale Cloud and Data Center, Confluence Cloud v2 and Data Center page tables, all through the sheet's column matching, preview, modes, needs review and traceability. A **Connect Jira and Confluence** card checks the account and saves `ATLASSIAN_*` to `.env`; only the configured hosts are called, 429 retries, caps, plain 401 / 403 / 404 messages, tokens never shown or logged. New `npm run test:atlassian`, `npm run test:ui-atlassian`, `npm run mock:atlassian` and an e2e run of the sample sheet as a Confluence page
- Docs: step-by-step Claude Code login in the README and `docs/TEAM-SETUP.md` (install, sign in, no API key needed; troubleshooting for PATH and a key in `.env` overriding the login)
- Test case sheets: upload or paste the team's manual test cases (CSV, TSV or XLSX) in the UI, or `--test-cases <file>` / `testCases` in the input; one test per row named `[TC-ID] [type] Title`, flexible column names, endpoint matching (Endpoint column, steps, then the model), "Only my test cases" or "My test cases + agent suggestions", vague or contradicting cases marked needs review, traceability back-map in `out/traceability.csv` and `.xlsx`, the summary, Allure labels and the export; template CSV in the UI; new `npm run test:test-cases` and e2e runs of the sample sheet.
- Scale: checkpoint and resume, incremental generation, `--budget` and concurrency flags (PR 10)
- UI refresh: every auth type, profiles, evidence and run history (PR 11)
- Hardening: cleanup of test-made records, OAuth2 client credentials, 429 retries, CI files in exports, Allure for Pactum (PR 12)
- Security: gate for untrusted generated code, provider keys kept from tests, local address ranges and DNS check (PR 13)
- CI behaviour: exit codes 0/1/2 with `--fail-on`, summary before export, in-process zip (PR 14)
- macOS, Windows and Linux support; CI on 3 OSes x Node 22/24; Node 22 or newer required (PR 15)
- Body assertions, OpenAPI response schemas, model retries, `schemaVersion`, docs (PR 16)
- Presented as a SprintSynergy product; `docs/HACKATHON-HANDOFF.md` replaced by `docs/DEMO.md` (PR 17)
- Windows: CI starts `npm run ui` from `J:\Api test agent\...` and other folders with spaces or on a non-C: drive (Node 22, 24 and 24.21.0) and loads the agent modules, new `npm run test:ui-smoke`; guards the fix for the UI crash `ERR_UNSUPPORTED_ESM_URL_SCHEME ... Received protocol 'j:'` on first page load (PR 20)
- Sheet runs against real APIs: image and file responses (headers, size and file signature instead of JSON; the probe reads bytes); the static gate drops only the tests it rejects and gives each case its own reason; invalid-input allowed when the OpenAPI spec documents a 4xx, a sheet case expects one, or `allowInvalidInput` / `--allow-invalid-input` / UI Test options; cross-call checks on stable data (read-only GET or `stableData` / `--stable-data`) run serially; "400 or 404, not 500" read correctly in the parser and prompts; per-clause coverage with the new `partially covered` status and needs review with expected vs actual (traceability, summary, UI, Allure); base URLs with a path keep it in the probe, tests, Pactum and the export; "Only my test cases" explained in the UI and README; local demo API gains a `/media/v1` image, paging and validation API with `npm run test:sheet-feedback` and `npm run test:e2e-media`
- UI layout: the right column (Agent pipeline, Recent runs) no longer covers the input column. A long `.env` variable name, input name, base URL or path used to widen the left cards past their 440px column (the card stack's grid track and the cards had no `min-width: 0`), so the right column sat on top of the tabs, the Base URL, the `.env` warning, the endpoints and Run options. All layout grids now use `minmax(0, ...)` tracks and `min-width: 0`, long text wraps inside its card, the runs table scrolls inside its card, the page stacks to one column at 1100px and below, and phones get a single-column options form. New `npm run test:ui-layout` (headless Chromium, 11 widths and zoom levels) in CI

## 1.0.0 (2026-11-14)

First version shared with a team.

- Static gate with per-type status rules, `noAuthApi` rule for auth tests, per-type plan coverage (PR 1)
- Eval harness: planted-bug catalog in the local shop API, scorer, `npm run eval` (PR 2)
- Pactum (Mocha) as a second output framework behind a framework adapter; standalone Pactum export (PR 3)
- Input model: several path placeholders with ordered setup steps, `query` and `headers` per endpoint, env/brand/region profiles with `--select` (PR 5)
- Hosted mode: login, per-login runs, rate limits, local and private hosts refused, API key path, `docs/HOSTING.md` (PR 4)
- Redaction before anything reaches the model (built-in rules, field list, strict mode); test data cleanup with counts in the summary (PR 6)
- Auth adapters: header, query, cookie, login flow with token cache and refresh, roles with `ctx.as(role)`, `[authz]` test type (PR 7)
- Model providers: Claude via Claude Code login or API key, OpenAI via Chat Completions; first-run setup card in the UI; `docs/TEAM-SETUP.md` (PR 8)
- MIT license, GitHub Actions CI on Node 20 and 22, dependency updates (PR 9)

## Before 1.0.0

- October 2026: first build. Probe, plan, generate, run, export for Playwright; importers for OpenAPI, Postman, cURL, HAR and ticket text; production safety guard; demo UI. Demo and design notes in `docs/DEMO.md`.
