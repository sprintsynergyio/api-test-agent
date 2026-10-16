import 'dotenv/config';
import { test as base, expect, request, type APIRequestContext } from '@playwright/test';
import { loadConfig } from '../../agent/config';

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

    const authValue = process.env[config.auth.valueEnv];
    if (!authValue) {
      throw new Error(
        `Missing auth value: environment variable ${config.auth.valueEnv} is not set (required by ${inputFile}). Add it to .env.`,
      );
    }

    const api = await request.newContext({
      baseURL: config.baseUrl,
      extraHTTPHeaders: { ...config.defaultHeaders, [config.auth.header]: authValue },
    });
    const noAuthApi = await request.newContext({
      baseURL: config.baseUrl,
      extraHTTPHeaders: { ...config.defaultHeaders },
    });

    const createResource = async (endpointId: string): Promise<string> => {
      const endpoint = config.endpoints.find((e) => e.id === endpointId);
      if (!endpoint) throw new Error(`createResource: unknown endpoint "${endpointId}"`);
      const idField = config.endpoints.find((e) => e.setup?.endpointId === endpointId)?.setup?.idField;
      if (!idField) throw new Error(`createResource: no endpoint uses "${endpointId}" as setup, so idField is unknown`);

      const client = endpoint.requiresAuth ? api : noAuthApi;
      const response = await client.fetch(endpoint.path, { method: endpoint.method, data: endpoint.body });
      const text = await response.text();
      if (!response.ok()) {
        throw new Error(`createResource(${endpointId}) failed: status ${response.status()}, body: ${text}`);
      }
      let id: unknown;
      try {
        id = JSON.parse(text)?.[idField];
      } catch {
        id = undefined;
      }
      if (id === undefined || id === null || id === '') {
        throw new Error(
          `createResource(${endpointId}) returned no "${idField}": status ${response.status()}, body: ${text}`,
        );
      }
      return String(id);
    };

    await use({ baseUrl: config.baseUrl, api, noAuthApi, createResource });

    await api.dispose();
    await noAuthApi.dispose();
  },
});

export { expect };
