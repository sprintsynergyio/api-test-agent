# Changelog

All notable changes to this project. Dates are the day the change reached `main`.

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

- October 2026: hackathon build. Probe, plan, generate, run, export for Playwright; importers for OpenAPI, Postman, cURL, HAR and ticket text; production safety guard; demo UI. History in `docs/HACKATHON-HANDOFF.md`.
