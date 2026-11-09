import { buildInput, ImportError, isCredentialParam, looksLikeSecretName, parseJsonSource, type Credential, type ImportResult, type RawBody, type RawRequest, type Skipped } from './core';

// HAR (browser network capture). Keeps API calls only: JSON responses or JSON bodies, plus fetch/XHR
// calls with an empty response (a 204 DELETE). Static assets, analytics and other origins are counted
// as "filtered: not an API call". The rest is grouped by method + path, numeric and UUID segments
// becoming {id}.

type NameValue = { name?: string; value?: string };
type Entry = {
  request?: { method?: string; url?: string; headers?: NameValue[]; cookies?: NameValue[]; postData?: { mimeType?: string; text?: string; params?: unknown[] } };
  response?: { status?: number; content?: { mimeType?: string; size?: number; text?: string } };
  _resourceType?: string;
};

const STATIC_PATH = /\.(m?js|css|map|png|jpe?g|gif|svg|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|html?|txt|xml|pdf|wasm)$/i;
const STATIC_TYPES = new Set(['script', 'stylesheet', 'image', 'font', 'media', 'document', 'manifest', 'texttrack', 'ping', 'websocket', 'eventsource', 'preflight']);
const ANALYTICS_HOST =
  /(^|\.)(google-analytics\.com|googletagmanager\.com|doubleclick\.net|segment\.(io|com)|mixpanel\.com|amplitude\.com|hotjar\.(com|io)|fullstory\.com|sentry\.io|nr-data\.net|newrelic\.com|datadoghq\.(com|eu)|facebook\.(com|net)|clarity\.ms|intercom\.io|optimizely\.com|heapanalytics\.com|bugsnag\.com|bat\.bing\.com)$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isJsonType = (mime: string | undefined) => /json/i.test(mime ?? '');

function jsonObject(text: string | undefined): Record<string, unknown> | undefined {
  if (!text?.trim()) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

// A capture holds real traffic: body fields named like credentials (password, token) are replaced.
function maskSecretFields(value: unknown, found: string[], secrets: string[]): unknown {
  if (Array.isArray(value)) return value.map((v) => maskSecretFields(v, found, secrets));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => {
      if (looksLikeSecretName(k) && typeof v === 'string' && v) {
        found.push(k);
        secrets.push(v);
        return [k, '<removed>'];
      }
      return [k, maskSecretFields(v, found, secrets)];
    }),
  );
}

export function importHar(content: string): ImportResult {
  const har = parseJsonSource(content, 'The HAR file') as { log?: { entries?: Entry[]; pages?: { title?: string }[] } };
  const entries = har?.log?.entries;
  if (!Array.isArray(entries)) throw new ImportError('Not a HAR file: expected log.entries. Save it from the browser network tab with "Save all as HAR".');

  type Candidate = { entry: Entry; method: string; origin: string; path: string; query: URLSearchParams };
  let filtered = 0;
  const candidates: Candidate[] = [];
  for (const entry of entries) {
    let url: URL;
    try {
      url = new URL(entry.request?.url ?? '');
    } catch {
      filtered++;
      continue;
    }
    const type = entry._resourceType?.toLowerCase();
    const res = entry.response;
    const jsonBody = isJsonType(entry.request?.postData?.mimeType) || jsonObject(entry.request?.postData?.text) !== undefined;
    const emptyFetch = (type === 'fetch' || type === 'xhr') && (res?.status === 204 || (!res?.content?.size && !res?.content?.text));
    const api =
      /^https?:$/.test(url.protocol) &&
      (jsonBody || isJsonType(res?.content?.mimeType) || emptyFetch) &&
      !STATIC_PATH.test(url.pathname) &&
      !(type && STATIC_TYPES.has(type)) &&
      !ANALYTICS_HOST.test(url.hostname);
    if (!api) {
      filtered++;
      continue;
    }
    const path = url.pathname.split('/').map((seg) => (/^\d+$/.test(seg) || UUID.test(seg) ? '{id}' : seg)).join('/');
    candidates.push({ entry, method: (entry.request?.method ?? 'GET').toUpperCase(), origin: url.origin, path, query: url.searchParams });
  }

  // Other origins count as not API calls too: the API is the most common origin among the calls.
  const counts = new Map<string, number>();
  for (const c of candidates) counts.set(c.origin, (counts.get(c.origin) ?? 0) + 1);
  let origin = '';
  for (const [o, n] of counts) if (!origin || n > counts.get(origin)!) origin = o;
  const groups = new Map<string, Candidate[]>();
  for (const c of candidates) {
    if (c.origin !== origin) {
      filtered++;
      continue;
    }
    const key = `${c.method} ${c.path}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }

  const requests: RawRequest[] = [];
  const secrets: string[] = [];
  const queryNotes: string[] = [];
  const maskedNotes: string[] = [];
  let cookies = false;
  for (const [key, group] of groups) {
    const credentials: Credential[] = [];
    const queryNames = new Set<string>();
    const headers: { name: string; value: string }[] = [];
    for (const c of group) {
      for (const h of c.entry.request?.headers ?? []) if (h.name) headers.push({ name: h.name, value: h.value ?? '' });
      const jar = (c.entry.request?.cookies ?? []).filter((k) => k.name);
      if (jar.length) credentials.push({ name: 'Cookie', where: 'header', value: jar.map((k) => `${k.name}=${k.value ?? ''}`).join('; ') });
      for (const [name, value] of c.query) {
        if (isCredentialParam(name)) credentials.push({ name, where: 'query', value });
        else queryNames.add(name);
      }
    }
    if (headers.some((h) => h.name.toLowerCase() === 'cookie') || credentials.some((c) => c.name === 'Cookie')) cookies = true;
    if (queryNames.size) queryNotes.push(`${key} (${[...queryNames].join(', ')})`);

    const withBody = group.find((c) => c.entry.request?.postData?.text?.trim()) ?? group[0];
    const postData = withBody.entry.request?.postData;
    let body: RawBody | undefined;
    const parsed = jsonObject(postData?.text);
    if (parsed) {
      const found: string[] = [];
      body = { json: maskSecretFields(parsed, found, secrets) };
      if (found.length) maskedNotes.push(`${key} (${[...new Set(found)].join(', ')})`);
    } else if (postData?.text?.trim()) body = { text: postData.text, contentType: postData.mimeType };
    else if (postData?.params?.length) body = { unsupported: postData.mimeType || 'form data' };

    // Requests are grouped by method and path; the query of the representative request is kept
    // (credential parameters are removed by the shared URL cleaning).
    const query = withBody.query.toString();
    requests.push({
      item: `${group.length} request${group.length === 1 ? '' : 's'}`,
      method: withBody.method,
      url: `${withBody.origin}${withBody.path}${query ? `?${query}` : ''}`,
      headers,
      body,
      credentials,
    });
  }

  const skipped: Skipped[] = filtered ? [{ item: `${filtered} request${filtered === 1 ? '' : 's'}`, reason: 'filtered: not an API call' }] : [];
  const grouped = [...groups.values()].flat().length;
  const warnings: string[] = [`Grouped ${grouped} API request${grouped === 1 ? '' : 's'} into ${groups.size} endpoint${groups.size === 1 ? '' : 's'}.`];
  if (queryNotes.length) warnings.push(`Query parameters kept from one request per endpoint (requests are grouped by path): ${queryNotes.join('; ')}. Check the values.`);
  if (maskedNotes.length) warnings.push(`Body fields that look like credentials were replaced with <removed>: ${maskedNotes.join('; ')}. Put test values in before running.`);
  if (cookies) warnings.push('Browsers send cookies with every request, so an endpoint can be marked requiresAuth only because of a cookie. Check requiresAuth before running.');
  return buildInput(requests, { name: har.log?.pages?.[0]?.title, skipped, warnings, secrets, noEndpointsMessage: 'No API calls found in the HAR file' });
}
