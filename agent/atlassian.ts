import { casesFromRows, FIELD_LABELS, mapColumns, MAX_SHEET_ROWS, SheetError, type CaseField, type CaseSource, type ParsedSheet } from './test-cases';

// Live test cases from Jira, Confluence, Xray and Zephyr Scale: a pasted link (or JQL) becomes the same
// rows a sheet gives, then goes through the sheet's column matching, preview, modes, needs review and
// traceability (agent/test-cases.ts). Read-only: only GET requests, plus the Xray Cloud token and
// GraphQL query (POST, read-only).
//
// Safety:
// - Credentials come from the environment (.env) only, never from the link or an input file, and are
//   never put in a message: every error text is passed through redactSecrets.
// - Only the configured hosts are called: the Atlassian site (ATLASSIAN_BASE_URL), an optional separate
//   Confluence site (CONFLUENCE_BASE_URL), and the Xray / Zephyr Scale API hosts (fixed vendor hosts, or
//   loopback for tests). A pasted link on any other host is refused before any request; redirects are
//   never followed.
// - HTTPS only, except loopback (local mock servers in tests).
// - Caps: the sheet's 1000 cases, 100 results per page, 10 MB per response, 2500 requests per import,
//   30 s per request. HTTP 429 and 503 are retried at most 3 times, waiting Retry-After (at most 60 s).

export class AtlassianError extends SheetError {}

type Env = Record<string, string | undefined>;
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type AtlassianSettings = {
  deployment: 'cloud' | 'datacenter';
  jiraBase: string;
  confluenceBase: string;
  email: string;
  authHeader: string;
  authKind: 'basic' | 'bearer';
  xray: { base: string; clientId: string; clientSecret: string } | null;
  zephyr: { base: string; token: string } | null;
  secrets: string[];
};

export const ATLASSIAN_ENV = ['ATLASSIAN_BASE_URL', 'ATLASSIAN_EMAIL', 'ATLASSIAN_API_TOKEN', 'ATLASSIAN_DEPLOYMENT', 'CONFLUENCE_BASE_URL', 'XRAY_CLIENT_ID', 'XRAY_CLIENT_SECRET', 'XRAY_BASE_URL', 'ZEPHYR_API_TOKEN', 'ZEPHYR_BASE_URL'] as const;
const SECRET_ENV = ['ATLASSIAN_API_TOKEN', 'XRAY_CLIENT_SECRET', 'ZEPHYR_API_TOKEN'];

const XRAY_DEFAULT = 'https://xray.cloud.getxray.app';
const ZEPHYR_DEFAULT = 'https://api.zephyrscale.smartbear.com/v2';
const XRAY_HOSTS = /(^|\.)xray\.cloud\.getxray\.app$/i;
const ZEPHYR_HOSTS = /(^|\.)api\.zephyrscale\.smartbear\.com$/i;

export const PAGE_SIZE = 100;
export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
export const MAX_REQUESTS = 2500;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const MAX_WAIT_MS = 60_000;

// Every secret value and its Basic-auth encodings, for redaction.
export function atlassianSecrets(env: Env = process.env): string[] {
  const out: string[] = [];
  for (const k of SECRET_ENV) {
    const v = (env[k] ?? '').trim();
    if (v.length >= 4) out.push(v);
  }
  const email = (env.ATLASSIAN_EMAIL ?? '').trim();
  const token = (env.ATLASSIAN_API_TOKEN ?? '').trim();
  if (email && token) out.push(Buffer.from(`${email}:${token}`).toString('base64'));
  return out;
}

export function redactSecrets(text: string, secrets: string[]): string {
  let t = text;
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) if (s && s.length >= 4) t = t.split(s).join('<redacted>');
  return t.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 <redacted>');
}

function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

// A base URL from the environment: http(s), no user info, query or fragment; HTTPS unless loopback.
function baseUrl(name: string, raw: string, hostRule?: RegExp): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new AtlassianError(`${name} is not a URL: use the address you open in the browser, like https://your-team.atlassian.net`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new AtlassianError(`${name} must start with https://`);
  if (u.protocol === 'http:' && !isLoopback(u.hostname)) throw new AtlassianError(`${name} must use https:// (plain http is only allowed for localhost)`);
  if (u.username || u.password) throw new AtlassianError(`${name} must not contain a user name or password; put the token in ATLASSIAN_API_TOKEN`);
  if (hostRule && !isLoopback(u.hostname) && !hostRule.test(u.hostname)) throw new AtlassianError(`${name} must be on ${hostRule === XRAY_HOSTS ? 'xray.cloud.getxray.app' : 'api.zephyrscale.smartbear.com'} (or a regional host of it)`);
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

// What the UI may show: never a secret value.
export function atlassianStatus(env: Env = process.env) {
  const base = (env.ATLASSIAN_BASE_URL ?? '').trim();
  let error: string | null = null;
  let s: AtlassianSettings | null = null;
  if (base) {
    try {
      s = atlassianSettings(env);
    } catch (err) {
      error = (err as Error).message;
    }
  }
  return {
    configured: Boolean(s),
    baseUrl: base,
    confluenceUrl: (env.CONFLUENCE_BASE_URL ?? '').trim(),
    deployment: s ? s.deployment : null,
    email: (env.ATLASSIAN_EMAIL ?? '').trim(),
    hasToken: Boolean((env.ATLASSIAN_API_TOKEN ?? '').trim()),
    xray: Boolean((env.XRAY_CLIENT_ID ?? '').trim() && (env.XRAY_CLIENT_SECRET ?? '').trim()),
    zephyr: Boolean((env.ZEPHYR_API_TOKEN ?? '').trim()),
    error,
  };
}

export function atlassianSettings(env: Env = process.env): AtlassianSettings {
  const rawBase = (env.ATLASSIAN_BASE_URL ?? '').trim();
  if (!rawBase) throw new AtlassianError('Jira and Confluence are not set up: add ATLASSIAN_BASE_URL, ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN to .env (or fill the Jira and Confluence card in the UI)');
  const jiraBase = baseUrl('ATLASSIAN_BASE_URL', rawBase);
  const host = new URL(jiraBase).hostname.toLowerCase();
  const dep = (env.ATLASSIAN_DEPLOYMENT ?? '').trim().toLowerCase();
  if (dep && dep !== 'cloud' && dep !== 'datacenter' && dep !== 'server') throw new AtlassianError('ATLASSIAN_DEPLOYMENT must be cloud or datacenter');
  const deployment: 'cloud' | 'datacenter' = dep ? (dep === 'cloud' ? 'cloud' : 'datacenter') : /\.(atlassian\.net|jira\.com)$/.test(host) ? 'cloud' : 'datacenter';
  const rawConf = (env.CONFLUENCE_BASE_URL ?? '').trim();
  const confluenceBase = rawConf ? baseUrl('CONFLUENCE_BASE_URL', rawConf) : deployment === 'cloud' ? `${jiraBase}/wiki` : jiraBase;
  const email = (env.ATLASSIAN_EMAIL ?? '').trim();
  const token = (env.ATLASSIAN_API_TOKEN ?? '').trim();
  if (!token) throw new AtlassianError('ATLASSIAN_API_TOKEN is empty: create an API token at https://id.atlassian.com/manage-profile/security/api-tokens (Cloud) or a personal access token in your Jira profile (Data Center), and add it to .env');
  if (/\s/.test(token)) throw new AtlassianError('ATLASSIAN_API_TOKEN contains spaces: paste the token exactly as Atlassian showed it');
  let authHeader: string;
  let authKind: 'basic' | 'bearer';
  if (deployment === 'cloud') {
    if (!email) throw new AtlassianError('ATLASSIAN_EMAIL is empty: Atlassian Cloud needs the email of the account that created the API token');
    authHeader = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
    authKind = 'basic';
  } else if (email) {
    authHeader = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
    authKind = 'basic';
  } else {
    authHeader = `Bearer ${token}`;
    authKind = 'bearer';
  }
  const xid = (env.XRAY_CLIENT_ID ?? '').trim();
  const xsecret = (env.XRAY_CLIENT_SECRET ?? '').trim();
  const xray = xid && xsecret ? { base: baseUrl('XRAY_BASE_URL', env.XRAY_BASE_URL?.trim() || XRAY_DEFAULT, XRAY_HOSTS), clientId: xid, clientSecret: xsecret } : null;
  const ztoken = (env.ZEPHYR_API_TOKEN ?? '').trim();
  const zephyr = ztoken ? { base: baseUrl('ZEPHYR_BASE_URL', env.ZEPHYR_BASE_URL?.trim() || ZEPHYR_DEFAULT, ZEPHYR_HOSTS), token: ztoken } : null;
  return { deployment, jiraBase, confluenceBase, email, authHeader, authKind, xray, zephyr, secrets: atlassianSecrets(env) };
}

// ---------- What was pasted ----------

export type LinkTarget =
  | { kind: 'jira'; jql: string; label: string }
  | { kind: 'confluence'; pageId: string | null; space: string | null; title: string | null; label: string }
  | { kind: 'zephyr'; keys: string[]; projectKey: string | null; label: string };

const JQL_START = /^\s*(project|issuetype|type|issue|issuekey|key|id|filter|labels?|status|text|summary|description|sprint|fixversion|component|assignee|reporter|creator|created|updated|parent|priority|resolution|epic link|"[^"]+"|cf\[\d+\])\s*(=|!=|~|!~|>=|<=|>|<|\bin\b|\bnot\b|\bis\b|\bwas\b)/i;
const ISSUE_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
const ZEPHYR_KEY = /[A-Z][A-Z0-9_]+-T\d+/g;

// True for something the link importer handles: one http(s) URL, or "jql:", "zephyr:" or plain JQL.
export function isLinkSource(text: string): boolean {
  const t = text.trim();
  if (!t || t.includes('\n')) return false;
  return /^https?:\/\/\S+$/i.test(t) || /^(jql|zephyr)\s*:/i.test(t) || (JQL_START.test(t) && !/\t/.test(t));
}

function sameSite(u: URL, base: string): boolean {
  const b = new URL(base);
  if (u.protocol !== b.protocol || u.host.toLowerCase() !== b.host.toLowerCase()) return false;
  const prefix = b.pathname.replace(/\/+$/, '');
  return !prefix || u.pathname === prefix || u.pathname.startsWith(`${prefix}/`);
}

export function parseLink(text: string, s: AtlassianSettings): LinkTarget {
  const t = text.trim();
  if (t.length > 4000) throw new AtlassianError('the link or JQL is longer than 4000 characters');
  const jql = /^jql\s*:\s*([\s\S]+)$/i.exec(t);
  if (jql) return { kind: 'jira', jql: jql[1].trim(), label: `JQL: ${jql[1].trim()}` };
  const z = /^zephyr\s*:\s*([\s\S]+)$/i.exec(t);
  if (z) return zephyrTarget(z[1].trim());
  if (!/^https?:\/\//i.test(t)) {
    if (JQL_START.test(t)) return { kind: 'jira', jql: t, label: `JQL: ${t}` };
    throw new AtlassianError('paste a Jira or Confluence link, or a JQL query such as: project = QA AND issuetype = Test');
  }
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    throw new AtlassianError('that link is not a valid URL');
  }
  const onConfluence = sameSite(u, s.confluenceBase);
  const onJira = sameSite(u, s.jiraBase);
  // Cloud: Confluence lives under /wiki on the same site as Jira.
  if (onConfluence && (s.confluenceBase !== s.jiraBase || /\/(pages|display|spaces)\//.test(u.pathname) || u.searchParams.has('pageId'))) return confluenceTarget(u);
  if (!onJira) {
    const allowed = [...new Set([new URL(s.jiraBase).host, new URL(s.confluenceBase).host])].join(' or ');
    throw new AtlassianError(`the link is on ${u.host}, but the Atlassian site in .env is ${allowed}. Only the configured site is called: paste a link from that site, or change ATLASSIAN_BASE_URL`);
  }
  const all = `${u.pathname}${u.search}${decodeURIComponent(u.hash)}`;
  if (/kanoah|zephyr|test-?management|\/testCase\//i.test(all)) {
    const keys = all.match(ZEPHYR_KEY) ?? [];
    const project = /projectKey=([A-Z][A-Z0-9_]+)/i.exec(all);
    if (keys.length || project) return { kind: 'zephyr', keys: [...new Set(keys)], projectKey: keys.length ? null : project![1].toUpperCase(), label: keys.length ? `Zephyr Scale ${keys.join(', ')}` : `Zephyr Scale project ${project![1].toUpperCase()}` };
  }
  const q = u.searchParams.get('jql');
  if (q && q.trim()) return { kind: 'jira', jql: q.trim(), label: `Jira search: ${q.trim()}` };
  const filter = u.searchParams.get('filter') ?? /\/filters?\/(\d+)/.exec(u.pathname)?.[1] ?? null;
  if (filter) {
    if (!/^-?\d+$/.test(filter)) throw new AtlassianError('the filter id in the link must be a number');
    return { kind: 'jira', jql: `filter = ${filter}`, label: `Jira filter ${filter}` };
  }
  const key = /\/browse\/([A-Za-z][A-Za-z0-9_]+-\d+)/.exec(u.pathname)?.[1] ?? u.searchParams.get('selectedIssue') ?? /\/issues?\/([A-Za-z][A-Za-z0-9_]+-\d+)/.exec(u.pathname)?.[1] ?? null;
  if (key && ISSUE_KEY.test(key.toUpperCase())) return { kind: 'jira', jql: `key = ${key.toUpperCase()}`, label: `Jira issue ${key.toUpperCase()}` };
  throw new AtlassianError('this Jira link names no issue, filter or search. Open the issue, a saved filter or a search (Filters > Advanced search) and copy that link, or paste the JQL');
}

function zephyrTarget(rest: string): LinkTarget {
  const keys = rest.toUpperCase().match(ZEPHYR_KEY) ?? [];
  if (keys.length) return { kind: 'zephyr', keys: [...new Set(keys)], projectKey: null, label: `Zephyr Scale ${[...new Set(keys)].join(', ')}` };
  const p = /^(?:project(?:key)?\s*=\s*)?"?([A-Za-z][A-Za-z0-9_]+)"?$/i.exec(rest);
  if (p) return { kind: 'zephyr', keys: [], projectKey: p[1].toUpperCase(), label: `Zephyr Scale project ${p[1].toUpperCase()}` };
  throw new AtlassianError('after "zephyr:" give test case keys (QA-T1, QA-T2) or a project (project = QA)');
}

function confluenceTarget(u: URL): LinkTarget {
  if (/\/x\/[A-Za-z0-9_-]+/.test(u.pathname)) throw new AtlassianError('short Confluence links (/x/...) are not supported: open the page and copy the full link from the address bar');
  const id = /\/pages\/(?:edit-v2\/|edit\/)?(\d+)/.exec(u.pathname)?.[1] ?? u.searchParams.get('pageId');
  if (id && /^\d+$/.test(id)) return { kind: 'confluence', pageId: id, space: null, title: null, label: `Confluence page ${id}` };
  const d = /\/display\/([^/]+)\/([^/?#]+)/.exec(u.pathname);
  if (d) {
    const title = decodeURIComponent(d[2].replace(/\+/g, ' '));
    return { kind: 'confluence', pageId: null, space: decodeURIComponent(d[1]), title, label: `Confluence page "${title}"` };
  }
  throw new AtlassianError('this Confluence link names no page. Open the page that holds the test case table and copy its link');
}

// ---------- HTTP ----------

export type LoadOptions = {
  env?: Env;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  maxWaitMs?: number;
};

type Ctx = { s: AtlassianSettings; fetch: FetchLike; sleep: (ms: number) => Promise<void>; maxWaitMs: number; requests: number; allowed: string[]; warnings: string[] };
type Service = 'Jira' | 'Confluence' | 'Xray' | 'Zephyr Scale';

function retryAfterMs(h: string | null, attempt: number): number {
  if (h) {
    const n = Number(h);
    if (Number.isFinite(n) && n >= 0) return n * 1000;
    const d = Date.parse(h);
    if (!Number.isNaN(d)) return Math.max(0, d - Date.now());
  }
  return 1000 * 2 ** attempt;
}

function apiMessage(body: unknown): string {
  if (!body || typeof body !== 'object') return typeof body === 'string' ? body : '';
  const b = body as Record<string, unknown>;
  const parts: string[] = [];
  if (Array.isArray(b.errorMessages)) parts.push(...b.errorMessages.map(String));
  if (b.errors && typeof b.errors === 'object' && !Array.isArray(b.errors)) parts.push(...Object.entries(b.errors as Record<string, unknown>).map(([k, v]) => `${k}: ${String(v)}`));
  if (Array.isArray(b.errors)) parts.push(...(b.errors as unknown[]).map((e) => (e && typeof e === 'object' ? String((e as Record<string, unknown>).message ?? (e as Record<string, unknown>).title ?? '') : String(e))));
  if (typeof b.message === 'string') parts.push(b.message);
  if (typeof b.error === 'string') parts.push(b.error);
  return parts.filter(Boolean).join('; ');
}

function statusHelp(service: Service, status: number, what: string, s: AtlassianSettings): string {
  if (service === 'Xray') {
    if (status === 401 || status === 403) return `Xray refused the credentials (${status}): check XRAY_CLIENT_ID and XRAY_CLIENT_SECRET (Jira > Apps > Xray > API Keys)`;
  }
  if (service === 'Zephyr Scale' && s.zephyr) {
    if (status === 401 || status === 403) return `Zephyr Scale refused the token (${status}): check ZEPHYR_API_TOKEN (Jira > your profile picture > Zephyr API keys)`;
  }
  if (status === 401) return `${service} said 401 (not signed in): check ${s.authKind === 'bearer' ? 'ATLASSIAN_API_TOKEN (a personal access token)' : 'ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN'}${s.deployment === 'cloud' ? '; a new token can be made at https://id.atlassian.com/manage-profile/security/api-tokens' : ''}`;
  if (status === 403) return `${service} said 403 (no permission) for ${what}: the account in .env cannot read it. Ask an admin for Browse projects (Jira) or View (Confluence space), or use an account that can open the link`;
  if (status === 404) return `${service} said 404 for ${what}: it does not exist or the account in .env cannot see it. Check the link opens in your browser while signed in as ${s.email || 'that account'}`;
  if (status === 400) return `${service} could not run the request for ${what} (400)`;
  if (status === 429) return `${service} is rate limiting (429) and still was after ${MAX_RETRIES} retries; wait a minute and try again`;
  if (status >= 500) return `${service} had a server error (${status}) for ${what}; try again later`;
  return `${service} answered ${status} for ${what}`;
}

async function call(ctx: Ctx, service: Service, what: string, url: string, init: { method?: 'GET' | 'POST'; auth: string | null; body?: unknown } = { auth: null }): Promise<unknown> {
  const u = new URL(url);
  if (!ctx.allowed.some((a) => sameSite(u, a))) throw new AtlassianError(`refused to call ${u.host}: only the configured Atlassian, Xray and Zephyr hosts are called`);
  const red = (t: string) => redactSecrets(t, ctx.s.secrets).replace(/\s+/g, ' ').trim().slice(0, 300);
  for (let attempt = 0; ; attempt++) {
    if (++ctx.requests > MAX_REQUESTS) throw new AtlassianError(`stopped after ${MAX_REQUESTS} requests to Atlassian; import fewer test cases at a time`);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (init.auth) headers.Authorization = init.auth;
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await ctx.fetch(url, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body), redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      const e = err as Error & { cause?: { code?: string } };
      const why = e.name === 'TimeoutError' || e.name === 'AbortError' ? `no answer within ${REQUEST_TIMEOUT_MS / 1000} s` : e.cause?.code ?? e.message;
      throw new AtlassianError(`could not reach ${service} at ${u.host}: ${red(String(why))}. Check the address in .env and your network or VPN`);
    }
    if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
      const wait = Math.min(ctx.maxWaitMs, retryAfterMs(res.headers.get('retry-after'), attempt));
      ctx.warnings.push(`${service} asked to slow down (${res.status}); waited ${Math.round(wait / 1000)} s and retried`);
      await res.arrayBuffer().catch(() => undefined);
      await ctx.sleep(wait);
      continue;
    }
    if (res.status >= 300 && res.status < 400) {
      throw new AtlassianError(`${service} redirected the request for ${what} to another address (${res.status}); redirects are not followed. Check ATLASSIAN_BASE_URL is the exact site address (for Data Center, also that the token is accepted and you are not sent to a login page)`);
    }
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > MAX_RESPONSE_BYTES) throw new AtlassianError(`${service} sent more than ${MAX_RESPONSE_BYTES / 1024 / 1024} MB for ${what}; refused`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_RESPONSE_BYTES) throw new AtlassianError(`${service} sent more than ${MAX_RESPONSE_BYTES / 1024 / 1024} MB for ${what}; refused`);
    const text = buf.toString('utf8');
    let body: unknown = undefined;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = undefined;
    }
    if (!res.ok) {
      const detail = red(apiMessage(body));
      throw new AtlassianError(`${statusHelp(service, res.status, what, ctx.s)}${detail ? `. ${service} said: ${detail}` : ''}`);
    }
    if (body === undefined) {
      const html = /^\s*</.test(text);
      throw new AtlassianError(`${service} sent ${html ? 'a web page' : 'something'} instead of data for ${what}. Check the site address in .env${html ? ' (it may be a login or SSO page)' : ''}`);
    }
    return body;
  }
}

// ---------- Text helpers ----------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '\u2013', mdash: '\u2014', rarr: '\u2192', larr: '\u2190', hellip: '\u2026', lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d', bull: '\u2022', middot: '\u00b7', times: '\u00d7', copy: '\u00a9' };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// HTML or Confluence storage format to plain text: line breaks for blocks, "- " for list items.
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, c: string) => c.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '\n- ')
      .replace(/<\/(p|div|h[1-6]|tr|ul|ol|blockquote|pre)>/gi, '\n')
      .replace(/<\/t[dh]>/gi, ' | ')
      .replace(/<ri:page\b[^>]*ri:content-title="([^"]*)"[^>]*\/?>/gi, '$1')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\| *(\n|$)/g, '$1')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

type Adf = { type?: string; text?: string; content?: Adf[]; attrs?: Record<string, unknown> };
// Atlassian Document Format (Jira Cloud descriptions and rich text fields) to plain text.
export function adfToText(node: unknown): string {
  const walk = (n: Adf, depth: number): string => {
    if (!n || typeof n !== 'object' || depth > 50) return '';
    const kids = (sep = '') => (Array.isArray(n.content) ? n.content.map((c) => walk(c, depth + 1)).join(sep) : '');
    const a = n.attrs ?? {};
    switch (n.type) {
      case 'text':
        return typeof n.text === 'string' ? n.text : '';
      case 'hardBreak':
        return '\n';
      case 'mention':
      case 'emoji':
      case 'status':
        return String(a.text ?? a.shortName ?? '');
      case 'inlineCard':
      case 'blockCard':
        return String(a.url ?? '');
      case 'date':
        return a.timestamp ? new Date(Number(a.timestamp)).toISOString().slice(0, 10) : '';
      case 'paragraph':
      case 'heading':
        return `${kids()}\n`;
      case 'codeBlock':
        return `${kids()}\n`;
      case 'rule':
        return '\n';
      case 'bulletList':
        return (n.content ?? []).map((li) => `- ${walk(li, depth + 1).trim()}\n`).join('');
      case 'orderedList': {
        const start = Number(a.order ?? 1) || 1;
        return (n.content ?? []).map((li, i) => `${start + i}. ${walk(li, depth + 1).trim()}\n`).join('');
      }
      case 'tableRow':
        return `${(n.content ?? []).map((c) => walk(c, depth + 1).trim().replace(/\n+/g, ' ')).join(' | ')}\n`;
      case 'mediaSingle':
      case 'mediaGroup':
      case 'media':
        return '';
      default:
        return kids();
    }
  };
  if (typeof node === 'string') return node;
  return walk(node as Adf, 0).replace(/\n{3,}/g, '\n\n').trim();
}

// A Jira field value of any shape to text: string, ADF, option, user, array.
function fieldText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(fieldText).filter(Boolean).join(', ');
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (o.type === 'doc') return adfToText(o);
    for (const k of ['value', 'name', 'displayName', 'key']) if (typeof o[k] === 'string') return (o[k] as string).trim();
  }
  return '';
}

// "Expected result:" inside a description: the text before is the steps, the rest the expected result.
// Also h3. headings (Jira wiki markup) and Markdown-ish headings.
export function splitExpected(text: string): { steps: string; expected: string } {
  const re = /^[ \t]*(?:h[1-6]\.\s*|#{1,6}\s*|\*{1,2}|_)?\s*expected(?:\s+(?:results?|outcome|response|behaviou?r))?\s*(?:\*{1,2}|_)?\s*[:\-\u2013]?\s*(?:\*{1,2})?(.*)$/im;
  const m = re.exec(text);
  if (!m) return { steps: text.trim(), expected: '' };
  const before = text.slice(0, m.index).replace(/^[ \t]*(?:h[1-6]\.\s*|#{1,6}\s*)?(?:steps|test steps|steps to reproduce)\s*:?\s*$/gim, '').trim();
  const after = `${m[1]}${text.slice(m.index + m[0].length)}`.trim();
  return { steps: before, expected: after };
}

// ---------- Canonical rows ----------

const CANON: CaseField[] = ['id', 'title', 'steps', 'expected', 'endpoint', 'method', 'priority', 'preconditions', 'testData', 'jira', 'confluence'];
type Canon = Partial<Record<CaseField, string>>;

function rowsOf(items: Canon[]): string[][] {
  return [CANON.map((f) => FIELD_LABELS[f]), ...items.map((it) => CANON.map((f) => it[f] ?? ''))];
}

function toSheet(items: Canon[], format: ParsedSheet['format'], source: CaseSource, columns: Partial<Record<CaseField, string>>, warnings: string[]): ParsedSheet {
  if (!items.length) throw new AtlassianError(`${source.label} has no test cases${format === 'jira' ? ' (the search found no issues)' : ''}`);
  if (items.length > MAX_SHEET_ROWS) throw new AtlassianError(`${source.label} has more than ${MAX_SHEET_ROWS} test cases; narrow it down (for Jira, add to the JQL, e.g. AND labels = api)`);
  // The traceability report links each case to where it lives: the Confluence page it was read from, or
  // the Zephyr Scale key (Jira issues carry their own browse link, set in loadJira).
  const linked = items.map((it) => ({
    ...it,
    ...(source.kind === 'confluence' && !it.confluence ? { confluence: source.link } : {}),
    ...(source.kind === 'zephyr' && !it.jira && it.id ? { jira: it.id } : {}),
  }));
  const sheet = casesFromRows(rowsOf(linked), format);
  // Show where each field really came from instead of the canonical header names.
  const shown: Partial<Record<CaseField, string>> = {};
  for (const f of Object.keys(sheet.columns) as CaseField[]) if (items.some((it) => it[f]) && (f !== 'jira' && f !== 'confluence' ? true : columns[f] !== undefined)) shown[f] = columns[f] ?? sheet.columns[f]!;
  const ws = [...sheet.warnings];
  if (!items.some((it) => it.expected)) ws.unshift({ row: null, caseId: null, message: `no expected result found in any case: write "Expected result: ..." in the ${format === 'jira' ? 'description (or add an Expected Result field)' : 'test case'}, or cases are marked needs review` });
  return { ...sheet, format, source, columns: shown, ignored: [], warnings: [...warnings.map((m) => ({ row: null, caseId: null, message: m })), ...ws] };
}

// ---------- Jira ----------

type JiraIssue = { id?: string; key: string; fields?: Record<string, unknown> };
const TEST_TYPE = /^(xray )?test$|^test case$/i;

async function jiraSearch(ctx: Ctx, jql: string): Promise<{ issues: JiraIssue[]; names: Record<string, string> }> {
  const issues: JiraIssue[] = [];
  const names: Record<string, string> = {};
  const maxPages = Math.ceil(MAX_SHEET_ROWS / PAGE_SIZE) + 1;
  let token: string | null = null;
  let startAt = 0;
  for (let page = 0; page < maxPages; page++) {
    const p = new URLSearchParams({ jql, maxResults: String(PAGE_SIZE), fields: '*navigable', expand: 'names' });
    let url: string;
    if (ctx.s.deployment === 'cloud') {
      if (token) p.set('nextPageToken', token);
      url = `${ctx.s.jiraBase}/rest/api/3/search/jql?${p}`;
    } else {
      p.set('startAt', String(startAt));
      url = `${ctx.s.jiraBase}/rest/api/2/search?${p}`;
    }
    const body = (await call(ctx, 'Jira', 'the search', url, { auth: ctx.s.authHeader })) as Record<string, unknown>;
    const got = Array.isArray(body?.issues) ? (body.issues as JiraIssue[]) : [];
    if (body?.names && typeof body.names === 'object') Object.assign(names, body.names);
    issues.push(...got.filter((i) => i && typeof i.key === 'string'));
    if (issues.length > MAX_SHEET_ROWS) throw new AtlassianError(`the Jira search finds more than ${MAX_SHEET_ROWS} issues; narrow the JQL (e.g. add AND labels = api or AND issuetype = Test)`);
    if (ctx.s.deployment === 'cloud') {
      token = typeof body?.nextPageToken === 'string' && body.nextPageToken ? body.nextPageToken : null;
      if (body?.isLast === true || !token || !got.length) return { issues, names };
    } else {
      startAt += got.length;
      const total = typeof body?.total === 'number' ? body.total : startAt;
      if (total > MAX_SHEET_ROWS) throw new AtlassianError(`the Jira search finds ${total} issues, more than ${MAX_SHEET_ROWS}; narrow the JQL`);
      if (!got.length || startAt >= total) return { issues, names };
    }
  }
  throw new AtlassianError(`the Jira search did not end after ${maxPages} pages; narrow the JQL`);
}

type Steps = { steps: string; expected: string; testData: string };
function formatSteps(list: { action: string; data: string; result: string }[]): Steps {
  const n = list.filter((x) => x.action || x.data || x.result);
  return {
    steps: n.map((x, i) => `${i + 1}. ${x.action}`.trim()).join('\n'),
    expected: n.filter((x) => x.result).map((x) => `${n.length > 1 ? `${n.indexOf(x) + 1}. ` : ''}${x.result}`).join('\n'),
    testData: n.filter((x) => x.data).map((x) => `${n.length > 1 ? `${n.indexOf(x) + 1}. ` : ''}${x.data}`).join('\n'),
  };
}

async function xrayCloudSteps(ctx: Ctx, keys: string[]): Promise<Map<string, Steps>> {
  const x = ctx.s.xray!;
  const token = await call(ctx, 'Xray', 'the sign-in', `${x.base}/api/v2/authenticate`, { method: 'POST', auth: null, body: { client_id: x.clientId, client_secret: x.clientSecret } });
  if (typeof token !== 'string' || !token) throw new AtlassianError('Xray did not return a token; check XRAY_CLIENT_ID and XRAY_CLIENT_SECRET');
  ctx.s.secrets.push(token);
  const out = new Map<string, Steps>();
  const query = 'query($jql: String, $limit: Int!, $start: Int) { getTests(jql: $jql, limit: $limit, start: $start) { total start limit results { issueId testType { name kind } steps { action data result } gherkin unstructured jira(fields: ["key"]) } } }';
  for (let i = 0; i < keys.length; i += PAGE_SIZE) {
    const chunk = keys.slice(i, i + PAGE_SIZE);
    const body = (await call(ctx, 'Xray', 'the test steps', `${x.base}/api/v2/graphql`, { method: 'POST', auth: `Bearer ${token}`, body: { query, variables: { jql: `key in (${chunk.join(',')})`, limit: PAGE_SIZE, start: 0 } } })) as Record<string, unknown>;
    const errors = Array.isArray(body?.errors) ? (body.errors as { message?: string }[]) : [];
    if (errors.length) throw new AtlassianError(`Xray could not read the test steps: ${redactSecrets(errors.map((e) => String(e?.message ?? '')).join('; '), ctx.s.secrets).slice(0, 300)}`);
    const results = ((body?.data as Record<string, unknown>)?.getTests as Record<string, unknown>)?.results;
    for (const r of Array.isArray(results) ? (results as Record<string, unknown>[]) : []) {
      const key = fieldText((r.jira as Record<string, unknown>)?.key);
      if (!key) continue;
      if (typeof r.gherkin === 'string' && r.gherkin.trim()) out.set(key, { steps: r.gherkin.trim(), expected: '', testData: '' });
      else if (typeof r.unstructured === 'string' && r.unstructured.trim()) out.set(key, { steps: r.unstructured.trim(), expected: '', testData: '' });
      else if (Array.isArray(r.steps)) out.set(key, formatSteps((r.steps as Record<string, unknown>[]).map((s) => ({ action: fieldText(s.action), data: fieldText(s.data), result: fieldText(s.result) }))));
    }
  }
  return out;
}

// Xray Server / Data Center: the "export tests" REST endpoint on the Jira host, with the Jira token.
async function xrayDcSteps(ctx: Ctx, keys: string[]): Promise<Map<string, Steps> | null> {
  const out = new Map<string, Steps>();
  for (let i = 0; i < keys.length; i += 50) {
    const chunk = keys.slice(i, i + 50);
    let body: unknown;
    try {
      body = await call(ctx, 'Jira', 'the Xray test steps', `${ctx.s.jiraBase}/rest/raven/1.0/api/test?keys=${encodeURIComponent(chunk.join(';'))}`, { auth: ctx.s.authHeader });
    } catch (err) {
      if (/ 404 /.test((err as Error).message)) return null;
      throw err;
    }
    for (const t of Array.isArray(body) ? (body as Record<string, unknown>[]) : []) {
      const key = fieldText(t.key);
      if (!key) continue;
      if (typeof t.definition === 'string' && t.definition.trim() && !Array.isArray(t.steps)) {
        out.set(key, { steps: t.definition.trim(), expected: '', testData: '' });
        continue;
      }
      const steps = Array.isArray(t.steps) ? (t.steps as Record<string, unknown>[]) : [];
      const raw = (v: unknown) => (v && typeof v === 'object' ? fieldText((v as Record<string, unknown>).raw ?? (v as Record<string, unknown>).rendered) : fieldText(v));
      out.set(
        key,
        formatSteps(
          steps.map((s) => {
            const f = (s.fields && typeof s.fields === 'object' ? s.fields : {}) as Record<string, unknown>;
            return { action: raw(s.step ?? f.Action ?? f.Step), data: raw(s.data ?? f.Data), result: raw(s.result ?? f['Expected Result'] ?? f.Result) };
          }),
        ),
      );
    }
  }
  return out;
}

async function loadJira(ctx: Ctx, target: Extract<LinkTarget, { kind: 'jira' }>, link: string): Promise<ParsedSheet> {
  const { issues, names } = await jiraSearch(ctx, target.jql);
  const columns: Partial<Record<CaseField, string>> = { id: 'Jira key', title: 'Summary', priority: 'Priority' };
  // Custom fields whose name is a known column (Expected Result, Endpoint, Test Data, ...).
  const custom: [string, CaseField, string][] = [];
  for (const [id, name] of Object.entries(names)) {
    if (!/^customfield_\d+$/.test(id) || typeof name !== 'string') continue;
    const m = mapColumns([name]);
    const f = (Object.keys(m.columns) as CaseField[])[0];
    if (f && f !== 'id' && f !== 'title' && f !== 'priority') custom.push([id, f, name]);
  }
  const testKeys = issues.filter((i) => TEST_TYPE.test(fieldText(i.fields?.issuetype))).map((i) => i.key);
  let steps: Map<string, Steps> | null = null;
  let stepsVia: string | null = null;
  const warnings: string[] = [];
  if (testKeys.length) {
    if (ctx.s.deployment === 'cloud') {
      if (ctx.s.xray) {
        steps = await xrayCloudSteps(ctx, testKeys);
        stepsVia = 'Xray Cloud';
      } else warnings.push(`${testKeys.length} issue(s) are Test issues; their Xray steps were not read because XRAY_CLIENT_ID and XRAY_CLIENT_SECRET are not set (the description is used)`);
    } else {
      steps = await xrayDcSteps(ctx, testKeys);
      if (steps) stepsVia = 'Xray Data Center';
    }
  }
  // Where each field came from, e.g. "Expected Result + Description" when issues differ.
  const from: Partial<Record<CaseField, Set<string>>> = {};
  const note = (f: CaseField, label: string) => (from[f] ??= new Set()).add(label);
  const items: Canon[] = issues.map((issue) => {
    const f = issue.fields ?? {};
    const it: Canon = { id: issue.key, title: fieldText(f.summary), priority: fieldText(f.priority), jira: `${ctx.s.jiraBase}/browse/${issue.key}` };
    for (const [id, field, name] of custom) {
      const v = fieldText(f[id]);
      if (v && !it[field]) {
        it[field] = v;
        note(field, name);
      }
    }
    const desc = fieldText(f.description);
    const xs = steps?.get(issue.key);
    if (xs && (xs.steps || xs.expected)) {
      if (it.steps) it.preconditions = it.preconditions || desc;
      it.steps = xs.steps;
      note('steps', `${stepsVia} steps`);
      if (!it.expected && xs.expected) {
        it.expected = xs.expected;
        note('expected', `${stepsVia} expected results`);
      }
      if (!it.testData && xs.testData) {
        it.testData = xs.testData;
        note('testData', `${stepsVia} test data`);
      }
      if (desc && !it.preconditions) {
        it.preconditions = desc;
        note('preconditions', 'Description');
      }
    } else if (desc) {
      if (!it.expected) {
        const sp = splitExpected(desc);
        if (!it.steps) {
          it.steps = sp.steps;
          note('steps', 'Description');
        }
        if (sp.expected) {
          it.expected = sp.expected;
          note('expected', 'Description ("Expected result" part)');
        }
      } else if (!it.steps) {
        it.steps = desc;
        note('steps', 'Description');
      }
    }
    return it;
  });
  for (const [f, set] of Object.entries(from) as [CaseField, Set<string>][]) columns[f] = [...set].join(' + ');
  return toSheet(items, 'jira', { kind: 'jira', link, label: target.label, steps: stepsVia }, columns, warnings.concat(ctx.warnings));
}

// ---------- Zephyr Scale ----------

async function loadZephyr(ctx: Ctx, target: Extract<LinkTarget, { kind: 'zephyr' }>, link: string): Promise<ParsedSheet> {
  const items: Canon[] = [];
  const cloud = ctx.s.deployment === 'cloud';
  if (cloud && !ctx.s.zephyr) throw new AtlassianError('Zephyr Scale needs its own API token: add ZEPHYR_API_TOKEN to .env (in Jira: your profile picture > Zephyr API keys)');
  const zBase = cloud ? ctx.s.zephyr!.base : `${ctx.s.jiraBase}/rest/atm/1.0`;
  const auth = cloud ? `Bearer ${ctx.s.zephyr!.token}` : ctx.s.authHeader;
  const tc = (c: Record<string, unknown>, st: Steps | null): Canon => ({
    id: fieldText(c.key),
    title: fieldText(c.name),
    steps: st?.steps || htmlToText(fieldText(c.objective)),
    expected: st?.expected ?? '',
    testData: st?.testData ?? '',
    preconditions: htmlToText(fieldText(c.precondition)),
    priority: typeof c.priority === 'string' ? c.priority : fieldText((c.priority as Record<string, unknown>)?.name),
  });
  const html = (v: unknown) => htmlToText(fieldText(v));
  const dcSteps = (c: Record<string, unknown>): Steps | null => {
    const script = c.testScript as Record<string, unknown> | undefined;
    if (!script) return null;
    if (typeof script.text === 'string') return { steps: html(script.text), expected: '', testData: '' };
    return Array.isArray(script.steps) ? formatSteps((script.steps as Record<string, unknown>[]).map((s) => ({ action: html(s.description), data: html(s.testData), result: html(s.expectedResult) }))) : null;
  };
  const cloudSteps = async (key: string): Promise<Steps | null> => {
    const list: { action: string; data: string; result: string }[] = [];
    for (let startAt = 0, page = 0; page < 20; page++) {
      const body = (await call(ctx, 'Zephyr Scale', `the steps of ${key}`, `${zBase}/testcases/${encodeURIComponent(key)}/teststeps?maxResults=${PAGE_SIZE}&startAt=${startAt}`, { auth })) as Record<string, unknown>;
      const values = Array.isArray(body?.values) ? (body.values as Record<string, unknown>[]) : [];
      for (const v of values) {
        const inl = (v.inline ?? {}) as Record<string, unknown>;
        if (v.inline) list.push({ action: html(inl.description), data: html(inl.testData), result: html(inl.expectedResult) });
        else if (v.testCase) list.push({ action: `Call test case ${fieldText((v.testCase as Record<string, unknown>).testCaseKey)}`, data: '', result: '' });
      }
      startAt += values.length;
      if (body?.isLast !== false || !values.length) break;
    }
    return list.length ? formatSteps(list) : null;
  };
  const cases: Record<string, unknown>[] = [];
  if (target.keys.length) {
    if (target.keys.length > MAX_SHEET_ROWS) throw new AtlassianError(`more than ${MAX_SHEET_ROWS} Zephyr Scale keys`);
    for (const key of target.keys) cases.push((await call(ctx, 'Zephyr Scale', `test case ${key}`, `${zBase}/${cloud ? 'testcases' : 'testcase'}/${encodeURIComponent(key)}`, { auth })) as Record<string, unknown>);
  } else {
    const pk = target.projectKey!;
    for (let startAt = 0, page = 0; ; page++) {
      if (page > Math.ceil(MAX_SHEET_ROWS / PAGE_SIZE) + 1) throw new AtlassianError(`Zephyr Scale project ${pk} has more than ${MAX_SHEET_ROWS} test cases; give the keys instead`);
      const url = cloud
        ? `${zBase}/testcases?projectKey=${encodeURIComponent(pk)}&maxResults=${PAGE_SIZE}&startAt=${startAt}`
        : `${zBase}/testcase/search?query=${encodeURIComponent(`projectKey = "${pk}"`)}&maxResults=${PAGE_SIZE}&startAt=${startAt}`;
      const body = await call(ctx, 'Zephyr Scale', `project ${pk}`, url, { auth });
      const values = cloud ? ((body as Record<string, unknown>)?.values as Record<string, unknown>[]) ?? [] : Array.isArray(body) ? (body as Record<string, unknown>[]) : [];
      cases.push(...values);
      if (cases.length > MAX_SHEET_ROWS) throw new AtlassianError(`Zephyr Scale project ${pk} has more than ${MAX_SHEET_ROWS} test cases; give the keys instead`);
      startAt += values.length;
      if (!values.length || (cloud ? (body as Record<string, unknown>)?.isLast !== false : values.length < PAGE_SIZE)) break;
    }
  }
  for (const c of cases) items.push(tc(c, cloud ? await cloudSteps(fieldText(c.key)) : dcSteps(c)));
  const columns: Partial<Record<CaseField, string>> = { id: 'Zephyr key', title: 'Name', steps: 'Test script steps (or Objective)', expected: 'Step expected results', testData: 'Step test data', preconditions: 'Precondition', priority: 'Priority' };
  return toSheet(items, 'zephyr', { kind: 'zephyr', link, label: target.label, steps: cloud ? 'Zephyr Scale Cloud' : 'Zephyr Scale Data Center' }, columns, ctx.warnings);
}

// ---------- Confluence ----------

// Every table in an HTML / storage-format page as rows of cell text. A table inside a cell becomes that
// cell's text. colspan repeats an empty cell so columns stay aligned.
export function parseHtmlTables(html: string): string[][][] {
  let src = html.replace(/<!--[\s\S]*?-->/g, '');
  const inner: string[] = [];
  const top: number[] = [];
  const innermost = /<table\b[^>]*>((?:(?!<table\b)[\s\S])*?)<\/table>/i;
  const parsed: string[][][] = [];
  for (let guard = 0; guard < 500; guard++) {
    const m = innermost.exec(src);
    if (!m) break;
    const rows: string[][] = [];
    for (const tr of m[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells: string[] = [];
      for (const td of tr[1].matchAll(/<(t[hd])\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
        const text = htmlToText(td[3].replace(/\u0000T(\d+)\u0000/g, (_, n: string) => inner[Number(n)]));
        cells.push(text);
        const span = Number(/colspan\s*=\s*"?(\d+)/i.exec(td[2])?.[1] ?? 1);
        for (let k = 1; k < Math.min(span, 50); k++) cells.push('');
      }
      if (cells.length) rows.push(cells);
    }
    const n = parsed.length;
    parsed.push(rows);
    inner.push(rows.map((r) => r.join(' | ')).join('\n'));
    src = `${src.slice(0, m.index)}\u0000T${n}\u0000${src.slice(m.index + m[0].length)}`;
  }
  for (const m of src.matchAll(/\u0000T(\d+)\u0000/g)) top.push(Number(m[1]));
  return top.map((i) => parsed[i]);
}

async function loadConfluence(ctx: Ctx, target: Extract<LinkTarget, { kind: 'confluence' }>, link: string): Promise<ParsedSheet> {
  const cb = ctx.s.confluenceBase;
  const cloud = ctx.s.deployment === 'cloud';
  let title = '';
  let storage = '';
  const what = target.pageId ? `page ${target.pageId}` : `page "${target.title}"`;
  if (cloud) {
    let id = target.pageId;
    if (!id) {
      const sp = (await call(ctx, 'Confluence', `space ${target.space}`, `${cb}/api/v2/spaces?keys=${encodeURIComponent(target.space!)}`, { auth: ctx.s.authHeader })) as Record<string, unknown>;
      const spaceId = fieldText(((sp?.results as Record<string, unknown>[]) ?? [])[0]?.id);
      if (!spaceId) throw new AtlassianError(`Confluence space ${target.space} was not found, or the account in .env cannot see it`);
      const pages = (await call(ctx, 'Confluence', what, `${cb}/api/v2/pages?space-id=${encodeURIComponent(spaceId)}&title=${encodeURIComponent(target.title!)}&body-format=storage`, { auth: ctx.s.authHeader })) as Record<string, unknown>;
      const page = ((pages?.results as Record<string, unknown>[]) ?? [])[0];
      if (!page) throw new AtlassianError(`Confluence ${what} was not found in space ${target.space}`);
      id = fieldText(page.id);
    }
    const page = (await call(ctx, 'Confluence', what, `${cb}/api/v2/pages/${encodeURIComponent(id)}?body-format=storage`, { auth: ctx.s.authHeader })) as Record<string, unknown>;
    title = fieldText(page?.title);
    storage = fieldText(((page?.body as Record<string, unknown>)?.storage as Record<string, unknown>)?.value);
  } else {
    let page: Record<string, unknown>;
    if (target.pageId) page = (await call(ctx, 'Confluence', what, `${cb}/rest/api/content/${encodeURIComponent(target.pageId)}?expand=body.storage`, { auth: ctx.s.authHeader })) as Record<string, unknown>;
    else {
      const r = (await call(ctx, 'Confluence', what, `${cb}/rest/api/content?spaceKey=${encodeURIComponent(target.space!)}&title=${encodeURIComponent(target.title!)}&expand=body.storage`, { auth: ctx.s.authHeader })) as Record<string, unknown>;
      page = ((r?.results as Record<string, unknown>[]) ?? [])[0];
      if (!page) throw new AtlassianError(`Confluence ${what} was not found in space ${target.space}`);
    }
    title = fieldText(page?.title);
    storage = fieldText(((page?.body as Record<string, unknown>)?.storage as Record<string, unknown>)?.value);
  }
  const label = title ? `Confluence page "${title}"` : target.label;
  const tables = parseHtmlTables(storage);
  if (!tables.length) throw new AtlassianError(`${label} has no table. Put the test cases in a table with a header row (ID, Title, Steps / Request, Expected Result)`);
  const usable = tables.filter((t) => t.length > 1 && (() => {
    const m = mapColumns(t[0]);
    return m.index.title !== undefined || m.index.steps !== undefined;
  })());
  if (!usable.length) throw new AtlassianError(`${label} has ${tables.length} table(s) but none has a Title or Steps column. Headers seen: ${tables[0][0]?.filter(Boolean).slice(0, 12).join(', ') || '(none)'}`);
  const warnings = [...ctx.warnings];
  if (usable.length < tables.length) warnings.push(`${tables.length - usable.length} other table(s) on the page have no Title or Steps column and were skipped`);
  if (usable.length === 1) {
    const sheet = casesFromRows(usable[0], 'confluence');
    if (sheet.cases.length > MAX_SHEET_ROWS) throw new AtlassianError(`${label} has more than ${MAX_SHEET_ROWS} test cases`);
    // Each case links back to the page it was read from (unless the table has its own Confluence column).
    const cases = sheet.cases.map((c) => (c.confluence ? c : { ...c, confluence: link }));
    return { ...sheet, cases, source: { kind: 'confluence', link, label, steps: null }, warnings: [...warnings.map((m) => ({ row: null, caseId: null, message: m })), ...sheet.warnings] };
  }
  // Several case tables: one list, each table's columns matched on its own.
  warnings.push(`cases come from ${usable.length} tables on the page`);
  const items: Canon[] = [];
  const columns: Partial<Record<CaseField, string>> = {};
  for (const t of usable) {
    const { index, columns: cols } = mapColumns(t[0]);
    for (const [f, h] of Object.entries(cols) as [CaseField, string][]) columns[f] = columns[f] ?? h;
    for (const r of t.slice(1)) {
      const it: Canon = {};
      for (const f of CANON) if (index[f] !== undefined) it[f] = r[index[f]!] ?? '';
      if (Object.values(it).some((v) => v && v.trim())) items.push(it);
    }
  }
  return toSheet(items, 'confluence', { kind: 'confluence', link, label, steps: null }, columns, warnings);
}

// ---------- Entry points ----------

function ctxFor(opts: LoadOptions): Ctx {
  const env = opts.env ?? process.env;
  const s = atlassianSettings(env);
  const allowed = [s.jiraBase, s.confluenceBase, ...(s.xray ? [s.xray.base] : []), ...(s.zephyr ? [s.zephyr.base] : [])];
  return {
    s,
    fetch: opts.fetch ?? ((url, init) => fetch(url, init)),
    sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    maxWaitMs: opts.maxWaitMs ?? MAX_WAIT_MS,
    requests: 0,
    allowed,
    warnings: [],
  };
}

// A link or JQL to sheet cases. Throws AtlassianError (a SheetError) with a message safe to show.
export async function loadLinkCases(text: string, opts: LoadOptions = {}): Promise<ParsedSheet> {
  const ctx = ctxFor(opts);
  try {
    const target = parseLink(text, ctx.s);
    const link = text.trim();
    if (target.kind === 'jira') return await loadJira(ctx, target, link);
    if (target.kind === 'confluence') return await loadConfluence(ctx, target, link);
    return await loadZephyr(ctx, target, link);
  } catch (err) {
    const msg = redactSecrets((err as Error).message ?? String(err), ctx.s.secrets);
    if (err instanceof SheetError) throw new AtlassianError(msg);
    throw new AtlassianError(`could not read the test cases: ${msg.slice(0, 300)}`);
  }
}

// Checks the credentials with one read (who am I), for the UI setup card. Never throws.
export async function verifyAtlassian(opts: LoadOptions = {}): Promise<{ ok: true; user: string; deployment: string } | { ok: false; error: string }> {
  let ctx: Ctx;
  try {
    ctx = ctxFor(opts);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  try {
    const me = (await call(ctx, 'Jira', 'your account', `${ctx.s.jiraBase}/rest/api/${ctx.s.deployment === 'cloud' ? 3 : 2}/myself`, { auth: ctx.s.authHeader })) as Record<string, unknown>;
    return { ok: true, user: fieldText(me?.displayName) || fieldText(me?.emailAddress) || fieldText(me?.name) || 'signed in', deployment: ctx.s.deployment };
  } catch (err) {
    return { ok: false, error: redactSecrets((err as Error).message, ctx.s.secrets) };
  }
}
