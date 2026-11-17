# Demo guide

How to show API Test Agent, a SprintSynergy product, to a prospect or a client team: what has to be running, a four-minute walkthrough, the questions people usually ask, and what to do when something goes wrong. Setup on a new machine is in [TEAM-SETUP.md](TEAM-SETUP.md).

## What must be running

| Run | `npm run ui` | `npm run api:local` | Internet |
|---|---|---|---|
| local-shop (the planted-bug demo API) | Yes | Yes | Only for the model calls |
| demo-small / endpoints (Restful Booker) | Yes | No | Yes |
| Your own API from the Build tab (or **Fill example**) | Yes | No | Yes, unless the API is local |

If the API under test does not answer, the page says "API not reachable" instead of showing a confusing result.

## Before you show it

1. Terminal 1: `npm run api:local`. Terminal 2: `npm run ui`. Open http://localhost:3000.
2. Run **demo-small** once and keep its report: the next run replaces `reports/`, so copy it first (`cp -R reports/html ~/restful-booker-report`, then `npx playwright show-report ~/restful-booker-report` to open it). Restful Booker is a shared public sandbox that resets its data, so show this saved result rather than running it live.
3. Run **local-shop** once so **Run history** has a finished run to fall back on, and download the framework zip once to check it.
4. Record a short screen capture of a full local-shop run as a backup.
5. On an unfamiliar network, do one full run at least ten minutes before you start.

## The walkthrough (about four minutes)

1. **The problem (30 s):** every endpoint needs the same baseline checks, and API coverage depends on how much time engineers have.
2. **The input (20 s):** show the local-shop endpoint list, or import an OpenAPI file in the Build tab. "This is all the agent gets."
3. **Run it (60 s):** click **Generate tests**. Narrate the phases: the probe calls the real API once per endpoint, the model plans the cases, the model writes one Playwright or Pactum spec per endpoint, the static gate rejects anything unsafe or weak, and the suite runs.
4. **The result (40 s):** "2 suspected API findings": a price sent as text returns 500 instead of 400, and a delete without a token succeeds.
5. **Real bugs, not planted (30 s):** the saved Restful Booker result shows bugs in a public API nobody planted (see the README).
6. **What you keep (30 s):** **Download framework (.zip)**. "A standalone project: `npm install`, `npm test`, with CI files for GitHub Actions and Azure DevOps."
7. **The evidence (30 s):** **Open Allure report**, open the failing delete-product auth test, and show the recorded request without an Authorization header and the 204 response.
8. **Any API (optional, 40 s):** Build tab, **Fill example**, **Generate tests**.

## Questions people ask

1. **Could the model write wrong tests?** Every file passes a static gate before it is kept: it may import only the test context, may not run code outside the test, must assert the exact status for its case type and must check the response body. A failure is only called an API bug with clear evidence (a 5xx, or a success where a rejection was expected).
2. **Those bugs are planted.** The local-shop ones are, on purpose. The Restful Booker ones are real and reproduce outside the tool.
3. **Why does the test count change between runs?** The tests are written fresh each run; the bugs found stay the same.
4. **What do we keep?** A standalone Playwright or Pactum project that runs without the agent, on macOS, Windows or Linux.
5. **Will it touch production?** Not by default: a production host is refused unless the input allows it, and then it runs read-only (GET, HEAD and OPTIONS only) unless writes are allowed explicitly.
6. **Where do our credentials go?** Only into `.env` on the machine running it, or typed into the page for one run. They are never written to input files, reports, summaries or the exported project, and model provider keys never reach the test process.
7. **Limits today?** Baseline checks per endpoint (happy path, schema, invalid input, auth, roles) rather than business rules or multi-step flows; acceptance criteria in tickets are not turned into tests yet. The plan is in [ROADMAP.md](ROADMAP.md).

## Why it is built this way

| Choice | Why |
|---|---|
| Probe each endpoint before planning | The plan and the status assertions follow what the API really does (some APIs answer 201 to a delete), not a guess |
| Generated Playwright tests run with one worker | They share one live API; parallel runs made results flaky. `--test-workers` raises it for APIs that can take it |
| Claude Code login as an alternative to an API key | A team that already has Claude Code needs no separate key |
| A local demo API with planted bugs | It cannot go down during a demo, and it always has something real to catch |

## When something goes wrong

| Problem | What to do |
|---|---|
| Port 3000 or 4000 is already in use | macOS or Linux: `lsof -ti tcp:3000 -sTCP:LISTEN \| xargs kill` (or `tcp:4000`); without `-sTCP:LISTEN` it also kills clients such as the browser. Windows: `netstat -ano \| findstr :3000`, then `taskkill /PID <pid> /F` |
| The local API is not running | The page says "API not reachable": start `npm run api:local` |
| Claude Code login not picked up | `echo "Reply with the word OK only" \| claude -p` should print `OK`; if it asks to log in, run `claude`, log in, `/exit`, and try again |
| Model rate limits | Calls that get HTTP 429 or a 5xx are retried with backoff (`MODEL_RETRIES`); set `LLM_MODEL` to a lighter model if limits stay tight. A local-shop run is about 10 model calls |
| The live run is slow or stalls | Open the last finished run from **Run history**, or play the backup recording |
| The Allure report tries to reach Google Analytics when opened | Harmless; offline it fails quietly and the report still works |
