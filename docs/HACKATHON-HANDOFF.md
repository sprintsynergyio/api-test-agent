# API Test Agent: Hackathon Handoff

Everything built so far, the decisions behind it, the current status, how to set it up on another machine, and how to demo it. Paste this file into a new Claude chat to continue from where the work stopped.

## Instructions for Claude (read first)

The repo also has `CLAUDE.md` at its root with the rules and verification steps; Claude Code reads it automatically.


You are my engineering lead for this hackathon project. I run Claude Code on my Mac. Your job:

1. Write Claude Code prompts for any remaining step.
2. When I paste Claude Code's summary, verify it against the raw output it pasted, not its own conclusions. Tell me if it is safe to continue, and fix the next prompt if the summary reveals a problem.
3. Keep answers short, in plain English, with exact commands and expected output for anything I run myself.
4. Never accept a change that hides a failure: no editing generated tests by hand, no changing an expected status to make a test pass, no empty results that look like a pass.

---

## 1. The pitch

**Problem:** writing API tests by hand is slow and repetitive. Every endpoint needs the same checks (status codes, response structure, required fields, negative cases, auth), and new endpoints often ship with few tests.

**Idea:** an agent, powered by Claude, that takes a base URL and a list of endpoints, writes a Playwright API test suite, runs it, reports suspected API bugs, and hands over a standalone Playwright framework the team can commit.

**Demo:** pick an API in a web UI (or type in a custom one), click Generate tests, watch the agent probe, plan, generate and run, then see "2 API bugs found" with evidence, the Playwright report, and a downloadable framework.

**Why it matters:**
1. Writing tests for a new endpoint drops from hours to minutes.
2. Every endpoint gets the same baseline checks.
3. API and UI tests live in one framework (Playwright), with one config, one report and one CI pipeline.
4. QA engineers review and add business rules instead of writing boilerplate.

**Next steps after the hackathon (not built):** login flows that fetch a token, CI integration, business-rule tests, turning ticket acceptance criteria into tests.

---

## 2. Key decisions

| Decision | Choice | Why |
|---|---|---|
| Framework | Playwright API testing (not PactumJS) | Same tool as UI tests, built-in HTML report, team already knows it |
| How the agent calls Claude | Claude Code CLI in headless mode (`claude -p`) | No API key needed, uses the logged-in Claude account |
| Model | Default model of the logged-in account; optional `CLAUDE_MODEL` in .env | Switch to a lighter model if usage limits get tight |
| Live demo API | Local shop API (`local-api/server.mjs`) | Cannot go down, two planted bugs caught every time |
| Public API | Restful Booker | Proof on a real API. Not run live: shared server that resets its data |
| Test types | happy, schema, invalid-input, auth | Baseline coverage that fits the build time |
| Test runs | workers 1 | Generated tests share one live API; parallel runs made results flaky |
| Git | Branch `main` on `sprintsynergyhq/api-test-agent`, commit after every verified change, push to `origin main`, never force push, no PRs | Rollback points without review overhead |

---

## 3. How the agent works

```
input/<api>.json  or  Custom API form in the UI
      |
  1. PROBE      call each endpoint once, keep the real response (out/probes/)
                non-2xx is retried once, then the endpoint is skipped
      |
  2. PLAN       Claude designs test cases per endpoint (out/plans/)
      |
  3. GENERATE   Claude writes a Playwright spec; a static gate checks it (generated/)
      |
  4. RUN        Playwright runs the suite (reports/html, reports/results.json)
      |
  5. EXPORT     standalone framework to frameworks/<name>/ + out/framework.zip
      |
  6. REPORTS    Playwright HTML (reports/html) + Allure (reports/allure-report)
      |
  7. SUMMARY    pass/fail per endpoint + suspected API findings (out/summary.json)
```

Plans and generations run 3 endpoints at a time. A full local-shop run takes about 40 to 50 seconds and about 10 Claude calls.

### Status rules

| Test type | Expected status | Notes |
|---|---|---|
| happy | exact 2xx the probe returned | Even unusual codes, e.g. Restful Booker returns 201 on delete |
| schema | same as happy | Field presence and types |
| invalid-input | any 4xx (400 to 499) | Only for endpoints with a body or a path placeholder |
| auth | 401 or 403 | Only for endpoints with `requiresAuth: true` |

A test **never** expects a 5xx. A 500 on bad input makes the test fail, and that failure is the finding.

### Finding classification

**Suspected API finding:** actual status 500 or higher, or an auth or invalid-input test that got a 2xx. Everything else is **needs review**. No actual status recorded means never an API finding.

### Static gate (every generated file must pass before it is saved)

1. Imports `test` and `expect` only from the ctx fixture; never directly from Playwright.
2. No `process.env`, no `http://` or `https://`.
3. No `test.only`, `test.skip`, empty catch, catch without rethrow, or `.catch(`.
4. Every title starts with `[happy]`, `[schema]`, `[invalid-input]` or `[auth]`.
5. Records an `actual-status` annotation before the first assertion.
6. Never asserts a status of 500 or higher.
7. At least as many tests as plan cases, and it must pass TypeScript typecheck.

One retry with the reasons, then the endpoint is reported as failed. No file is written.

### Security rules (all verified)

1. Auth values live only in `.env` or are typed into the UI for one run. They are never written to input files, summaries, reports or the exported framework.
2. The exporter scans every exported file for the real auth value and fails loudly if it finds it.
3. The Claude CLI child process receives no environment variable with AUTH in its name.
4. Error text in the summary has no absolute paths.

### Importers

`npm run -s import <type> < file` (or Custom API tab, Source) turns an existing description of the API into the input file shape, validated with the same zod schema as input files. Output: `{ input, skipped, warnings }`; exit 1 with the reason on stderr when nothing can be imported. Code: `agent/import.ts`, `agent/importers/`. Fixtures: `test-fixtures/importers/`.

| Type | Source |
|---|---|
| postman | Postman collection v2.0 / v2.1 |
| openapi | OpenAPI 3.x or Swagger 2.0, JSON or YAML |
| curl | one or more curl commands |
| har | browser network capture; grouped by method + path, numeric and UUID ids become `{id}` |
| text | Jira / Confluence text; Claude extracts it, max 2 calls per import, not counted in the run budget |

1. **Skipped, never dropped silently:** other origins than the base URL (the most common origin), unresolved URL variables, non-JSON bodies, unsupported methods. HAR: static assets, analytics and other origins are one counted "filtered: not an API call" entry. Text: a base URL, path or field that is not in the text.
2. **Auth:** credentials are dropped and a warning names each one (Authorization, Cookie, headers containing auth/token/key/secret/session, Postman auth blocks, curl -u/-b, credential query params, URL userinfo). Those endpoints get requiresAuth true; the input gets `auth { header, valueEnv: "CUSTOM_API_AUTH" }`. The value is typed into the auth field for the run. Values never reach the output, warnings or errors; text is masked before it goes to Claude.
3. **Setup:** a path with a placeholder gets setup from the POST on its parent path (warning to check idField), or a warning that it needs setup.
4. **12 endpoints:** each endpoint costs about 2 Claude calls of the 30-call budget, so the preview checks the first 12 and warns above that.
5. Imported Postman and OpenAPI fixtures (`input/import-postman-local-shop.json`, `input/import-openapi-local-shop.json`) give the same 2 findings as local-shop. Acceptance criteria are not turned into tests yet.

---

## 4. Project layout

The project lives at `~/Projects/api-test-agent` on the Mac (repo `sprintsynergyhq/api-test-agent`; the local folder name may differ).

```
api-test-agent/
  .env                      auth values and settings (NOT in git, create it by hand)
  .env.example
  README.md
  CLAUDE.md                 rules and commands Claude Code reads automatically
  KIT.md                    description of the test kit
  docs/HACKATHON-HANDOFF.md this file
  input/
    endpoints.json          Restful Booker, 5 endpoints
    demo-small.json         Restful Booker, 3 endpoints, no auth
    local-shop.json         local shop API, 5 endpoints (main live demo)
  local-api/server.mjs      local shop API with two planted bugs
  ui/
    index.html              demo UI (Saved API and Custom API tabs)
    server.mjs              UI server on http://localhost:3000
    CONTRACT.md             exact output the UI expects from the agent
    mock-agent.mjs          fake agent for UI testing only, never for the demo
  agent/
    config.ts               loads and validates input files
    http.ts                 shared HTTP client + createResource
    probe.ts  plan.ts  generate.ts  validate.ts  claude.ts
    export.ts               writes the standalone framework + zip
    cli.ts                  full pipeline (npm run agent)
    import.ts               importer CLI (npm run -s import <type> < file)
    importers/              core.ts + postman, openapi, curl, har, text; importers.test.ts
  test-fixtures/importers/  importer fixtures (fake credential importer-secret-test-value)
  tests/
    fixtures/ctx.ts         ctx fixture, only test-side reader of env
    template/update-booking.spec.ts   hand-written template the generator copies
  frameworks/<name>/        exported standalone frameworks (not in git)
  playwright.config.ts            runs the template
  playwright.generated.config.ts  runs generated/
```

### .env

```
API_AUTH_VALUE=Basic YWRtaW46cGFzc3dvcmQxMjM=
LOCAL_API_AUTH_VALUE=Bearer hackathon-demo-token
MAX_CLAUDE_CALLS=30
CLAUDE_MODEL=
```

Both auth values are public demo credentials (Restful Booker's documented demo login, and the local API's demo token).

### npm scripts

| Script | What it does |
|---|---|
| `npm run api:local` | local shop API, bugs on, port 4000 |
| `npm run api:local:fixed` | local shop API, bugs off |
| `npm run ui` | demo UI, port 3000 |
| `npm run agent <input file>` | full pipeline from the terminal |
| `npm run probe <input file>` | probe only |
| `npm run test:template` | runs the hand-written template (4 tests) |
| `npm run typecheck` | TypeScript check |
| `npm run allure` | open the last Allure report |
| `npm run -s import <type> < file` | import endpoints: postman, openapi, curl, har, text |
| `npm run test:importers` | importer tests (21, two of them make live Claude calls) |

### The local shop API

Base URL `http://localhost:4000`, token `Bearer hackathon-demo-token`.

| Endpoint | Auth |
|---|---|
| GET /products | no |
| POST /products | yes |
| GET /products/{id} | no |
| PUT /products/{id} | yes |
| DELETE /products/{id} | yes |

Planted bugs: POST with price as text returns **500** (correct: 400); DELETE works **without a token** (correct: 401).

### Input file shape

```json
{
  "name": "orders-api",
  "baseUrl": "https://api.example.com",
  "defaultHeaders": { "Accept": "application/json", "Content-Type": "application/json" },
  "auth": { "header": "Authorization", "valueEnv": "MY_API_AUTH" },
  "endpoints": [
    { "id": "create-order", "method": "POST", "path": "/orders", "requiresAuth": true, "body": { "item": "shoe" } },
    { "id": "get-order", "method": "GET", "path": "/orders/{id}", "requiresAuth": false,
      "setup": { "endpointId": "create-order", "idField": "id" } }
  ]
}
```

`name` and `auth` are optional. Without `auth`, no endpoint may have `requiresAuth: true`. `setup` creates a resource first and puts its id into the path placeholder.

---

## 5. Status

| Step | Status | Commit |
|---|---|---|
| 1. Scaffold, config, ctx fixture, template test | Done. 4/4 template tests pass on Restful Booker | 459e0b0 |
| 2. Probe | Done. Auth token leak in error logs found and fixed | 5b4ee50 |
| 3. Claude wrapper, plan, generate, static gate | Done. Non-2xx probes retried once, then refused | 666a12c |
| 4. End-to-end CLI + summary | Done. local-shop: exactly the 2 planted bugs. Restful Booker: 3 real bugs | 0645cc5 |
| 5. workers 1 + UI connected | Done. Bugs off: 25/25 pass, 0 findings | d7dd6af |
| 6. Framework export + Custom API tab | Done. Exported framework runs standalone with the same results; auth never written to disk | 6272a7c |
| 7. Demo polish, README, this doc | Done. JSONPlaceholder custom run works | 073fb98 |
| 8. Allure reporting with request/response evidence | Done. Allure 3 (no Java), labels per test, request and response attached to every test with auth redacted, also in the exported framework | 58c9ebd |
| 9. UI re-run bug fixed | Done. Root cause: a run that failed before the agent cleared out/ left the old summary.json, and the page rendered it after "done"; the server now deletes it before each run, and saved APIs run from their own file so inputFile matches | 656ee99 |
| 10. Importers stage 0: claude CLI preflight | Done. Before PROBING the agent checks that `claude` starts; if not it prints "claude CLI not found on PATH...", writes a no-tests summary and exits 1. Child env keeps PATH, drops every AUTH variable (`claudeEnv()` in claude.ts) | fd52408 |
| 11. Importers stage 1: core, Postman, cURL | Done. `npm run -s import postman\|curl < file` gives the input file shape plus skipped and warnings; credentials stripped; 10/10 `test:importers`. Imported Postman fixture (`input/import-postman-local-shop.json`): the same 2 findings as local-shop | 519fa0f |
| 12. Importers stage 2: OpenAPI/Swagger, HAR | Done. OpenAPI 3.x and Swagger 2.0 (JSON or YAML), HAR with filtering and grouping; 16/16 `test:importers`. Imported OpenAPI fixture (`input/import-openapi-local-shop.json`): the same 2 findings as local-shop | 1b15836 |
| 13. Importers stage 3: Jira / Confluence text | Done. Claude extracts endpoints (max 2 calls per import, outside the run budget, logged); credentials masked before sending; base URL, paths and fields not in the text are dropped. Jira fixture gives the 5 local-shop endpoints; 20/20 `test:importers`. Acceptance criteria are not turned into tests yet | faefb9d |
| 14. Importers stage 4: UI | Done. `POST /api/import` (CONTRACT.md section 6); Custom API tab source picker, paste or upload, preview with checkboxes, 12-endpoint budget warning, skipped list, editable base URL (Generate disabled while empty), "Use these endpoints" into the JSON editor. Fixes: Generate clears the old result first; red/amber phase cards; no Playwright report button when no test ran | 6a0f792 |
| 15. Importers review on `main` | Done. Reviewed all five importers. Fixtures hold only fake credentials; imported HAR and Postman configs contain only `auth.header` and `auth.valueEnv`. New warning names every dropped credential ("Credentials dropped from the import ...: Authorization header, Cookie header"); new test proves it for HAR, Postman and cURL (in process and through the CLI); 21/21 `test:importers`. `input/import-openapi-local-shop.json`: the same 2 findings as local-shop, 22/24 pass. CLAUDE.md updated for `main` (importers section, rule 10: no build output in git), package renamed `api-test-agent` | this commit ("review importers, harden auth stripping, update CLAUDE.md for main") |

### Results so far

| API | Result |
|---|---|
| Local shop, bugs on | 2 suspected API findings (text price returns 500; delete without token returns 204), all other tests pass |
| Local shop, bugs off | 25/25 pass, 0 findings |
| Restful Booker (real, not planted) | Missing firstname returns 500; totalprice sent as text returns 200 and saves null; missing bookingdates returns 500 |
| JSONPlaceholder (custom tab) | 3 invalid-input findings: the API accepts invalid data and returns 201 |

Test counts vary slightly between runs because Claude writes the tests fresh each time. The findings stay the same.

---

## 6. Setting up on a second laptop

The second laptop needs: macOS, Node 20 or higher, git, and Claude Code logged in. The `.env` file is not in git, so it must be created by hand. On Windows the `api:local:fixed` script and Allure generation will not work as written; tell Claude Code and it can adapt them.

### Option A: clone from GitHub (preferred, needs the repo pushed first)

On the Mac, first check everything is committed and pushed:
```
cd ~/Projects/api-test-agent
git status
git push
```
Expected: `nothing to commit, working tree clean` and `Everything up-to-date` (or the push output).

On the second laptop:
```
mkdir -p ~/Projects && cd ~/Projects
git clone https://github.com/sprintsynergyhq/api-test-agent.git
cd api-test-agent
npm install
```
Expected: `npm install` ends with `added N packages`.

### Option B: copy the folder (no GitHub)

On the Mac, make a zip without node_modules and generated output:
```
cd ~/Projects
zip -r ~/Desktop/api-test-agent.zip api-test-agent -x "api-test-agent/node_modules/*" "api-test-agent/out/*" "api-test-agent/reports/*" "api-test-agent/generated/*" "api-test-agent/test-results/*" "api-test-agent/frameworks/*/node_modules/*"
```
The zip includes the `.git` folder (so history and rollback points come along) and the `.env` file. Move it with AirDrop or a USB drive. On the second laptop:
```
mkdir -p ~/Projects && cd ~/Projects
unzip ~/Downloads/api-test-agent.zip
cd api-test-agent
npm ci
```

### Then, on the second laptop (both options)

1. Create `.env` if it is missing (Option A always needs this):
   ```
   cat > .env <<'EOF'
   API_AUTH_VALUE=Basic YWRtaW46cGFzc3dvcmQxMjM=
   LOCAL_API_AUTH_VALUE=Bearer hackathon-demo-token
   MAX_CLAUDE_CALLS=30
   CLAUDE_MODEL=
   EOF
   ```
2. Check Node: `node -v`. Expected: v20 or higher.
3. Check headless Claude: `echo "Reply with the word OK only" | claude -p`. Expected: `OK`. If it asks to log in, run `claude`, log in, `/exit`, and try again.
4. Check the build: `npm run typecheck` (expected: no errors) and `npm run test:template` (expected: 4 passed).
5. Tab 1: `npm run api:local`. Expected: `Local shop API running on http://localhost:4000  (bugs ON)`
6. Tab 2: `npm run ui`. Expected: `API Test Agent UI running on http://localhost:3000`
7. Open http://localhost:3000, keep local-shop selected, click Generate tests. Expected: "2 API bugs found" in about 45 seconds, plus the framework card.

If port 3000 or 4000 is already in use: `lsof -ti :3000 | xargs kill` (or `:4000`), then start again.

---

## 7. Demo

### What must be running

| Run | Needs `npm run ui` | Needs `npm run api:local` | Needs internet |
|---|---|---|---|
| local-shop | Yes | Yes | For the Claude calls |
| demo-small / endpoints (Restful Booker) | Yes | No | Yes |
| Custom API (e.g. Fill example) | Yes | No | Yes |

If the API is down the UI shows "API not reachable" instead of a confusing result.

### Before presenting

1. Tab 1: `npm run api:local`. Tab 2: `npm run ui`. Open http://localhost:3000.
2. Run **demo-small** once. Screenshot the "3 API bugs found" result. Save its report before the next run deletes it: `cp -R reports/html ~/Desktop/restful-booker-report`. To show it: `npx playwright show-report ~/Desktop/restful-booker-report`.
3. Run **local-shop** once so "Load last run" has real data as a backup. Download the framework zip once to check it.
4. Record a backup video of a full local-shop run (QuickTime Player, File, New Screen Recording).
5. At the venue, do one run on the venue Wi-Fi at least 10 minutes early.

### On stage (about 4 minutes)

1. **The problem (30s):** API tests are repetitive; coverage depends on time.
2. **The input (20s):** show the local-shop endpoint list. "This is all the agent gets."
3. **Run it (60s):** click Generate tests. Narrate: probe calls the real API, Claude plans cases, Claude writes Playwright specs, a static gate rejects anything unsafe, Playwright runs them.
4. **The result (40s):** "2 API bugs found": text price returns 500 instead of 400; delete works without a token.
5. **Real bugs, not planted (30s):** show the saved Restful Booker result: 3 real bugs in a public API.
6. **The framework (30s):** show the framework card and download the zip. "This is a standalone Playwright project. npm install, npx playwright test, done."
7. **The evidence (30s):** click Open Allure report, open the failing delete-product auth test, show the attached request with no Authorization header and the 204 response.
8. **Any API (optional, 40s):** Custom API tab, Fill example, Generate tests.
9. **Close (20s):** "Same framework as our UI tests. Next: OpenAPI import and CI."

If the live run stalls: click "Load last run" or play the backup video.

### Likely questions

1. **Could the AI write wrong tests?** Every file passes a static gate first, and failures are only called bugs with clear evidence (a 500, or a success where a rejection was expected).
2. **Those bugs are planted.** The local shop ones are. The three Restful Booker bugs are real and were reproduced outside the tool.
3. **Why does the test count change?** Tests are generated fresh each run; the bugs found stay the same.
4. **What do we keep?** A standalone Playwright project, proven to run without the agent.
5. **Limits?** Fixed header auth only (no login flows), baseline checks rather than business rules, acceptance criteria not turned into tests yet. Endpoints can be imported from Postman, OpenAPI, cURL, HAR or ticket text.

---

## 8. Known risks

| Risk | Mitigation |
|---|---|
| Restful Booker resets its data | Not run live; show the saved report |
| Claude usage limit | Set `CLAUDE_MODEL` in .env to a lighter model; each run is about 10 calls |
| Live run slow on stage | About 45 seconds; "Load last run"; backup video |
| Allure report pings Google Analytics when opened | Harmless; offline it fails silently and the report still works |
| Old UI server holding port 3000 | `lsof -ti :3000 \| xargs kill`, then `npm run ui` |
| Local API not running | UI shows "API not reachable"; start `npm run api:local` |
| Venue network | Local shop API and UI need no internet; only the Claude calls do |
