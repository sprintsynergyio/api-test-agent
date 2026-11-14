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

// A resource made on the target API, so cleanup can delete it afterwards. source: 'setup' for
// createResource and setup steps, 'test' for a POST the test code sent itself through ctx.api.
export type CreatedResource = { endpointId: string; id: string; params: Record<string, string>; source?: 'setup' | 'test' };

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

// retryBaseMs: the first back-off after a 429 without Retry-After (1 s, then 2 s, then 4 s); tests shorten it.
export type ClientOptions = { timeoutMs?: number; forceProduction?: boolean; hosted?: boolean; retryBaseMs?: number };

// 429 handling
// A 429 means the server did not process the request, so it is safe to send again, writes included.
// At most MAX_429_RETRIES retries: Retry-After (seconds or an HTTP date) when the server sends it,
// else 1 s, 2 s, 4 s. Every retry counts as a request sent. After the last retry the 429 is returned
// as the actual status (a test reports it, the probe marks the endpoint rate limited).
export const MAX_429_RETRIES = 3;
export const RETRY_BASE_MS = 1000;

export function retryAfterMs(header: string | undefined, attempt: number, baseMs: number = RETRY_BASE_MS): number {
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
    const at = Date.parse(header);
    if (!Number.isNaN(at)) return Math.max(0, Math.min(at - Date.now(), 60_000));
  }
  return baseMs * 2 ** attempt;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
  // Set by createResource: it records what it made itself, so the generic POST tracking skips it.
  skipCreatedTracking?: boolean;
};

// After every response: records what a test's own POST created (see trackCreated in createClients).
type OnResponse = (method: string, path: string, response: APIResponse) => Promise<void>;
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
function guarded(
  context: APIRequestContext,
  safety: Safety,
  counter: RequestCounter,
  auth: Authenticator | null,
  secrets: () => string[],
  retryBaseMs: number,
  onResponse: OnResponse | null,
): APIRequestContext {
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
        const { authLogin: _login, skipCreatedTracking, ...rest } = options;
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
        for (let attempt = 0; response.status() === 429 && attempt < MAX_429_RETRIES; attempt++) {
          await sleep(retryAfterMs(response.headers()['retry-after'], attempt, retryBaseMs));
          response = await send();
        }
        if (onResponse && !skipCreatedTracking) await onResponse(method, urlOf(urlOrRequest), response);
        return response;
      };
    },
  });
}

// what a test's own POST created
// A 2xx POST sent by test code through ctx.api (or ctx.as) whose path matches a POST endpoint with a
// paired DELETE is recorded so cleanup deletes it, like a createResource record. The id comes from
// the idField a setup step declares for that endpoint, else the first of id, _id, uuid at the top
// level or under data.

function matchTemplate(template: string, path: string): Record<string, string> | null {
  const t = template.split('/');
  const p = path.split('/');
  if (t.length !== p.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < t.length; i++) {
    const m = t[i].match(/^\{([^}]+)\}$/);
    if (m) {
      if (!p[i]) return null;
      params[m[1]] = decodeURIComponent(p[i]);
    } else if (t[i] !== p[i]) return null;
  }
  return params;
}

function pathOnly(url: string): string {
  const q = url.indexOf('?');
  const noQuery = q < 0 ? url : url.slice(0, q);
  // An absolute URL on the API host: keep its path.
  const abs = noQuery.match(/^https?:\/\/[^/]+(\/.*)?$/);
  return abs ? abs[1] || '/' : noQuery;
}

export function createdIdFrom(body: unknown, idField?: string): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const obj = body as Record<string, unknown>;
  const pick = (o: Record<string, unknown>, key: string) => {
    const v = o[key];
    return (typeof v === 'string' && v.length > 0) || typeof v === 'number' ? String(v) : undefined;
  };
  if (idField) {
    const direct = pick(obj, idField);
    if (direct !== undefined) return direct;
    const data = obj.data;
    if (data && typeof data === 'object') return pick(data as Record<string, unknown>, idField);
    return undefined;
  }
  for (const key of ['id', '_id', 'uuid']) {
    const v = pick(obj, key);
    if (v !== undefined) return v;
  }
  const data = obj.data;
  if (data && typeof data === 'object') for (const key of ['id', '_id', 'uuid']) {
    const v = pick(data as Record<string, unknown>, key);
    if (v !== undefined) return v;
  }
  return undefined;
}

// The POST endpoint (with a paired DELETE) a request path belongs to, and its placeholder values.
export function createEndpointFor(config: Config, path: string): { endpoint: Config['endpoints'][number]; params: Record<string, string> } | undefined {
  for (const endpoint of config.endpoints) {
    if (endpoint.method !== 'POST') continue;
    const params = matchTemplate(endpoint.path, pathOnly(path));
    if (!params) continue;
    if (!deleteEndpointFor(config, endpoint.id)) continue;
    return { endpoint, params };
  }
  return undefined;
}

// Throws ProductionRefused before any context exists when the host is production and the config
// does not allow it. forceProduction can only make the guard stricter. authEnv holds the values of
// the environment variables the auth section names (pickAuthEnv), never anything else.
export async function createClients(config: Config, authEnv: Record<string, string | undefined> = {}, opts: ClientOptions = {}): Promise<Clients> {
  const safety = assessSafety(config, { forceProduction: opts.forceProduction, hosted: opts.hosted });
  if (safety.mode === 'refused') throw new ProductionRefused(refusalMessage(safety));
  // An OAuth2 token URL on another host is classified too: a production token host is refused
  // like any production host unless the config allows production.
  const tokenHost = tokenHostSafety(config, opts);
  if (tokenHost && tokenHost.mode === 'refused') throw new ProductionRefused(refusalMessage(tokenHost));

  const counter: RequestCounter = { sent: 0 };
  const authenticators: Record<string, Authenticator> = {};
  const secrets = () => [...new Set([...secretValues(config.auth, authEnv), ...Object.values(authenticators).flatMap((a) => a.secrets())])];
  const retryBaseMs = opts.retryBaseMs ?? RETRY_BASE_MS;
  const created: CreatedResource[] = [];

  // Records what a test's own 2xx POST created (createResource records its own and skips this).
  const trackCreated: OnResponse = async (method, path, response) => {
    if (method !== 'POST' || !response.ok()) return;
    const match = createEndpointFor(config, path);
    if (!match) return;
    let body: unknown;
    try {
      body = JSON.parse(await response.text());
    } catch {
      return;
    }
    const id = createdIdFrom(body, declaredIdField(config, match.endpoint.id));
    if (id !== undefined) created.push({ endpointId: match.endpoint.id, id, params: match.params, source: 'test' });
  };

  const newContext = () => request.newContext({ baseURL: config.baseUrl, extraHTTPHeaders: { ...config.defaultHeaders }, timeout: opts.timeoutMs });

  const rawNoAuth = await newContext();
  const noAuthApi = guarded(rawNoAuth, safety, counter, null, secrets, retryBaseMs, trackCreated);
  const box = { noAuthApi };
  // The login transport: a guarded, recorded request with no auth of its own. A JSON body goes as
  // data, a form body (OAuth2 token request) as form.
  const transport = async (req: AuthRequest) => {
    const loginOptions: RequestOptions = { method: req.method, headers: req.headers, params: req.query, authLogin: true, ...(req.form ? { form: req.form } : { data: req.body }) };
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
      clientsByRole[role] = guarded(raw, safety, counter, authenticators[role], secrets, retryBaseMs, trackCreated);
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
    created,
    secrets,
    loginCount: () => Object.values(authenticators).reduce((n, a) => n + a.loginCount(), 0),
    _box: box,
    _auth: authenticators,
  };
  disposables.set(clients, contexts);
  return clients;
}

const disposables = new WeakMap<Clients, APIRequestContext[]>();

// The safety assessment of an absolute OAuth2 token URL's host, undefined when the token URL is a
// path on the API host (covered by the main assessment) or the auth type does not log in.
export function tokenHostSafety(config: Config, opts: { forceProduction?: boolean; hosted?: boolean } = {}): Safety | undefined {
  if (!config.auth || config.auth.type !== 'oauth2_client' || !/^https?:\/\//.test(config.auth.tokenUrl)) return undefined;
  return assessSafety({ ...config, baseUrl: config.auth.tokenUrl }, opts);
}

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
  const options: RequestOptions = { method: endpoint.method, data: endpoint.body, params: endpoint.query, headers: endpoint.headers, skipCreatedTracking: true };
  const response = await client.fetch(path, options as Parameters<APIRequestContext['fetch']>[1]);
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
  clients.created.push({ endpointId, id: String(id), params: own, source: 'setup' });
  return String(id);
}

// cleanup
// Deletes what createResource made, newest first (a review goes before its product), through the same
// guarded clients. Nothing is hidden: the totals say what was deleted, what failed and why, and what
// had no DELETE endpoint to use.

// created counts every record (setup and test-made); createdByTests says how many of them a test's
// own POST made. deleted + failed + skippedNoDeleteEndpoint = created.
export type CleanupTotals = { created: number; createdByTests: number; deleted: number; failed: number; skippedNoDeleteEndpoint: number; failures: string[] };

export const emptyCleanup = (): CleanupTotals => ({ created: 0, createdByTests: 0, deleted: 0, failed: 0, skippedNoDeleteEndpoint: 0, failures: [] });

export function addCleanup(into: CleanupTotals, more: Partial<CleanupTotals> | null | undefined): CleanupTotals {
  if (!more) return into;
  into.created += more.created ?? 0;
  into.createdByTests += more.createdByTests ?? 0;
  into.deleted += more.deleted ?? 0;
  into.failed += more.failed ?? 0;
  into.skippedNoDeleteEndpoint += more.skippedNoDeleteEndpoint ?? 0;
  if (more.failures) into.failures.push(...more.failures);
  return into;
}

export function cleanupLine(t: CleanupTotals): string {
  const byTests = t.createdByTests ? ` (${t.createdByTests} by test code)` : '';
  return `cleanup: created ${t.created}${byTests}, deleted ${t.deleted}, failed ${t.failed}, no delete endpoint ${t.skippedNoDeleteEndpoint}`;
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
  totals.createdByTests = list.filter((m) => m.source === 'test').length;
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
