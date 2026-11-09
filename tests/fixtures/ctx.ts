import 'dotenv/config';
import { test as base, expect, type APIRequestContext } from '@playwright/test';
import { labels } from 'allure-js-commons';
import { apiName, loadConfig } from '../../agent/config';
import { createClients, createResource, disposeClients, formatExchange, recordClients, reportLabels, runSetup } from '../../agent/http';
import { endpointAllowed, READ_ONLY_SKIP } from '../../agent/safety';

export type Ctx = {
  baseUrl: string;
  api: APIRequestContext;
  noAuthApi: APIRequestContext;
  createResource: (endpointId: string) => Promise<string>;
  // Runs this spec's endpoint setup steps in order and returns every path placeholder value, for
  // example { id: '4', reviewId: '7' } for /products/{id}/reviews/{reviewId}.
  setup: () => Promise<Record<string, string>>;
};

const inputFile = process.env.INPUT_FILE || 'input/endpoints.json';

export const test = base.extend<{ ctx: Ctx }>({
  ctx: async ({}, use, testInfo) => {
    const config = loadConfig(inputFile);

    // No auth section: api and noAuthApi are the same. With one, the value must be set.
    const authValue = config.auth ? process.env[config.auth.valueEnv] : undefined;
    if (config.auth && !authValue) {
      throw new Error(
        `Missing auth value: environment variable ${config.auth.valueEnv} is not set (required by ${inputFile}). Add it to .env.`,
      );
    }

    await labels(...reportLabels(apiName(config, inputFile), testInfo.titlePath, testInfo.file));

    // The safety guard: refused on a production host without allowProduction, writes blocked in
    // read-only mode. AGENT_FORCE_PRODUCTION=1 (testing only) treats every host as production.
    const clients = await createClients(config, authValue, { forceProduction: process.env.AGENT_FORCE_PRODUCTION === '1' });
    // A spec is named after its endpoint. In read-only mode a write endpoint's tests are skipped, never passed.
    const endpoint = config.endpoints.find((e) => `${e.id}.spec.ts` === testInfo.file.split(/[\\/]/).pop());
    if (endpoint && !endpointAllowed(clients.safety, endpoint)) {
      await disposeClients(clients);
      testInfo.skip(true, READ_ONLY_SKIP);
    }

    // Every request and response is attached to the test (Playwright report and Allure).
    const recordedClients = recordClients(config, clients, authValue, async (exchange) => {
      const { name, body } = formatExchange(config, exchange, authValue);
      await testInfo.attach(name, { body, contentType: 'application/json' });
    });

    await use({
      baseUrl: config.baseUrl,
      api: recordedClients.api,
      noAuthApi: recordedClients.noAuthApi,
      createResource: (endpointId) => createResource(config, recordedClients, endpointId),
      setup: async () => {
        if (!endpoint) throw new Error(`ctx.setup: no endpoint in ${inputFile} is named after this spec file`);
        return runSetup(config, recordedClients, endpoint);
      },
    });

    // The agent adds these up into requestsSent in out/summary.json.
    testInfo.annotations.push({ type: 'requests-sent', description: String(clients.counter.sent) });
    await disposeClients(clients);
  },
});

export { expect };
