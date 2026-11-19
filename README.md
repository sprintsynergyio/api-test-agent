# API Test Agent

[![CI](https://github.com/sprintsynergyio/api-test-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/sprintsynergyio/api-test-agent/actions/workflows/ci.yml)

Give the agent a base URL and a list of API endpoints, and it writes an API test suite in Playwright or Pactum, runs it, and reports suspected API bugs. It first calls each endpoint once to see how the API really responds. Then a model (Claude or OpenAI) plans the test cases (happy path, response schema, invalid input, missing auth, wrong role) and writes one spec file per endpoint. Each file must pass a static gate before it is kept. The suite runs and every failure is classified. The result is a standalone test project you can download and run anywhere.

API Test Agent is a SprintSynergy product, built and maintained by [SprintSynergy](https://sprintsynergy.com).

**New to the repo? Team setup: see [docs/TEAM-SETUP.md](docs/TEAM-SETUP.md).** Clone, `npm ci`, `npm run ui`, then either paste a model API key once or use your Claude Code login, and run.

## What it does today

- Two output frameworks: Playwright (TypeScript) and Pactum (Mocha). Same plan, same gate, same findings.
- Importers: OpenAPI or Swagger, Postman, cURL, HAR, ticket text. Credentials are dropped on import.
- Inputs for real APIs: nested paths with several ids, query parameters, per-endpoint headers, and a profile block for environments, brands and regions (`--select env=staging,brand=alpha,region=eu`), so one export serves every combination.
- Auth: fixed header, API key in the query string, cookie, or a login call that fetches a token (cached, refreshed once on 401), plus extra roles for permission tests (`[authz]`).
- Prompt safety: API responses, imported specs and ticket text go to the model inside marked untrusted-data blocks with an instruction to treat them as data only, and the test process never sees the model provider keys (`.env` is parsed into a private object, only the auth variables the input names are used).
- Redaction before anything reaches the model: emails, phones, card numbers, tokens, IPs and secret-looking fields are replaced; optional field list and a strict mode that keeps only the shape. UUIDs are ids, not personal data: a fixed test value such as `00000000-0000-0000-0000-000000000000` reaches the plan and the tests unchanged (credential-named fields and headers are still hidden whatever they hold).
- Test data cleanup: after each test (and after the probe), the records it made through `ctx.createResource` / `ctx.setup`, and its own 2xx POSTs, are deleted through the same guarded client, when the input has a DELETE for them (matched by path, or `setup.cleanup`). Without one they are counted as `no delete endpoint`, and a DELETE that fails is counted as `failed`, in `summary.json` `cleanup`; nothing is hidden, but nothing is retried either.
- Production safety guard: production hosts are refused unless you say so, and then run read-only. Local, private and `staging`-style hosts run in full. Loopback (127/8), link-local (169.254/16), CGNAT (100.64/10) and private IPv6 count as local; a host name is also resolved, and one that points at a local address never gets looser rules by DNS.
- Model providers: Claude (API key or your Claude Code login) or OpenAI. Set once from the UI on your own machine.
- Eval harness: a local demo API with planted bugs and `npm run eval` to measure detection, false alarms and flakiness per provider.
- Hosted mode for a shared server: login, per-user runs, rate limits, local hosts refused. See [docs/HOSTING.md](docs/HOSTING.md).
- Showing it to someone: [docs/DEMO.md](docs/DEMO.md).
- Plan and open items: [docs/ROADMAP.md](docs/ROADMAP.md). Rules for changing the code: `CLAUDE.md`.

## Requirements

- Node 22 or newer, on macOS, Windows or Linux. CI runs every offline suite and a full end-to-end run on all three (Node 22 and 24).
- A Claude or OpenAI API key, or a Claude Code login, if you want the agent to generate tests. Typechecking, the offline test suites and the hand-written template tests do not need a key. See [Model providers](#model-providers) for which one is used when several are set and what each costs.

## Setup

1. Install Node 22+.
2. `npm ci` (Playwright browsers are not needed, the tests only use Playwright's API client).
3. Start the UI (`npm run ui`, http://localhost:3000). The first screen asks for a Claude or OpenAI API key, checks it, and saves it to `.env` on your machine. If Claude Code is installed and logged in, no key is needed and the card does not appear (see [Use Claude Code instead of an API key](#use-claude-code-instead-of-an-api-key)).
4. `cp .env.example .env`. `.env` holds the auth values your input files name; `.env.example` already has the public demo values (`API_AUTH_VALUE` for Restful Booker's documented admin login, `LOCAL_API_AUTH_VALUE` for the local shop API), so the demos work as they are. `MAX_CLAUDE_CALLS` caps model calls per run (default 60, about 2 per endpoint; `--budget N` overrides it for one run). `LLM_MODEL` is optional and applies to the API key and the Claude Code paths. Model calls that get HTTP 429 or a 5xx are retried with backoff (`MODEL_RETRIES`, default 3).
5. Check it works: `npm run typecheck` and `npm run test:template` (4 tests against Restful Booker).

## Use Claude Code instead of an API key

You can run the agent with your Claude Code login. No API key is needed.

You need a paid Claude plan (Pro, Max, Ultra, Team or Enterprise) or a Claude Console account. The free Claude plan does not include Claude Code. Each person uses their own login; do not share an account. Usage counts against that person's plan.

1. Install the official Claude Code CLI (Node 22 or newer; do not use `sudo`):

```
npm install -g @anthropic-ai/claude-code@latest
```

2. Check the install:

```
claude --version
```

Expected: a version number followed by `(Claude Code)`, for example `2.1.211 (Claude Code)`. If you see `command not found` or `'claude' is not recognized`, close the terminal completely, open a new one, and try again. On Windows, add npm's global folder to your PATH (usually `%AppData%\npm`) and open a new terminal. See [Anthropic's setup guide](https://code.claude.com/docs/en/setup) if it still fails (that page also has a native installer).

3. Sign in once:

```
claude
```

On first use, Claude Code opens a browser window. Sign in with your Claude account. If the browser does not open, press `c` to copy the login URL and paste it into a browser. If the browser shows a login code instead of returning to the terminal, paste that code at the prompt. When the terminal says `Login successful`, press Enter, then type `/exit` to leave. (Later, `/login` inside a Claude Code session signs you in or switches accounts.)

4. In this repo's `.env`, make sure `ANTHROPIC_API_KEY` has no value. A key in `.env` wins over the login, and `LLM_PROVIDER=openai` always uses OpenAI instead.

5. From the repo folder, run `npm ci` (if you have not already) and `npm run ui`, then open http://localhost:3000. The key card should not appear, and the header should say `Claude via Claude Code login`. If you started the UI before installing or signing in, stop it (Ctrl+C) and start it again: the CLI is checked once at startup.

To switch back to an API key, click **Change** next to the model name at the top of the page, paste the key, and save. The header should then say `via API key`.

A shared or hosted server cannot use a personal Claude Code login; it needs an API key. See [docs/HOSTING.md](docs/HOSTING.md).

## Run it

### From the terminal

```
npm run api:local                      # local shop API on http://localhost:4000 (two planted bugs)
npm run agent input/local-shop.json    # any input file works
```

Flags after the input file (use `npm run agent -- <input> <flags>`):

| Flag | What it does |
|---|---|
| `--resume` | continue the last run of the same input from `out/checkpoint.json`: probes, plans and specs already made are reused, only the rest costs model calls. A run that stopped at the budget prints `stopped at budget: run again with --resume to continue` |
| `--only-new` | after you change the input file, regenerate only the endpoints whose definition changed (id, method, path, body, query, headers, setup); the rest is kept and every spec runs |
| `--endpoints a,b` | restrict the run to these endpoint ids |
| `--budget N` | model calls allowed in this run (overrides `MAX_CLAUDE_CALLS`, default 60) |
| `--concurrency N` | plans and generations in flight at once (default 3, max 8) |
| `--test-workers N` | Playwright workers for the test run (default 1: the tests share one live API, so data-dependent tests may need 1; Pactum runs one at a time and says so) |
| `--select k=v,...` | pick the profile dimensions (see Profiles) |

The agent prints five phases (PROBING, PLANNING, GENERATING, RUNNING TESTS, SUMMARY) and writes:

- `generated/<endpointId>.spec.ts`: the generated tests
- `reports/html/`: the Playwright HTML report
- `reports/allure-report/`: the Allure 3 report (no Java needed), with every request and response attached and the auth header redacted. Open it with `npm run allure`.
- `out/summary.json`: totals, per-endpoint results and findings
- `frameworks/<name>/` and `out/framework.zip`: the standalone project (see below)

### From the UI

```
npm run api:local
npm run ui            # then open http://localhost:3000
```

- **Saved** tab: pick an input file from `input/` (or edit its JSON) and click **Generate tests**. Inputs with a profile get one dropdown per dimension; the page shows which `.env` variables the auth section reads. The log streams live, then the page shows the findings with their request and response evidence (**Copy as Jira ticket**, **Copy as Markdown**), the generated code, **Open Playwright report**, and **Download framework (.zip)**. **Recent runs** keeps the last 20.
- **Build** tab: enter a name, base URL, auth (header, query parameter, cookie or a login call, plus optional roles for permission tests) and endpoints in a form. A header, query or cookie value typed here is passed to that one run through an environment variable and is never written to disk; login credentials and role values are read from `.env`. **Save as input file** stores the config (without any auth value) in `input/<name>.json`.
- **Import** tab: pick a **Source** to import the endpoints (see Importers).
- **Run options**: the framework (Playwright or Pactum), redaction (standard or strict, plus extra fields to hide), and an optional **Test cases** sheet to automate (see Test case sheets).

### Exit codes

`npm run agent` exits with a code a CI pipeline can act on, in the same style as the other SprintSynergy tools:

| Code | Meaning |
|---|---|
| `0` | The run completed and nothing fails it: no failed tests, or `--fail-on none`. Skipped tests and known issues that failed as expected do not fail the run unless you ask for it (below) |
| `1` | Findings: at least one failed test (a suspected API finding or a failure that needs review) or an unexpected pass (a known issue whose test passed), with `--fail-on finding` (the default). With `--fail-on skipped`, also any test or sheet case that did not run (skipped, blocked, manual) |
| `2` | Tool or setup error: bad input or flags, a refused host, no model set up, no tests generated, a budget stop, an endpoint that could not be tested, a failed framework export, or a crash |

`--fail-on none` still reports every finding in the console and `out/summary.json`; only the exit code changes.

**CI policy for skips.** By default a skipped or blocked test does not fail the pipeline, but it is never
counted as passed: the console, `out/summary.json` (`totals.skipped`, `skippedTests`), the traceability
files and the dashboard show every one with its reason code. Use `--fail-on skipped` in the pipeline that
must prove full coverage (for example the release gate), and the default `--fail-on finding` for nightly
runs against shared environments where some data comes and goes. Known issues that fail as expected
never fail the run; when one starts passing the run fails (exit 1), so someone closes the bug and removes
the marker.

`out/summary.json` is written before the framework export and holds `exitCode`, `failOn` and, when the export failed, `frameworkError`, so a failed export never loses the results.

## Importers

Instead of writing the input file by hand, import the endpoints from something you already have. In the UI: **Import** tab, **Source**. From the terminal (prints `{ input, skipped, warnings }` as JSON; save `input` as an input file):

```
npm run -s import postman < collection.json
```

| Type | Source |
|---|---|
| `postman` | Postman collection v2.0 or v2.1: nested folders, collection variables, auth blocks |
| `openapi` | OpenAPI 3.x or Swagger 2.0, JSON or YAML. The body comes from the example, else from the schema's required fields |
| `curl` | One or more curl commands pasted together |
| `har` | A browser network capture (Save all as HAR). Requests are grouped by method and path, ids become `{id}` |
| `text` | A Jira ticket or Confluence page. Claude extracts the endpoints (at most 2 calls, not counted in the run budget) |

- **Nothing is dropped silently.** Every request becomes an endpoint or a skipped entry with a reason: another origin than the base URL (the most common origin), an unresolved variable in the URL (`{{baseUrl}}` with no value, `$VAR`), a non-JSON body, or a method other than GET, POST, PUT, PATCH, DELETE. In a HAR file, static assets, analytics and other origins are counted in one "filtered: not an API call" entry. From text, a base URL, path or body field that is not in the text is dropped.
- **Auth.** Every credential is removed: Authorization, Cookie, any header whose name contains auth, token, key, secret or session, Postman auth blocks, curl `-u` and `-b`, credential query parameters, and `user:password@` in URLs. Those endpoints get `requiresAuth: true`, and the input gets `auth: { header, valueEnv: "CUSTOM_API_AUTH" }`. Enter the value in the auth field before running. Credential values never appear in the output, warnings or errors.
- Ids are slugs of the method and path (`get-products-id`). Path params (`:id`, `{{id}}`, `{id}`) become `{id}`. A path with a placeholder gets `setup` from the POST on its parent path; check its `idField`.
- **Grouped by route.** Requests to the same route with different values in the path become one endpoint: `/products/42` and `/products/7` become `/products/{productId}`, `/asset/fabletics/badge` and `/asset/savage/badge` become `/asset/{asset}/badge` (only a middle segment, never the first or last word). The first recorded value goes to `pathParams` (for example `{ "productId": "42" }`) so the probe can call it without a setup step, and the warnings say what was grouped. Sheet cases can still use their own ids. Paths with no value segment stay separate. Code that calls `buildInput` can pass `groupRoutes: false` to keep every literal path.
- A missing or relative base URL leaves `baseUrl` empty, and Generate stays disabled until you fill it in.
- **Big imports.** Every imported endpoint is selected. Each costs about 2 model calls of the 60-call budget; above 50 endpoints the preview shows the estimate. A run that stops at the budget is continued from the terminal with `--resume` (see Run it).
- Acceptance criteria in a ticket are not turned into tests yet.

## Test case sheets

Already have manual test cases in a spreadsheet? The agent automates exactly those: one test per row,
named `[TC-ID] [type] Title`, so every result maps back to the sheet.

In the UI: **Run options**, **Test cases**, then **Upload CSV or Excel** (or **Paste instead** and paste
rows copied from Excel or Google Sheets). The preview shows how the columns were read, the row count and
a warning per row (missing ID, unknown endpoint). **Download template CSV** gives a starting sheet.
From the terminal:

```
npm run agent -- input/local-shop.json --test-cases input/local-shop-test-cases.csv --test-cases-mode sheet-only
```

or put it in the input file: `"testCases": { "file": "local-shop-test-cases.csv", "mode": "sheet-plus-agent" }`
(the path is relative to the input file; see `input/local-shop-sheet.json`).

- **Formats.** `.csv`, `.tsv`, `.txt` (comma, semicolon or tab), and `.xlsx` (the first sheet). Old `.xls`
  files are refused; save as `.xlsx` or `.csv`.
- **Columns** are matched by name, ignoring case and punctuation: **ID** (`Test Case ID`, `TC ID`, `Key`,
  `Issue key`, ...), **Title** (`Summary`, `Name`, `Scenario`, ...), **Steps / Request** (`Steps`,
  `Request`, `Description`, `Action`, ...), **Expected Result** (`Expected`, `Expected Outcome`, ...), and
  optional **Endpoint**, **Method**, **Priority**, **Preconditions**, **Test Data**, **Known issue**,
  **Required data** and **Automation** (see [Statuses, skips and known issues](#statuses-skips-and-known-issues)). Other columns are
  ignored and listed. Step-per-row exports (Xray, Zephyr) work: a row with no ID and no title continues the
  case above.
- **Endpoint matching.** The Endpoint column first (an endpoint id, `GET /products/{id}`, a path or a URL),
  then a `METHOD /path` line in the steps, then the model (one call per 25 unmatched cases, counted in the
  run budget). A case that matches nothing is reported as **not automated** with the reason, never dropped.
- **Modes.** **My test cases + agent suggestions** (default, `sheet-plus-agent`): your cases, plus the
  agent's own cases for what the sheet does not cover, titled `[agent] [type] ...`; suggestions that repeat
  a sheet case are dropped. **Only my test cases** (`sheet-only`): exactly one test per row and nothing
  else. The agent adds no tests of its own (the summary shows `agentSuggestions: 0`), and only the
  endpoints your rows name are probed and tested. The UI says which mode is on under the toggle; from the
  terminal use `--test-cases-mode sheet-only` or `"mode": "sheet-only"` in the input.
- **The rules still apply.** Every test passes the static gate. A case whose steps or expected result are
  too vague, that expects a 5xx, or that contradicts what the API answered when probed (for example the
  sheet says 201 and the API returns 200) is not guessed at: it becomes a test marked **needs review**
  (`test.fixme` in Playwright, a pending test in Pactum) with the reason. It never runs and never passes,
  and it does not change the exit code.
- **Skipped, blocked, manual and known issues.** See [Statuses, skips and known issues](#statuses-skips-and-known-issues).
- **Expected results are read clause by clause.** "Response is 400 or 404 JSON error, not 500 or 502"
  expects 400 or 404 (the test asserts the status is one of them) and rules out 500 and 502; codes after
  *not*, *never*, *must not be*, *instead of* or *other than* are never read as expected. Each clause
  (split on lines, semicolons and sentences) must map to an assertion in the test. When a test passes but
  some clause has no assertion (for example "items are sorted by name"), the case is **partially
  covered**, never passed, and the reason lists the missing clauses. When the probe response contradicts
  a clause (the sheet says `download_url` contains `/cdn/`, the API returns `/files/...`), the case is
  **needs review** with expected and actual.
- **Which case types an endpoint gets.** happy and schema always; invalid-input when the endpoint has a
  request body, a path id, a 4xx response documented in its OpenAPI spec, `"allowInvalidInput": true`, or a
  sheet case that expects a 4xx (other than 401/403); auth when it requires auth; authz when there is
  another role. A case of a type the endpoint does not allow is **needs review** with that rule and how to
  turn the type on. See [Test rules](#test-rules) for images, paging and cross-call checks.
- **Traceability.** `out/traceability.csv` and `out/traceability.xlsx` list every row with ID, Title,
  Endpoint, Test file, Status (passed, partially covered, failed, needs review, not automated, skipped,
  manual, blocked, known issue, unexpected pass), Reason code, Coverage, Reason, Jira and Confluence, followed by the agent suggestions. Test file is blank when no runnable test
  automates the case (needs review, dropped by the static gate, not automated). Coverage is how many
  clauses of the case's expected result a test assertion checks (`2/3 (66.7%)`). Reasons are never
  shortened. Jira and Confluence come from sheet columns of that name (`Jira`, `Jira link`, `Story`,
  `Confluence`, `Confluence page`, ...; a `Jira key` column stays the case ID), or from the import: each
  Jira issue's browse link, the Confluence page a case was read from, the Zephyr Scale key. The summary and
  the UI show the overall **assertion coverage**: of all the clauses in the sheet's expected results, how
  many a test checks (cases without a test count as not checked). The UI shows the same table with download buttons, `out/summary.json` has `testCases`, the
  Allure report labels each test with its case ID (`caseId` and a tag), and the exported framework and zip
  include `traceability.csv`.
- **Limits.** 5 MB, 1000 test cases, 100 columns and 4000 characters per cell. Excel files are read for
  their stored values only: formulas are never run, links never followed.
- **Jira and Confluence links.** See the next section: paste a link instead of exporting a file.

### Statuses, skips and known issues

A test that did not run, or that failed for a bug the team already knows about, is never shown as passed
and never hidden. Every such case has a status and a **reason code**:

| Status | Reason code | When |
|---|---|---|
| skipped | `MISSING_TEST_DATA` | The case uses a placeholder like `[OTHER_BRAND]` and the test data file has no value for it |
| manual | `MANUAL` / `MANUAL_VISUAL` | The **Automation** column says manual (`Manual`, `Manual - visual check`, ...). Visual checks get `MANUAL_VISUAL` |
| blocked | `DATA_NOT_ON_ENV` | The **Required data** is not on the environment: the test checked before it ran and skipped itself |
| blocked | `ENV_UNAVAILABLE` | The data lookup could not answer (no connection, 401, 403, 429 or a 5xx) |
| needs review | `SPEC_UNCLEAR` (or none) | Steps or expected result too vague, or they contradict the API |
| known issue | `KNOWN_ISSUE` | The **Known issue** column names a Jira bug and the test failed as expected |
| unexpected pass | `KNOWN_ISSUE` | The known issue's test passed: the bug may be fixed. This is a finding (needs review, exit 1) |

- **Known issue column** (`Known issue`, `Known bug`, `Bug`, `Defect`, ...): a Jira key and an optional note,
  for example `SHOP-8: delete does not check the token`. A cell without a Jira key is ignored with a
  warning and the case runs as a normal test. The agent then writes the test with the correct expected
  status (401 here) and marks it as expected to fail (`test.fail(...)` in Playwright, `knownIssue(...)` in
  Pactum). Known issues come only from this column: the model can never mark a test as a known issue.
- **Required data column** (`Required data`, `Required files`, ...): names separated by `;`, `,` or new
  lines (`Summer Hat (seasonal); Classic Tee`). Before the test runs it asks the environment, with the
  lookup endpoint from the test data file, and skips itself as **blocked** (`DATA_NOT_ON_ENV`) when a name
  is not in the answer. The lookup is always a GET.
- **Automation column**: a case marked manual is listed as **manual** and never generated.
- **Test data file**, one per environment (`input/local-shop-test-data.json`):

  ```json
  { "environment": "local", "values": { "CATEGORY": "tops" }, "lookup": { "endpointId": "list-products" } }
  ```

  `values` fill the `[PLACEHOLDER]` names (upper case, 3 or more characters) in the steps and expected
  results; `lookup` names a GET endpoint of the input (and an optional `query`) used for Required data.
  Give it with `--test-data input/staging-test-data.json` or `"testData": "staging-test-data.json"` in the
  input file. Keep no secrets in it. The exported framework includes it as `config/test-data.json`
  (point `TEST_DATA_FILE` at another file to run the same tests against another environment).
- **Where you see them.** The console lists each skipped test and known issue with its reason. The
  dashboard has **Skipped** and **Known issues** tiles next to Passed and Failed, and lists each one with
  its code and reason under the findings. `out/summary.json` has `totals.skipped`, `totals.knownIssues`,
  `totals.skippedByCode`, `skippedTests` and `knownIssues` (see `ui/CONTRACT.md`). Allure tags known
  issues `known issue` with a link to the Jira key.
- **The model cannot skip.** The static gate still rejects `test.skip`, `test.fixme`, `test.fail`,
  `this.skip()` and the markers above in model-written code. The agent adds the markers itself, after the
  gate, only from the sheet columns and the test data file.

Try it: `npm run agent -- input/local-shop-statuses.json` (seven cases, one of each status).

### The sheet decides the expected status

The probe (one real call per endpoint before planning) only shows what a response looks like: its fields,
types and headers. The status a test expects comes from your sheet:

- **The sheet's status wins.** When a row says `201 Created` and the probe saw `200`, the test still
  expects 201. The run shows who is right: if the API answers 200 the test fails as **needs review**, and
  the console and dashboard list a **probe warning** before the run (`the sheet expects 201; the API
  answered 200 when probed`). A row with no status code uses the probe's 2xx.
- **A probe that does not work no longer blocks your cases.** When the probe of an endpoint fails (a 404
  because the id in the config does not exist, a 503 maintenance page), the endpoint is still planned from
  the sheet with the statuses it names, and the console prints `<endpoint> WARNING probe not usable (404):
  planning the team's cases from the sheet, with the statuses it names`. Without sheet cases the endpoint
  is skipped as before.
- **Cases with their own ids get their own probe.** A row whose steps name a literal path
  (`GET /products/1`, `GET /products/999999`) runs against exactly that path, and the agent sends one
  extra GET for it before planning (`case probes: ...` in the console, `out/probes/<id>.cases.json`). At
  most 20 per run (`--case-probes N`, 0 turns them off). Writes (POST, PUT, PATCH, DELETE) are never
  probed, and neither is a case whose path needs a setup step.
- **A 5xx only when you documented it.** A test never expects a 5xx unless the row says so: a
  `Documented 5xx` column (any value except `no`, `-`, `n/a`; write where it is documented, for example
  `ops runbook 3.1`) or the tag `@documented-5xx` anywhere in the row. Then the test expects exactly that
  code and, when it passes, shows as **accepted 5xx** (not a finding). The same 503 without the column is
  **needs review** with the reason.

Try it: `npm run agent -- input/local-shop-probes.json` (a wrong 201, an unusable probe, cases with their
own ids, a write that is not probed and a documented 503 from `GET /maintenance` on the local API).

### Test cases straight from Jira, Confluence, Xray or Zephyr Scale

Instead of exporting a sheet, paste a link. The agent reads the cases live, read-only, with your own
Atlassian account, and everything above (column matching, preview, modes, needs review, traceability)
works the same way.

| You paste | What is read |
|---|---|
| A Jira issue link (`.../browse/QA-12`) | that issue |
| A Jira saved filter link (`.../issues/?filter=10001`) or a search link (`...?jql=...`) | every issue it finds |
| JQL, e.g. `project = QA AND issuetype = Test` (or `jql: ...`) | every issue it finds |
| A Confluence page link (`.../wiki/spaces/QA/pages/12345/...`) | the test case table(s) on the page |
| `zephyr: QA-T1, QA-T2`, `zephyr: project = QA`, or a Zephyr Scale test case link | Zephyr Scale test cases with their steps |

**Set up once (per person).** In the UI open **Run options**, **Test cases**, **Jira or Confluence link**,
then **Connect Jira and Confluence**: your site address (`https://your-team.atlassian.net`), your Atlassian
email, and an API token from <https://id.atlassian.com/manage-profile/security/api-tokens> (choose
**Create API token**, the plain one, not "with scopes": scoped tokens only work through Atlassian's API
gateway). **Check and
save** signs in once to check them, then writes them to `.env` on your machine; the token is never shown
again. Or put them in `.env` yourself:

```
ATLASSIAN_BASE_URL=https://your-team.atlassian.net
ATLASSIAN_EMAIL=you@company.com
ATLASSIAN_API_TOKEN=<token>
# optional: Xray Cloud test steps (Jira > Apps > Xray > API Keys)
XRAY_CLIENT_ID=
XRAY_CLIENT_SECRET=
# optional: Zephyr Scale Cloud (profile picture > Zephyr API keys)
ZEPHYR_API_TOKEN=
```

Data Center / Server: `ATLASSIAN_BASE_URL` is your Jira address (with its context path, e.g.
`https://jira.company.com/jira`), leave `ATLASSIAN_EMAIL` empty and put a personal access token in
`ATLASSIAN_API_TOKEN` (sent as a bearer token), and set `CONFLUENCE_BASE_URL` when Confluence has its own
address. `ATLASSIAN_DEPLOYMENT=cloud|datacenter` overrides the automatic choice (`*.atlassian.net` is Cloud).

From the terminal:

```
npm run agent -- input/local-shop.json --test-cases "https://your-team.atlassian.net/issues/?filter=10001"
npm run agent -- input/local-shop.json --test-cases "project = QA AND labels = api" --test-cases-mode sheet-only
```

or in the input file: `"testCases": { "link": "https://your-team.atlassian.net/browse/QA-12" }`.

How each source becomes rows:
- **Jira** (Cloud: `GET /rest/api/3/search/jql`, paged with `nextPageToken`; Data Center:
  `/rest/api/2/search`). Key becomes ID, Summary becomes Title, the description (rich text turned into plain
  text) becomes the steps, and a line or heading starting with "Expected result" splits off the expected
  result. Custom fields whose names match a column (Expected Result, Endpoint, Method, Test Data,
  Preconditions, Steps) are used automatically.
- **Xray.** For issues of type Test: Xray Cloud through its GraphQL API (`XRAY_CLIENT_ID` and
  `XRAY_CLIENT_SECRET`), Xray Data Center through its REST API with the Jira token. Steps, data and expected
  results are numbered; Gherkin and generic tests use their definition. Without Xray credentials on Cloud
  the description is used and the preview says so.
- **Zephyr Scale.** Cloud through `api.zephyrscale.smartbear.com/v2` with `ZEPHYR_API_TOKEN`; Data Center
  through `/rest/atm/1.0` with the Jira token. Name, objective, precondition and step-by-step scripts.
- **Confluence** (Cloud: `GET /wiki/api/v2/pages/{id}?body-format=storage`; Data Center:
  `/rest/api/content`). Every table on the page whose header row has a Title or Steps column is read; other
  tables are skipped and listed.

Safety and limits: only the configured Atlassian site (and the Xray and Zephyr Scale API hosts) is ever
called, so a link to any other host is refused before a request; redirects are not followed; HTTPS only
(plain http only for `localhost`); read-only requests; 1000 cases, 100 results per page, 10 MB per
response; HTTP 429 and 503 are retried up to 3 times after `Retry-After` (at most 60 s). 401, 403 and 404
come back as plain messages that say what to check. Tokens never appear in messages, logs, the summary,
the generated tests' environment or the export. The ticket and page text is treated as untrusted data in
every prompt, like a sheet.

Not included yet: Zephyr Squad (the older Zephyr for Jira), Confluence short links (`/x/...`, open the page
and copy the full link), pages behind SSO-only Data Center sites that reject tokens, and writing results
back to Xray or Zephyr test executions. Try it offline with `npm run mock:atlassian` (a fake Atlassian
site with sample cases; it prints the `.env` lines to use).

## What you get

`frameworks/<name>/` is a standalone Playwright project (also downloadable as a zip from the UI):

```
<name>/
  package.json            npm test, npm run report (pinned Playwright, dotenv, TypeScript)
  playwright.config.ts    tests/, 1 worker, list + html reporters, loads .env
  config/api.json         base URL, headers and endpoints (no auth values)
  src/http.ts             API clients and createResource
  tests/fixtures/ctx.ts   the ctx fixture, the only file that reads process.env
  tests/<endpoint>.spec.ts
  .env.example            the auth variable to fill in
  README.md               coverage table, how to run, findings from the generating run
```

It never imports from this repo. Copy it anywhere, `npm install`, fill in `.env`, `npm test`.

**Font.** The UI and the HTML reports from an agent run (the Playwright report in `reports/html` and the
Allure report) use Calibri: `Calibri, Carlito, 'Segoe UI', Arial, sans-serif`. Calibri is not licensed for
the web, so no font file is bundled; on machines without it, Carlito (the free font with Calibri's exact
widths, `fonts-crosextra-carlito` on Linux) keeps the layout the same, then Segoe UI or Arial.

## Point it at another API

Write an input file (or use the Build tab in the UI):

```json
{
  "name": "my-api",
  "baseUrl": "https://api.example.com",
  "defaultHeaders": { "Accept": "application/json", "Content-Type": "application/json" },
  "auth": { "header": "Authorization", "valueEnv": "MY_API_AUTH" },
  "endpoints": [
    { "id": "list-items", "method": "GET", "path": "/items", "requiresAuth": false },
    { "id": "create-item", "method": "POST", "path": "/items", "requiresAuth": true,
      "body": { "name": "Example", "price": 10 } },
    { "id": "delete-item", "method": "DELETE", "path": "/items/{id}", "requiresAuth": true,
      "setup": { "endpointId": "create-item", "idField": "id" } }
  ]
}
```

- `name` is optional (lowercase letters, numbers, dashes). It names the framework folder; the default is the input file name.
- `auth` is optional. The file only names the environment variable; put the value in `.env`. Without `auth`, no endpoint may have `requiresAuth: true`.
- `body` is the sample request body used for the happy path.
- `setup` means: before calling this endpoint, call `endpointId` with its sample body, read `idField` from the response, and put it into the path placeholder (`{id}`).
- `baseUrl` may have a path (`https://api.example.com/media/v1`). Endpoint paths are joined to it, so `/photos` calls `https://api.example.com/media/v1/photos`, in the probe, the generated tests and the exported framework, on every OS.
- `query` is the sample query string (`{ "page": 1, "per_page": 10 }`).
- `errorStatuses` (optional, 400-499): the 4xx codes the API documents for this endpoint. The OpenAPI importer fills it in. It turns on invalid-input tests.
- `allowInvalidInput: true` (optional): invalid-input tests for an endpoint with nothing else to make invalid, such as a query-only GET (bad page or filter values). Same as `--allow-invalid-input <ids>` or **Run options > Test options > Invalid-input tests** in the UI.
- `pathParams` (optional): fixed values for path placeholders no `setup` step fills, for example `"pathParams": { "id": "42" }` for `/products/{id}`. The importers write it for grouped routes. A setup value wins over it.
- `stableData: true` (optional): the endpoint's data does not change during the run, so tests may compare several calls (paging, totals). Same as `--stable-data <ids>` or **Test options > Stable data** in the UI. Read-only GET endpoints get this automatically when nothing in the run writes the same resource.

Then run `npm run agent path/to/my-api.json`.

## Model providers

| `.env` | Effect |
|---|---|
| nothing set, Claude Code logged in | the agent calls the `claude` CLI with your login (no API cost beyond your plan) |
| `ANTHROPIC_API_KEY=sk-ant-...` | Claude through the Messages API, billed to that key; `LLM_MODEL` picks the model (default `claude-sonnet-5-5`) |
| `LLM_PROVIDER=openai` and `OPENAI_API_KEY=sk-...` | OpenAI through Chat Completions; `LLM_MODEL` picks the model (default `gpt-6.1-sol`) |

Which one wins when several are set: `LLM_PROVIDER=openai` always selects OpenAI (and requires `OPENAI_API_KEY`). Otherwise an `ANTHROPIC_API_KEY` beats the Claude Code login, and the login is used only when no key is set. The agent prints `model: <provider> <model> (API key|Claude Code login)` at the start of every run, so the choice is never silent.

Cost: a run on a 5-endpoint API makes about 10 model calls (two per endpoint, plus one retry each when the static gate rejects a spec), roughly 70 thousand input and 10 thousand output tokens. With a Claude or OpenAI key that is a few cents per run; with the Claude Code login it counts against your plan. `MAX_CLAUDE_CALLS` caps the calls per run.

The UI's setup card writes these lines for you. The prompts were tuned against Claude; use `npm run eval -- --provider openai` to see the detection table for OpenAI before standardising on it.

## Test rules

Every generated spec must pass the static gate (`agent/validate.ts`) before it is kept. The gate runs inside the GENERATING phase, right after the model returns a spec and before anything is written to `generated/`: it checks the rules below and runs a TypeScript typecheck on the candidate. If it fails, generation is retried once with the reasons. If it fails again, only the tests the gate rejected are dropped and the rest of the file is kept (`OK written ... (2 tests dropped by the static gate, the rest kept)`); each dropped case is **not automated** with its own reason. Only a problem with the file itself (a forbidden import, code outside the tests) rejects the whole spec, and then the console shows `FAILED static gate: <reasons>` for that endpoint, with each sheet case still getting its own reason. The same name is used in the code, the console output and this document.

- No hardcoded hosts: paths are relative, and the base URL comes from the fixture.
- Expected status: the sheet's code when it names one (a 5xx only when the row is a documented 5xx, then exactly that code), else the probe's 2xx; see The sheet decides the expected status.
- No `process.env` in tests: everything comes from the `ctx` fixture.
- Assert status codes, field presence and field types. Assert exact values only for data the test itself sent.
- Nothing hides errors: no `test.only`, no `test.skip`, no empty or swallowing `catch`, no `.catch()`.
- Generated code is untrusted: the only import allowed is the ctx file, and the gate rejects `require`, dynamic `import()`, `eval`, `Function`, `process`, `globalThis`, `fetch`, Node built-in modules (`child_process`, `fs`, `net`, `http`, ...) and any Playwright fixture other than `ctx`. Every request goes through `ctx`, so the safety guard sees it.
- Never expect a 5xx. A 5xx on bad input fails the test, and that is reported as a suspected API bug. Expectations are never changed to match a bug.
- Every test title starts with its type (`[happy]`, `[schema]`, `[invalid-input]`, `[auth]`), records the real status before asserting, and the file must typecheck.
- Response format: when a sheet case's expected result names one (`Content-Type application/json`, `a JSON error`, `plain text`, `image/png`), the test asserts the Content-Type header (`toContain('json')` for any JSON type, else the media type), and a test for a format that is not JSON never calls `response.json()` (it reads `response.text()` or `response.body()`). A format that is ruled out (`not JSON`) or describes the request (`send a JSON body`) is ignored.
- Responses that are not JSON (images, PDFs, files): a happy or schema test checks headers (`Content-Type`, `Cache-Control`, `Content-Length`), the body size (`(await response.body()).length > 0`) or the file signature (PNG `89504E47`, JPEG `FFD8FF`, GIF, WebP, PDF), never `response.json()`. The probe reads such a body as bytes and records its type, size, signature and headers for the prompts.
- invalid-input asserts the 4xx range, plus the sheet's own codes when it lists them (`expect([400, 404]).toContain(response.status())`).
- Tests that compare several calls (a paging walk, totals across pages, no item on two pages) are allowed only when the endpoint's data is stable: a read-only GET with nothing in the run writing the same resource, or `stableData` on. Each such case is one test that sends every call it compares, so no test depends on another or on the order tests run in. Serial mode (`test.describe.configure({ mode: 'serial' })`, `test.describe.serial`) is rejected by the gate: in serial mode one failure skips every later test in the file. On an endpoint that changes data they are refused, and a sheet case that asks for one is **needs review** with how to turn Stable data on.
- Sheet cases mark each checked clause with `// covers clause N` before its assertion; the agent reads these to report coverage, so a clause with no comment and no `expect` is reported as not asserted.

A failed test is a **suspected API finding** when the API returned a 5xx, or returned 2xx to an invalid-input or auth test. Anything else is marked **needs review**.

## Results so far

All numbers below come from runs on a developer Mac with Claude (`claude-sonnet-5-5`), framework Playwright, between 9 and 13 November 2026. They are single runs, not averages; the eval harness (`npm run eval`) is the tool for repeated runs with detection, false alarm and flakiness rates per provider.

**Local shop API** (`input/local-shop.json`, two planted bugs, `npm run api:local`, 13 Nov 2026):
- Bugs on: 5 endpoints, 25 tests, 23 passed, 2 failed. Exactly the 2 planted bugs found (price sent as text returns 500; DELETE without a token returns 204). Every other test passes. 10 model calls, 79 seconds.
- Bugs off (`npm run api:local:fixed`, 9 Nov 2026): 0 findings, 0 failures.
- Login and roles (`input/local-shop-login.json` with the planted bug `viewer-can-delete` on, 13 Nov 2026): 5 endpoints, 27 tests, 3 findings: the two above plus `[authz]` viewer can delete (expected 403 or 404, got 204). 59 values redacted before the model, 15 records created and 15 deleted.
- Pactum on the same API (9 Nov 2026): 27 tests, the same 2 findings.
- The exported framework, run on its own outside this repo, gives the same results.

**Restful Booker** (`input/demo-small.json`, public API): 3 real bugs found in POST /booking, confirmed with direct requests:
- missing `firstname` returns 500 (expected 4xx)
- `totalprice` sent as text returns 200 and saves the booking with `totalprice: null`
- missing `bookingdates` returns 500 (expected 4xx)

## Other commands

| Command | What it does |
|---|---|
| `npm run probe [input]` | Probe only, writes `out/probes/` |
| `npm run test:generated` | Rerun the generated tests (`INPUT_FILE=<input>` picks the API) |
| `npm run api:local:fixed` | Local shop API with the bugs fixed |
| `npx tsx agent/try-one.ts <input> <endpointId>` | Plan and generate one endpoint |
| `npm run -s import <type> < file` | Import endpoints from Postman, OpenAPI, cURL, HAR or text (see Importers) |
| `npm run test:importers` | Importer tests against `test-fixtures/importers/`, offline; the 2 live text-importer tests run only with `RUN_LIVE_CLAUDE_TESTS=1` and a model |
| `npm run test:platform` | The parts that differ between macOS, Windows and Linux (how tools are started, paths) |
| `npm run test:ui-layout` | Opens the UI in headless Chromium at 1920 to 390 px wide and at 125% and 150% zoom, with a long input name, base URL, `.env` variable and path, and checks the two columns never overlap, nothing sticks out of its card and the page never scrolls sideways (needs `npx playwright install chromium` once) |
| `npm run test:ui-smoke` | Starts the UI with `npm run ui` and calls the routes that load the agent modules (input validation, key check); CI runs it on Windows from a folder with spaces on a J: drive |
| `npm run test:e2e` | Whole agent with `FAKE_MODEL=1` (no key) for both frameworks against the local API, then `npm install` and `npm test` in each exported project |

## License

MIT. Copyright 2026 SprintSynergy (https://sprintsynergy.com). See [LICENSE](LICENSE).
