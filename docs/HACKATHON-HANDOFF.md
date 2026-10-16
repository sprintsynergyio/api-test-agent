# API Test Agent: Hackathon Handoff

This file explains everything built so far, the decisions behind it, the current status, and the exact prompts left to run. Paste it into a new Claude chat to continue the work from where it stopped.

## Instructions for Claude (read first)

You are my engineering lead for this hackathon project. I run Claude Code on my Mac. Your job:

1. Write the Claude Code prompts for each remaining step (they are below, ready to use).
2. When I paste Claude Code's summary, verify it against the raw output it pasted, not its own conclusions. Tell me if it is safe to run the next prompt, and fix the next prompt if the summary reveals a problem.
3. Keep answers short, in plain English, with exact commands and expected output for anything I run myself.
4. Never accept a change that hides a failure: no editing generated tests by hand, no changing an expected status to make a test pass, no empty results that look like a pass.

---

## 1. The pitch

**Problem:** writing API tests by hand is slow and repetitive. Every endpoint needs the same checks (status codes, response structure, required fields, negative cases, auth), and new endpoints often ship with few tests.

**Idea:** an agent, powered by Claude, that takes a base URL and a list of endpoints and produces a ready-to-run Playwright API test suite, runs it, and reports suspected API bugs.

**Demo:** pick an API in a web UI, click Generate tests, watch the agent probe, plan, generate and run, then see "2 API bugs found" with the evidence and the Playwright report.

**Why it matters:**
1. Writing tests for a new endpoint drops from hours to minutes.
2. Every endpoint gets the same baseline checks.
3. API and UI tests live in one framework (Playwright), with one config, one report and one CI pipeline.
4. QA engineers review and add business rules instead of writing boilerplate.

**Next steps after the hackathon (not built):** OpenAPI/Swagger import, login flows that fetch a token, CI integration, self-repair of broken test code.

---

## 2. Key decisions

| Decision | Choice | Why |
|---|---|---|
| Framework | Playwright API testing (not PactumJS) | Same tool as UI tests, built-in HTML report, team already knows it |
| How the agent calls Claude | Claude Code CLI in headless mode (`claude -p`) | No API key needed, uses the logged-in Claude account |
| Model | Default model of the logged-in account; optional `CLAUDE_MODEL` env to switch | Lets us move to a faster model if usage limits get tight |
| Live demo API | Local shop API on the Mac (`local-api/server.mjs`) | Cannot go down, has two planted bugs the agent catches every time |
| Public API | Restful Booker (restful-booker.herokuapp.com) | Proof it works on a real API. Not used live: it is a shared server that resets its data |
| Test types | happy, schema, invalid-input, auth | Baseline coverage that fits a 5 hour build |
| Git | Branch `hackathon`, commit after every prompt, no PRs | Rollback points without review overhead |

---

## 3. How the agent works

```
input/<api>.json
      |
  1. PROBE      call each endpoint once, save the real response (out/probes/)
      |
  2. PLAN       Claude designs test cases per endpoint (out/plans/)
      |
  3. GENERATE   Claude writes a Playwright spec, a static gate checks it (generated/)
      |
  4. RUN        Playwright runs the suite (reports/html, reports/results.json)
      |
  5. SUMMARY    pass/fail per endpoint + suspected API findings (out/summary.json)
```

### Status rules (the core of honest results)

| Test type | Expected status | Notes |
|---|---|---|
| happy | exact 2xx the probe returned | Even unusual codes, e.g. Restful Booker returns 201 on delete |
| schema | same as happy | Checks field presence and types |
| invalid-input | any 4xx (400 to 499) | Only for endpoints with a body or an `{id}` in the path |
| auth | 401 or 403 | Only for endpoints with `requiresAuth: true` |

A test **never** expects a 5xx. If the API returns 500 on bad input, the test fails, and that failure is the finding.

### Finding classification

A failed test is a **suspected API finding** when the actual status is 500 or higher, or when an auth or invalid-input test got a 2xx. Everything else is **needs review**. A test without a recorded actual status is never called an API finding.

### Rules every generated test must follow (enforced by the static gate)

1. Imports `test` and `expect` from `tests/fixtures/ctx` only.
2. No `process.env`, no hardcoded `http://` or `https://`.
3. No `test.only`, `test.skip`, empty catch, catch without rethrow, or `.catch(`.
4. Every title starts with `[happy]`, `[schema]`, `[invalid-input]` or `[auth]`.
5. Records the real status with an `actual-status` annotation before the first assertion.
6. Never asserts a status of 500 or higher.
7. At least as many tests as plan cases, and it must pass TypeScript typecheck.

If a candidate fails the gate, generation retries once with the reasons. If it fails again, no file is written and the endpoint is reported as failed.

---

## 4. Project layout

```
qa-test-agent/            (on the Mac: ~/Projects/qa-test-agent)
  .env                      auth values and settings (not committed)
  KIT.md                    description of the test kit (APIs and input files)
  input/
    endpoints.json          Restful Booker, 5 endpoints
    demo-small.json         Restful Booker, 3 endpoints, no auth
    local-shop.json         local shop API, 5 endpoints (main live demo)
  local-api/server.mjs      local shop API with two planted bugs
  ui/
    index.html              demo UI (built and tested, do not redesign)
    server.mjs              UI server on http://localhost:3000
    CONTRACT.md             exact output the UI expects from the agent
    mock-agent.mjs          fake agent for UI testing only, never for the demo
  agent/
    config.ts               loads and validates input files (zod)
    http.ts                 shared HTTP client + createResource logic
    probe.ts                step 1
    claude.ts               headless Claude CLI wrapper + call budget
    plan.ts                 step 2
    generate.ts             step 3
    validate.ts             static gate
    try-one.ts              plan + generate for a single endpoint
    cli.ts                  full pipeline (Prompt 4, not built yet)
    export.ts               writes the standalone framework to frameworks/<name>/ and zips it to out/framework.zip
  frameworks/               exported standalone Playwright projects, one folder per API (not committed, only .gitkeep)
  tests/
    fixtures/ctx.ts         the ctx fixture, only test-side reader of env
    template/update-booking.spec.ts   hand-written template the generator copies
  playwright.config.ts            runs the template
  playwright.generated.config.ts  runs generated/ (list, html and json reporters)
```

### .env

```
API_AUTH_VALUE=Basic YWRtaW46cGFzc3dvcmQxMjM=
LOCAL_API_AUTH_VALUE=Bearer hackathon-demo-token
MAX_CLAUDE_CALLS=30
CLAUDE_MODEL=
```

Both auth values are public demo credentials (Restful Booker's documented demo login, and the local API's demo token).

### The local shop API

Run with `npm run api:local` (bugs on) or `npm run api:local:fixed` (bugs off). Base URL `http://localhost:4000`, token `Bearer hackathon-demo-token`.

| Endpoint | Auth |
|---|---|
| GET /products | no |
| POST /products | yes |
| GET /products/{id} | no |
| PUT /products/{id} | yes |
| DELETE /products/{id} | yes |

Planted bugs:
1. POST /products with price as text returns **500** (correct: 400).
2. DELETE /products/{id} works **without a token** (correct: 401).

### The ctx fixture

Tests get everything from `ctx`: `baseUrl`, `api` (with auth), `noAuthApi` (without auth), and `createResource('<creating endpoint id>')`, which returns the new id as a string. The input file comes from the `INPUT_FILE` env variable; the auth value comes from the env variable named in the input file's `auth.valueEnv`.

---

## 5. Status

| Step | Status | Commit |
|---|---|---|
| Prompt 1: scaffold, config, ctx fixture, template test | Done. Typecheck clean, 4/4 template tests pass on Restful Booker (200 / 400 / 403) | 459e0b0 |
| Prompt 2: probe | Done. All 3 input files probe OK. Auth token leak in error logs found and fixed | 5b4ee50 |
| Prompt 3: claude.ts, plan, generate, static gate | Done. create-product: 5 cases planned, spec passed gate first try (8s plan, 13.5s generate). Non-2xx probes are retried once, then refused | 666a12c |
| Prompt 4: end-to-end CLI + summary | Done. local-shop (bugs on): 5 specs, 25 tests, 23 pass, exactly the 2 planted bugs found, 44s, 10 Claude calls. Restful Booker: 3 real bugs found (see section 7). Summary passes the UI contract check | 0645cc5 |
| Prompt 5: workers 1 for determinism + connect the UI | Done. Generated tests run with workers 1. UI connected to the real agent, all UI routes checked with curl | d7dd6af |
| Prompt 6: framework export + custom API | Done. Framework export to frameworks/<name> with zip download. Standalone run proven (same 2 failures, 23 pass, outside the project). Custom API tab works; auth values are never written to disk | 6272a7c |
| Prompt 7: self-repair loop | Optional | |

**Lessons from Prompt 4:**
1. Generated tests share one live API. Running them in parallel made one test fail (a list count changed while another test created a product). Fixed by an instruction in plan.ts and generate.ts, and Prompt 5 sets workers to 1 in playwright.generated.config.ts so runs are deterministic.
2. The pipeline runs phase by phase (all plans, then all generations, 3 at a time) so the UI marks the right steps.
3. stopped-budget exits 0 (tests still ran); no-tests exits 1.

**Open item:** the GitHub repo is not created yet, so commits are only local. The token cannot create repos. Create `qa-test-agent` (private) on github.com, then from ~/Projects/qa-test-agent run:

```
git remote add origin https://github.com/sardar-usman/qa-test-agent.git
git push -u origin hackathon
```

If the push returns 403, add the repo to the fine-grained token (GitHub Settings, Developer settings, Personal access tokens, Fine-grained tokens, Edit, Repository access, Contents read and write).

---

## 6. Remaining prompts

### Prompt 4: end-to-end CLI and summary (next)

```
Read the current code and ui/CONTRACT.md first. Build agent/cli.ts that runs the full flow. Its console output and out/summary.json must match ui/CONTRACT.md exactly, because the demo UI reads them.

1. Take an input file path as the first argument, default input/endpoints.json. Load it with loadConfig.
2. Delete generated/, out/ and reports/ at the start of each run, so old files never look like new results.
3. Print the five phase header lines from the contract. Inside probe, plan and generate, print one line per endpoint in the contract format: "<endpointId> OK <detail>" or "<endpointId> FAILED <reason>". The existing [claude] log lines can stay.
4. Probe all endpoints using the existing probe logic. Endpoints with usable false are not planned; they appear in the summary with their failure reason.
5. For usable endpoints, run plan then generate, at most 3 endpoints at the same time. The Claude call counter and the budget check must stay correct when calls run in parallel.
6. Run the generated tests with playwright.generated.config.ts, passing INPUT_FILE set to the input file path so the ctx fixture uses the same file. Stream Playwright's list output to the console as it runs.
7. Write out/summary.json in the exact contract shape, then print a short readable summary.

Findings: for every failed test, read reports/results.json and record endpoint id, test title, type tag from the title, expected status from the plan, actual status from the actual-status annotation, and the first 300 characters of the error with any auth values redacted. Classify it as:
- "suspected API finding" if the actual status is 500 or higher, or if the type is auth or invalid-input and the actual status is 2xx
- "needs review" for anything else
Never classify a test as an API finding without an actual-status value.

Model setting: in agent/claude.ts, if the env variable CLAUDE_MODEL is set, pass it with the model flag from the claude CLI help. If it is not set, keep the current default. Add CLAUDE_MODEL to .env.example with an empty value.

Rules:
- Catch only BudgetExceeded. When it happens: stop generating, run the tests that exist, set status "stopped-budget" and print "STOPPED: budget reached".
- If zero spec files were written, do not run Playwright. Write the summary with status "no-tests", print "NO TESTS GENERATED" and exit with code 1. A run with no tests must never look like a pass.
- A failing generated test does not crash the agent. Exit 0 when the pipeline completed.

Add npm script "agent": "tsx agent/cli.ts".

Verify:
1. Start the local API in the background with npm run api:local. Run npm run agent input/local-shop.json. Paste the full raw output and the full out/summary.json.
   Expected: 5 spec files written, exactly two suspected API findings (create-product with a text price returning 500, delete-product without auth returning 2xx), and every other test passing. If either finding is missing, or any other test fails, tell me why.
2. Validate out/summary.json against ui/CONTRACT.md field by field and list any field that is missing or has the wrong type. Fix until none are left.
3. Stop the local API, start it with npm run api:local:fixed, and run npm run agent input/local-shop.json again. Paste the summary section. Expected: zero findings, all tests pass. Stop the local API.
4. Run npm run agent input/demo-small.json. Paste the summary section. Restful Booker is a shared public server that resets its data, so a random 404 can happen. If something fails, report it with evidence but do not change any expectation to hide it.
5. For every failure marked "needs review" in any run, tell me if it is a GENERATOR BUG or real API behavior, with evidence from reports/results.json.
6. Fix generator bugs only by improving the instructions in plan.ts and generate.ts. Never edit files in generated/ by hand, and never change an expected status to make a test pass. If you changed anything, rerun step 1 once and paste the new summary.
7. Run npm run typecheck and npm run test:template. Expected: no errors, 4 passed.
8. Commit "end to end agent run". If a git remote named origin exists, push. If not, skip the push and say so.
```

**Manual check after Prompt 4:**
1. Run `npx playwright show-report reports/html`. Expected: the report opens in the browser.
2. The only two failed tests should be the text price (500) and delete without a token (success code).

### Prompt 5: deterministic runs and connect the demo UI (next)

```
Read the current code first.

Step 0. Make generated test runs deterministic
- In playwright.generated.config.ts set workers to 1. Generated tests share one live API, so running them in parallel lets one test change data another test is reading.
- Start the local API with npm run api:local:fixed in the background. Run npm run agent input/local-shop.json. Paste the summary section. Expected: 0 findings, 0 failures. Stop the local API.
- Start it with npm run api:local in the background. Run npm run agent input/local-shop.json. Paste the summary section. Expected: exactly the same 2 suspected API findings, all other tests pass. Leave the local API running for step 1.

Step 1. Connect the demo UI
The demo UI already exists in ui/ (server.mjs, index.html). Do not redesign or restyle it. Your job is to connect it to the real agent and prove it works.

1. Add npm script "ui": "node ui/server.mjs".
2. Make sure .gitignore does not ignore ui/, and does ignore input/ui-run.json.
3. Start the UI in the background with npm run ui.
4. With curl:
   - GET http://localhost:3000/api/inputs. Expected: the 3 input files.
   - POST /api/run with body {"json":"{bad"}. Expected: 400 with a message.
   - POST /api/run with {"json": <content of input/local-shop.json as a string>}. Expected: 202.
   - POST /api/run again immediately. Expected: 409, a run is already in progress.
   - Read /api/stream until the done event and paste the last 15 lines.
   - GET /api/summary and paste the findings part. Expected: two suspected API findings.
   - GET /api/spec?name=create-product.spec.ts. Expected: the spec content.
   - GET /api/spec?name=../.env. Expected: 400.
   - GET /report/index.html. Expected: 200.
5. If anything fails, fix the agent side (agent/cli.ts output or summary.json) to match ui/CONTRACT.md. Only change ui/server.mjs if the bug is clearly in the server, and tell me exactly what you changed and why.
6. Stop both servers.
7. Run npm run typecheck and npm run test:template. Expected: no errors, 4 passed.
8. Commit "deterministic runs, connect demo UI". If a git remote named origin exists, push. If not, skip the push and say so.
```

**Manual check after Prompt 5:**
1. Terminal tab 1: `npm run api:local`. Expected: `Local shop API running on http://localhost:4000  (bugs ON)`
2. Terminal tab 2: `npm run ui`. Expected: `API Test Agent UI running on http://localhost:3000`
3. Open http://localhost:3000, keep local-shop selected, click Generate tests.
4. Expected: the four steps turn green in order, the log streams, then a red "2 API bugs found" headline. Click the create-product row to see its code. Click Open Playwright report.
5. Pick demo-small and run it once. Expected: "3 API bugs found" (real Restful Booker bugs).

### Prompt 6: demo polish

```
Read the current code first. Prepare for a live demo. No logic changes.

1. README.md: one paragraph on what the agent does; setup in 4 steps (no API key needed, it uses the logged-in Claude Code CLI); how to run it from the terminal (npm run agent <input file>) and from the UI (npm run api:local, npm run ui, open http://localhost:3000); how to point it at a different API by adding an input file; and the test rules (no hardcoded hosts, no process.env in tests, exact values only for data the test sent, no hiding errors, never expect a 5xx).
2. Start the local API in the background. Run npm run agent input/local-shop.json three times in a row. Paste the findings section from each run. Expected: every run writes 5 spec files and finds the same 2 API bugs. If any run differs, tell me what changed and why. Stop the local API.
3. Commit "demo polish". If a git remote named origin exists, push. If not, skip the push and say so.
```

### Prompt 7: self-repair loop (optional, only with 45 minutes spare)

```
Read the current code first. Add one repair pass after the Playwright run.

- For each generated spec with a failing test where the failure is in the test code itself (TypeScript error, runtime error such as an undefined property, wrong ctx usage), send the spec file and the exact error from reports/results.json to Claude once through agent/claude.ts and ask for a corrected file.
- Run the corrected file through agent/validate.ts. If it passes, replace the spec and rerun only that file.
- Never repair a test classified as "suspected API finding", and never repair a test that failed only on a status or response assertion.
- The repaired file must keep every expected status from the plan. If any expected status changed, reject the repair.
- Max one repair attempt per file. Repair calls count against MAX_CLAUDE_CALLS.
- Add a "repaired" field per endpoint in out/summary.json.

Verify: run npm run agent input/local-shop.json, paste the full summary, and list which files were repaired and why. Commit "one-pass self repair". If a git remote named origin exists, push.
```

---

## 7. Demo script (about 4 minutes)

**Before presenting:**
1. Terminal tab 1: `npm run api:local` (bugs on).
2. Terminal tab 2: `npm run ui`, open http://localhost:3000.
3. Run demo-small once in the UI (Restful Booker real bugs). Take a screenshot of the results, then save its report before the next run deletes it: `cp -R reports/html ~/Desktop/restful-booker-report`. To show it on stage: `npx playwright show-report ~/Desktop/restful-booker-report`.
4. Then run local-shop once, so "Load last run" has real data as a backup.
5. Record a backup video of a full run (QuickTime Player, File, New Screen Recording).

**On stage:**
1. **The problem (30s):** API tests are repetitive; coverage depends on time.
2. **The input (20s):** show the local-shop endpoint list. "This is all the agent gets."
3. **Run it (60 to 90s):** click Generate tests. Narrate: probe calls the real API, Claude plans cases, Claude writes Playwright specs, a static gate rejects anything unsafe, Playwright runs them.
4. **The result (40s):** "2 API bugs found". Point at each: text price returns 500 instead of 400; delete works without a token.
5. **Real bugs, not planted (40s):** "Those two were planted. Here is the same agent on Restful Booker, a public API." Show the earlier demo-small result: 3 real bugs. Missing firstname returns 500, totalprice sent as text returns 200 and saves null, missing bookingdates returns 500.
6. **The code (20s):** click create-product, show a generated test. Point at the tags and the honest status checks.
7. **The report (20s):** open the Playwright report.
8. **Optional ending (40s):** stop the API, run `npm run api:local:fixed`, run again, show "No API bugs found".
9. **Close (20s):** "Same framework as our UI tests. Next: OpenAPI import and CI."

**If the live run stalls:** click "Load last run" or play the backup video.

---

## 8. Known risks

| Risk | Mitigation |
|---|---|
| Restful Booker resets its data, causing random 404s | Not used live. Probe retries non-2xx once, then refuses to plan |
| Claude usage limit hit during the day | Set `CLAUDE_MODEL` in .env to a lighter model; each full run is about 10 calls |
| Live run slow on stage | 3 endpoints in parallel (about 1 minute); "Load last run"; backup video |
| Commits only on the laptop | Create the GitHub repo and push (section 5) |
| Network at the venue | The local shop API and UI need no internet; only the Claude calls do |
