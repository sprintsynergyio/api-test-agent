# API Test Agent

Give the agent a base URL and a list of API endpoints, and it writes an API test suite in Playwright or Pactum, runs it, and reports suspected API bugs. It first calls each endpoint once to see how the API really responds. Then a model (Claude or OpenAI) plans the test cases (happy path, response schema, invalid input, missing auth, wrong role) and writes one spec file per endpoint. Each file must pass a static gate before it is kept. The suite runs and every failure is classified. The result is a standalone test project you can download and run anywhere.

**New to the repo? Team setup: see [docs/TEAM-SETUP.md](docs/TEAM-SETUP.md).** Clone, `npm ci`, `npm run ui`, paste a model API key once, run.

## What it does today

- Two output frameworks: Playwright (TypeScript) and Pactum (Mocha). Same plan, same gate, same findings.
- Importers: OpenAPI or Swagger, Postman, cURL, HAR, ticket text. Credentials are dropped on import.
- Inputs for real APIs: nested paths with several ids, query parameters, per-endpoint headers, and a profile block for environments, brands and regions (`--select env=staging,brand=alpha,region=eu`), so one export serves every combination.
- Auth: fixed header, API key in the query string, cookie, or a login call that fetches a token (cached, refreshed once on 401), plus extra roles for permission tests (`[authz]`).
- Redaction before anything reaches the model: emails, phones, card numbers, tokens, IPs and secret-looking fields are replaced; optional field list and a strict mode that keeps only the shape.
- Test data cleanup: every record the tests create is deleted at the end, through the same guarded client.
- Production safety guard: production hosts are refused unless you say so, and then run read-only. Local, private and `staging`-style hosts run in full.
- Model providers: Claude (API key or your Claude Code login) or OpenAI. Set once from the UI on your own machine.
- Eval harness: a local demo API with planted bugs and `npm run eval` to measure detection, false alarms and flakiness per provider.
- Hosted mode for a shared server: login, per-user runs, rate limits, local hosts refused. See [docs/HOSTING.md](docs/HOSTING.md).
- Plan and open items: [docs/ROADMAP.md](docs/ROADMAP.md). Rules for changing the code: `CLAUDE.md`.

## Setup

1. Install Node 20+.
2. `npm ci` (Playwright browsers are not needed, the tests only use Playwright's API client).
3. Start the UI (`npm run ui`, http://localhost:3000). The first screen asks for a Claude or OpenAI API key, checks it, and saves it to `.env` on your machine. If Claude Code is installed and logged in, no key is needed and the card does not appear.
4. `.env` also holds the auth values your input files name (for the kit: `API_AUTH_VALUE` for Restful Booker, `LOCAL_API_AUTH_VALUE` for the local shop API; copy them from `.env.example`). `MAX_CLAUDE_CALLS` caps model calls per run (default 30). `LLM_MODEL` is optional.
5. Check it works: `npm run typecheck` and `npm run test:template` (4 tests against Restful Booker).

## Run it

### From the terminal

```
npm run api:local                      # local shop API on http://localhost:4000 (two planted bugs)
npm run agent input/local-shop.json    # any input file works
```

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

- **Saved API** tab: pick an input file from `input/` (or edit its JSON) and click **Generate tests**. The log streams live, then the page shows the findings, the generated code, **Open Playwright report**, and **Download framework (.zip)**.
- **Custom API** tab: enter a name, base URL, optional auth header, and endpoints in a form. The auth value is passed to that one run through an environment variable and is never written to disk. **Save as input file** stores the config (without any auth value) in `input/<name>.json`. Or pick another **Source** to import the endpoints (see Importers).

## Importers

Instead of writing the input file by hand, import the endpoints from something you already have. In the UI: **Custom API** tab, **Source**. From the terminal (prints `{ input, skipped, warnings }` as JSON; save `input` as an input file):

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
- A missing or relative base URL leaves `baseUrl` empty, and Generate stays disabled until you fill it in.
- **Keep a run to 12 endpoints or fewer.** Each endpoint costs about 2 Claude calls of the 30-call budget. The preview checks the first 12 and warns above that.
- Acceptance criteria in a ticket are not turned into tests yet.

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

## Point it at another API

Write an input file (or use the Custom API tab):

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

Then run `npm run agent path/to/my-api.json`.

## Model providers

| `.env` | Effect |
|---|---|
| nothing set, Claude Code logged in | the agent calls the `claude` CLI with your login (no API cost beyond your plan) |
| `ANTHROPIC_API_KEY=sk-ant-...` | Claude through the Messages API, billed to that key; `LLM_MODEL` picks the model (default `claude-sonnet-5-5`) |
| `LLM_PROVIDER=openai` and `OPENAI_API_KEY=sk-...` | OpenAI through Chat Completions; `LLM_MODEL` picks the model (default `gpt-6.1-sol`) |

The UI's setup card writes these lines for you. The prompts were tuned against Claude; use `npm run eval -- --provider openai` to see the detection table for OpenAI before standardising on it.

## Test rules

Every generated spec must pass a static gate before it is kept. If it fails, generation is retried once with the reasons. If it fails again, the spec is not written.

- No hardcoded hosts: paths are relative, and the base URL comes from the fixture.
- No `process.env` in tests: everything comes from the `ctx` fixture.
- Assert status codes, field presence and field types. Assert exact values only for data the test itself sent.
- Nothing hides errors: no `test.only`, no `test.skip`, no empty or swallowing `catch`, no `.catch()`.
- Never expect a 5xx. A 5xx on bad input fails the test, and that is reported as a suspected API bug. Expectations are never changed to match a bug.
- Every test title starts with its type (`[happy]`, `[schema]`, `[invalid-input]`, `[auth]`), records the real status before asserting, and the file must typecheck.

A failed test is a **suspected API finding** when the API returned a 5xx, or returned 2xx to an invalid-input or auth test. Anything else is marked **needs review**.

## Results so far

**Local shop API** (`input/local-shop.json`, two planted bugs):
- Bugs on: 5 specs, 25 tests. Exactly the 2 planted bugs found (price sent as text returns 500; DELETE without a token returns 204). Every other test passes.
- Bugs off (`npm run api:local:fixed`): 0 findings, 0 failures.
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
| `npm run test:importers` | Importer tests against `test-fixtures/importers/` (makes 2 live Claude calls) |
