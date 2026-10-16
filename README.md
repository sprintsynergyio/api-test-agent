# API Test Agent

Give the agent a base URL and a list of API endpoints, and it writes a Playwright API test suite in TypeScript, runs it, and reports suspected API bugs. It first calls each endpoint once to see how the API really responds. Then Claude plans the test cases (happy path, response schema, invalid input, missing auth) and writes one spec file per endpoint. Each file must pass a static gate before it is kept. The suite runs and every failure is classified. The result is a standalone Playwright project you can download and run anywhere.

## Setup

No API key is needed. The agent calls the Claude Code CLI you are already logged in to.

1. Install Node 20+ and the Claude Code CLI, and log in to Claude Code (`claude`).
2. `npm install` (Playwright browsers are not needed, the tests only use Playwright's API client).
3. `cp .env.example .env` and fill in the auth values your input files name (for the kit: `API_AUTH_VALUE` for Restful Booker, `LOCAL_API_AUTH_VALUE` for the local shop API). `MAX_CLAUDE_CALLS` caps Claude calls per run (default 30). `CLAUDE_MODEL` is optional.
4. Check it works: `npm run typecheck` and `npm run test:template` (4 tests against Restful Booker).

## Run it

### From the terminal

```
npm run api:local                      # local shop API on http://localhost:4000 (two planted bugs)
npm run agent input/local-shop.json    # any input file works
```

The agent prints five phases (PROBING, PLANNING, GENERATING, RUNNING TESTS, SUMMARY) and writes:

- `generated/<endpointId>.spec.ts`: the generated tests
- `reports/html/`: the Playwright HTML report
- `out/summary.json`: totals, per-endpoint results and findings
- `frameworks/<name>/` and `out/framework.zip`: the standalone project (see below)

### From the UI

```
npm run api:local
npm run ui            # then open http://localhost:3000
```

- **Saved API** tab: pick an input file from `input/` (or edit its JSON) and click **Generate tests**. The log streams live, then the page shows the findings, the generated code, **Open Playwright report**, and **Download framework (.zip)**.
- **Custom API** tab: enter a name, base URL, optional auth header, and endpoints in a form. The auth value is passed to that one run through an environment variable and is never written to disk. **Save as input file** stores the config (without any auth value) in `input/<name>.json`.

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
