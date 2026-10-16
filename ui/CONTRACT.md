# UI contract with the agent

The UI (ui/server.mjs + ui/index.html) runs `node_modules/.bin/tsx agent/cli.ts input/ui-run.json`
and expects exactly this from agent/cli.ts.

## 1. Console output

Phase header lines, exactly:

    === PROBING ===
    === PLANNING ===
    === GENERATING ===
    === RUNNING TESTS ===
    === SUMMARY ===

Inside PROBING, PLANNING and GENERATING, one line per endpoint that starts with the endpoint id,
then OK or FAILED, then detail:

    create-product OK 201
    create-product OK 5 cases
    create-product OK written generated/create-product.spec.ts
    update-product FAILED static gate: contains process.env

Exit code 0 when the pipeline completed (even with failing tests), non-zero otherwise.

## 2. out/summary.json

    {
      "status": "completed" | "stopped-budget" | "no-tests",
      "inputFile": "input/local-shop.json",
      "baseUrl": "http://localhost:4000",
      "startedAt": "2026-10-17T10:00:00.000Z",
      "durationSec": 74,
      "claudeCalls": { "used": 10, "budget": 30 },
      "totals": { "endpoints": 5, "testsGenerated": 23, "passed": 21, "failed": 2 },
      "endpoints": [
        {
          "id": "create-product", "method": "POST", "path": "/products", "requiresAuth": true,
          "probeStatus": 201, "casesPlanned": 5, "specWritten": true,
          "specFile": "create-product.spec.ts", "passed": 4, "failed": 1, "failureReason": null
        }
      ],
      "findings": [
        {
          "endpointId": "create-product",
          "testTitle": "[invalid-input] create-product rejects price sent as text",
          "type": "invalid-input", "expectedStatus": "4xx", "actualStatus": 500,
          "classification": "suspected API finding",
          "error": "first 300 characters of the Playwright error"
        }
      ]
    }

probeStatus is null when the probe failed. specFile is null when no spec was written.
classification is "suspected API finding" or "needs review".

## 3. Files the UI reads

- generated/<endpointId>.spec.ts (code viewer)
- reports/html/ (Playwright HTML report, served at /report/)

## 4. Additions for the framework export and custom APIs

Input file changes:
- optional top-level "name" (lowercase letters, numbers, dashes). Used as the framework folder name.
- "auth" is optional. Without it, ctx.api and ctx.noAuthApi behave the same, and no endpoint may have requiresAuth true.
- When auth.valueEnv is "CUSTOM_API_AUTH", the UI passes the value to the agent process in the
  CUSTOM_API_AUTH environment variable for that run only. It is never written to disk.

out/summary.json gets one more top-level field:

    "framework": {
      "name": "local-shop",
      "dir": "frameworks/local-shop",
      "zip": "out/framework.zip",
      "files": ["package.json", "playwright.config.ts", "tests/fixtures/ctx.ts", "tests/create-product.spec.ts", "..."],
      "specCount": 5
    }

framework is null when no spec was written. files are paths relative to dir.

New UI routes:
- POST /api/run body may include "authValue" (string)
- POST /api/inputs/save { name, json } writes input/<name>.json (kit files protected, auth values refused)
- GET /api/framework/download streams out/framework.zip
