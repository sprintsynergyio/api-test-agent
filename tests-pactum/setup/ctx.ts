import 'dotenv/config';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pactum from 'pactum';
import { assessSafety, endpointAllowed, ProductionRefused, READ_METHODS, ReadOnlyBlocked, refusalMessage, type Safety } from '../../agent/safety';
import { applyProfile, pathParams, queryString, resolvePath, setupSteps, type Profile, type Query, type Selection, type Setup } from '../../agent/model';
import {
  authRoles,
  createAuthenticator,
  DEFAULT_ROLE,
  normalizeAuth,
  pickAuthEnv,
  readCredentials,
  redactHeaders as redactAuthHeaders,
  redactLoginRequest,
  redactLoginResponse,
  redactQuery,
  scrubSecrets,
  secretValues,
  type AuthConfig,
  type Authenticator,
  type AuthRequest,
} from '../../agent/auth';
import { redactHeaders, redactText, redactValue, type RedactionConfig } from '../../agent/redact';

// The Pactum equivalent of tests/fixtures/ctx.ts: the ONLY Pactum test-side file that reads process.env
// or the input file. Tests import { ctx, expect, recordStatus } from here and nothing from pactum.
//
// Every request goes through send(), which runs the safety guard (rule 11) before anything leaves the
// process, counts the request, and writes redacted request/response evidence. Mocha loads this file as a
// root hook plugin (mochaHooks below) to skip write endpoints in read-only mode and to write
// reports/pactum/status.json, the Pactum equivalent of the actual-status annotation.

const INPUT_FILE = process.env.INPUT_FILE || 'input/endpoints.json'; // EXPORT-INPUT
const REPORT_DIR = 'reports/pactum';
const STATUS_FILE = join(REPORT_DIR, 'status.json');
const EVIDENCE_DIR = join(REPORT_DIR, 'evidence');
const MAX_BODY_CHARS = 5 * 1024;
export type Config = {
  name?: string;
  baseUrl: string;
  profile?: Profile;
  selection: Selection | null;
  defaultHeaders: Record<string, string>;
  auth?: AuthConfig;
  allowProduction?: boolean;
  allowWrites?: boolean;
  redaction?: RedactionConfig;
  endpoints: {
    id: string;
    method: string;
    path: string;
    requiresAuth: boolean;
    body?: Record<string, unknown>;
    query?: Query;
    headers?: Record<string, string>;
    setup?: Setup | Setup[];
  }[];
};

// With a profile, AGENT_SELECT (env=staging,brand=alpha,...) picks the base URL and headers.
function loadConfig(file: string): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read input file ${file}: ${(err as Error).message}`);
  }
  const c = raw as Omit<Config, 'baseUrl' | 'selection'> & { baseUrl?: string };
  if (!c || typeof c !== 'object' || (typeof c.baseUrl !== 'string' && !c.profile) || !Array.isArray(c.endpoints) || !c.endpoints.length) {
    throw new Error(`Invalid input file ${file}: needs baseUrl (or a profile) and a non-empty endpoints array`);
  }
  try {
    const loaded = applyProfile({ ...c, defaultHeaders: c.defaultHeaders ?? {} }, process.env.AGENT_SELECT) as Config;
    // An auth section without "type" is the original header form.
    return { ...loaded, auth: normalizeAuth(loaded.auth) };
  } catch (err) {
    throw new Error(`Invalid input file ${file}: ${(err as Error).message}`);
  }
}

const config = loadConfig(INPUT_FILE);
// Only the environment variables the auth section names leave this file (the auth module). A missing
// one throws with its name before any request.
const authEnv = pickAuthEnv(config.auth, process.env);

// The safety guard, once at load: a refused host stops the whole run before any request.
// AGENT_FORCE_PRODUCTION=1 (testing only) treats every host as production.
const safety: Safety = assessSafety(config, { forceProduction: process.env.AGENT_FORCE_PRODUCTION === '1' });
if (safety.mode === 'refused') throw new ProductionRefused(refusalMessage(safety));
// An OAuth2 token URL on another host is classified too: a production token host is refused as well.
if (config.auth?.type === 'oauth2_client' && /^https?:\/\//.test(config.auth.tokenUrl)) {
  const tokenHost = assessSafety({ ...config, baseUrl: config.auth.tokenUrl }, { forceProduction: process.env.AGENT_FORCE_PRODUCTION === '1' });
  if (tokenHost.mode === 'refused') throw new ProductionRefused(refusalMessage(tokenHost));
}

// 429 handling: the server did not process the request, so it is sent again, writes included. At most
// MAX_429_RETRIES retries, waiting Retry-After (seconds or an HTTP date) or 1 s, 2 s, 4 s. Every retry
// is counted. After the last retry the 429 is returned as the actual status.
const MAX_429_RETRIES = 3;
const RETRY_BASE_MS = 1000;
function retryAfterMs(header: string | undefined, attempt: number): number {
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
    const at = Date.parse(header);
    if (!Number.isNaN(at)) return Math.max(0, Math.min(at - Date.now(), 60_000));
  }
  return RETRY_BASE_MS * 2 ** attempt;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

pactum.settings.setLogLevel('ERROR');

// Mirrors the parts of Playwright's APIResponse that the tests and the static gate use.
export type ApiResponse = {
  status(): number;
  ok(): boolean;
  headers(): Record<string, string>;
  text(): Promise<string>;
  json(): Promise<unknown>;
};

// params: query parameters, headers: extra request headers (same option names as Playwright's request API).
export type RequestOptions = { params?: Query; headers?: Record<string, string> };

export type Client = {
  get(path: string, options?: RequestOptions): Promise<ApiResponse>;
  delete(path: string, options?: RequestOptions): Promise<ApiResponse>;
  post(path: string, body?: unknown, options?: RequestOptions): Promise<ApiResponse>;
  put(path: string, body?: unknown, options?: RequestOptions): Promise<ApiResponse>;
  patch(path: string, body?: unknown, options?: RequestOptions): Promise<ApiResponse>;
  fetch(path: string, options?: RequestOptions & { method?: string; data?: unknown }): Promise<ApiResponse>;
};

export type Ctx = {
  baseUrl: string;
  api: Client;
  noAuthApi: Client;
  // A client authenticated as another role from the input's auth.roles (for [authz] tests).
  as: (role: string) => Client;
  createResource: (endpointId: string) => Promise<string>;
  // Runs this spec's endpoint setup steps in order and returns every path placeholder value, for
  // example { id: '4', reviewId: '7' } for /products/{id}/reviews/{reviewId}.
  setup: () => Promise<Record<string, string>>;
};

const counter = { sent: 0 };
const redaction = { replaced: 0 };
// Everything made on the API and not deleted yet, newest last. source: 'setup' for createResource and
// setup steps, 'test' for a POST the test code sent itself through ctx.api or ctx.as.
type CreatedResource = { endpointId: string; id: string; params: Record<string, string>; source: 'setup' | 'test' };
const created: CreatedResource[] = [];

type Current = { file: string; title: string; actualStatus: number | null; sentBefore: number; redactedBefore: number; evidence: string[] } | null;
let current: Current = null;
let evidenceIndex = 0;

type PactumResponse = { statusCode: number; headers: Record<string, string>; body: unknown; text?: string };

function toJsonOrText(text: string): unknown {
  if (text.length > MAX_BODY_CHARS) return `${text.slice(0, MAX_BODY_CHARS)}... [truncated, ${text.length} characters]`;
  if (text.length === 0) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// Every secret value seen so far: credential values from the environment and tokens from logins.
const authenticators: Record<string, Authenticator> = {};
function secrets(): string[] {
  return [...new Set([...secretValues(config.auth, authEnv), ...Object.values(authenticators).flatMap((a) => a.secrets())])];
}

// One JSON file per exchange in reports/pactum/evidence/, redacted twice: the auth rules (sensitive
// headers and query values for the configured auth type, login credentials and tokens) and the
// redact.ts rules (credential-looking headers, personal or secret-looking values in bodies, paths and
// errors, plus the per-API rules in config.redaction). Every secret value is scrubbed from the rest.
function writeEvidence(method: string, path: string, role: string | null, headers: Record<string, string>, body: unknown, status: number | null, text: string, error?: string) {
  const shownPath = redactText(redactQuery(config.auth, path), redaction);
  const shownHeaders = redactHeaders(redactAuthHeaders(config.auth, headers), redaction) ?? {};
  const shownBody = toJsonOrText(role === 'login' ? redactLoginResponse(config.auth, text) : text);
  const requestBody = role === 'login' ? redactLoginRequest(config.auth, body) : body ?? null;
  const evidence = {
    test: current ? { file: current.file, title: current.title } : null,
    request: { method, path: shownPath, role, headers: shownHeaders, body: redactValue(requestBody ?? null, config.redaction, redaction, 'request') },
    response: error
      ? { error: redactText(error, redaction) }
      : { status, body: typeof shownBody === 'string' ? redactText(shownBody, redaction) : redactValue(shownBody, config.redaction, redaction) },
  };
  const out = scrubSecrets(JSON.stringify(evidence, null, 2), secrets());
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const name = `${String(++evidenceIndex).padStart(3, '0')}-${method}-${shownPath.replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 40)}-${error ? 'failed' : status}.json`;
  writeFileSync(join(EVIDENCE_DIR, name), out + '\n');
  current?.evidence.push(name);
}

// Sends one request with the headers and query exactly as given. Counts it and writes evidence.
// form: a form-encoded body (OAuth2 token request) instead of a JSON body. An absolute path (a token
// URL on another host) is sent as it is; everything else is relative to the API's base URL.
async function transmit(m: string, path: string, headers: Record<string, string>, query: Query | undefined, body: unknown, role: string | null, form?: Record<string, string>): Promise<ApiResponse> {
  const fullPath = path + queryString(query);
  counter.sent++;
  const url = /^https?:\/\//.test(path) ? fullPath : config.baseUrl + fullPath;
  let s = pactum.spec().withMethod(m).withPath(url).withHeaders(headers);
  if (form) s = s.withForm(form);
  else if (body !== undefined) s = s.withJson(body as Record<string, unknown>);
  let res: PactumResponse;
  try {
    res = (await s.toss()) as unknown as PactumResponse;
  } catch (err) {
    const message = scrubSecrets(String((err as Error)?.message ?? err).split('\n')[0], secrets());
    writeEvidence(m, fullPath, role, headers, form ?? body, null, '', message);
    throw new Error(`request ${m} ${redactQuery(config.auth, fullPath)} failed: ${message}`);
  }
  const text = typeof res.text === 'string' ? res.text : res.body === undefined || res.body === '' ? '' : JSON.stringify(res.body);
  writeEvidence(m, fullPath, role, headers, form ?? body, res.statusCode, text);
  return {
    status: () => res.statusCode,
    ok: () => res.statusCode >= 200 && res.statusCode < 300,
    headers: () => res.headers,
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

// The one guarded request path. Blocks writes in read-only mode before anything is sent (a login
// request is not a data write and is let through), applies the role's auth (logging in first when
// needed) and re-sends once after a refresh status. role null: no auth (noAuthApi).
type SendFlags = { login?: boolean; form?: Record<string, string>; track?: boolean };
async function send(method: string, path: string, body: unknown, role: string | null, options: RequestOptions = {}, flags: SendFlags = {}): Promise<ApiResponse> {
  const m = method.toUpperCase();
  const login = flags.login === true;
  if (safety.mode !== 'full' && !READ_METHODS.has(m) && !login) throw new ReadOnlyBlocked(m, path + queryString(options.params));
  const auth = role ? authenticators[role] : null;
  if (role && !auth) throw new Error(`ctx.as: unknown auth role "${role}" (roles: ${authRoles(config.auth).join(', ') || 'none'})`);
  const base: AuthRequest = { method: m, path, headers: { ...config.defaultHeaders, ...(options.headers ?? {}) }, query: options.params, body };
  const once = async () => {
    const req = auth ? await auth.decorate(base) : base;
    return transmit(m, path, req.headers, req.query, body, login ? 'login' : role, flags.form);
  };
  let response = await once();
  if (auth && auth.shouldRefresh(response.status())) {
    auth.invalidate();
    response = await once();
  }
  for (let attempt = 0; response.status() === 429 && attempt < MAX_429_RETRIES; attempt++) {
    await sleep(retryAfterMs(response.headers()['retry-after'], attempt));
    response = await once();
  }
  if (flags.track !== false && !login) await trackCreated(m, path, response);
  return response;
}

// A 2xx POST the test code sent itself, to a POST endpoint with a paired DELETE, is recorded so the
// per-test cleanup deletes it (createResource records its own and passes track: false).
async function trackCreated(method: string, path: string, response: ApiResponse): Promise<void> {
  if (method !== 'POST' || !response.ok()) return;
  const match = createEndpointFor(path);
  if (!match) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await response.text());
  } catch {
    return;
  }
  const id = createdIdFrom(parsed, declaredIdField(match.endpoint.id));
  if (id !== undefined) created.push({ endpointId: match.endpoint.id, id, params: match.params, source: 'test' });
}

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

function createEndpointFor(path: string): { endpoint: Config['endpoints'][number]; params: Record<string, string> } | undefined {
  const q = path.indexOf('?');
  const bare = q < 0 ? path : path.slice(0, q);
  for (const endpoint of config.endpoints) {
    if (endpoint.method !== 'POST') continue;
    const params = matchTemplate(endpoint.path, bare);
    if (params && deleteEndpointFor(endpoint.id)) return { endpoint, params };
  }
  return undefined;
}

// The new record's id: the declared idField (top level or under data), else id, _id or uuid.
function createdIdFrom(body: unknown, idField?: string): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const obj = body as Record<string, unknown>;
  const pick = (o: Record<string, unknown>, key: string) => {
    const v = o[key];
    return (typeof v === 'string' && v.length > 0) || typeof v === 'number' ? String(v) : undefined;
  };
  const data = obj.data && typeof obj.data === 'object' ? (obj.data as Record<string, unknown>) : undefined;
  const keys = idField ? [idField] : ['id', '_id', 'uuid'];
  for (const key of keys) {
    const v = pick(obj, key);
    if (v !== undefined) return v;
  }
  if (data) for (const key of keys) {
    const v = pick(data, key);
    if (v !== undefined) return v;
  }
  return undefined;
}

// The login transport for the login and oauth2_client auth types: a guarded, recorded request with no
// auth of its own. A form body (OAuth2 token request) is sent form-encoded, a JSON body as JSON.
const transport = async (req: AuthRequest) => {
  const res = await send(req.method, req.path, req.body, null, { headers: req.headers, params: req.query }, { login: true, form: req.form });
  return { status: res.status(), text: await res.text() };
};
if (config.auth) {
  for (const role of authRoles(config.auth)) {
    authenticators[role] = createAuthenticator(config.auth, readCredentials(config.auth, authEnv, role), transport);
  }
}

function client(role: string | null): Client {
  return {
    get: (path, options) => send('GET', path, undefined, role, options),
    delete: (path, options) => send('DELETE', path, undefined, role, options),
    post: (path, body, options) => send('POST', path, body, role, options),
    put: (path, body, options) => send('PUT', path, body, role, options),
    patch: (path, body, options) => send('PATCH', path, body, role, options),
    fetch: (path, options = {}) => send(options.method ?? 'GET', path, options.data, role, options),
  };
}

const noAuthApi = client(null);
// Without an auth section, api and noAuthApi are the same.
const api = config.auth ? client(DEFAULT_ROLE) : noAuthApi;
// The role createResource sends as when the endpoint needs auth (none without an auth section).
const DEFAULT_ROLE_OR_NULL: string | null = config.auth ? DEFAULT_ROLE : null;
const roleClients: Record<string, Client> = {};
for (const role of authRoles(config.auth)) roleClients[role] = client(role);
function as(role: string): Client {
  const c = roleClients[role];
  if (!c) throw new Error(`ctx.as: unknown auth role "${role}" (roles: ${authRoles(config.auth).join(', ') || 'none'})`);
  return c;
}

// The idField for a setup endpoint: declared by the first setup step anywhere that references it.
function declaredIdField(endpointId: string): string | undefined {
  for (const e of config.endpoints) {
    const step = setupSteps(e).find((st) => st.endpointId === endpointId);
    if (step) return step.idField;
  }
  return undefined;
}

// Calls endpointId with its sample body, query and headers and returns the id read from idField. params
// fills placeholders in the setup endpoint's own path; the rest come from its own setup. Goes through
// send(), so the guard covers it.
async function createResource(endpointId: string, idField?: string, params: Record<string, string> = {}): Promise<string> {
  const endpoint = config.endpoints.find((e) => e.id === endpointId);
  if (!endpoint) throw new Error(`createResource: unknown endpoint "${endpointId}"`);
  const field = idField ?? declaredIdField(endpointId);
  if (!field) throw new Error(`createResource: no endpoint uses "${endpointId}" as setup, so idField is unknown`);
  const own = await runSetup(endpoint, params);
  const response = await send(endpoint.method, resolvePath(endpoint.path, own), endpoint.body, endpoint.requiresAuth ? DEFAULT_ROLE_OR_NULL : null, { params: endpoint.query, headers: endpoint.headers }, { track: false });
  const text = await response.text();
  if (!response.ok()) throw new Error(`createResource(${endpointId}) failed: status ${response.status()}, body: ${scrubSecrets(text, secrets())}`);
  let id: unknown;
  try {
    id = (JSON.parse(text) as Record<string, unknown>)?.[field];
  } catch {
    id = undefined;
  }
  if (id === undefined || id === null || id === '') {
    throw new Error(`createResource(${endpointId}) returned no "${field}": status ${response.status()}, body: ${scrubSecrets(text, secrets())}`);
  }
  created.push({ endpointId, id: String(id), params: own, source: 'setup' });
  return String(id);
}

// cleanup
// Deletes what createResource made, newest first, through send() (so the guard covers it). The totals
// go to status.json per test; the agent adds them into summary.cleanup. Failures are listed, never hidden.

export type CleanupTotals = { created: number; createdByTests: number; deleted: number; failed: number; skippedNoDeleteEndpoint: number; failures: string[] };

const isPlaceholder = (seg: string) => /^\{[^}]+\}$/.test(seg);

// Is child the parent path plus exactly one placeholder segment (placeholder names may differ)?
function isChildPath(parent: string, child: string): boolean {
  const p = parent.split('/');
  const c = child.split('/');
  if (c.length !== p.length + 1 || !isPlaceholder(c[c.length - 1])) return false;
  return p.every((seg, i) => seg === c[i] || (isPlaceholder(seg) && isPlaceholder(c[i])));
}

// The setup step's explicit cleanup endpoint, else the DELETE whose path is the create path plus one placeholder.
function deleteEndpointFor(createEndpointId: string): Config['endpoints'][number] | undefined {
  const create = config.endpoints.find((e) => e.id === createEndpointId);
  if (!create) return undefined;
  for (const e of config.endpoints) {
    const step = setupSteps(e).find((st) => st.endpointId === createEndpointId && st.cleanup);
    if (step) return config.endpoints.find((d) => d.id === step.cleanup!.endpointId);
  }
  return config.endpoints.find((d) => d.method === 'DELETE' && isChildPath(create.path, d.path));
}

async function cleanupResources(): Promise<CleanupTotals> {
  const totals: CleanupTotals = { created: 0, createdByTests: 0, deleted: 0, failed: 0, skippedNoDeleteEndpoint: 0, failures: [] };
  const list = created.splice(0).reverse();
  totals.created = list.length;
  totals.createdByTests = list.filter((m) => m.source === 'test').length;
  for (const made of list) {
    const del = deleteEndpointFor(made.endpointId);
    if (!del) {
      totals.skippedNoDeleteEndpoint++;
      continue;
    }
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
    try {
      const response = await (del.requiresAuth ? api : noAuthApi).delete(path, { params: del.query, headers: del.headers });
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

// Runs an endpoint's setup steps in order; each step sees the values collected so far.
async function runSetup(endpoint: Config['endpoints'][number], known: Record<string, string> = {}): Promise<Record<string, string>> {
  const params = { ...known };
  for (const step of setupSteps(endpoint)) {
    if (step.param! in params) continue;
    params[step.param!] = await createResource(step.endpointId, step.idField, params);
  }
  return params;
}

async function setup(): Promise<Record<string, string>> {
  const endpoint = current ? config.endpoints.find((e) => `${e.id}.spec.ts` === current!.file) : undefined;
  if (!endpoint) throw new Error('ctx.setup: no endpoint in the input is named after this spec file');
  return runSetup(endpoint);
}

export const ctx: Ctx = { baseUrl: config.baseUrl, api, noAuthApi, as, createResource: (endpointId) => createResource(endpointId), setup };

// Records the real status of the request under test. Call it before the first expect, like the
// actual-status annotation in the Playwright tests. The finding rules only trust tests that record it.
export function recordStatus(status: number): void {
  if (!current) throw new Error('recordStatus called outside a test');
  current.actualStatus = status;
}

// A small expect with the matchers the template uses, so the tests read like the Playwright ones and
// the shared static gate can check them. Failures throw, which Mocha reports as the test error.
class Expectation {
  constructor(
    private readonly actual: unknown,
    private readonly negate = false,
  ) {}

  get not(): Expectation {
    return new Expectation(this.actual, !this.negate);
  }

  private check(pass: boolean, message: string) {
    if (pass === this.negate) throw new Error(`${this.negate ? 'expected not: ' : ''}${message}`);
  }

  toBe(expected: unknown) {
    this.check(Object.is(this.actual, expected), `expected ${show(this.actual)} to be ${show(expected)}`);
  }
  toEqual(expected: unknown) {
    this.check(JSON.stringify(this.actual) === JSON.stringify(expected), `expected ${show(this.actual)} to equal ${show(expected)}`);
  }
  toStrictEqual(expected: unknown) {
    this.toEqual(expected);
  }
  toBeGreaterThanOrEqual(n: number) {
    this.check(typeof this.actual === 'number' && this.actual >= n, `expected ${show(this.actual)} to be >= ${n}`);
  }
  toBeGreaterThan(n: number) {
    this.check(typeof this.actual === 'number' && this.actual > n, `expected ${show(this.actual)} to be > ${n}`);
  }
  toBeLessThanOrEqual(n: number) {
    this.check(typeof this.actual === 'number' && this.actual <= n, `expected ${show(this.actual)} to be <= ${n}`);
  }
  toBeLessThan(n: number) {
    this.check(typeof this.actual === 'number' && this.actual < n, `expected ${show(this.actual)} to be < ${n}`);
  }
  toContain(item: unknown) {
    const a = this.actual;
    const has = Array.isArray(a) ? a.some((x) => Object.is(x, item)) : typeof a === 'string' && typeof item === 'string' ? a.includes(item) : false;
    this.check(has, `expected ${show(a)} to contain ${show(item)}`);
  }
  toBeTruthy() {
    this.check(Boolean(this.actual), `expected ${show(this.actual)} to be truthy`);
  }
  toBeFalsy() {
    this.check(!this.actual, `expected ${show(this.actual)} to be falsy`);
  }
  toBeNull() {
    this.check(this.actual === null, `expected ${show(this.actual)} to be null`);
  }
  toBeUndefined() {
    this.check(this.actual === undefined, `expected ${show(this.actual)} to be undefined`);
  }
  toBeDefined() {
    this.check(this.actual !== undefined, `expected ${show(this.actual)} to be defined`);
  }
  toHaveProperty(key: string) {
    const has = this.actual !== null && typeof this.actual === 'object' && key in (this.actual as object);
    this.check(has, `expected ${show(this.actual)} to have property "${key}"`);
  }
  toHaveLength(n: number) {
    const len = (this.actual as { length?: unknown } | null)?.length;
    this.check(len === n, `expected length ${show(len)} to be ${n}`);
  }
  toMatch(re: RegExp | string) {
    const ok = typeof this.actual === 'string' && (typeof re === 'string' ? this.actual.includes(re) : re.test(this.actual));
    this.check(ok, `expected ${show(this.actual)} to match ${String(re)}`);
  }
}

function show(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s.length > 200 ? `${s.slice(0, 200)}...` : s;
  } catch {
    return String(v);
  }
}

export function expect(actual: unknown): Expectation {
  return new Expectation(actual);
}

// Mocha root hooks (loaded with --require). beforeEach: skip write endpoints in read-only mode, never
// pass them. afterEach: append this test's actual status and request count to reports/pactum/status.json.
type StatusEntry = {
  file: string;
  title: string;
  state: string;
  actualStatus: number | null;
  requestsSent: number;
  redactionReplaced: number;
  cleanup: CleanupTotals;
  evidence: string[];
};

function appendStatus(entry: StatusEntry) {
  mkdirSync(REPORT_DIR, { recursive: true });
  const entries: StatusEntry[] = existsSync(STATUS_FILE) ? (JSON.parse(readFileSync(STATUS_FILE, 'utf8')) as StatusEntry[]) : [];
  entries.push(entry);
  writeFileSync(STATUS_FILE, JSON.stringify(entries, null, 2) + '\n');
}

type MochaContext = { currentTest?: { file?: string; title: string; state?: string }; skip(): void };

export const mochaHooks = {
  beforeEach(this: MochaContext) {
    const file = (this.currentTest?.file ?? '').split(/[\\/]/).pop() ?? '';
    const endpoint = config.endpoints.find((e) => `${e.id}.spec.ts` === file);
    if (endpoint && !endpointAllowed(safety, endpoint)) {
      current = null;
      this.skip();
      return;
    }
    current = { file, title: this.currentTest?.title ?? '', actualStatus: null, sentBefore: counter.sent, redactedBefore: redaction.replaced, evidence: [] };
  },
  async afterEach(this: MochaContext) {
    if (!current) return;
    const state = this.currentTest?.state ?? 'unknown';
    // Delete what this test created on the API, then record the test (cleanup requests count too).
    const cleanup = await cleanupResources();
    appendStatus({
      file: current.file,
      title: current.title,
      state,
      actualStatus: current.actualStatus,
      requestsSent: counter.sent - current.sentBefore,
      redactionReplaced: redaction.replaced - current.redactedBefore,
      cleanup,
      evidence: current.evidence,
    });
    current = null;
  },
};

export { safety };
