# Team setup

This page is for a QA engineer who has never seen this repo. Every step has the command to type and what you should see. Allow 15 minutes the first time.

## What it does

You give it the base URL and the endpoints of an API. It calls each endpoint once to see how the API really answers, asks a model (Claude or OpenAI) to plan and write API tests in Playwright or Pactum, runs them against the API, and tells you which failures look like real API bugs. You can download the generated tests as a standalone project and keep them in your own repo.

## What you need

1. Node.js 22 or newer (macOS, Windows or Linux). Check with `node --version`; you should see `v22` or higher. If not, install it from https://nodejs.org (the LTS build).
2. git. Check with `git --version`.
3. One of these, to pay for the model calls:
   - a Claude API key from https://console.anthropic.com (API Keys, Create Key), or
   - an OpenAI API key from https://platform.openai.com/api-keys, or
   - Claude Code installed and logged in on your machine (`claude --version` prints a version). Then no key is needed. The steps are under [Use Claude Code instead of an API key](#use-claude-code-instead-of-an-api-key).

   Ask your lead which one the team uses. A key is billed per run: about 10 model calls for an API with 5 endpoints, a few cents. A Claude Code login counts those calls against your plan instead.

## Install

Open a terminal and run these one at a time.

```
git clone https://github.com/sprintsynergyio/api-test-agent.git
cd api-test-agent
npm ci
```

Expected at the end of `npm ci`: a line like `added 210 packages`. Warnings about audits are fine.

If you are using Claude Code, follow the next subsection before you start the UI. If you are using an API key, skip to [Or paste an API key](#or-paste-an-api-key).

### Use Claude Code instead of an API key

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

Expected: a version number followed by `(Claude Code)`, for example `2.1.211 (Claude Code)`.

If you see `command not found` or `'claude' is not recognized`, close the terminal completely, open a new one, and try again. On Windows, add npm's global folder to your PATH (usually `%AppData%\npm`) and open a new terminal. See [Anthropic's setup guide](https://code.claude.com/docs/en/setup) if it still fails (that page also has a native installer).

3. Sign in once:

```
claude
```

On first use, Claude Code opens a browser window. Sign in with your Claude account. If the browser does not open, press `c` to copy the login URL and paste it into a browser. If the browser shows a login code instead of returning to the terminal, paste that code at the prompt. Expected: the terminal says `Login successful`. Press Enter, then type `/exit` to leave. (Later, `/login` inside a Claude Code session signs you in or switches accounts.)

4. In this repo's `.env`, make sure `ANTHROPIC_API_KEY` has no value. A key in `.env` wins over the login, and `LLM_PROVIDER=openai` always uses OpenAI instead. (An empty `ANTHROPIC_API_KEY=` line, as in `.env.example`, is fine.)

5. Start the UI:

```
npm run ui
```

Expected: `API Test Agent UI running on http://localhost:3000 (local demo, no login); model: anthropic default (Claude Code login)`. Leave this terminal open; it is the server.

Open http://localhost:3000 in your browser. The "Set up your model" card should not appear, and the header should say `Claude via Claude Code login`. If you started the UI before installing or signing in, stop it (Ctrl+C) and run `npm run ui` again: the CLI is checked once at startup.

To switch back to an API key, click **Change** next to the model name at the top of the page, paste the key, and save. The header should then say `via API key`.

### Or paste an API key

```
npm run ui
```

Expected: `API Test Agent UI running on http://localhost:3000 (local demo, no login); model: not set up yet (the page will ask for a key)`. Leave this terminal open; it is the server.

Open http://localhost:3000 in your browser. The first screen is "Set up your model":

1. Pick the provider: Claude (Anthropic) or OpenAI.
2. Paste the API key. Leave Model empty unless your lead gave you a model name.
3. Click **Verify**. Expected: `Key works. Model: ...`. If you see an error instead, read it: it names the usual cause (wrong key, no credits, model not found, rate limit, no network).
4. Click **Save**. Expected: `Saved to .env. The next run uses ...`.

The key goes into a file called `.env` inside the project folder, on your machine only. It is never committed to git and never shown again in the page.

To change the provider or key later, click **Change** next to the model name at the top of the page.

## First run: the built-in demo API

The repo ships a small fake shop API with two planted bugs, so you can see the agent find them without touching any real system.

Open a second terminal in the same folder:

```
npm run api:local
```

Expected: `Local shop API running on http://localhost:4000 (bugs ON: price-text-500,delete-no-auth)`. Leave it open.

Back in the browser: on the **Saved API** tab, "API to test" shows `local-shop`. Click **Generate tests**. The right panel streams the four phases (Probe, Plan, Generate, Run tests). After about a minute you should see:

- `2 suspected API findings`:
  - `[invalid-input] create-product rejects price sent as text: expected 4xx, got 500`: the API crashes on bad input instead of answering 400.
  - `[auth] delete-product ... expected 401|403, got 204`: the API lets a request without a token delete a product.
- every other test green, a report button, and **Download framework (.zip)**.

To see a clean run, stop the shop API (Ctrl+C in that terminal) and start it with the bugs off:

```
npm run api:local:fixed
```

Run again: 0 findings.

## Testing your own API

Click the **Build** tab.

1. **Name**: anything, for example `orders-staging`.
2. **Base URL**: the API's root, for example `https://api-staging.example.com`. Do not put a path or query string here. A badge next to it tells you whether the agent sees a local, non-production or production host.
3. **Auth**: pick how the API is protected.
   - **Header**: the header name, usually `Authorization`, and the value, for example `Bearer eyJ...`. The value is used for this one run only; it is never saved to disk, never shown in reports and never sent to the model.
   - **Query parameter** or **Cookie**: the parameter or cookie name, and the value for this run only, the same way.
   - **Login call**: the agent calls your login endpoint first and uses the token it returns. Fill in the method and path, the body fields and which `.env` variables hold their values (for example `username=API_USER, password=API_PASSWORD`), where the token sits in the response (`data.token`) and how to send it (a header with a prefix, a cookie or a query parameter). The credentials themselves go in `.env`; the page lists the variable names and has a **Copy .env snippet** button.
   - **Roles** (optional): add a second user with fewer rights, for example `viewer`, and the `.env` variable names for its key or credentials. The agent then writes permission tests: that user must get 403 or 404 on the main user's data.
4. **Endpoints**: add each one with method, path and, for POST and PUT, a sample JSON body. The list icon opens query parameters, extra headers and setup. Use `{id}` in a path for an id, and pick the endpoint that creates that record as its setup (the agent creates a fresh record before each test that needs one, and deletes it afterwards).

   Or click the **Import** tab, pick a **Source** and import: an OpenAPI or Swagger file, a Postman collection, cURL commands, a browser HAR capture, or ticket text. Credentials in the import are dropped automatically and the import tells you what it removed.

5. **Run options**: the test framework (**Playwright** or **Pactum**), and redaction. Standard redaction replaces emails, phone numbers, card numbers, tokens and IP addresses before anything reaches the model; **Strict** sends only the shape of the response data. Add field paths such as `customer.name, address.*` to hide more.
6. Click **Generate tests**.

**Save as input file** stores the configuration (without any auth value) under `input/<name>.json`, so next time it is in the Saved list. Put your real auth values in `.env` as the variables the file names, for example `CUSTOM_API_AUTH=Bearer ...`. The Saved tab shows which variables an input reads and highlights the ones your `.env` does not have yet.

**Several environments, brands or regions.** An input file can carry a `profile` instead of one base URL (see `input/example-profile.json`). The Saved tab then shows one dropdown per dimension; the resolved base URL and its host badge update as you pick, and the run uses that selection.

**After a run.** Each finding card has **Show request and response** (what was sent, what came back, already redacted), **Copy as Jira ticket** and **Copy as Markdown**. Click an endpoint row to see its tests. **Recent runs** lists the last 20 runs; **Load** brings one back.

## Automating your team's test case sheet

If your team keeps manual test cases in Excel, Google Sheets, Jira or Confluence, the agent can turn each
row into an automated test that keeps the case ID in its name.

1. Export the sheet as `.csv` or `.xlsx` (from Jira: **Export > CSV**; from Confluence: export or copy the
   table), or skip the export and paste a link (next section). Or download the template from the UI (**Run options**, **Test cases**, **Download template CSV**).
   The columns that matter are ID, Title, Steps / Request and Expected Result; an Endpoint column (for
   example `get-product` or `GET /products/{id}`) makes the matching exact.
2. In **Run options**, **Test cases**, click **Upload CSV or Excel** (or **Paste instead**). Check the
   preview: how many cases were found, which column became which field, and any warnings per row.
3. Pick **Only my test cases** or **My test cases + agent suggestions**, then **Generate tests**.
4. After the run, the **Test case sheet** card lists every case as passed, failed, needs review or not
   automated, with the reason. Download the traceability CSV or Excel file and attach it to your test cycle.
   The exported framework includes the same `traceability.csv`.

Cases marked **needs review** were too vague to automate safely, or what they expect contradicts what the
API actually answered. Fix the row (say what to send and which status to expect) and run again.

## Test cases from a Jira or Confluence link

No export needed: paste a link and the agent reads the cases itself, with your own Atlassian account. It
only reads; it never changes anything in Jira or Confluence.

**Once per person: connect your Atlassian account**

1. Open <https://id.atlassian.com/manage-profile/security/api-tokens> and sign in.
2. Click **Create API token** (the plain one, not "Create API token with scopes"). Give it a name such as
   `API Test Agent`, pick an expiry date, click **Create**, then **Copy**. Keep the page open until step 5.
3. Start the UI (`npm run ui`), open **Run options**, **Test cases**, click **Jira or Confluence link**, then
   **Connect Jira and Confluence**.
4. Fill in:
   - **Site address**: the address you see in the browser in Jira, like `https://your-team.atlassian.net`.
   - **Email**: the email you sign in to Atlassian with.
   - **API token**: paste the token from step 2.
   - Optional, under **Xray and Zephyr Scale test steps**: if your team writes steps in Xray, an Xray
     **client ID** and **client secret** (in Jira: **Apps**, **Xray**, **API Keys**, ask a Jira admin if you
     cannot see it). If your team uses Zephyr Scale, a **Zephyr Scale API token** (in Jira: your profile
     picture, **Zephyr API keys**).
5. Click **Check and save**. The agent signs in once to check, shows **Connected ... as <your name>**, and
   saves the values to `.env` on your computer only. The token is never shown on the page again; to change
   it, click **Change** and paste a new one (leave a token field empty to keep the saved one).

Data Center / Server (Jira on your company's own server): the site address is your Jira address
(including a path such as `/jira` if it has one), leave **Email** empty, and paste a **personal access
token** (in Jira: your profile picture, **Profile**, **Personal Access Tokens**). If Confluence has a
different address, fill **Confluence address**. Xray and Zephyr Scale on Data Center use the same token.

**Every time: paste a link**

1. In **Run options**, **Test cases**, click **Jira or Confluence link**.
2. Paste one of these and press **Load cases** (or Enter):
   - a Jira issue: `https://your-team.atlassian.net/browse/QA-12`
   - a saved Jira filter: `https://your-team.atlassian.net/issues/?filter=10001`
   - a Jira search (open **Filters**, **Advanced issue search**, run it, copy the address), or just the JQL:
     `project = QA AND issuetype = Test AND labels = api`
   - a Confluence page that holds a table with columns like ID, Title, Steps, Expected Result:
     `https://your-team.atlassian.net/wiki/spaces/QA/pages/12345/API+test+cases`
   - Zephyr Scale: `zephyr: project = QA` or `zephyr: QA-T1, QA-T2`
3. Check the preview, exactly like a sheet: how many cases, where each field came from (for example
   **Expected Result ← Description ("Expected result" part)** or **Steps ← Xray Cloud steps**), and any
   warnings.
4. Pick the mode and click **Generate tests**. The **Test case sheet** card and the traceability files list
   every Jira key or Confluence row with its status.

Tips for good results:
- In Jira descriptions, write the request on one line (`POST /orders with ...`) and put the expected
  result after a line starting with **Expected result:**. An **Endpoint** custom field makes matching exact.
- On a Confluence page, use a real table with a header row. Other tables on the page are skipped.

If something goes wrong, the message says what to check:
- **401 (not signed in)**: the email or token is wrong or the token expired. Make a new token (step 2) and
  save it again.
- **403 (no permission)** or **404 (does not exist or you cannot see it)**: open the link in your browser
  while signed in as the same person; if you cannot see it there, ask for access to the project or space.
- **the link is on ..., but the Atlassian site in .env is ...**: the agent only talks to the site you
  connected. Paste a link from that site, or connect the other site.
- **more than 1000 issues**: narrow the JQL (add `AND labels = api` or a component).
- **rate limiting (429)**: Atlassian asked to slow down and still did after 3 retries. Wait a minute.

From the terminal the same works with `--test-cases`:
`npm run agent -- input/my-api.json --test-cases "https://your-team.atlassian.net/issues/?filter=10001"`.

## The safety guard, in plain words

The agent classifies the host before sending anything:

- `localhost`, `127.0.0.1`, private addresses, and hosts with `dev`, `test`, `qa`, `staging`, `sandbox`, `uat` or `preprod` in the name: full run, writes allowed.
- anything else counts as production. The page shows a red box. Without ticking "I understand this is a production host" nothing is sent at all. With it ticked, only GET endpoints run; POST, PUT, PATCH and DELETE are skipped and marked as skipped, never as passed. A second checkbox allows writes if you really mean it.

Point the agent at staging or test environments. That is what it is for.

## What leaves your machine

- To the model provider you chose (Anthropic or OpenAI): the endpoint list, sample request bodies, and the real responses from the probe calls, after redaction. Emails, phone numbers, card numbers, tokens, IP addresses and anything in a field named like a secret are replaced before the prompt is built. Nothing else goes to the model.
- To the API you are testing: the test requests.
- Nowhere else. If you saved a key, it stays in `.env`. Reports, the generated tests and the downloaded framework stay in the project folder.

If your client only allows the shape of the data and not the values, add `"redaction": { "mode": "strict" }` to the saved input file: every string and number in responses becomes a placeholder.

## Using the generated tests in your own repo

Click **Download framework (.zip)**, unzip it anywhere, then:

```
npm install
cp .env.example .env
```

Put the auth value in `.env`, then:

```
npx playwright test
```

(or `npm test` for a Pactum export). The project has no dependency on this repo. Commit it to your own repository and run it in CI like any other test project.

Every export ships `.github/workflows/api-tests.yml` and `azure-pipelines.yml`; the README's "Run in CI" section lists the exact secret names to create (the same names as the lines in `.env.example`).

APIs behind OAuth2 client credentials use `"auth": { "type": "oauth2_client", "tokenUrl": "/oauth/token", "clientIdEnv": "MY_CLIENT_ID", "clientSecretEnv": "MY_CLIENT_SECRET" }` in the input file; the client id and secret live in `.env` only, like every other auth value.

## Troubleshooting

- `Port 3000 is already in use` or `4000`: another copy is running. On macOS or Linux: `lsof -ti tcp:3000 -sTCP:LISTEN | xargs kill` (same for 4000). On Windows: close the other terminal.
- Windows: `npm run ui` starts, then stops with `ERR_UNSUPPORTED_ESM_URL_SCHEME ... Received protocol 'c:'` (or `'j:'`, your drive letter) as soon as the page opens: your copy is older than Nov 17, 2026. Run `git pull`, then `npm ci`, then `npm run ui` again.
- `The service was stopped` from `tsx` on macOS: run `npm ci` again (macOS blocked a downloaded binary).
- The setup card says the provider cannot be reached, and you are on a corporate network with Zscaler or another TLS proxy: export your company's root certificate as a `.pem` file and start the UI with `NODE_EXTRA_CA_CERTS=/path/to/zscaler-root.pem npm run ui`.
- `claude` not found after you installed it (`command not found` or `'claude' is not recognized`): close the terminal completely, open a new one, and run `claude --version` again. On Windows, add npm's global folder to your PATH (usually `%AppData%\npm`) and open a new terminal. Do not install with `sudo`.
- The header still says `via API key`, or the setup card still appears, after you logged in to Claude Code: `.env` has an `ANTHROPIC_API_KEY` value, which wins over the login. Remove that value (leave the line empty or delete it), stop the UI (Ctrl+C), and run `npm run ui` again. The header should say `Claude via Claude Code login`.
- You installed or signed in to Claude Code while the UI was already running: stop it (Ctrl+C) and run `npm run ui` again. The CLI is checked once when the UI starts.
- The run says `claude CLI not found` and you meant to use a key: open the setup card with **Change** and save the key; the header should then say `via API key`.
- The run stops with `stopped at budget: run again with --resume to continue`: the default is 60 model calls per run, about 25 endpoints. Run `npm run agent -- input/<name>.json --resume` in the terminal and it continues where it stopped without paying for the finished endpoints again, or raise `MAX_CLAUDE_CALLS` in `.env`.
- A finding on your API that you think is wrong: open the report, look at the request and response attached to the test, and decide. The agent never changes an expected status to make a test pass; it reports what the API did.

## Cost

One run of 5 endpoints makes about 10 model calls, roughly 70 thousand input tokens and 10 thousand output tokens. With a Claude key that is a few cents. With a Claude Code login, those calls count against your plan. Bigger APIs scale about linearly: two calls per endpoint.
