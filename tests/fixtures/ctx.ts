import 'dotenv/config';
import { test as base, expect, type APIRequestContext } from '@playwright/test';
import { labels } from 'allure-js-commons';
import { pickAuthEnv } from '../../agent/auth';
import { apiName, loadConfig } from '../../agent/config';
import { cleanupResources, createClients, createResource, disposeClients, formatExchange, recordClients, reportLabels, runSetup } from '../../agent/http';
import { endpointAllowed, READ_ONLY_SKIP } from '../../agent/safety';

export type Ctx = {
  baseUrl: string;
  api: APIRequestContext;
  noAuthApi: APIRequestContext;
  // A client authenticated as another role from the input's auth.roles (for [authz] tests).
  as: (role: string) => APIRequestContext;
  createResource: (endpointId: string) => Promise<string>;
  // Runs this spec's endpoint setup steps in order and returns every path placeholder value, for
  // example { id: '4', reviewId: '7' } for /products/{id}/reviews/{reviewId}.
  setup: () => Promise<Record<string, string>>;
};

const inputFile = process.env.INPUT_FILE || 'input/endpoints.json';

export const test = base.extend<{ ctx: Ctx }>({
  ctx: async ({}, use, testInfo) => {
    const config = loadConfig(inputFile);

    // Only the environment variables the auth section names leave this file (agent/auth.ts).
    // A missing one throws with its name before any request. Without an auth section, api and
    // noAuthApi are the same.
    const authEnv = pickAuthEnv(config.auth, process.env);

    await labels(...reportLabels(apiName(config, inputFile), testInfo.titlePath, testInfo.file));

    // The safety guard: refused on a production host without allowProduction, writes blocked in
    // read-only mode. AGENT_FORCE_PRODUCTION=1 (testing only) treats every host as production.
    const clients = await createClients(config, authEnv, { forceProduction: process.env.AGENT_FORCE_PRODUCTION === '1' });
    // A spec is named after its endpoint. In read-only mode a write endpoint's tests are skipped, never passed.
    const endpoint = config.endpoints.find((e) => `${e.id}.spec.ts` === testInfo.file.split(/[\\/]/).pop());
    if (endpoint && !endpointAllowed(clients.safety, endpoint)) {
      await disposeClients(clients);
      testInfo.skip(true, READ_ONLY_SKIP);
    }

    // Every request and response is attached to the test (Playwright report and Allure), login
    // requests included, with every credential value and token scrubbed and the redaction rules applied.
    const redaction = { replaced: 0 };
    const recordedClients = recordClients(config, clients, async (exchange) => {
      const { name, body } = formatExchange(config, exchange, clients.secrets(), redaction);
      await testInfo.attach(name, { body, contentType: 'application/json' });
    });

    await use({
      baseUrl: config.baseUrl,
      api: recordedClients.api,
      noAuthApi: recordedClients.noAuthApi,
      as: (role) => recordedClients.as(role),
      createResource: (endpointId) => createResource(config, recordedClients, endpointId),
      setup: async () => {
        if (!endpoint) throw new Error(`ctx.setup: no endpoint in ${inputFile} is named after this spec file`);
        return runSetup(config, recordedClients, endpoint);
      },
    });

    // Delete what this test's createResource and setup calls made on the API, through the same guarded
    // clients. The agent adds the counts up into summary.cleanup; failures are listed, never hidden.
    const cleanup = await cleanupResources(config, recordedClients);
    // The agent adds these up into requestsSent, redaction and cleanup in out/summary.json.
    testInfo.annotations.push({ type: 'requests-sent', description: String(clients.counter.sent) });
    testInfo.annotations.push({ type: 'redaction', description: String(redaction.replaced) });
    testInfo.annotations.push({ type: 'cleanup', description: JSON.stringify(cleanup) });
    await disposeClients(clients);
  },
});

export { expect };
