import { buildInput, ImportError, looksLikeSecretName, parseJsonSource, type Credential, type ImportResult, type RawBody, type RawRequest, type Skipped } from './core';

// Postman collection v2.0 / v2.1: nested folders, collection variables, auth inherited from the
// collection and folders. Each request becomes an endpoint or a skipped item.

type KeyValue = { key?: string; value?: unknown; disabled?: boolean };
type Auth = { type?: string; [param: string]: unknown };
type Url = string | { raw?: string; protocol?: string; host?: string | string[]; port?: string; path?: string | string[]; query?: KeyValue[] };
type Body = { mode?: string; raw?: string; disabled?: boolean; options?: { raw?: { language?: string } }; [mode: string]: unknown };
type Request = string | { method?: string; url?: Url; header?: KeyValue[] | string; body?: Body; auth?: Auth | null };
type Event = { listen?: string; script?: { exec?: string[] | string } };
type Item = { name?: string; item?: Item[]; request?: Request; auth?: Auth | null; event?: Event[] };
type Collection = { info?: { name?: string; schema?: string }; item?: Item[]; variable?: KeyValue[]; auth?: Auth | null; event?: Event[] };

// Auth params are an array of {key, value} in v2.1 and an object in v2.0.
function authParams(auth: Auth): Record<string, string> {
  const raw = auth[auth.type ?? ''];
  const out: Record<string, string> = {};
  if (Array.isArray(raw)) for (const p of raw as KeyValue[]) if (p?.key) out[p.key] = String(p.value ?? '');
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) for (const [k, v] of Object.entries(raw)) out[k] = String(v ?? '');
  return out;
}

// undefined, null and "inherit" take the parent's auth; "noauth" turns it off.
function effectiveAuth(own: Auth | null | undefined, inherited: Auth | null): Auth | null {
  if (!own || !own.type || own.type === 'inherit') return inherited;
  return own.type === 'noauth' ? null : own;
}

function hasScript(events: Event[] | undefined): boolean {
  return (events ?? []).some((e) => e.listen === 'prerequest' && String([e.script?.exec ?? ''].flat().join('')).trim() !== '');
}

function urlText(url: Url | undefined): string {
  if (!url) return '';
  if (typeof url === 'string') return url;
  if (url.raw) return url.raw;
  const host = Array.isArray(url.host) ? url.host.join('.') : url.host ?? '';
  const path = Array.isArray(url.path) ? url.path.join('/') : url.path ?? '';
  const query = (url.query ?? []).filter((q) => !q.disabled && q.key).map((q) => `${q.key}=${String(q.value ?? '')}`).join('&');
  return `${url.protocol ? `${url.protocol}://` : ''}${host}${url.port ? `:${url.port}` : ''}/${path}${query ? `?${query}` : ''}`;
}

export function importPostman(content: string): ImportResult {
  const parsed = parseJsonSource(content, 'The Postman collection');
  const collection = parsed as Collection;
  if (!collection || typeof collection !== 'object' || !Array.isArray(collection.item)) {
    throw new ImportError('Not a Postman collection: expected an object with "info" and "item". Export the collection from Postman as Collection v2.1.');
  }
  const schema = collection.info?.schema ?? '';
  if (schema && !/collection\/v2\.[01]/.test(schema)) {
    throw new ImportError(`Unsupported Postman collection format (${schema}). Export the collection from Postman as Collection v2.1.`);
  }

  // A variable with no value stays unresolved: never guessed.
  const vars = new Map<string, string>();
  const secrets: string[] = [];
  for (const v of collection.variable ?? []) {
    if (!v.key || v.disabled || v.value === undefined || v.value === null || String(v.value) === '') continue;
    vars.set(v.key, String(v.value));
    if (looksLikeSecretName(v.key)) secrets.push(String(v.value));
  }
  const resolve = (text: string): string => {
    let out = text;
    for (let pass = 0; pass < 5; pass++) {
      const next = out.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (m, name: string) => vars.get(name) ?? m);
      if (next === out) break;
      out = next;
    }
    return out;
  };

  const requests: RawRequest[] = [];
  const skipped: Skipped[] = [];
  let scripts = hasScript(collection.event);

  const toRequest = (request: Request, label: string, auth: Auth | null): RawRequest => {
    const req = typeof request === 'string' ? { url: request } : request;
    let url = resolve(urlText(req.url));
    // Postman, like curl, sends a URL without a scheme over http.
    if (url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !url.startsWith('/') && !url.startsWith('{{')) url = `http://${url}`;
    const headers =
      typeof req.header === 'string'
        ? req.header.split('\n').flatMap((line) => {
            const i = line.indexOf(':');
            return i > 0 ? [{ name: line.slice(0, i).trim(), value: resolve(line.slice(i + 1).trim()) }] : [];
          })
        : (req.header ?? []).filter((h) => !h.disabled && h.key).map((h) => ({ name: resolve(h.key!), value: resolve(String(h.value ?? '')) }));

    const credentials: Credential[] = [];
    if (auth) {
      const params = Object.fromEntries(Object.entries(authParams(auth)).map(([k, v]) => [k, resolve(v)]));
      for (const [k, v] of Object.entries(params)) if (/token|secret|password|^value$/i.test(k) && v) secrets.push(v);
      if (auth.type === 'apikey') credentials.push({ name: params.key || 'X-API-Key', where: params.in === 'query' ? 'query' : 'header' });
      else credentials.push({ name: 'Authorization', where: 'header', scheme: auth.type === 'bearer' ? 'bearer' : auth.type === 'oauth2' ? 'oauth2' : undefined });
    }

    let body: RawBody | undefined;
    const b = req.body;
    const mode = b && !b.disabled ? b.mode ?? (b.raw !== undefined ? 'raw' : undefined) : undefined;
    if (mode === 'raw') {
      const text = resolve(b!.raw ?? '');
      const language = b!.options?.raw?.language;
      const headerType = headers.find((h) => h.name.toLowerCase() === 'content-type')?.value;
      if (text.trim()) body = { text, contentType: language === 'json' ? 'application/json' : headerType ?? (language ? `raw ${language}` : undefined) };
    } else if (mode) {
      const data = b![mode];
      const empty = data === undefined || data === null || (Array.isArray(data) && data.length === 0) || (typeof data === 'object' && Object.keys(data as object).length === 0);
      if (!empty) body = { unsupported: { urlencoded: 'form-urlencoded', formdata: 'multipart form-data' }[mode] ?? mode };
    }
    return { item: label, method: req.method ?? 'GET', url, headers, body, credentials };
  };

  const walk = (items: Item[], path: string[], inherited: Auth | null) => {
    for (const it of items) {
      const label = [...path, it.name || '(unnamed)'].join(' / ');
      scripts ||= hasScript(it.event);
      if (Array.isArray(it.item)) walk(it.item, [...path, it.name || '(unnamed)'], effectiveAuth(it.auth, inherited));
      else if (it.request !== undefined) {
        const own = typeof it.request === 'string' ? undefined : it.request.auth;
        requests.push(toRequest(it.request, label, effectiveAuth(own, inherited)));
      } else skipped.push({ item: label, reason: 'not a request or a folder' });
    }
  };
  walk(collection.item, [], effectiveAuth(collection.auth, null));

  const warnings: string[] = [];
  if (scripts) warnings.push('The collection has pre-request scripts. Values they set at run time are not available to the import.');
  return buildInput(requests, { name: collection.info?.name, skipped, warnings, secrets });
}
