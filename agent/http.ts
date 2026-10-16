import { request, type APIRequestContext } from '@playwright/test';
import type { Config } from './config';

// Shared HTTP logic for the ctx fixture and the agent. Never reads process.env or files:
// callers pass the auth value in.

export type Clients = {
  api: APIRequestContext;
  noAuthApi: APIRequestContext;
};

export async function createClients(config: Config, authValue: string, timeoutMs?: number): Promise<Clients> {
  const api = await request.newContext({
    baseURL: config.baseUrl,
    extraHTTPHeaders: { ...config.defaultHeaders, [config.auth.header]: authValue },
    timeout: timeoutMs,
  });
  const noAuthApi = await request.newContext({
    baseURL: config.baseUrl,
    extraHTTPHeaders: { ...config.defaultHeaders },
    timeout: timeoutMs,
  });
  return { api, noAuthApi };
}

export async function disposeClients(clients: Clients): Promise<void> {
  await clients.api.dispose();
  await clients.noAuthApi.dispose();
}

export function resolvePath(path: string, id: string): string {
  return path.replace('{id}', encodeURIComponent(id));
}

// Calls endpointId with its sample body and returns the id read from idField.
// idField defaults to the one declared by the first endpoint whose setup references endpointId.
export async function createResource(
  config: Config,
  clients: Clients,
  endpointId: string,
  idField?: string,
): Promise<string> {
  const endpoint = config.endpoints.find((e) => e.id === endpointId);
  if (!endpoint) throw new Error(`createResource: unknown endpoint "${endpointId}"`);
  const field = idField ?? config.endpoints.find((e) => e.setup?.endpointId === endpointId)?.setup?.idField;
  if (!field) throw new Error(`createResource: no endpoint uses "${endpointId}" as setup, so idField is unknown`);

  const client = endpoint.requiresAuth ? clients.api : clients.noAuthApi;
  const response = await client.fetch(endpoint.path, { method: endpoint.method, data: endpoint.body });
  const text = await response.text();
  if (!response.ok()) {
    throw new Error(`createResource(${endpointId}) failed: status ${response.status()}, body: ${text}`);
  }
  let id: unknown;
  try {
    id = JSON.parse(text)?.[field];
  } catch {
    id = undefined;
  }
  if (id === undefined || id === null || id === '') {
    throw new Error(`createResource(${endpointId}) returned no "${field}": status ${response.status()}, body: ${text}`);
  }
  return String(id);
}
