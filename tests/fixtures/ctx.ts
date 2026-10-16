import 'dotenv/config';
import { test as base, expect, type APIRequestContext } from '@playwright/test';
import { loadConfig } from '../../agent/config';
import { createClients, createResource, disposeClients } from '../../agent/http';

export type Ctx = {
  baseUrl: string;
  api: APIRequestContext;
  noAuthApi: APIRequestContext;
  createResource: (endpointId: string) => Promise<string>;
};

const inputFile = process.env.INPUT_FILE || 'input/endpoints.json';

export const test = base.extend<{ ctx: Ctx }>({
  ctx: async ({}, use) => {
    const config = loadConfig(inputFile);

    // No auth section: api and noAuthApi are the same. With one, the value must be set.
    const authValue = config.auth ? process.env[config.auth.valueEnv] : undefined;
    if (config.auth && !authValue) {
      throw new Error(
        `Missing auth value: environment variable ${config.auth.valueEnv} is not set (required by ${inputFile}). Add it to .env.`,
      );
    }

    const clients = await createClients(config, authValue);

    await use({
      baseUrl: config.baseUrl,
      api: clients.api,
      noAuthApi: clients.noAuthApi,
      createResource: (endpointId) => createResource(config, clients, endpointId),
    });

    await disposeClients(clients);
  },
});

export { expect };
