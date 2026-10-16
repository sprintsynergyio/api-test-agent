import { request, type APIRequestContext, type APIResponse } from '@playwright/test';
import type { Config } from './config';

// Shared HTTP logic for the ctx fixture and the agent. Never reads process.env or files:
// callers pass the auth value in. Without an auth section, api and noAuthApi are the same.

const PATH_PARAM = /\{[^}]+\}/;

export type Clients = {
  api: APIRequestContext;
  noAuthApi: APIRequestContext;
};

export async function createClients(config: Config, authValue: string | undefined, timeoutMs?: number): Promise<Clients> {
  if (config.auth && !authValue) {
    throw new Error(`Missing auth value for header ${config.auth.header} (environment variable ${config.auth.valueEnv})`);
  }
  const authHeaders: Record<string, string> = config.auth && authValue ? { [config.auth.header]: authValue } : {};
  const api = await request.newContext({
    baseURL: config.baseUrl,
    extraHTTPHeaders: { ...config.defaultHeaders, ...authHeaders },
    timeout: timeoutMs,
  });
  const noAuthApi = await request.newContext({
    baseURL: config.baseUrl,
    extraHTTPHeaders: { ...config.defaultHeaders },
    timeout: timeoutMs,
  });
  return { api, noAuthApi };
}

// Evidence: every request and response made through the clients, for test reports.
// The auth header value is always shown as <redacted>.

export type Exchange = {
  method: string;
  path: string;
  requestHeaders: Record<string, string>;
  requestBody: unknown;
  status: number | null;
  responseBody: string;
  error?: string;
};

const RECORDED_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'fetch']);
const MAX_BODY_CHARS = 5 * 1024;
const REDACTED = '<redacted>';

type RequestOptions = { method?: string; headers?: Record<string, string>; data?: unknown; form?: unknown; multipart?: unknown };

function recorded(
  context: APIRequestContext,
  baseHeaders: Record<string, string>,
  onExchange: (exchange: Exchange) => Promise<void>,
): APIRequestContext {
  return new Proxy(context, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      if (typeof prop !== 'string' || !RECORDED_METHODS.has(prop)) return value.bind(target);
      return async (urlOrRequest: string | { url(): string }, options: RequestOptions = {}): Promise<APIResponse> => {
        const exchange: Exchange = {
          method: (prop === 'fetch' ? options.method ?? 'GET' : prop).toUpperCase(),
          path: typeof urlOrRequest === 'string' ? urlOrRequest : urlOrRequest.url(),
          requestHeaders: { ...baseHeaders, ...(options.headers ?? {}) },
          requestBody: options.data ?? options.form ?? options.multipart ?? null,
          status: null,
          responseBody: '',
        };
        let response: APIResponse;
        try {
          response = await value.call(target, urlOrRequest, options);
        } catch (err) {
          exchange.error = String((err as Error)?.message ?? err).split('\n')[0];
          await onExchange(exchange);
          throw err;
        }
        exchange.status = response.status();
        exchange.responseBody = await response.text();
        await onExchange(exchange);
        return response;
      };
    },
  });
}

// Wraps both clients so every call (including createResource) is passed to onExchange.
export function recordClients(
  config: Config,
  clients: Clients,
  authValue: string | undefined,
  onExchange: (exchange: Exchange) => Promise<void>,
): Clients {
  const authHeaders: Record<string, string> = config.auth && authValue ? { [config.auth.header]: authValue } : {};
  return {
    api: recorded(clients.api, { ...config.defaultHeaders, ...authHeaders }, onExchange),
    noAuthApi: recorded(clients.noAuthApi, { ...config.defaultHeaders }, onExchange),
  };
}

// One report attachment per exchange: JSON with the request and the response (body cut to 5 KB).
export function formatExchange(config: Config, exchange: Exchange, authValue: string | undefined): { name: string; body: string } {
  const authHeader = config.auth?.header.toLowerCase();
  const headers = Object.fromEntries(
    Object.entries(exchange.requestHeaders).map(([k, v]) => [k, k.toLowerCase() === authHeader ? REDACTED : v]),
  );
  const text = exchange.responseBody;
  let responseBody: unknown = text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}... [truncated, ${text.length} characters]` : text;
  if (text.length > 0 && text.length <= MAX_BODY_CHARS) {
    try {
      responseBody = JSON.parse(text);
    } catch {
      responseBody = text;
    }
  }
  const evidence = {
    request: { method: exchange.method, path: exchange.path, headers, body: exchange.requestBody },
    response: exchange.error ? { error: exchange.error } : { status: exchange.status, body: responseBody },
  };
  let body = JSON.stringify(evidence, null, 2);
  if (authValue) body = body.split(authValue).join(REDACTED);
  const outcome = exchange.error ? 'request failed' : String(exchange.status);
  return { name: `${exchange.method} ${exchange.path} -> ${outcome}`, body };
}

// Allure labels for one test: epic = API name, feature = endpoint id (first word of the describe
// title), story = type tag, severity = critical for auth and invalid-input tests.
export function reportLabels(apiName: string, titlePath: string[], file: string): { name: string; value: string }[] {
  const title = titlePath[titlePath.length - 1] ?? '';
  const describe = titlePath.length > 2 ? titlePath[titlePath.length - 2] : undefined;
  const feature = describe?.split(' ')[0] || (file.split(/[\\/]/).pop() ?? file).replace(/\.spec\.ts$/, '');
  const type = title.match(/^\[(happy|schema|invalid-input|auth)\]/)?.[1];
  const labels = [
    { name: 'epic', value: apiName },
    { name: 'feature', value: feature },
    { name: 'severity', value: type === 'auth' || type === 'invalid-input' ? 'critical' : 'normal' },
  ];
  if (type) labels.push({ name: 'story', value: type });
  return labels;
}

export async function disposeClients(clients: Clients): Promise<void> {
  await clients.api.dispose();
  await clients.noAuthApi.dispose();
}

export function resolvePath(path: string, id: string): string {
  return path.replace(PATH_PARAM, encodeURIComponent(id));
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
