import 'dotenv/config';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pactum from 'pactum';
import { assessSafety, endpointAllowed, ProductionRefused, READ_METHODS, ReadOnlyBlocked, refusalMessage, type Safety } from '../../agent/safety';
import { applyProfile, queryString, resolvePath, setupSteps, type Profile, type Query, type Selection, type Setup } from '../../agent/model';
import {
  authRoles,
  createAuthenticator,
  DEFAULT_ROLE,
  normalizeAuth,
  pickAuthEnv,
  readCredentials,
  redactHeaders,
  redactLoginRequest,
  redactLoginResponse,
  redactQuery,
  scrubSecrets,
  secretValues,
  type AuthConfig,
  type Authenticator,
  type AuthRequest,
} from '../../agent/auth';

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

type Current = { file: string; title: string; actualStatus: number | null; sentBefore: number; evidence: string[] } | null;
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

// One JSON file per exchange in reports/pactum/evidence/, sensitive headers and query values shown as
// <redacted> and every secret value scrubbed from everything else.
function writeEvidence(method: string, path: string, role: string | null, headers: Record<string, string>, body: unknown, status: number | null, text: string, error?: string) {
  const shownPath = redactQuery(config.auth, path);
  const evidence = {
    test: current ? { file: current.file, title: current.title } : null,
    request: { method, path: shownPath, role, headers: redactHeaders(config.auth, headers), body: role === 'login' ? redactLoginRequest(config.auth, body) : body ?? null },
    response: error ? { error } : { status, body: toJsonOrText(role === 'login' ? redactLoginResponse(config.auth, text) : text) },
  };
  const out = scrubSecrets(JSON.stringify(evidence, null, 2), secrets());
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const name = `${String(++evidenceIndex).padStart(3, '0')}-${method}-${shownPath.replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 40)}-${error ? 'failed' : status}.json`;
  writeFileSync(join(EVIDENCE_DIR, name), out + '\n');
  current?.evidence.push(name);
}

// Sends one request with the headers and query exactly as given. Counts it and writes evidence.
async function transmit(m: string, path: string, headers: Record<string, string>, query: Query | undefined, body: unknown, role: string | null): Promise<ApiResponse> {
  const fullPath = path + queryString(query);
  counter.sent++;
  let s = pactum.spec().withMethod(m).withPath(config.baseUrl + fullPath).withHeaders(headers);
  if (body !== undefined) s = s.withJson(body as Record<string, unknown>);
  let res: PactumResponse;
  try {
    res = (await s.toss()) as unknown as PactumResponse;
  } catch (err) {
    const message = scrubSecrets(String((err as Error)?.message ?? err).split('\n')[0], secrets());
    writeEvidence(m, fullPath, role, headers, body, null, '', message);
    throw new Error(`request ${m} ${redactQuery(config.auth, fullPath)} failed: ${message}`);
  }
  const text = typeof res.text === 'string' ? res.text : res.body === undefined || res.body === '' ? '' : JSON.stringify(res.body);
  writeEvidence(m, fullPath, role, headers, body, res.statusCode, text);
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
async function send(method: string, path: string, body: unknown, role: string | null, options: RequestOptions = {}, login = false): Promise<ApiResponse> {
  const m = method.toUpperCase();
  if (safety.mode !== 'full' && !READ_METHODS.has(m) && !login) throw new ReadOnlyBlocked(m, path + queryString(options.params));
  const auth = role ? authenticators[role] : null;
  if (role && !auth) throw new Error(`ctx.as: unknown auth role "${role}" (roles: ${authRoles(config.auth).join(', ') || 'none'})`);
  const base: AuthRequest = { method: m, path, headers: { ...config.defaultHeaders, ...(options.headers ?? {}) }, query: options.params, body };
  const once = async () => {
    const req = auth ? await auth.decorate(base) : base;
    return transmit(m, path, req.headers, req.query, body, login ? 'login' : role);
  };
  let response = await once();
  if (auth && auth.shouldRefresh(response.status())) {
    auth.invalidate();
    response = await once();
  }
  return response;
}

// The login transport for the login auth type: a guarded, recorded request with no auth of its own.
const transport = async (req: AuthRequest) => {
  const res = await send(req.method, req.path, req.body, null, { headers: req.headers, params: req.query }, true);
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
  const response = await (endpoint.requiresAuth ? api : noAuthApi).fetch(resolvePath(endpoint.path, own), {
    method: endpoint.method,
    data: endpoint.body,
    params: endpoint.query,
    headers: endpoint.headers,
  });
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
  return String(id);
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
type StatusEntry = { file: string; title: string; state: string; actualStatus: number | null; requestsSent: number; evidence: string[] };

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
    current = { file, title: this.currentTest?.title ?? '', actualStatus: null, sentBefore: counter.sent, evidence: [] };
  },
  afterEach(this: MochaContext) {
    if (!current) return;
    appendStatus({
      file: current.file,
      title: current.title,
      state: this.currentTest?.state ?? 'unknown',
      actualStatus: current.actualStatus,
      requestsSent: counter.sent - current.sentBefore,
      evidence: current.evidence,
    });
    current = null;
  },
};

export { safety };
