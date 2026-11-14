# Team setup

This page is for a QA engineer who has never seen this repo. Every step has the command to type and what you should see. Allow 15 minutes the first time.

## What it does

You give it the base URL and the endpoints of an API. It calls each endpoint once to see how the API really answers, asks a model (Claude or OpenAI) to plan and write API tests in Playwright or Pactum, runs them against the API, and tells you which failures look like real API bugs. You can download the generated tests as a standalone project and keep them in your own repo.

## What you need

1. Node.js 20 or newer. Check with `node --version`; you should see `v20` or higher. If not, install it from https://nodejs.org (the LTS build).
2. git. Check with `git --version`.
3. One of these, to pay for the model calls:
   - a Claude API key from https://console.anthropic.com (API Keys, Create Key), or
   - an OpenAI API key from https://platform.openai.com/api-keys, or
   - Claude Code installed and logged in on your machine (`claude --version` prints a version). Then no key is needed.

   Ask your lead which one the team uses. The key is billed per run: about 10 model calls for an API with 5 endpoints, a few cents.

## Install

Open a terminal and run these one at a time.

```
git clone https://github.com/sprintsynergyio/api-test-agent.git
cd api-test-agent
npm ci
```

Expected at the end of `npm ci`: a line like `added 210 packages`. Warnings about audits are fine.

```
npm run ui
```

Expected: `API Test Agent UI running on http://localhost:3000 (local demo, no login); model: not set up yet (the page will ask for a key)`. Leave this terminal open; it is the server.

Open http://localhost:3000 in your browser. The first screen is "Set up your model":

1. Pick the provider: Claude (Anthropic) or OpenAI.
2. Paste the API key. Leave Model empty unless your lead gave you a model name.
3. Click **Verify**. Expected: `Key works. Model: ...`. If you see an error instead, read it: it names the usual cause (wrong key, no credits, model not found, rate limit, no network).
4. Click **Save**. Expected: `Saved to .env. The next run uses ...`.

The key goes into a file called `.env` inside the project folder, on your machine only. It is never committed to git and never shown again in the page. If Claude Code is logged in on your machine, the setup card does not appear at all; the header says `Claude via Claude Code login`.

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

Click the **Custom API** tab.

1. **Name**: anything, for example `orders-staging`.
2. **Base URL**: the API's root, for example `https://api-staging.example.com`. Do not put a path or query string here.
3. **Auth header** (optional): the header name, usually `Authorization`, and the value, for example `Bearer eyJ...`. The value is used for this one run only; it is never saved to disk, never shown in reports and never sent to the model.
4. **Endpoints**: add each one with method, path and, for POST and PUT, a sample JSON body. Use `{id}` in a path for an id, and pick the endpoint that creates that record as its setup (the agent creates a fresh record before each test that needs one, and deletes it afterwards).

   Or pick a **Source** and import: an OpenAPI or Swagger file, a Postman collection, cURL commands, a browser HAR capture, or ticket text. Credentials in the import are dropped automatically and the import tells you what it removed.

5. Click **Generate tests**.

**Save as input file** stores the configuration (without any auth value) under `input/<name>.json`, so next time it is in the Saved API list. Put your real auth value in `.env` as the variable the file names, for example `CUSTOM_API_AUTH=Bearer ...`.

Login-based auth (a call to `/auth/login` that returns a token), API keys in the query string, cookies and a second user role for permission tests are supported from the terminal: see the Auth section of `CLAUDE.md` and `input/local-shop-login.json` for the shape.

## The safety guard, in plain words

The agent classifies the host before sending anything:

- `localhost`, `127.0.0.1`, private addresses, and hosts with `dev`, `test`, `qa`, `staging`, `sandbox`, `uat` or `preprod` in the name: full run, writes allowed.
- anything else counts as production. The page shows a red box. Without ticking "I understand this is a production host" nothing is sent at all. With it ticked, only GET endpoints run; POST, PUT, PATCH and DELETE are skipped and marked as skipped, never as passed. A second checkbox allows writes if you really mean it.

Point the agent at staging or test environments. That is what it is for.

## What leaves your machine

- To the model provider you chose (Anthropic or OpenAI): the endpoint list, sample request bodies, and the real responses from the probe calls, after redaction. Emails, phone numbers, card numbers, tokens, IP addresses and anything in a field named like a secret are replaced before the prompt is built. Nothing else goes to the model.
- To the API you are testing: the test requests.
- Nowhere else. The key stays in `.env`. Reports, the generated tests and the downloaded framework stay in the project folder.

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
- `The service was stopped` from `tsx` on macOS: run `npm ci` again (macOS blocked a downloaded binary).
- The setup card says the provider cannot be reached, and you are on a corporate network with Zscaler or another TLS proxy: export your company's root certificate as a `.pem` file and start the UI with `NODE_EXTRA_CA_CERTS=/path/to/zscaler-root.pem npm run ui`.
- The run says `claude CLI not found` and you meant to use a key: open the setup card with **Change** and save the key; the header should then say `via API key`.
- The run stops at `Claude call budget reached`: the default is 30 model calls per run, enough for about 12 endpoints. Raise `MAX_CLAUDE_CALLS` in `.env` for bigger APIs.
- A finding on your API that you think is wrong: open the report, look at the request and response attached to the test, and decide. The agent never changes an expected status to make a test pass; it reports what the API did.

## Cost

One run of 5 endpoints makes about 10 model calls, roughly 70 thousand input tokens and 10 thousand output tokens. With a Claude key that is a few cents. Bigger APIs scale about linearly: two calls per endpoint.
