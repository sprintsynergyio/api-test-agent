import 'dotenv/config';
import { test as base, expect, type APIRequestContext } from '@playwright/test';
import { labels } from 'allure-js-commons';
import { apiName, loadConfig } from '../../agent/config';
import { createClients, createResource, disposeClients, formatExchange, recordClients, reportLabels } from '../../agent/http';

export type Ctx = {
  baseUrl: string;
  api: APIRequestContext;
  noAuthApi: APIRequestContext;
  createResource: (endpointId: string) => Promise<string>;
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

    // Every request and response is attached to the test (Playwright report and Allure).
    const clients = await createClients(config, authValue);
    const recordedClients = recordClients(config, clients, authValue, async (exchange) => {
      const { name, body } = formatExchange(config, exchange, authValue);
      await testInfo.attach(name, { body, contentType: 'application/json' });
    });

    await use({
      baseUrl: config.baseUrl,
      api: recordedClients.api,
      noAuthApi: recordedClients.noAuthApi,
      createResource: (endpointId) => createResource(config, recordedClients, endpointId),
    });

    await disposeClients(clients);
  },
});

export { expect };
