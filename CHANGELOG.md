# Changelog

All notable changes to this project. Dates are the day the change reached `main`.

## Unreleased

- Scale: checkpoint and resume, incremental generation, `--budget` and concurrency flags (PR 10)
- UI refresh: every auth type, profiles, evidence and run history (PR 11)
- Hardening: cleanup of test-made records, OAuth2 client credentials, 429 retries, CI files in exports, Allure for Pactum (PR 12)
- Security: gate for untrusted generated code, provider keys kept from tests, local address ranges and DNS check (PR 13)
- CI behaviour: exit codes 0/1/2 with `--fail-on`, summary before export, in-process zip (PR 14)
- macOS, Windows and Linux support; CI on 3 OSes x Node 22/24; Node 22 or newer required (PR 15)
- Body assertions, OpenAPI response schemas, model retries, `schemaVersion`, docs (PR 16)
- Presented as a SprintSynergy product; `docs/HACKATHON-HANDOFF.md` replaced by `docs/DEMO.md` (PR 17)

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
