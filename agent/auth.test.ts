import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  allAuthEnvNames,
  authEnvNames,
  authRoles,
  createAuthenticator,
  credentialValues,
  DEFAULT_ROLE,
  isSecretField,
  redactLoginRequest,
  secretValues,
  normalizeAuth,
  pickAuthEnv,
  readCredentials,
  redactHeaders,
  redactLoginResponse,
  redactQuery,
  scrubSecrets,
  tokenAt,
  type AuthConfig,
  type AuthRequest,
} from './auth';
import { authProblems, type Config } from './config';
import { createClients, createResource, disposeClients, formatExchange, recordClients, type Exchange } from './http';
import { ProductionRefused, ReadOnlyBlocked } from './safety';

// npm run test:auth: the auth adapters (agent/auth.ts) and their use in the shared HTTP layer, against
// a tiny in-process HTTP server. Plain node:assert via tsx, offline, no Claude.

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`ok    ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}\n      ${String((err as Error)?.message ?? err).split('\n').join('\n      ')}`);
  }
}

// ---- the in-process API: records every request, issues tokens, rejects the wrong ones ----

type Seen = { method: string; path: string; headers: Record<string, string>; body: string };
const seen: Seen[] = [];
let tokenCounter = 0;
const issued = new Map<string, string>(); // token -> role
let expireFirstToken = false;
const ADMIN_TOKEN = 'fixed-admin-token-value';
const oauthSeen: { contentType: string; grant: string | null; scope: string | null; audience: string | null; basic: boolean }[] = [];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => resolve(raw));
  });
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const body = await readBody(req);
  const url = new URL(req.url ?? '/', 'http://x');
  const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)]));
  seen.push({ method: req.method ?? '', path: url.pathname + url.search, headers, body });
  const reply = (status: number, data?: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(data === undefined ? '' : JSON.stringify(data));
  };
  if (req.method === 'POST' && url.pathname === '/oauth/token') {
    // Client credentials: form body, or client id and secret in a Basic header.
    const form = new URLSearchParams(body);
    let id = form.get('client_id');
    let secret = form.get('client_secret');
    const basic = headers.authorization?.match(/^Basic (.+)$/)?.[1];
    if (basic) [id, secret] = Buffer.from(basic, 'base64').toString('utf8').split(':');
    oauthSeen.push({ contentType: headers['content-type'] ?? '', grant: form.get('grant_type'), scope: form.get('scope'), audience: form.get('audience'), basic: Boolean(basic) });
    if (form.get('grant_type') !== 'client_credentials') return reply(400, { error: 'unsupported_grant_type' });
    if (id !== 'test-client' || secret !== 'test-client-secret-value') return reply(401, { error: 'invalid_client' });
    const token = `oauth-tok-${++tokenCounter}`;
    issued.set(token, 'admin');
    return reply(200, { access_token: token, token_type: 'Bearer', expires_in: 3600 });
  }
  if (req.method === 'POST' && url.pathname === '/login') {
    const b = JSON.parse(body || '{}') as { user?: string; pass?: string };
    const roles: Record<string, string> = { 'alice@example.com': 'admin', 'bob@example.com': 'viewer' };
    if (!b.user || b.pass !== `${b.user}-secret` || !roles[b.user]) return reply(401, { error: 'bad credentials' });
    const token = `tok-${b.user.split('@')[0]}-${++tokenCounter}`;
    issued.set(token, roles[b.user]);
    return reply(200, { data: { token, user: b.user } });
  }
  // Who is calling: fixed header, bearer token, cookie or query key.
  const bearer = headers.authorization?.replace(/^Bearer /, '');
  const cookieToken = headers.cookie?.match(/session=([^;]+)/)?.[1];
  const queryKey = url.searchParams.get('api_key');
  const token = bearer ?? cookieToken ?? queryKey ?? headers['x-api-key'];
  let role: string | null = null;
  if (token === ADMIN_TOKEN) role = 'admin';
  else if (token === 'viewer-key-value') role = 'viewer';
  else if (token && issued.has(token)) {
    if (expireFirstToken && token.endsWith('-1')) return reply(401, { error: 'token expired' });
    role = issued.get(token)!;
  }
  if (url.pathname === '/items' && req.method === 'POST') {
    if (!role) return reply(401, { error: 'unauthorized' });
    if (role !== 'admin') return reply(403, { error: 'forbidden' });
    return reply(201, { id: 7, token: bearer ?? null });
  }
  if (url.pathname === '/items' && req.method === 'GET') return reply(200, [{ id: 1 }]);
  if (url.pathname === '/whoami') return reply(200, { role });
  return reply(404, { error: 'not found' });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const endpoints: Config['endpoints'] = [
  { id: 'list-items', method: 'GET', path: '/items', requiresAuth: false },
  { id: 'create-item', method: 'POST', path: '/items', requiresAuth: true, body: { name: 'x' } },
  { id: 'whoami', method: 'GET', path: '/whoami', requiresAuth: true },
];
function config(auth: AuthConfig | undefined, flags: { allowProduction?: boolean } = {}): Config {
  return { baseUrl: base, selection: null, defaultHeaders: { Accept: 'application/json', 'Content-Type': 'application/json' }, auth, ...flags, endpoints };
}

const LOGIN: AuthConfig = {
  type: 'login',
  request: { method: 'POST', path: '/login', body: { remember: true } },
  credentialsEnv: { user: 'T_ADMIN_USER', pass: 'T_ADMIN_PASS' },
  tokenPath: 'data.token',
  apply: { type: 'header', header: 'Authorization', prefix: 'Bearer ' },
  refresh: { statuses: [401], once: true },
  roles: { viewer: { credentialsEnv: { user: 'T_VIEWER_USER', pass: 'T_VIEWER_PASS' } } },
};
const LOGIN_ENV = { T_ADMIN_USER: 'alice@example.com', T_ADMIN_PASS: 'alice@example.com-secret', T_VIEWER_USER: 'bob@example.com', T_VIEWER_PASS: 'bob@example.com-secret' };
const HEADER: AuthConfig = { type: 'header', header: 'X-API-Key', valueEnv: 'T_KEY', roles: { viewer: { valueEnv: 'T_VIEWER_KEY' } } };
const HEADER_ENV = { T_KEY: ADMIN_TOKEN, T_VIEWER_KEY: 'viewer-key-value' };

const OAUTH: AuthConfig = { type: 'oauth2_client', tokenUrl: '/oauth/token', clientIdEnv: 'T_CLIENT_ID', clientSecretEnv: 'T_CLIENT_SECRET', scope: 'read write' };
const OAUTH_ENV = { T_CLIENT_ID: 'test-client', T_CLIENT_SECRET: 'test-client-secret-value' };

const lastRequest = () => seen[seen.length - 1];

// ---- pure helpers ----

await check('normalizeAuth: no type means header; other types pass through', () => {
  assert.deepEqual(normalizeAuth({ header: 'Authorization', valueEnv: 'X' }), { type: 'header', header: 'Authorization', valueEnv: 'X' });
  assert.deepEqual(normalizeAuth(LOGIN), LOGIN);
  assert.equal(normalizeAuth(undefined), undefined);
});

await check('roles and env names per role', () => {
  assert.deepEqual(authRoles(LOGIN), ['default', 'viewer']);
  assert.deepEqual(authEnvNames(LOGIN), ['T_ADMIN_USER', 'T_ADMIN_PASS']);
  assert.deepEqual(authEnvNames(LOGIN, 'viewer'), ['T_VIEWER_USER', 'T_VIEWER_PASS']);
  assert.deepEqual(allAuthEnvNames(LOGIN), ['T_ADMIN_USER', 'T_ADMIN_PASS', 'T_VIEWER_USER', 'T_VIEWER_PASS']);
  assert.deepEqual(allAuthEnvNames(HEADER), ['T_KEY', 'T_VIEWER_KEY']);
  assert.deepEqual(authRoles(undefined), []);
  assert.throws(() => authEnvNames(LOGIN, 'nobody'), /unknown auth role "nobody"/);
});

await check('pickAuthEnv copies only the named variables; readCredentials names a missing one', () => {
  assert.deepEqual(pickAuthEnv(HEADER, { ...HEADER_ENV, OTHER: 'no' }), HEADER_ENV);
  assert.deepEqual(readCredentials(HEADER, HEADER_ENV, 'viewer'), { role: 'viewer', value: 'viewer-key-value' });
  assert.deepEqual(readCredentials(LOGIN, LOGIN_ENV), { role: 'default', fields: { user: 'alice@example.com', pass: 'alice@example.com-secret' } });
  assert.throws(() => readCredentials(LOGIN, { T_ADMIN_USER: 'a' }), /environment variable T_ADMIN_PASS is not set \(role default\)/);
  assert.deepEqual(credentialValues(LOGIN, LOGIN_ENV).sort(), Object.values(LOGIN_ENV).sort());
  // Only secret-looking fields are scrubbed from every text; usernames are redacted in the login evidence instead.
  assert.deepEqual(secretValues(LOGIN, LOGIN_ENV).sort(), ['alice@example.com-secret', 'bob@example.com-secret']);
  assert.deepEqual(secretValues(HEADER, HEADER_ENV).sort(), [ADMIN_TOKEN, 'viewer-key-value'].sort());
  assert.deepEqual(['password', 'pass', 'pwd', 'apiKey', 'client_secret', 'token', 'otp'].map(isSecretField), [true, true, true, true, true, true, true]);
  assert.deepEqual(['username', 'user', 'email', 'tenant'].map(isSecretField), [false, false, false, false]);
  assert.deepEqual(redactLoginRequest(LOGIN, { user: 'u', pass: 'p', remember: true }), { user: '<redacted>', pass: '<redacted>', remember: true });
});

await check('tokenAt follows a dot path; redactLoginResponse hides the token', () => {
  assert.equal(tokenAt({ data: { token: 'abc' } }, 'data.token'), 'abc');
  assert.equal(tokenAt({ tokens: [{ v: 'x' }] }, 'tokens.0.v'), 'x');
  assert.equal(tokenAt({ data: {} }, 'data.token'), undefined);
  assert.equal(redactLoginResponse(LOGIN, '{"data":{"token":"abc","user":"u"}}'), '{"data":{"token":"<redacted>","user":"u"}}');
  assert.equal(redactLoginResponse(LOGIN, 'not json'), 'not json');
});

await check('redaction helpers: headers, query, secrets longest first', () => {
  assert.deepEqual(redactHeaders(HEADER, { 'x-api-key': 'k', Accept: 'a', Cookie: 'c' }), { 'x-api-key': '<redacted>', Accept: 'a', Cookie: '<redacted>' });
  const q: AuthConfig = { type: 'query', param: 'api_key', valueEnv: 'K' };
  assert.equal(redactQuery(q, '/items?api_key=secret&x=1'), '/items?api_key=<redacted>&x=1');
  assert.equal(redactQuery(HEADER, '/items?api_key=secret'), '/items?api_key=secret');
  assert.equal(scrubSecrets('tok tok-long', ['tok', 'tok-long']), '<redacted> <redacted>');
});

await check('authProblems: role shapes must match the auth type', () => {
  assert.deepEqual(authProblems(LOGIN), []);
  assert.deepEqual(authProblems(HEADER), []);
  assert.match(authProblems({ ...LOGIN, roles: { viewer: { credentialsEnv: { user: 'U' } } } })[0], /roles\.viewer\.credentialsEnv.*same fields/);
  assert.match(authProblems({ ...HEADER, roles: { viewer: {} } })[0], /roles\.viewer\.valueEnv" is required/);
  assert.match(authProblems({ ...HEADER, roles: { default: { valueEnv: 'X' } } })[0], /reserved/);
  assert.match(authProblems({ ...LOGIN, request: { method: 'POST', path: '/login', body: { user: 'x' } } })[0], /body\.user" is also in credentialsEnv/);
});

await check('authenticator (login): logs in once, caches the token, refreshes once on 401', async () => {
  const calls: AuthRequest[] = [];
  let n = 0;
  const transport = async (req: AuthRequest) => {
    calls.push(req);
    return { status: 200, text: JSON.stringify({ data: { token: `t${++n}` } }) };
  };
  const a = createAuthenticator(LOGIN, readCredentials(LOGIN, LOGIN_ENV), transport);
  const r1 = await a.decorate({ method: 'GET', path: '/x', headers: {} });
  const r2 = await a.decorate({ method: 'GET', path: '/x', headers: {} });
  assert.equal(r1.headers.Authorization, 'Bearer t1');
  assert.equal(r2.headers.Authorization, 'Bearer t1');
  assert.equal(a.loginCount(), 1);
  assert.deepEqual(calls[0].body, { remember: true, user: 'alice@example.com', pass: 'alice@example.com-secret' });
  assert.equal(a.shouldRefresh(401), true);
  assert.equal(a.shouldRefresh(403), false);
  a.invalidate();
  const r3 = await a.decorate({ method: 'GET', path: '/x', headers: {} });
  assert.equal(r3.headers.Authorization, 'Bearer t2');
  assert.deepEqual(a.secrets().sort(), ['alice@example.com-secret', 't1', 't2']);
  // Concurrent first calls share one login.
  const b = createAuthenticator(LOGIN, readCredentials(LOGIN, LOGIN_ENV), transport);
  await Promise.all([b.decorate({ method: 'GET', path: '/x', headers: {} }), b.decorate({ method: 'GET', path: '/x', headers: {} })]);
  assert.equal(b.loginCount(), 1);
});

await check('authenticator (login): a failed login or a missing token throws, never a silent empty value', async () => {
  const bad = createAuthenticator(LOGIN, readCredentials(LOGIN, LOGIN_ENV), async () => ({ status: 401, text: '{}' }));
  await assert.rejects(bad.decorate({ method: 'GET', path: '/x', headers: {} }), /auth login \(POST \/login, role default\) failed: status 401/);
  const noToken = createAuthenticator(LOGIN, readCredentials(LOGIN, LOGIN_ENV), async () => ({ status: 200, text: '{"data":{}}' }));
  await assert.rejects(noToken.decorate({ method: 'GET', path: '/x', headers: {} }), /no token at tokenPath "data.token"/);
});

await check('authenticator: cookie and query apply, with and without login', async () => {
  const cookie = createAuthenticator({ type: 'cookie', name: 'session', valueEnv: 'C' }, { role: DEFAULT_ROLE, value: 'sv' }, async () => ({ status: 200, text: '' }));
  assert.deepEqual((await cookie.decorate({ method: 'GET', path: '/x', headers: { Cookie: 'a=b' } })).headers, { Cookie: 'a=b; session=sv' });
  const query = createAuthenticator({ type: 'query', param: 'api_key', valueEnv: 'K' }, { role: DEFAULT_ROLE, value: 'kv' }, async () => ({ status: 200, text: '' }));
  assert.deepEqual((await query.decorate({ method: 'GET', path: '/x', headers: {}, query: { page: 2 } })).query, { page: 2, api_key: 'kv' });
  const loginQuery: AuthConfig = { ...LOGIN, apply: { type: 'query', param: 'token' }, roles: undefined };
  const lq = createAuthenticator(loginQuery, readCredentials(loginQuery, LOGIN_ENV), async () => ({ status: 200, text: '{"data":{"token":"qt"}}' }));
  assert.deepEqual((await lq.decorate({ method: 'GET', path: '/x', headers: {} })).query, { token: 'qt' });
});

// ---- the shared HTTP layer against the real in-process server ----

async function withClients<T>(cfg: Config, env: Record<string, string | undefined>, fn: (c: Awaited<ReturnType<typeof createClients>>) => Promise<T>, opts = {}) {
  const clients = await createClients(cfg, env, opts);
  try {
    return await fn(clients);
  } finally {
    await disposeClients(clients);
  }
}

await check('header auth: the default role sends the header, noAuthApi does not, as(viewer) sends the viewer value', async () => {
  seen.length = 0;
  await withClients(config(HEADER), HEADER_ENV, async (c) => {
    assert.equal((await c.api.post('/items', { data: { name: 'x' } })).status(), 201);
    assert.equal(lastRequest().headers['x-api-key'], ADMIN_TOKEN);
    assert.equal((await c.noAuthApi.post('/items', { data: {} })).status(), 401);
    assert.equal(lastRequest().headers['x-api-key'], undefined);
    assert.equal((await c.as('viewer').post('/items', { data: {} })).status(), 403);
    assert.equal(lastRequest().headers['x-api-key'], 'viewer-key-value');
    assert.deepEqual(c.roles, ['default', 'viewer']);
    assert.throws(() => c.as('nobody'), /unknown auth role "nobody"/);
    assert.equal(c.counter.sent, 3);
    assert.equal(c.loginCount(), 0);
  });
});

await check('query and cookie auth: sent where the API expects them', async () => {
  seen.length = 0;
  await withClients(config({ type: 'query', param: 'api_key', valueEnv: 'K' }), { K: ADMIN_TOKEN }, async (c) => {
    assert.equal((await c.api.post('/items', { data: {}, params: { page: 1 } })).status(), 201);
    assert.equal(lastRequest().path, `/items?page=1&api_key=${ADMIN_TOKEN}`);
  });
  await withClients(config({ type: 'cookie', name: 'session', valueEnv: 'C' }), { C: ADMIN_TOKEN }, async (c) => {
    assert.equal((await c.api.post('/items', { data: {} })).status(), 201);
    assert.equal(lastRequest().headers.cookie, `session=${ADMIN_TOKEN}`);
  });
});

await check('login auth: one login for many requests, counted and recorded, roles log in separately', async () => {
  seen.length = 0;
  issued.clear();
  await withClients(config(LOGIN), LOGIN_ENV, async (c) => {
    const exchanges: Exchange[] = [];
    const rc = recordClients(config(LOGIN), c, async (e) => {
      exchanges.push(e);
    });
    assert.equal((await rc.api.post('/items', { data: { name: 'a' } })).status(), 201);
    assert.equal((await rc.api.post('/items', { data: { name: 'b' } })).status(), 201);
    assert.equal(await createResource(config(LOGIN), rc, 'create-item', 'id'), '7');
    assert.equal(c.loginCount(), 1, 'one login for the default role');
    assert.equal(seen.filter((s) => s.path === '/login').length, 1);
    assert.match(seen[1].headers.authorization, /^Bearer tok-alice-\d+$/);
    assert.equal((await rc.as('viewer').post('/items', { data: {} })).status(), 403);
    assert.equal(c.loginCount(), 2, 'the viewer role logs in on first use');
    assert.equal(c.counter.sent, 6, 'two logins plus four requests');
    // Evidence: the login exchange is recorded with credentials and token redacted.
    const login = exchanges.find((e) => e.role === 'login');
    assert.ok(login, 'login exchange recorded');
    const { name, body } = formatExchange(config(LOGIN), login!, c.secrets());
    assert.equal(name, 'POST /login (auth login) -> 200');
    assert.ok(!body.includes('alice@example.com-secret'), 'password redacted');
    const parsedEvidence = JSON.parse(body) as { request: { body: Record<string, unknown> } };
    assert.deepEqual(parsedEvidence.request.body, { remember: true, user: '<redacted>', pass: '<redacted>' }, 'login fields redacted in the request evidence');
    assert.ok(!/tok-alice-\d/.test(body), `token redacted: ${body}`);
    assert.ok(body.includes('"remember": true'));
    // Evidence of a normal request: the token never appears (the API echoes it back in the body).
    const created = exchanges.find((e) => e.role === 'default' && e.method === 'POST');
    const ev = formatExchange(config(LOGIN), created!, c.secrets());
    assert.ok(!/tok-alice-\d/.test(ev.body), `token scrubbed from the response body: ${ev.body}`);
    assert.ok(c.secrets().some((s) => /^tok-alice-\d+$/.test(s)), 'the token is in secrets()');
  });
});

await check('login auth: a 401 refreshes the token once and re-sends; a second 401 is returned, not retried', async () => {
  seen.length = 0;
  issued.clear();
  tokenCounter = 0;
  expireFirstToken = true;
  try {
    await withClients(config(LOGIN), LOGIN_ENV, async (c) => {
      const res = await c.api.post('/items', { data: {} });
      assert.equal(res.status(), 201);
      assert.equal(c.loginCount(), 2, 'first token expired: logged in again once');
      assert.deepEqual(seen.map((s) => `${s.method} ${s.path} ${s.headers.authorization ?? ''}`), ['POST /login ', 'POST /items Bearer tok-alice-1', 'POST /login ', 'POST /items Bearer tok-alice-2']);
      // A role whose every login yields an expiring token: one retry, then the 401 is returned.
      seen.length = 0;
      const env2 = { ...LOGIN_ENV };
      const cfg2 = config({ ...LOGIN, roles: undefined });
      issued.clear();
      tokenCounter = 0;
      const clients2 = await createClients(cfg2, env2);
      try {
        expireFirstToken = false;
        // Make every token invalid by clearing the issued map after login.
        const r1 = await clients2.api.post('/items', { data: {} });
        assert.equal(r1.status(), 201);
        issued.clear();
        const r2 = await clients2.api.post('/items', { data: {} });
        assert.equal(r2.status(), 201, 'after the token was revoked, one refresh fixes it');
        assert.equal(clients2.loginCount(), 2);
      } finally {
        await disposeClients(clients2);
      }
    });
  } finally {
    expireFirstToken = false;
  }
});

await check('login auth: a request that keeps failing is retried once only', async () => {
  seen.length = 0;
  const cfg = config({ ...LOGIN, roles: undefined, credentialsEnv: { user: 'T_VIEWER_USER', pass: 'T_VIEWER_PASS' } });
  await withClients(cfg, LOGIN_ENV, async (c) => {
    // The viewer logs in fine but gets 403 on writes: 403 is not a refresh status, so no retry.
    assert.equal((await c.api.post('/items', { data: {} })).status(), 403);
    assert.equal(c.loginCount(), 1);
    assert.equal(seen.length, 2);
  });
});

await check('oauth2_client: helpers, env names, secrets and redaction', () => {
  assert.deepEqual(authEnvNames(OAUTH), ['T_CLIENT_ID', 'T_CLIENT_SECRET']);
  assert.deepEqual(allAuthEnvNames({ ...OAUTH, roles: { viewer: { clientIdEnv: 'V_ID', clientSecretEnv: 'V_SECRET' } } }), ['T_CLIENT_ID', 'T_CLIENT_SECRET', 'V_ID', 'V_SECRET']);
  assert.deepEqual(readCredentials(OAUTH, OAUTH_ENV), { role: 'default', fields: { client_id: 'test-client', client_secret: 'test-client-secret-value' } });
  assert.throws(() => readCredentials(OAUTH, { T_CLIENT_ID: 'x' }), /environment variable T_CLIENT_SECRET is not set \(role default\)/);
  // Only the secret is scrubbed from every text; the client id is redacted in the token request evidence.
  assert.deepEqual(secretValues(OAUTH, OAUTH_ENV), ['test-client-secret-value']);
  assert.deepEqual(redactLoginRequest(OAUTH, { grant_type: 'client_credentials', client_id: 'a', client_secret: 'b', scope: 's' }), { grant_type: 'client_credentials', client_id: '<redacted>', client_secret: '<redacted>', scope: 's' });
  assert.equal(redactLoginResponse(OAUTH, '{"access_token":"abc","token_type":"Bearer"}'), '{"access_token":"<redacted>","token_type":"Bearer"}');
  assert.deepEqual(redactHeaders(OAUTH, { Authorization: 'Bearer x', Accept: 'a' }), { Authorization: '<redacted>', Accept: 'a' });
  assert.deepEqual(authProblems(OAUTH), []);
  assert.match(authProblems({ ...OAUTH, roles: { viewer: { clientIdEnv: 'V' } } })[0], /roles\.viewer" needs clientIdEnv and clientSecretEnv/);
  assert.match(authProblems({ ...HEADER, roles: { viewer: { valueEnv: 'X', clientIdEnv: 'V' } } })[0], /clientIdEnv/);
});

await check('oauth2_client authenticator: form grant, cached token, refresh once on 401, basic client auth', async () => {
  const calls: AuthRequest[] = [];
  let n = 0;
  const transport = async (req: AuthRequest) => {
    calls.push(req);
    return { status: 200, text: JSON.stringify({ access_token: `at${++n}`, token_type: 'Bearer' }) };
  };
  const a = createAuthenticator(OAUTH, readCredentials(OAUTH, OAUTH_ENV), transport);
  const r1 = await a.decorate({ method: 'GET', path: '/x', headers: {} });
  const r2 = await a.decorate({ method: 'GET', path: '/x', headers: {} });
  assert.equal(r1.headers.Authorization, 'Bearer at1');
  assert.equal(r2.headers.Authorization, 'Bearer at1', 'token cached');
  assert.equal(a.loginCount(), 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].path, '/oauth/token');
  assert.deepEqual(calls[0].form, { grant_type: 'client_credentials', client_id: 'test-client', client_secret: 'test-client-secret-value', scope: 'read write' });
  assert.equal(calls[0].body, undefined, 'form encoded, not JSON');
  assert.equal(a.shouldRefresh(401), true);
  assert.equal(a.shouldRefresh(403), false);
  a.invalidate();
  const r3 = await a.decorate({ method: 'GET', path: '/x', headers: {} });
  assert.equal(r3.headers.Authorization, 'Bearer at2');
  assert.equal(a.loginCount(), 2);
  assert.ok(a.secrets().includes('at1') && a.secrets().includes('at2'), 'issued tokens are secrets');
  // clientAuth basic: id and secret go in an Authorization header, never in the form.
  const b = createAuthenticator({ ...OAUTH, clientAuth: 'basic', audience: 'api://shop' }, readCredentials(OAUTH, OAUTH_ENV), transport);
  await b.decorate({ method: 'GET', path: '/x', headers: {} });
  const last = calls[calls.length - 1];
  assert.equal(last.headers?.Authorization, `Basic ${Buffer.from('test-client:test-client-secret-value').toString('base64')}`);
  assert.deepEqual(last.form, { grant_type: 'client_credentials', scope: 'read write', audience: 'api://shop' });
  assert.ok(b.secrets().includes(Buffer.from('test-client:test-client-secret-value').toString('base64')), 'the base64 client pair is a secret');
  // Failures throw with the reason, never an empty token.
  const bad = createAuthenticator(OAUTH, readCredentials(OAUTH, OAUTH_ENV), async () => ({ status: 401, text: '{"error":"invalid_client"}' }));
  await assert.rejects(bad.decorate({ method: 'GET', path: '/x', headers: {} }), /401/);
  const noToken = createAuthenticator(OAUTH, readCredentials(OAUTH, OAUTH_ENV), async () => ({ status: 200, text: '{"token_type":"Bearer"}' }));
  await assert.rejects(noToken.decorate({ method: 'GET', path: '/x', headers: {} }), /access_token/);
});

await check('oauth2_client through the HTTP layer: one token request, counted, recorded redacted; the token never leaks', async () => {
  seen.length = 0;
  oauthSeen.length = 0;
  issued.clear();
  await withClients(config(OAUTH), OAUTH_ENV, async (c) => {
    const exchanges: Exchange[] = [];
    const rc = recordClients(config(OAUTH), c, async (e) => {
      exchanges.push(e);
    });
    assert.equal((await rc.api.post('/items', { data: { name: 'a' } })).status(), 201);
    assert.equal((await rc.api.get('/whoami')).status(), 200);
    assert.equal(c.loginCount(), 1);
    assert.deepEqual(seen.map((s) => `${s.method} ${s.path}`), ['POST /oauth/token', 'POST /items', 'GET /whoami']);
    assert.match(oauthSeen[0].contentType, /application\/x-www-form-urlencoded/);
    assert.deepEqual([oauthSeen[0].grant, oauthSeen[0].scope, oauthSeen[0].basic], ['client_credentials', 'read write', false]);
    assert.match(seen[1].headers.authorization, /^Bearer oauth-tok-\d+$/);
    assert.equal(c.counter.sent, 3, 'the token request counts');
    const tokenReq = exchanges.find((e) => e.role === 'login');
    assert.ok(tokenReq, 'token exchange recorded');
    const { name, body } = formatExchange(config(OAUTH), tokenReq!, c.secrets());
    assert.equal(name, 'POST /oauth/token (auth login) -> 200');
    assert.ok(!body.includes('test-client-secret-value'), `client secret redacted: ${body}`);
    assert.ok(!body.includes('"test-client"'), `client id redacted: ${body}`);
    assert.ok(!/oauth-tok-\d/.test(body), `token redacted: ${body}`);
    const created = exchanges.find((e) => e.role === 'default' && e.method === 'POST');
    assert.ok(!/oauth-tok-\d/.test(formatExchange(config(OAUTH), created!, c.secrets()).body), 'token scrubbed from the echo');
    // noAuthApi sends nothing.
    assert.equal((await rc.noAuthApi.post('/items', { data: {} })).status(), 401);
    assert.equal(c.loginCount(), 1, 'noAuthApi never fetches a token');
  });
});

await check('oauth2_client: an expired token is refreshed once and the request re-sent', async () => {
  seen.length = 0;
  issued.clear();
  tokenCounter = 0;
  expireFirstToken = true;
  try {
    await withClients(config(OAUTH), OAUTH_ENV, async (c) => {
      assert.equal((await c.api.get('/whoami')).status(), 200);
      assert.deepEqual(seen.map((s) => `${s.method} ${s.path}`), ['POST /oauth/token', 'GET /whoami', 'POST /oauth/token', 'GET /whoami']);
      assert.equal(c.loginCount(), 2);
    });
  } finally {
    expireFirstToken = false;
  }
});

await check('oauth2_client: a production token URL is refused before any request; a missing variable is named', async () => {
  seen.length = 0;
  await assert.rejects(createClients(config({ ...OAUTH, tokenUrl: 'https://login.example.com/oauth/token' }), OAUTH_ENV), /login\.example\.com.*production/);
  assert.deepEqual(seen, []);
  await assert.rejects(createClients(config(OAUTH), { T_CLIENT_ID: 'test-client' }), /environment variable T_CLIENT_SECRET is not set \(role default\)/);
  assert.deepEqual(seen, []);
});

await check('guard: on a refused host no login request is sent; in read-only mode the login goes through but writes do not', async () => {
  seen.length = 0;
  await assert.rejects(createClients(config(LOGIN), LOGIN_ENV, { forceProduction: true }), ProductionRefused);
  assert.equal(seen.length, 0, 'no request at all, the login included');
  await withClients(config(LOGIN, { allowProduction: true }), LOGIN_ENV, async (c) => {
    assert.equal(c.safety.mode, 'read-only');
    assert.equal((await c.api.get('/whoami')).status(), 200);
    assert.deepEqual(seen.map((s) => `${s.method} ${s.path}`), ['POST /login', 'GET /whoami']);
    await assert.rejects(c.api.post('/items', { data: {} }), ReadOnlyBlocked);
    assert.equal(seen.length, 2, 'the blocked write never reached the server');
  }, { forceProduction: true });
});

await check('a missing credential variable fails before any request, naming the variable', async () => {
  seen.length = 0;
  await assert.rejects(createClients(config(LOGIN), { ...LOGIN_ENV, T_VIEWER_PASS: undefined }), /environment variable T_VIEWER_PASS is not set \(role viewer\)/);
  assert.deepEqual(seen, []);
});

await check('no auth section: api and noAuthApi are the same client, as() has no roles', async () => {
  await withClients(config(undefined), {}, async (c) => {
    assert.equal(c.api, c.noAuthApi);
    assert.deepEqual(c.roles, []);
    assert.equal((await c.api.get('/items')).status(), 200);
    assert.throws(() => c.as('viewer'), /unknown auth role/);
  });
});

server.close();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
