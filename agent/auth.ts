// Auth adapters: how a request proves who it is. No imports: both framework exports copy this file
// as src/auth.ts, so the agent, both ctx files and both exported frameworks share one implementation.
//
//   header  a fixed header value from the environment (the original and default type)
//   query   an API key in the query string
//   cookie  a fixed cookie value
//   login   a login request sends credentials from the environment, the token in its response is
//           cached for the run and applied as a header, cookie or query parameter; on a configured
//           status (401 by default) the login is repeated once and the request re-sent
//   oauth2_client  OAuth2 client credentials: a form-encoded POST to the token URL with
//           grant_type=client_credentials and the client id and secret from the environment (in the
//           body, or as HTTP Basic); the access token is cached and applied like a login token
//
// Roles: the main auth section is the "default" role. auth.roles adds more identities with their
// own environment variables (the same type as the main auth). Tests call ctx.as('<role>').
//
// Rule 6: credential values and tokens come only from the environment and never reach inputs,
// summaries, reports, exports or Claude. secrets() lists every value to scrub from evidence.

export type AuthQuery = Record<string, string | number | boolean>;

export type AuthApply =
  | { type: 'header'; header: string; prefix?: string }
  | { type: 'cookie'; name: string }
  | { type: 'query'; param: string };

export type LoginRequest = { method: string; path: string; body?: Record<string, unknown>; headers?: Record<string, string> };

// What a role supplies: the environment variable names for its own credentials.
export type RoleConfig = { valueEnv?: string; credentialsEnv?: Record<string, string>; clientIdEnv?: string; clientSecretEnv?: string };

export type OAuth2ClientConfig = {
  type: 'oauth2_client';
  tokenUrl: string; // a path on the API host (/oauth/token) or an absolute URL
  clientIdEnv: string;
  clientSecretEnv: string;
  scope?: string;
  audience?: string;
  clientAuth?: 'body' | 'basic'; // where the client id and secret go; default body
  tokenPath?: string; // default access_token
  apply?: AuthApply; // default header Authorization with the Bearer prefix
  refresh?: { statuses: number[]; once?: boolean }; // default [401], once
  roles?: Record<string, RoleConfig>;
};

export type AuthConfig =
  | { type: 'header'; header: string; valueEnv: string; roles?: Record<string, RoleConfig> }
  | { type: 'query'; param: string; valueEnv: string; roles?: Record<string, RoleConfig> }
  | { type: 'cookie'; name: string; valueEnv: string; roles?: Record<string, RoleConfig> }
  | {
      type: 'login';
      request: LoginRequest;
      credentialsEnv: Record<string, string>;
      tokenPath: string;
      apply: AuthApply;
      refresh?: { statuses: number[]; once?: boolean };
      roles?: Record<string, RoleConfig>;
    }
  | OAuth2ClientConfig;

// The form fields an OAuth2 client credentials login sends, in field order.
export const OAUTH2_ID_FIELD = 'client_id';
export const OAUTH2_SECRET_FIELD = 'client_secret';
export const OAUTH2_DEFAULT_TOKEN_PATH = 'access_token';
export const OAUTH2_DEFAULT_APPLY: AuthApply = { type: 'header', header: 'Authorization', prefix: 'Bearer ' };

export function oauth2TokenPath(auth: OAuth2ClientConfig): string {
  return auth.tokenPath || OAUTH2_DEFAULT_TOKEN_PATH;
}
export function oauth2Apply(auth: OAuth2ClientConfig): AuthApply {
  return auth.apply ?? OAUTH2_DEFAULT_APPLY;
}
// The client id and secret variable names for one role.
function oauth2EnvPair(auth: OAuth2ClientConfig, role: string): { id?: string; secret?: string } {
  if (role === DEFAULT_ROLE) return { id: auth.clientIdEnv, secret: auth.clientSecretEnv };
  const r = auth.roles?.[role];
  return { id: r?.clientIdEnv, secret: r?.clientSecretEnv };
}

export const DEFAULT_ROLE = 'default';
export const REDACTED = '<redacted>';

// An auth section without "type" is the original header form.
export function normalizeAuth(raw: unknown): AuthConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') throw new Error('auth must be an object');
  const a = raw as Record<string, unknown>;
  if (a.type === undefined) return { ...a, type: 'header' } as AuthConfig;
  return a as AuthConfig;
}

export function authRoles(auth: AuthConfig | undefined): string[] {
  if (!auth) return [];
  return [DEFAULT_ROLE, ...Object.keys(auth.roles ?? {})];
}

export function extraRoles(auth: AuthConfig | undefined): string[] {
  return authRoles(auth).filter((r) => r !== DEFAULT_ROLE);
}

// The environment variable names one role needs.
export function authEnvNames(auth: AuthConfig, role: string = DEFAULT_ROLE): string[] {
  if (auth.type === 'oauth2_client') {
    if (role !== DEFAULT_ROLE && !auth.roles?.[role]) throw new Error(`unknown auth role "${role}" (roles: ${extraRoles(auth).join(', ') || 'none'})`);
    const pair = oauth2EnvPair(auth, role);
    return [pair.id, pair.secret].filter((n): n is string => Boolean(n));
  }
  if (role === DEFAULT_ROLE) return auth.type === 'login' ? Object.values(auth.credentialsEnv) : [auth.valueEnv];
  const r = auth.roles?.[role];
  if (!r) throw new Error(`unknown auth role "${role}" (roles: ${extraRoles(auth).join(', ') || 'none'})`);
  if (auth.type === 'login') return Object.values(r.credentialsEnv ?? {});
  return r.valueEnv ? [r.valueEnv] : [];
}

// Every environment variable name the auth section needs, all roles included, in order.
export function allAuthEnvNames(auth: AuthConfig | undefined): string[] {
  if (!auth) return [];
  const names: string[] = [];
  for (const role of authRoles(auth)) for (const n of authEnvNames(auth, role)) if (!names.includes(n)) names.push(n);
  return names;
}

export type Credentials = { role: string; value?: string; fields?: Record<string, string> };

// Reads one role's credential values from env. Throws naming the missing variable.
export function readCredentials(auth: AuthConfig, env: Record<string, string | undefined>, role: string = DEFAULT_ROLE): Credentials {
  const missing = (name: string) => new Error(`Missing auth value: environment variable ${name} is not set (role ${role}). Add it to .env.`);
  if (auth.type === 'oauth2_client') {
    const pair = oauth2EnvPair(auth, role);
    if (!pair.id || !pair.secret) throw new Error(`auth role "${role}" needs clientIdEnv and clientSecretEnv`);
    const id = env[pair.id];
    if (!id) throw missing(pair.id);
    const secret = env[pair.secret];
    if (!secret) throw missing(pair.secret);
    return { role, fields: { [OAUTH2_ID_FIELD]: id, [OAUTH2_SECRET_FIELD]: secret } };
  }
  if (auth.type === 'login') {
    const map = role === DEFAULT_ROLE ? auth.credentialsEnv : (auth.roles?.[role]?.credentialsEnv ?? {});
    const fields: Record<string, string> = {};
    for (const [field, name] of Object.entries(map)) {
      const value = env[name];
      if (!value) throw missing(name);
      fields[field] = value;
    }
    return { role, fields };
  }
  const name = role === DEFAULT_ROLE ? auth.valueEnv : auth.roles?.[role]?.valueEnv;
  if (!name) throw new Error(`auth role "${role}" has no valueEnv`);
  const value = env[name];
  if (!value) throw missing(name);
  return { role, value };
}

// Only the variables the auth section names, copied out of a larger environment.
export function pickAuthEnv(auth: AuthConfig | undefined, env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const name of allAuthEnvNames(auth)) out[name] = env[name];
  return out;
}

// Every credential value present in env, all roles.
export function credentialValues(auth: AuthConfig | undefined, env: Record<string, string | undefined>): string[] {
  return allAuthEnvNames(auth)
    .map((n) => env[n])
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
}

// A login field whose value is a secret (password, token, key, ...). A username is a credential
// too, but a plain word like "admin" cannot be scrubbed from every report without breaking it; the
// login request evidence redacts every credential field instead (redactLoginRequest).
export function isSecretField(field: string): boolean {
  return /pass|pwd|secret|token|key|credential|otp|pin/i.test(field);
}

// The credential values to scrub from every text: header, query and cookie values, and the secret
// login fields of every role. Tokens are added by the authenticators as logins happen.
export function secretValues(auth: AuthConfig | undefined, env: Record<string, string | undefined>): string[] {
  if (!auth) return [];
  const names: string[] = [];
  for (const role of authRoles(auth)) {
    if (auth.type === 'oauth2_client') {
      const secret = oauth2EnvPair(auth, role).secret;
      if (secret) names.push(secret);
      continue;
    }
    if (auth.type !== 'login') {
      names.push(...authEnvNames(auth, role));
      continue;
    }
    const map = role === DEFAULT_ROLE ? auth.credentialsEnv : (auth.roles?.[role]?.credentialsEnv ?? {});
    for (const [field, name] of Object.entries(map)) if (isSecretField(field)) names.push(name);
  }
  return [...new Set(names)].map((n) => env[n]).filter((v): v is string => typeof v === 'string' && v.length > 0);
}

// The login request body for evidence: every credential field shown as <redacted>.
export function redactLoginRequest(auth: AuthConfig | undefined, body: unknown): unknown {
  if (!auth || body === null || typeof body !== 'object') return body;
  const out: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  if (auth.type === 'oauth2_client') {
    for (const f of [OAUTH2_ID_FIELD, OAUTH2_SECRET_FIELD]) if (f in out) out[f] = REDACTED;
    return out;
  }
  if (auth.type !== 'login') return body;
  const fields = new Set(Object.keys(auth.credentialsEnv));
  for (const r of Object.values(auth.roles ?? {})) for (const f of Object.keys(r.credentialsEnv ?? {})) fields.add(f);
  for (const f of fields) if (f in out) out[f] = REDACTED;
  return out;
}

// Dot path into a parsed JSON body: "data.token", "tokens.0.value".
export function tokenAt(body: unknown, path: string): string | undefined {
  let cur: unknown = body;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === 'string' && cur.length > 0 ? cur : typeof cur === 'number' ? String(cur) : undefined;
}

// form: a form-encoded body (OAuth2 token requests); body: a JSON body. A transport sends one or the other.
export type AuthRequest = { method: string; path: string; headers: Record<string, string>; query?: AuthQuery; body?: unknown; form?: Record<string, string> };
export type AuthResponse = { status: number; text: string };
// Sends the login request. Must go through the framework's guarded request path so it is counted and recorded.
export type Transport = (req: AuthRequest) => Promise<AuthResponse>;

export type Authenticator = {
  role: string;
  type: AuthConfig['type'];
  // Adds this role's credentials to a request, logging in first when needed.
  decorate(req: AuthRequest): Promise<AuthRequest>;
  // True when a response status means the token should be refreshed and the request sent again.
  // A request is retried at most once.
  shouldRefresh(status: number): boolean;
  // Drops the cached token so the next decorate logs in again.
  invalidate(): void;
  // Every secret value this role has seen: secret credential values and tokens.
  secrets(): string[];
  // Login requests made so far (0 for non-login types).
  loginCount(): number;
};

function applyTo(req: AuthRequest, apply: AuthApply, value: string): AuthRequest {
  if (apply.type === 'header') return { ...req, headers: { ...req.headers, [apply.header]: `${apply.prefix ?? ''}${value}` } };
  if (apply.type === 'cookie') {
    const existing = req.headers.Cookie ?? req.headers.cookie;
    const cookie = `${apply.name}=${value}`;
    const headers = { ...req.headers };
    delete headers.cookie;
    headers.Cookie = existing ? `${existing}; ${cookie}` : cookie;
    return { ...req, headers };
  }
  return { ...req, query: { ...(req.query ?? {}), [apply.param]: value } };
}

export function createAuthenticator(auth: AuthConfig, creds: Credentials, transport: Transport): Authenticator {
  const seen = new Set<string>();
  if (creds.value) seen.add(creds.value);
  for (const [field, v] of Object.entries(creds.fields ?? {})) if (isSecretField(field)) seen.add(v);

  if (auth.type === 'oauth2_client') return createOAuth2Authenticator(auth, creds, transport, seen);

  if (auth.type !== 'login') {
    const apply: AuthApply =
      auth.type === 'header' ? { type: 'header', header: auth.header } : auth.type === 'cookie' ? { type: 'cookie', name: auth.name } : { type: 'query', param: auth.param };
    const value = creds.value ?? '';
    return {
      role: creds.role,
      type: auth.type,
      decorate: async (req) => applyTo(req, apply, value),
      shouldRefresh: () => false,
      invalidate: () => {},
      secrets: () => [...seen],
      loginCount: () => 0,
    };
  }

  let token: string | null = null;
  let inflight: Promise<string> | null = null;
  let logins = 0;
  const statuses = new Set(auth.refresh?.statuses ?? []);

  const login = async (): Promise<string> => {
    logins++;
    const body = { ...(auth.request.body ?? {}), ...(creds.fields ?? {}) };
    const res = await transport({
      method: auth.request.method.toUpperCase(),
      path: auth.request.path,
      headers: { ...(auth.request.headers ?? {}) },
      body,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`auth login (${auth.request.method.toUpperCase()} ${auth.request.path}, role ${creds.role}) failed: status ${res.status}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.text);
    } catch {
      throw new Error(`auth login (role ${creds.role}): response is not JSON, so tokenPath "${auth.tokenPath}" cannot be read`);
    }
    const value = tokenAt(parsed, auth.tokenPath);
    if (!value) throw new Error(`auth login (role ${creds.role}): no token at tokenPath "${auth.tokenPath}" in the response`);
    seen.add(value);
    return value;
  };

  const getToken = async (): Promise<string> => {
    if (token) return token;
    if (!inflight) {
      inflight = login().finally(() => {
        inflight = null;
      });
    }
    token = await inflight;
    return token;
  };

  return {
    role: creds.role,
    type: 'login',
    decorate: async (req) => applyTo(req, auth.apply, await getToken()),
    shouldRefresh: (status) => statuses.has(status),
    invalidate: () => {
      token = null;
    },
    secrets: () => [...seen],
    loginCount: () => logins,
  };
}

// OAuth2 client credentials: POST tokenUrl with a form body (grant_type=client_credentials and the
// client id and secret, or those two as HTTP Basic), the access token at tokenPath cached for the run.
function createOAuth2Authenticator(auth: OAuth2ClientConfig, creds: Credentials, transport: Transport, seen: Set<string>): Authenticator {
  let token: string | null = null;
  let inflight: Promise<string> | null = null;
  let logins = 0;
  const statuses = new Set(auth.refresh?.statuses ?? [401]);
  const clientId = creds.fields?.[OAUTH2_ID_FIELD] ?? '';
  const clientSecret = creds.fields?.[OAUTH2_SECRET_FIELD] ?? '';
  const basic = toBase64(`${clientId}:${clientSecret}`);
  if (auth.clientAuth === 'basic') seen.add(basic);
  const path = oauth2TokenPath(auth);

  const login = async (): Promise<string> => {
    logins++;
    const form: Record<string, string> = { grant_type: 'client_credentials' };
    if (auth.scope) form.scope = auth.scope;
    if (auth.audience) form.audience = auth.audience;
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    if (auth.clientAuth === 'basic') headers.Authorization = `Basic ${basic}`;
    else {
      form[OAUTH2_ID_FIELD] = clientId;
      form[OAUTH2_SECRET_FIELD] = clientSecret;
    }
    const res = await transport({ method: 'POST', path: auth.tokenUrl, headers, form });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`oauth2 token request (POST ${auth.tokenUrl}, role ${creds.role}) failed: status ${res.status}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.text);
    } catch {
      throw new Error(`oauth2 token request (role ${creds.role}): response is not JSON, so tokenPath "${path}" cannot be read`);
    }
    const value = tokenAt(parsed, path);
    if (!value) throw new Error(`oauth2 token request (role ${creds.role}): no token at tokenPath "${path}" in the response`);
    seen.add(value);
    return value;
  };

  const getToken = async (): Promise<string> => {
    if (token) return token;
    if (!inflight) {
      inflight = login().finally(() => {
        inflight = null;
      });
    }
    token = await inflight;
    return token;
  };

  return {
    role: creds.role,
    type: 'oauth2_client',
    decorate: async (req) => applyTo(req, oauth2Apply(auth), await getToken()),
    shouldRefresh: (status) => statuses.has(status),
    invalidate: () => {
      token = null;
    },
    secrets: () => [...seen],
    loginCount: () => logins,
  };
}

// Base64 without Buffer, so this file keeps working wherever it is copied (Node and browsers).
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

// Header names whose values are shown as <redacted> in evidence, lowercase.
export function sensitiveHeaderNames(auth: AuthConfig | undefined): string[] {
  const names = new Set<string>(['authorization', 'proxy-authorization', 'cookie', 'set-cookie']);
  if (auth) {
    if (auth.type === 'header') names.add(auth.header.toLowerCase());
    if (auth.type === 'login' && auth.apply.type === 'header') names.add(auth.apply.header.toLowerCase());
    if (auth.type === 'oauth2_client') {
      const apply = oauth2Apply(auth);
      if (apply.type === 'header') names.add(apply.header.toLowerCase());
    }
  }
  return [...names];
}

// Query parameter names whose values are shown as <redacted> in evidence.
export function sensitiveQueryParams(auth: AuthConfig | undefined): string[] {
  if (!auth) return [];
  if (auth.type === 'query') return [auth.param];
  if (auth.type === 'login' && auth.apply.type === 'query') return [auth.apply.param];
  if (auth.type === 'oauth2_client') {
    const apply = oauth2Apply(auth);
    if (apply.type === 'query') return [apply.param];
  }
  return [];
}

export function redactHeaders(auth: AuthConfig | undefined, headers: Record<string, string>): Record<string, string> {
  const names = new Set(sensitiveHeaderNames(auth));
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, names.has(k.toLowerCase()) ? REDACTED : v]));
}

// Replaces every secret value in a text, longest first so a token inside a longer value is caught.
export function scrubSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const s of [...new Set(secrets)].filter((s) => s.length > 0).sort((a, b) => b.length - a.length)) out = out.split(s).join(REDACTED);
  return out;
}

// The login response with the token at tokenPath replaced, for evidence written before the
// authenticator has read the token. Not JSON: returned as it is (there is no token to read then).
export function redactLoginResponse(auth: AuthConfig | undefined, text: string): string {
  if (!auth || (auth.type !== 'login' && auth.type !== 'oauth2_client') || !text) return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  const value = tokenAt(parsed, auth.type === 'login' ? auth.tokenPath : oauth2TokenPath(auth));
  return value ? text.split(value).join(REDACTED) : text;
}

// True for the auth types that log in (send a request for a token) before the first API request.
export function logsIn(auth: AuthConfig | undefined): boolean {
  return auth?.type === 'login' || auth?.type === 'oauth2_client';
}

// A path with a sensitive query parameter value replaced, for evidence names and logs.
export function redactQuery(auth: AuthConfig | undefined, path: string): string {
  const params = sensitiveQueryParams(auth);
  if (!params.length) return path;
  const q = path.indexOf('?');
  if (q < 0) return path;
  const pairs = path
    .slice(q + 1)
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      const key = eq < 0 ? pair : pair.slice(0, eq);
      let name = key;
      try {
        name = decodeURIComponent(key);
      } catch {
        name = key;
      }
      return params.includes(name) ? `${key}=${REDACTED}` : pair;
    });
  return `${path.slice(0, q)}?${pairs.join('&')}`;
}

// A short description of what one role needs, for README and error text. Names only, never values.
export function describeAuth(auth: AuthConfig | undefined): string {
  if (!auth) return 'No auth is needed for this API.';
  const roles = extraRoles(auth);
  const roleText = roles.length ? ` Extra roles: ${roles.join(', ')} (their own variables, same type).` : '';
  switch (auth.type) {
    case 'header':
      return `Header ${auth.header} from ${auth.valueEnv}.${roleText}`;
    case 'query':
      return `Query parameter ${auth.param} from ${auth.valueEnv}.${roleText}`;
    case 'cookie':
      return `Cookie ${auth.name} from ${auth.valueEnv}.${roleText}`;
    case 'login': {
      const fields = Object.entries(auth.credentialsEnv)
        .map(([f, n]) => `${f} from ${n}`)
        .join(', ');
      const where =
        auth.apply.type === 'header' ? `header ${auth.apply.header}` : auth.apply.type === 'cookie' ? `cookie ${auth.apply.name}` : `query parameter ${auth.apply.param}`;
      return `Login ${auth.request.method.toUpperCase()} ${auth.request.path} with ${fields}; token at ${auth.tokenPath}, sent as ${where}.${roleText}`;
    }
    case 'oauth2_client': {
      const apply = oauth2Apply(auth);
      const where = apply.type === 'header' ? `header ${apply.header}` : apply.type === 'cookie' ? `cookie ${apply.name}` : `query parameter ${apply.param}`;
      const how = auth.clientAuth === 'basic' ? 'as HTTP Basic' : 'in the form body';
      return `OAuth2 client credentials: POST ${auth.tokenUrl} with client id from ${auth.clientIdEnv} and secret from ${auth.clientSecretEnv} ${how}${auth.scope ? `, scope ${auth.scope}` : ''}; token at ${oauth2TokenPath(auth)}, sent as ${where}.${roleText}`;
    }
  }
}
