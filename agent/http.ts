import { request, type APIRequestContext, type APIResponse } from '@playwright/test';
import {
  createAuthenticator,
  DEFAULT_ROLE,
  authRoles,
  readCredentials,
  redactHeaders as redactAuthHeaders,
  redactLoginRequest,
  redactLoginResponse,
  redactQuery,
  scrubSecrets,
  secretValues,
  type Authenticator,
  type AuthRequest,
} from './auth';
import type { Config } from './config';
import { pathParams, queryString, resolvePath, setupSteps } from './model';
import { redactHeaders, redactText, redactValue, type RedactionCounter } from './redact';
import { assessSafety, ProductionRefused, READ_METHODS, ReadOnlyBlocked, refusalMessage, type Safety } from './safety';

// Shared HTTP logic for the ctx fixture and the agent. Never reads process.env or files:
// callers pass the auth environment in (only the variables the auth section names).
// Without an auth section, api and noAuthApi are the same.
// The safety guard lives here, so it covers every request: probe, createResource, login and tests.
// Auth (header, query, cookie, login with roles) is applied per request by ./auth.

export type RequestCounter = { sent: number };

// A resource createResource made on the target API, so cleanup can delete it afterwards.
export type CreatedResource = { endpointId: string; id: string; params: Record<string, string> };

export type Clients = {
  api: APIRequestContext; // the default role
  noAuthApi: APIRequestContext;
  // One client per role; as('default') is api. Unknown role: throws.
  as(role: string): APIRequestContext;
  roles: string[];
  safety: Safety;
  counter: RequestCounter; // requests actually sent, login requests included
  created: CreatedResource[]; // everything createResource made, newest last
  // Every secret value seen so far (credential values and tokens), for redaction.
  secrets(): string[];
  // Login requests made so far, all roles.
  loginCount(): number;
  // Internal: the client login requests go through (replaced by recordClients so logins are recorded too).
  _box: { noAuthApi: APIRequestContext };
  _auth: Record<string, Authenticator>;
};

export type ClientOptions = { timeoutMs?: number; forceProduction?: boolean; hosted?: boolean };

const REQUEST_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'fetch']);

type RequestOptions = {
  method?: string;
  headers?: Record<string, string>;
  params?: Record<string, string | number | boolean>;
  data?: unknown;
  form?: unknown;
  multipart?: unknown;
  // Set by the auth login transport: the request is a login, allowed in read-only mode (it changes no data).
  authLogin?: boolean;
};
type UrlOrRequest = string | { url(): string; method?(): string };

function requestMethod(prop: string, urlOrRequest: UrlOrRequest, options: RequestOptions | undefined): string {
  if (prop !== 'fetch') return prop.toUpperCase();
  if (options?.method) return options.method.toUpperCase();
  if (typeof urlOrRequest !== 'string' && typeof urlOrRequest.method === 'function') return urlOrRequest.method().toUpperCase();
  return 'GET';
}

const urlOf = (u: UrlOrRequest) => (typeof u === 'string' ? u : u.url());

// Playwright errors append a call log with request headers. Keep the first line, secrets scrubbed.
function cleanRequestError(err: unknown, secrets: () => string[]): Error {
  const first = String((err as Error)?.message ?? err).split('\n')[0];
  const e = new Error(scrubSecrets(first, secrets()));
  e.name = (err as Error)?.name ?? 'Error';
  return e;
}

// Blocks writes in read-only mode before anything leaves the process, counts what is sent, applies
// the role's auth (logging in first when needed) and retries once after a refresh status.
function guarded(context: APIRequestContext, safety: Safety, counter: RequestCounter, auth: Authenticator | null, secrets: () => string[]): APIRequestContext {
  return new Proxy(context, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      if (typeof prop !== 'string' || !REQUEST_METHODS.has(prop)) return value.bind(target);
      return async (urlOrRequest: UrlOrRequest, options: RequestOptions = {}): Promise<APIResponse> => {
        const method = requestMethod(prop, urlOrRequest, options);
        if (safety.mode !== 'full' && !READ_METHODS.has(method) && !options.authLogin) {
          throw new ReadOnlyBlocked(method, urlOf(urlOrRequest));
        }
        const { authLogin: _login, ...rest } = options;
        const send = async (): Promise<APIResponse> => {
          let opts: RequestOptions = rest;
          if (auth) {
            const req = await auth.decorate({ method, path: urlOf(urlOrRequest), headers: { ...(rest.headers ?? {}) }, query: rest.params });
            opts = { ...rest, headers: req.headers, ...(req.query ? { params: req.query } : {}) };
          }
          counter.sent++;
          try {
            return await value.call(target, urlOrRequest, opts);
          } catch (err) {
            throw cleanRequestError(err, secrets);
          }
        };
        let response = await send();
        if (auth && auth.shouldRefresh(response.status())) {
          auth.invalidate();
          response = await send();
        }
        return response;
      };
    },
  });
}

// Throws ProductionRefused before any context exists when the host is production and the config
// does not allow it. forceProduction can only make the guard stricter. authEnv holds the values of
// the environment variables the auth section names (pickAuthEnv), never anything else.
export async function createClients(config: Config, authEnv: Record<string, string | undefined> = {}, opts: ClientOptions = {}): Promise<Clients> {
  const safety = assessSafety(config, { forceProduction: opts.forceProduction, hosted: opts.hosted });
  if (safety.mode === 'refused') throw new ProductionRefused(refusalMessage(safety));

  const counter: RequestCounter = { sent: 0 };
  const authenticators: Record<string, Authenticator> = {};
  const secrets = () => [...new Set([...secretValues(config.auth, authEnv), ...Object.values(authenticators).flatMap((a) => a.secrets())])];

  const newContext = () => request.newContext({ baseURL: config.baseUrl, extraHTTPHeaders: { ...config.defaultHeaders }, timeout: opts.timeoutMs });

  const rawNoAuth = await newContext();
  const noAuthApi = guarded(rawNoAuth, safety, counter, null, secrets);
  const box = { noAuthApi };
  // The login transport: a guarded, recorded request with no auth of its own.
  const transport = async (req: AuthRequest) => {
    const loginOptions: RequestOptions = { method: req.method, headers: req.headers, data: req.body, params: req.query, authLogin: true };
    const response = await box.noAuthApi.fetch(req.path, loginOptions as Parameters<APIRequestContext['fetch']>[1]);
    return { status: response.status(), text: await response.text() };
  };

  const clientsByRole: Record<string, APIRequestContext> = {};
  const contexts: APIRequestContext[] = [rawNoAuth];
  if (config.auth) {
    for (const role of authRoles(config.auth)) {
      const creds = readCredentials(config.auth, authEnv, role);
      authenticators[role] = createAuthenticator(config.auth, creds, transport);
      const raw = await newContext();
      contexts.push(raw);
      clientsByRole[role] = guarded(raw, safety, counter, authenticators[role], secrets);
    }
  }
  const api = config.auth ? clientsByRole[DEFAULT_ROLE] : noAuthApi;

  const clients: Clients = {
    api,
    noAuthApi,
    roles: authRoles(config.auth),
    as(role) {
      const c = clientsByRole[role];
      if (!c) throw new Error(`ctx.as: unknown auth role "${role}" (roles: ${authRoles(config.auth).join(', ') || 'none'})`);
      return c;
    },
    safety,
    counter,
    created: [],
    secrets,
    loginCount: () => Object.values(authenticators).reduce((n, a) => n + a.loginCount(), 0),
    _box: box,
    _auth: authenticators,
  };
  disposables.set(clients, contexts);
  return clients;
}

const disposables = new WeakMap<Clients, APIRequestContext[]>();

// Evidence: every request and response made through the clients, for test reports.
// Sensitive header values are shown as <redacted> and every secret value is scrubbed.

export type Exchange = {
  method: string;
  path: string;
  role: string | null; // which role's client sent it; null for noAuthApi
  requestHeaders: Record<string, string>;
  requestBody: unknown;
  status: number | null;
  responseBody: string;
  error?: string;
};

const RECORDED_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'fetch']);
const MAX_BODY_CHARS = 5 * 1024;

function recorded(context: APIRequestContext, role: string | null, baseHeaders: Record<string, string>, onExchange: (exchange: Exchange) => Promise<void>): APIRequestContext {
  return new Proxy(context, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      if (typeof prop !== 'string' || !RECORDED_METHODS.has(prop)) return value.bind(target);
      return async (urlOrRequest: string | { url(): string }, options: RequestOptions = {}): Promise<APIResponse> => {
        const exchange: Exchange = {
          method: (prop === 'fetch' ? options.method ?? 'GET' : prop).toUpperCase(),
          path: (typeof urlOrRequest === 'string' ? urlOrRequest : urlOrRequest.url()) + (options.params ? queryString(options.params) : ''),
          role: options.authLogin ? 'login' : role,
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

// Wraps every client (roles and login transport included) so each call is passed to onExchange.
export function recordClients(config: Config, clients: Clients, onExchange: (exchange: Exchange) => Promise<void>): Clients {
  const base = { ...config.defaultHeaders };
  const byRole: Record<string, APIRequestContext> = {};
  for (const role of clients.roles) byRole[role] = recorded(clients.as(role), role, base, onExchange);
  const noAuthApi = recorded(clients.noAuthApi, null, base, onExchange);
  clients._box.noAuthApi = noAuthApi;
  const out: Clients = {
    ...clients,
    api: config.auth ? byRole[DEFAULT_ROLE] : noAuthApi,
    noAuthApi,
    as(role) {
      const c = byRole[role];
      if (!c) throw new Error(`ctx.as: unknown auth role "${role}" (roles: ${clients.roles.join(', ') || 'none'})`);
      return c;
    },
  };
  disposables.set(out, disposables.get(clients) ?? []);
  return out;
}

// One report attachment per exchange: JSON with the request and the response (body cut to 5 KB).
// Everything written is redacted twice: the auth rules (sensitive headers and query params for the
// configured auth type, login credentials and tokens, every secret value seen so far) and the
// redact.ts rules (credential-looking headers, personal or secret-looking values in bodies, paths
// and errors; config.redaction adds the per-API rules). The per-request auth headers (login tokens)
// are not in exchange.requestHeaders, and every secret value is scrubbed from the text anyway.
export function formatExchange(
  config: Config,
  exchange: Exchange,
  secrets: string[] | string | undefined,
  counter: RedactionCounter = { replaced: 0 },
): { name: string; body: string } {
  const list = typeof secrets === 'string' ? [secrets] : (secrets ?? []);
  const headers = redactHeaders(redactAuthHeaders(config.auth, exchange.requestHeaders), counter) ?? {};
  const path = redactText(redactQuery(config.auth, exchange.path), counter);
  const text = exchange.role === 'login' ? redactLoginResponse(config.auth, exchange.responseBody) : exchange.responseBody;
  let responseBody: unknown = text.length > MAX_BODY_CHARS ? redactText(`${text.slice(0, MAX_BODY_CHARS)}... [truncated, ${text.length} characters]`, counter) : text;
  if (text.length > 0 && text.length <= MAX_BODY_CHARS) {
    try {
      responseBody = redactValue(JSON.parse(text), config.redaction, counter);
    } catch {
      responseBody = redactText(text, counter);
    }
  }
  const requestBody = exchange.role === 'login' ? redactLoginRequest(config.auth, exchange.requestBody) : exchange.requestBody;
  const evidence = {
    request: { method: exchange.method, path, role: exchange.role, headers, body: redactValue(requestBody, config.redaction, counter, 'request') },
    response: exchange.error ? { error: redactText(exchange.error, counter) } : { status: exchange.status, body: responseBody },
  };
  const body = scrubSecrets(JSON.stringify(evidence, null, 2), list);
  const outcome = exchange.error ? 'request failed' : String(exchange.status);
  const who = exchange.role === 'login' ? ' (auth login)' : exchange.role && exchange.role !== DEFAULT_ROLE ? ` (as ${exchange.role})` : '';
  return { name: scrubSecrets(`${exchange.method} ${path}${who} -> ${outcome}`, list), body };
}

// Allure labels for one test: epic = API name, feature = endpoint id (first word of the describe
// title), story = type tag, severity = critical for auth, authz and invalid-input tests.
export function reportLabels(apiName: string, titlePath: string[], file: string): { name: string; value: string }[] {
  const title = titlePath[titlePath.length - 1] ?? '';
  const describe = titlePath.length > 2 ? titlePath[titlePath.length - 2] : undefined;
  const feature = describe?.split(' ')[0] || (file.split(/[\\/]/).pop() ?? file).replace(/\.spec\.ts$/, '');
  const type = title.match(/^\[(happy|schema|invalid-input|auth|authz)\]/)?.[1];
  const labels = [
    { name: 'epic', value: apiName },
    { name: 'feature', value: feature },
    { name: 'severity', value: type === 'auth' || type === 'authz' || type === 'invalid-input' ? 'critical' : 'normal' },
  ];
  if (type) labels.push({ name: 'story', value: type });
  return labels;
}

export async function disposeClients(clients: Clients): Promise<void> {
  for (const c of disposables.get(clients) ?? []) await c.dispose();
}

export { resolvePath };

// The idField for a setup endpoint: declared by the first setup step anywhere that references it.
function declaredIdField(config: Config, endpointId: string): string | undefined {
  for (const e of config.endpoints) {
    const step = setupSteps(e).find((st) => st.endpointId === endpointId);
    if (step) return step.idField;
  }
  return undefined;
}

// Calls endpointId with its sample body, query and headers and returns the id read from idField.
// idField defaults to the one declared by the first endpoint whose setup references endpointId.
// params fills placeholders in the setup endpoint's own path (a nested resource such as
// POST /products/{id}/reviews); a placeholder not in params is filled by that endpoint's own setup.
export async function createResource(
  config: Config,
  clients: Clients,
  endpointId: string,
  idField?: string,
  params: Record<string, string> = {},
): Promise<string> {
  const endpoint = config.endpoints.find((e) => e.id === endpointId);
  if (!endpoint) throw new Error(`createResource: unknown endpoint "${endpointId}"`);
  const field = idField ?? declaredIdField(config, endpointId);
  if (!field) throw new Error(`createResource: no endpoint uses "${endpointId}" as setup, so idField is unknown`);

  const own = await runSetup(config, clients, endpoint, params);
  const path = resolvePath(endpoint.path, own);
  const client = endpoint.requiresAuth ? clients.api : clients.noAuthApi;
  const response = await client.fetch(path, { method: endpoint.method, data: endpoint.body, params: endpoint.query, headers: endpoint.headers });
  const text = await response.text();
  if (!response.ok()) {
    throw new Error(`createResource(${endpointId}) failed: status ${response.status()}, body: ${scrubSecrets(text, clients.secrets())}`);
  }
  let id: unknown;
  try {
    id = JSON.parse(text)?.[field];
  } catch {
    id = undefined;
  }
  if (id === undefined || id === null || id === '') {
    throw new Error(`createResource(${endpointId}) returned no "${field}": status ${response.status()}, body: ${scrubSecrets(text, clients.secrets())}`);
  }
  clients.created.push({ endpointId, id: String(id), params: own });
  return String(id);
}

// ---- cleanup ----
// Deletes what createResource made, newest first (a review goes before its product), through the same
// guarded clients. Nothing is hidden: the totals say what was deleted, what failed and why, and what
// had no DELETE endpoint to use.

export type CleanupTotals = { created: number; deleted: number; failed: number; skippedNoDeleteEndpoint: number; failures: string[] };

export const emptyCleanup = (): CleanupTotals => ({ created: 0, deleted: 0, failed: 0, skippedNoDeleteEndpoint: 0, failures: [] });

export function addCleanup(into: CleanupTotals, more: Partial<CleanupTotals> | null | undefined): CleanupTotals {
  if (!more) return into;
  into.created += more.created ?? 0;
  into.deleted += more.deleted ?? 0;
  into.failed += more.failed ?? 0;
  into.skippedNoDeleteEndpoint += more.skippedNoDeleteEndpoint ?? 0;
  if (more.failures) into.failures.push(...more.failures);
  return into;
}

export function cleanupLine(t: CleanupTotals): string {
  return `cleanup: created ${t.created}, deleted ${t.deleted}, failed ${t.failed}, no delete endpoint ${t.skippedNoDeleteEndpoint}`;
}

// The DELETE endpoint for resources made by createEndpointId: the setup step's explicit cleanup, else the
// DELETE whose path is the create endpoint's path plus one more placeholder (/products -> /products/{id}).
export function deleteEndpointFor(config: Config, createEndpointId: string): Config['endpoints'][number] | undefined {
  const create = config.endpoints.find((e) => e.id === createEndpointId);
  if (!create) return undefined;
  for (const e of config.endpoints) {
    const step = setupSteps(e).find((st) => st.endpointId === createEndpointId && st.cleanup);
    if (step) return config.endpoints.find((d) => d.id === step.cleanup!.endpointId);
  }
  return config.endpoints.find((d) => d.method === 'DELETE' && isChildPath(create.path, d.path));
}

// Is child the parent path plus exactly one placeholder segment? Placeholder names may differ:
// /products/{id}/reviews is the parent of /products/{productId}/reviews/{reviewId}.
function isChildPath(parent: string, child: string): boolean {
  const p = parent.split('/');
  const c = child.split('/');
  if (c.length !== p.length + 1 || !/^\{[^}]+\}$/.test(c[c.length - 1])) return false;
  return p.every((seg, i) => seg === c[i] || (/^\{[^}]+\}$/.test(seg) && /^\{[^}]+\}$/.test(c[i])));
}

export async function cleanupResources(config: Config, clients: Clients): Promise<CleanupTotals> {
  const totals = emptyCleanup();
  const list = clients.created.splice(0).reverse();
  totals.created = list.length;
  for (const made of list) {
    const del = deleteEndpointFor(config, made.endpointId);
    if (!del) {
      totals.skippedNoDeleteEndpoint++;
      continue;
    }
    // The parent placeholders may be named differently on the DELETE path: map them by position.
    const create = config.endpoints.find((e) => e.id === made.endpointId)!;
    const createParams = pathParams(create.path);
    const delParams = pathParams(del.path);
    const values: Record<string, string> = {};
    delParams.slice(0, -1).forEach((name, i) => {
      const from = createParams[i];
      if (from !== undefined && made.params[from] !== undefined) values[name] = made.params[from];
    });
    values[delParams[delParams.length - 1]] = made.id;
    let path: string;
    try {
      path = resolvePath(del.path, values);
    } catch (err) {
      totals.failed++;
      totals.failures.push(`DELETE ${del.path}: ${String((err as Error)?.message ?? err).split('\n')[0]}`);
      continue;
    }
    const client = del.requiresAuth ? clients.api : clients.noAuthApi;
    try {
      const response = await client.fetch(path, { method: 'DELETE', params: del.query, headers: del.headers });
      // 404 means it is already gone, which is the state cleanup wants.
      if (response.ok() || response.status() === 404) totals.deleted++;
      else {
        totals.failed++;
        totals.failures.push(`DELETE ${path} returned ${response.status()}`);
      }
    } catch (err) {
      totals.failed++;
      totals.failures.push(`DELETE ${path} failed: ${String((err as Error)?.message ?? err).split('\n')[0]}`);
    }
  }
  return totals;
}

// Runs an endpoint's setup steps in order and returns every placeholder value, known ones included.
// Each step sees the values collected so far, so a review is created under the product made one step
// earlier rather than under a fresh one.
export async function runSetup(
  config: Config,
  clients: Clients,
  endpoint: Config['endpoints'][number],
  known: Record<string, string> = {},
): Promise<Record<string, string>> {
  const params = { ...known };
  for (const step of setupSteps(endpoint)) {
    if (step.param! in params) continue;
    params[step.param!] = await createResource(config, clients, step.endpointId, step.idField, params);
  }
  return params;
}
