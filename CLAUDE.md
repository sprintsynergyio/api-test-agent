# qa-test-agent

An agent that takes a base URL and a list of API endpoints, probes the real API, uses Claude to plan and write Playwright API tests, runs them, reports suspected API bugs, and exports a standalone Playwright framework. Built for a hackathon demo; the full story, status and demo script are in `docs/HACKATHON-HANDOFF.md`.

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
6. Auth values come only from `.env` or the UI (env `CUSTOM_API_AUTH`, one run only). They must never appear in input files, summaries, reports, attachments, logs or the exported framework. The Claude CLI child process gets no env variable with AUTH in its name.
7. `tests/fixtures/ctx.ts` is the only test-side file that reads `process.env` or the input file. Tests use `ctx.api`, `ctx.noAuthApi`, `ctx.createResource(endpointId)`.
8. The UI reads agent output exactly as described in `ui/CONTRACT.md` (console phase headers, per-endpoint OK/FAILED lines, `out/summary.json` shape). Any change to agent output must keep that contract. Do not restyle `ui/` unless asked.
9. The exported framework must stay standalone: no imports from `agent/` or outside its own folder.

## Static gate (agent/validate.ts) rejects a spec when

- it does not import `test` and `expect` from the ctx fixture, or imports from `@playwright/test` directly
- it contains `process.env`, `http://` or `https://`
- it contains `test.only`, `test.skip`, an empty catch, a catch that does not rethrow, or `.catch(`
- a title does not start with `[happy]`, `[schema]`, `[invalid-input]` or `[auth]`
- a test lacks the `actual-status` annotation before its first assertion
- any assertion expects a status of 500 or higher
- it has fewer tests than plan cases, or fails typecheck

## Input files

`input/endpoints.json` and `input/demo-small.json` (Restful Booker), `input/local-shop.json` (local demo API). Shape: optional `name`, `baseUrl`, `defaultHeaders`, optional `auth { header, valueEnv }`, `endpoints[] { id, method, path, requiresAuth, body?, setup? { endpointId, idField } }`. Do not overwrite the three kit files.

## How to verify any change

1. `npm run typecheck`: no errors.
2. `npm run test:template`: 4 passed.
3. Tab 1 `npm run api:local`, then `npm run agent input/local-shop.json`: exactly 2 suspected API findings (create-product with a text price returns 500; delete-product without auth returns 204), every other test passes, contract check clean.
4. `npm run api:local:fixed`, same run: 0 findings, 0 failures.
5. `grep -r "hackathon-demo-token\|YWRtaW46" out/ reports/ frameworks/ input/`: no matches.
6. Paste raw command output in your reply, not a summary. Commit after each verified change on branch `hackathon`.

## Known environment notes

- macOS assumed: `npm run api:local:fixed` uses `FIXED=1 node ...` and Allure 3 uses macOS's `mdls`. On Windows, Allure may not generate (the run continues with `allureReport: null`).
- If port 3000 or 4000 is busy: `lsof -ti :3000 | xargs kill`.
- Restful Booker is a shared public server that resets its data; a random 404 there is not a code bug.
