import { z } from 'zod';
import { ConfigSchema, configProblems, zodProblems, type Config, type Endpoint } from '../config';

// Shared importer logic. Each importer turns its source into RawRequest entries; buildInput turns them
// into the input file shape (validated with the config schema), plus skipped items and warnings.
// Credentials are removed here, and their values never leave this module: not in the input, not in
// skipped items, not in warnings, not in errors.

export class ImportError extends Error {}

export type Skipped = { item: string; reason: string };
export type ImportResult = { input: Config; skipped: Skipped[]; warnings: string[] };

// declared: the source says auth is needed (OpenAPI security, a ticket text) but held no value.
export type Credential = { name: string; where: 'header' | 'query'; value?: string; declared?: boolean };
export type RawBody = { text: string; contentType?: string } | { json: unknown } | { unsupported: string };

export type RawRequest = {
  item: string; // label for skipped entries; buildInput adds the method and the cleaned URL
  method: string;
  url: string; // absolute http(s) URL, or a path starting with / when the source has no origin
  headers?: { name: string; value: string }[];
  body?: RawBody;
  credentials?: Credential[]; // found outside headers and query (Postman auth block, curl -u, ...)
  requiresAuth?: boolean; // stated by the source (OpenAPI security, text)
  unresolved?: string; // an unresolved variable the importer found in the URL, e.g. a shell $VAR
};

export type BuildOptions = {
  name?: string;
  skipped?: Skipped[];
  warnings?: string[];
  secrets?: string[]; // extra values that must never appear in the output
  authHeader?: string; // header name when endpoints require auth but no credential was seen
  noBaseUrlWarning?: string; // replaces the generic warning when no origin was found
  noEndpointsMessage?: string; // replaces the start of the error when nothing could be imported
};

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
type Method = (typeof METHODS)[number];

export const VALUE_ENV = 'CUSTOM_API_AUTH';
export const AUTH_REMOVED = 'Auth value removed. Enter it in the auth field before running.';
export const AUTH_NEEDED = 'This API needs auth. Enter the auth header value in the auth field before running.';
const NO_BASE_URL = 'No base URL in the source. Enter the base URL before running.';
const REMOVED = '<removed>';
const DEFAULT_HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json' };

// The import may leave baseUrl empty for the user to fill in; everything else is the config schema.
const ImportSchema = ConfigSchema.extend({ baseUrl: z.union([z.literal(''), ConfigSchema.shape.baseUrl]) });

// Headers that tools and browsers add on their own. Not part of the API, so not worth a warning.
const TRANSPORT_HEADERS = new Set([
  'accept', 'content-type', 'content-length', 'host', 'connection', 'keep-alive', 'accept-encoding',
  'accept-language', 'user-agent', 'origin', 'referer', 'pragma', 'cache-control', 'dnt', 'priority',
  'te', 'upgrade-insecure-requests', 'if-none-match', 'if-modified-since', 'expect', 'postman-token',
]);

const VARIABLE = /\{\{\s*([^{}]+?)\s*\}\}/;

// CLAUDE.md rule 6: Authorization, Cookie, and any header whose name contains auth, token, key,
// secret or session. Postman-Token is a random request id Postman adds, not a credential.
export function isCredentialHeader(name: string): boolean {
  const n = name.toLowerCase();
  if (n === 'postman-token') return false;
  return n === 'authorization' || n === 'proxy-authorization' || n === 'cookie' || /auth|token|key|secret|session/.test(n);
}

const SECRET_WORDS = new Set([
  'auth', 'authorization', 'token', 'secret', 'password', 'passwd', 'pwd', 'apikey', 'session', 'sessionid',
  'sid', 'cookie', 'jwt', 'bearer', 'credential', 'credentials', 'signature', 'sig',
]);

// Names like token, apiKey, access_token, client_secret, sessionId. Not author, keyword or monkey.
export function looksLikeSecretName(name: string): boolean {
  const n = name.toLowerCase();
  if (n.split(/[^a-z0-9]+/).some((part) => SECRET_WORDS.has(part))) return true;
  return /(token|secret|password|passwd|apikey|auth|cookie|session|jwt)$/.test(n.replace(/[^a-z0-9]/g, ''));
}

// Query parameters named like api_key, key, token or access_token.
export function isCredentialParam(name: string): boolean {
  return looksLikeSecretName(name) || name.toLowerCase().split(/[^a-z0-9]+/).includes('key');
}

// The value plus the parts of it that are secret on their own: the token after "Bearer ", the
// decoded "user:password" of Basic auth, cookie values, the password of user:password.
function secretVariants(value: string): string[] {
  const out = [value];
  const scheme = value.match(/^\s*(bearer|basic|token|digest|apikey)\s+(\S+)\s*$/i);
  if (scheme) {
    out.push(scheme[2]);
    if (scheme[1].toLowerCase() === 'basic') {
      const decoded = Buffer.from(scheme[2], 'base64').toString('utf8');
      out.push(decoded, decoded.slice(decoded.indexOf(':') + 1));
    }
  }
  for (const part of value.split(/[;&]/)) {
    const eq = part.indexOf('=');
    if (eq > 0) out.push(part.slice(eq + 1));
  }
  if (/^[^:\s/]+:\S+$/.test(value)) out.push(value.slice(value.indexOf(':') + 1));
  return out.map((s) => s.trim()).filter((s) => s.length >= 6);
}

export function slugName(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 40).replace(/-+$/, '');
}

// get-products-id for GET /products/{id}
export function slugId(method: string, pathname: string): string {
  return `${method} ${pathname}`.toLowerCase().replace(/[{}]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    return text;
  }
}

// Line and column of a parse error, for messages that must not quote the source.
export function lineAndColumn(content: string, position: number): string {
  const before = content.slice(0, position);
  const line = before.split('\n').length;
  return `line ${line}, column ${position - before.lastIndexOf('\n')}`;
}

class JsonSyntax {
  constructor(readonly at: number) {}
}

// Offset of the first JSON syntax error, or -1. Used instead of the engine's error message, which
// quotes part of the source (and so may quote a credential).
function jsonErrorOffset(text: string): number {
  let i = 0;
  const fail = (): never => {
    throw new JsonSyntax(i);
  };
  const ws = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i])) i++;
  };
  const string = () => {
    for (i++; i < text.length && text[i] !== '"'; i++) {
      if (text[i] === '\\') i++;
      else if (text[i] < ' ') fail();
    }
    if (i >= text.length) fail();
    i++;
  };
  const value = (): void => {
    ws();
    const c = text[i];
    if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']';
      i++;
      ws();
      if (text[i] === close) {
        i++;
        return;
      }
      for (;;) {
        if (c === '{') {
          ws();
          if (text[i] !== '"') fail();
          string();
          ws();
          if (text[i] !== ':') fail();
          i++;
        }
        value();
        ws();
        if (text[i] === ',') i++;
        else if (text[i] === close) {
          i++;
          return;
        } else fail();
      }
    }
    if (c === '"') return string();
    const literal = text.slice(i, i + 40).match(/^(true|false|null|-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?)/);
    if (!literal) fail();
    i += literal![0].length;
  };
  try {
    value();
    ws();
    if (i < text.length) fail();
    return -1;
  } catch (err) {
    return err instanceof JsonSyntax ? err.at : -1;
  }
}

export function parseJsonSource(content: string, what: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    const at = jsonErrorOffset(content);
    throw new ImportError(`${what} is not valid JSON${at >= 0 ? ` (${lineAndColumn(content, at)})` : ''}.`);
  }
}

type CleanUrl = {
  display: string; // the URL without credentials, safe for labels
  origin: string | null;
  pathname: string;
  query: string;
  problem?: string;
};

// Removes credentials from the URL first (userinfo and credential query parameters), then splits it.
function cleanUrl(url: string, creds: Credential[]): CleanUrl {
  let text = url.trim().replace(/#.*$/, '');
  const q = text.indexOf('?');
  const beforeQuery = q >= 0 ? text.slice(0, q) : text;
  const keptParams: string[] = [];
  for (const pair of (q >= 0 ? text.slice(q + 1) : '').split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const name = safeDecode(eq >= 0 ? pair.slice(0, eq) : pair);
    if (isCredentialParam(name)) creds.push({ name, where: 'query', value: eq >= 0 ? safeDecode(pair.slice(eq + 1)) : undefined });
    else keptParams.push(pair);
  }
  let base = beforeQuery;
  const userinfo = base.match(/^([a-z][a-z0-9+.-]*:\/\/)([^/@]*)@/i);
  if (userinfo) {
    creds.push({ name: 'Authorization', where: 'header', value: safeDecode(userinfo[2]) });
    base = userinfo[1] + base.slice(userinfo[0].length);
  }
  const query = keptParams.join('&');
  text = query ? `${base}?${query}` : base;
  const result: CleanUrl = { display: text, origin: null, pathname: '/', query };

  let pathname = base;
  const abs = base.match(/^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)(.*)$/i);
  if (abs) {
    const variable = (abs[1] + abs[2]).match(VARIABLE);
    if (variable) return { ...result, problem: `unresolved variable {{${variable[1]}}} in URL` };
    if (!/^https?$/i.test(abs[1])) return { ...result, problem: `unsupported URL scheme ${abs[1]}` };
    try {
      result.origin = new URL(`${abs[1]}://${abs[2]}`).origin;
    } catch {
      return { ...result, problem: 'invalid host in URL' };
    }
    pathname = abs[3];
  } else if (!base.startsWith('/')) {
    const variable = base.match(VARIABLE);
    if (variable && base.startsWith(variable[0])) return { ...result, problem: `unresolved variable {{${variable[1]}}} in URL` };
    return { ...result, problem: 'URL has no http:// or https:// origin' };
  }

  // Path params: Postman :id, {{id}} (no value) and OpenAPI {id} all become {id}.
  const segments = pathname.replace(/%7B/gi, '{').replace(/%7D/gi, '}').split('/').map((seg) => {
    const whole = seg.match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
    if (whole) return `{${whole[1]}}`;
    if (/^:[A-Za-z_][A-Za-z0-9_-]*$/.test(seg)) return `{${seg.slice(1)}}`;
    return seg;
  });
  pathname = segments.join('/') || '/';
  if (!pathname.startsWith('/')) pathname = `/${pathname}`;
  if (pathname.length > 1) pathname = pathname.replace(/\/+$/, '') || '/';
  const variable = `${pathname}?${query}`.match(VARIABLE);
  if (variable) return { ...result, problem: `unresolved variable {{${variable[1]}}} in URL` };
  return { ...result, pathname };
}

type BodyResult = { value?: Record<string, unknown>; problem?: string };

function parseBody(body: RawBody | undefined): BodyResult {
  if (!body) return {};
  if ('unsupported' in body) return { problem: `non-JSON body (${body.unsupported})` };
  let value: unknown;
  if ('json' in body) value = body.json;
  else {
    if (body.text.trim() === '') return {};
    const type = (body.contentType ?? '').split(';')[0].trim();
    try {
      value = JSON.parse(body.text);
    } catch {
      return { problem: /json/i.test(type) ? 'body is not valid JSON' : `non-JSON body (${type || 'plain text'})` };
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { problem: 'JSON body is not an object (input files support object bodies only)' };
  }
  return { value: value as Record<string, unknown> };
}

// Replaces every secret value in strings anywhere in value. Records where it happened.
function scrub<T>(value: T, secrets: string[], where: string, hits: Set<string>): T {
  if (typeof value === 'string') {
    let out: string = value;
    for (const s of secrets) {
      if (out.includes(s)) {
        out = out.split(s).join(REMOVED);
        hits.add(where);
      }
    }
    return out as T;
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, secrets, where, hits)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [scrub(k, secrets, where, hits), scrub(v, secrets, where, hits)]),
    ) as T;
  }
  return value;
}

function countLabel(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function noEndpointsMessage(skipped: Skipped[], start: string): string {
  if (!skipped.length) return `${start}.`;
  const byReason = new Map<string, number>();
  for (const s of skipped) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
  const reasons = [...byReason].map(([reason, n]) => `${n} x ${reason}`).join('; ');
  return `${start}: ${countLabel(skipped.length, 'item')} skipped (${reasons}).`;
}

type Kept = {
  label: string;
  method: Method;
  origin: string | null;
  pathname: string;
  query: string;
  body?: Record<string, unknown>;
  requiresAuth: boolean;
  credentials: Credential[];
  extraHeaders: string[];
};

export function buildInput(requests: RawRequest[], opts: BuildOptions = {}): ImportResult {
  const skipped: Skipped[] = [...(opts.skipped ?? [])];
  const warnings: string[] = [...(opts.warnings ?? [])];
  const secretSet = new Set<string>((opts.secrets ?? []).flatMap(secretVariants));
  const kept: Kept[] = [];

  for (const r of requests) {
    // Credentials come out first, so nothing below (labels included) can contain one.
    const credentials: Credential[] = [...(r.credentials ?? [])];
    const extraHeaders: string[] = [];
    for (const h of r.headers ?? []) {
      // HTTP/2 pseudo-headers (:authority, :path) in browser captures are not request headers.
      if (!h.name || h.name.startsWith(':')) continue;
      if (isCredentialHeader(h.name)) credentials.push({ name: h.name, where: 'header', value: h.value });
      else if (!TRANSPORT_HEADERS.has(h.name.toLowerCase()) && !/^sec-/i.test(h.name)) extraHeaders.push(h.name);
    }
    const url = cleanUrl(r.url, credentials);
    for (const c of credentials) if (c.value) for (const v of secretVariants(c.value)) secretSet.add(v);

    const method = r.method.trim().toUpperCase();
    const label = `${r.item} (${method} ${url.display})`;
    const skip = (reason: string) => skipped.push({ item: label, reason });
    if (!(METHODS as readonly string[]).includes(method)) {
      skip(`method ${method} is not supported (GET, POST, PUT, PATCH, DELETE only)`);
      continue;
    }
    if (r.unresolved) {
      skip(`unresolved variable ${r.unresolved} in URL`);
      continue;
    }
    if (url.problem) {
      skip(url.problem);
      continue;
    }
    const body = parseBody(r.body);
    if (body.problem) {
      skip(body.problem);
      continue;
    }
    kept.push({
      label,
      method: method as Method,
      origin: url.origin,
      pathname: url.pathname,
      query: url.query,
      body: body.value,
      requiresAuth: Boolean(r.requiresAuth) || credentials.length > 0,
      credentials,
      extraHeaders,
    });
  }

  // Base URL: the most common origin. Ties go to the one seen first.
  const originCounts = new Map<string, number>();
  for (const k of kept) if (k.origin) originCounts.set(k.origin, (originCounts.get(k.origin) ?? 0) + 1);
  let baseUrl = '';
  for (const [origin, n] of originCounts) if (!baseUrl || n > originCounts.get(baseUrl)!) baseUrl = origin;
  const onBase = kept.filter((k) => {
    if (k.origin && k.origin !== baseUrl) {
      skipped.push({ item: k.label, reason: `origin ${k.origin} differs from the base URL ${baseUrl}` });
      return false;
    }
    return true;
  });
  if (!baseUrl && onBase.length) warnings.push(opts.noBaseUrlWarning ?? NO_BASE_URL);

  // Ids: lowercase slug of method and path, unique with -2, -3 on collision.
  const used = new Set<string>();
  const endpoints: Endpoint[] = onBase.map((k) => {
    const base = slugId(k.method, k.pathname) || k.method.toLowerCase();
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return {
      id,
      method: k.method,
      path: k.query ? `${k.pathname}?${k.query}` : k.pathname,
      requiresAuth: k.requiresAuth,
      ...(k.body ? { body: k.body } : {}),
    };
  });

  // Setup: a path with a placeholder gets a resource from the POST on its parent collection path.
  const setupUsers = new Map<string, string[]>();
  onBase.forEach((k, i) => {
    const segments = k.pathname.split('/');
    const first = segments.findIndex((seg) => /\{[^}]+\}/.test(seg));
    if (first < 0) return;
    const ep = endpoints[i];
    if ((k.pathname.match(/\{[^}]+\}/g) ?? []).length > 1) {
      warnings.push(`${ep.id}: path has more than one placeholder; setup fills only the first one.`);
    }
    const parent = segments.slice(0, first).join('/') || '/';
    const creator = onBase.findIndex((c, j) => j !== i && c.method === 'POST' && c.pathname === parent);
    if (creator < 0) {
      warnings.push(`${ep.id} needs setup: its path has a placeholder but there is no POST ${parent} to create the resource first.`);
      return;
    }
    const creatorId = endpoints[creator].id;
    ep.setup = { endpointId: creatorId, idField: 'id' };
    setupUsers.set(creatorId, [...(setupUsers.get(creatorId) ?? []), ep.id]);
  });
  for (const [creatorId, users] of setupUsers) {
    warnings.push(
      `Setup added: ${users.join(', ')} first create${users.length === 1 ? 's' : ''} a resource with ${creatorId} and read${users.length === 1 ? 's' : ''} its id from the "id" field. Check that ${creatorId} returns the new id as "id" (idField).`,
    );
  }

  // Auth: one header for the whole input. The most common credential name wins.
  let auth: Config['auth'];
  const authUsers = onBase.filter((k) => k.requiresAuth);
  if (authUsers.length) {
    const names = new Map<string, { name: string; where: Credential['where']; count: number }>();
    for (const k of authUsers) {
      const seen = new Set<string>();
      for (const c of k.credentials) {
        const key = `${c.where}:${c.name.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const entry = names.get(key) ?? { name: c.name, where: c.where, count: 0 };
        entry.count++;
        names.set(key, entry);
      }
    }
    const ranked = [...names.values()].sort((a, b) => b.count - a.count);
    const chosen = ranked[0];
    const canonical = (n: string) => ({ authorization: 'Authorization', cookie: 'Cookie' })[n.toLowerCase()] ?? n;
    const header = chosen ? canonical(chosen.name) : opts.authHeader ?? 'Authorization';
    auth = { header, valueEnv: VALUE_ENV };
    const removed = authUsers.some((k) => k.credentials.some((c) => !c.declared));
    warnings.push(removed ? AUTH_REMOVED : AUTH_NEEDED);
    if (ranked.length > 1) {
      const list = ranked.map((e) => (e.where === 'query' ? `query parameter ${e.name}` : canonical(e.name))).join(', ');
      warnings.push(
        `Credentials used more than one name (${list}). Kept ${header}, used by ${chosen.count} of ${authUsers.length} requests that need auth; requests that used another name may fail their auth check.`,
      );
    }
    if (chosen?.where === 'query') {
      warnings.push(`The credential was sent as the query parameter ${chosen.name}, but the agent sends auth as a header named ${header}. Check that the API accepts it as a header before running.`);
    }
  }

  const extra = new Map<string, string>();
  for (const k of onBase) for (const h of k.extraHeaders) if (!extra.has(h.toLowerCase())) extra.set(h.toLowerCase(), h);
  if (extra.size) {
    warnings.push(
      `Headers not imported (input files only have default headers): ${[...extra.values()].join(', ')}. Add them to defaultHeaders in the JSON if the API needs them.`,
    );
  }
  endpoints.forEach((ep) => {
    const vars = [...new Set([...JSON.stringify(ep.body ?? {}).matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map((m) => m[1]))];
    if (vars.length) warnings.push(`${ep.id}: sample body has unresolved variables (${vars.map((v) => `{{${v}}}`).join(', ')}); replace them with real values.`);
  });

  const name = opts.name ? slugName(opts.name) : '';
  let input: Config = {
    ...(name ? { name } : {}),
    baseUrl,
    defaultHeaders: { ...DEFAULT_HEADERS },
    ...(auth ? { auth } : {}),
    endpoints,
  };

  // Last line of defense: a removed credential value must not survive anywhere else in the output.
  const secrets = [...secretSet].sort((a, b) => b.length - a.length);
  const hits = new Set<string>();
  input = { ...input, endpoints: input.endpoints.map((ep) => scrub(ep, secrets, ep.id, hits)) };
  const cleanSkipped = scrub(skipped, secrets, 'the skipped list', hits);
  const cleanWarnings = scrub(warnings, secrets, 'the warnings', hits);
  if (hits.size) {
    cleanWarnings.push(`A removed credential value also appeared in ${[...hits].join(', ')} and was replaced with ${REMOVED}. Check those values.`);
  }

  if (!input.endpoints.length) throw new ImportError(noEndpointsMessage(cleanSkipped, opts.noEndpointsMessage ?? 'No endpoints imported'));
  const parsed = ImportSchema.safeParse(input);
  if (!parsed.success) throw new ImportError(`The imported input is invalid: ${zodProblems(parsed.error).join('; ')}`);
  const problems = configProblems(parsed.data);
  if (problems.length) throw new ImportError(`The imported input is invalid: ${problems.join('; ')}`);
  return { input: parsed.data, skipped: cleanSkipped, warnings: cleanWarnings };
}
