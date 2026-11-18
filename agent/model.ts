// Input model helpers shared by the agent, both ctx files and the exported frameworks.
// No imports: the framework export copies this file as src/model.ts, so it must stand alone.
// Everything here is pure: no process.env, no files, no network.

export type Query = Record<string, string | number | boolean>;

// setup creates the resource a path placeholder needs. param names the placeholder it fills; a
// single setup object without param fills the first placeholder (the original shape).
export type Setup = { endpointId: string; idField: string; param?: string; cleanup?: { endpointId: string } };

export type EndpointLike = {
  id: string;
  method: string;
  path: string;
  requiresAuth: boolean;
  body?: Record<string, unknown>;
  query?: Query;
  headers?: Record<string, string>;
  setup?: Setup | Setup[];
};

// One input file for every environment, brand and region: each dimension lists its values, baseUrl and
// headers use {dimension} placeholders, overrides apply when the selection matches their "when".
export type Profile = {
  dimensions: Record<string, string[]>;
  baseUrl: string;
  headers?: Record<string, string>;
  overrides?: { when: Record<string, string>; baseUrl?: string; headers?: Record<string, string> }[];
};

export type Selection = Record<string, string>;

export const PATH_PARAM = /\{[^}]+\}/;

// Placeholder names in order of appearance: "/products/{id}/reviews/{reviewId}" gives ["id", "reviewId"].
export function pathParams(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
}

// Fills placeholders. A string fills the first placeholder only (the original single-id behaviour);
// a map fills every placeholder it names. Values are URL-encoded. A placeholder left unfilled throws.
export function resolvePath(path: string, params: string | Record<string, string>): string {
  if (typeof params === 'string') return path.replace(PATH_PARAM, encodeURIComponent(params));
  const resolved = path.replace(/\{([^}]+)\}/g, (whole, name: string) => (name in params ? encodeURIComponent(params[name]) : whole));
  const left = pathParams(resolved);
  if (left.length) throw new Error(`path ${path} still has unfilled placeholder(s): ${left.map((p) => `{${p}}`).join(', ')}`);
  return resolved;
}

// The setup steps of an endpoint, in order, each with the placeholder it fills.
export function setupSteps(endpoint: Pick<EndpointLike, 'path' | 'setup'>): Setup[] {
  if (!endpoint.setup) return [];
  const steps = Array.isArray(endpoint.setup) ? endpoint.setup : [endpoint.setup];
  const params = pathParams(endpoint.path);
  return steps.map((step, i) => ({ ...step, param: step.param ?? params[i] ?? `param${i + 1}` }));
}

// "?a=1&b=x" or "". Only strings, numbers and booleans: arrays and objects have no single wire format,
// so they are refused with a clear message instead of guessed.
export function queryString(query: Query | undefined): string {
  if (!query) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new Error(`query parameter "${key}" must be a string, number or boolean (arrays and objects are not supported)`);
    }
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

// "env=staging,brand=alpha,region=eu" to { env: "staging", brand: "alpha", region: "eu" }.
export function parseSelection(text: string | undefined): Selection {
  const selection: Selection = {};
  for (const part of (text ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const eq = part.indexOf('=');
    if (eq <= 0 || eq === part.length - 1) throw new Error(`selection "${part}" is not in the form dimension=value`);
    selection[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return selection;
}

function describeDimensions(profile: Profile): string {
  return Object.entries(profile.dimensions)
    .map(([dim, values]) => `  ${dim}: ${values.join(', ')}`)
    .join('\n');
}

// Replaces {dimension} placeholders in a profile string. An unknown placeholder is an error, never left in.
function fill(text: string, selection: Selection, where: string): string {
  return text.replace(/\{([^}]+)\}/g, (whole, name: string) => {
    if (name in selection) return selection[name];
    throw new Error(`${where} uses {${name}}, which is not a profile dimension`);
  });
}

export type Resolved = { baseUrl: string; defaultHeaders: Record<string, string>; selection: Selection | null };

// Resolves the profile (if any) against the selection text (the --select flag or AGENT_SELECT).
// Without a profile, baseUrl must be set and the selection is null. With one, every dimension needs
// exactly one chosen value; a dimension with a single value is chosen on its own.
// Header order, later wins: defaultHeaders, profile.headers, matching overrides in order. Endpoint
// headers and the auth header are added per request on top of these.
export function resolveProfile(
  raw: { profile?: Profile; baseUrl?: string; defaultHeaders?: Record<string, string> },
  selectionText: string | undefined,
): Resolved {
  const defaultHeaders = { ...(raw.defaultHeaders ?? {}) };
  if (!raw.profile) {
    if (!raw.baseUrl) throw new Error('input has neither baseUrl nor profile');
    return { baseUrl: raw.baseUrl, defaultHeaders, selection: null };
  }
  const profile = raw.profile;
  const given = parseSelection(selectionText);
  const dims = Object.keys(profile.dimensions);
  if (!dims.length) throw new Error('profile.dimensions is empty');
  for (const dim of Object.keys(given)) {
    if (!dims.includes(dim)) throw new Error(`selection names unknown dimension "${dim}". Dimensions:\n${describeDimensions(profile)}`);
  }
  const selection: Selection = {};
  const missing: string[] = [];
  for (const dim of dims) {
    const values = profile.dimensions[dim];
    if (!values.length) throw new Error(`profile dimension "${dim}" has no values`);
    const chosen = given[dim] ?? (values.length === 1 ? values[0] : undefined);
    if (chosen === undefined) {
      missing.push(dim);
      continue;
    }
    if (!values.includes(chosen)) {
      throw new Error(`selection ${dim}=${chosen} is not one of the profile's values. Dimensions:\n${describeDimensions(profile)}`);
    }
    selection[dim] = chosen;
  }
  if (missing.length) {
    throw new Error(
      `select one value for ${missing.map((d) => `"${d}"`).join(', ')} with --select ${dims.map((d) => `${d}=<value>`).join(',')} (or AGENT_SELECT). Dimensions:\n${describeDimensions(profile)}`,
    );
  }

  let baseUrl = fill(profile.baseUrl, selection, 'profile.baseUrl');
  const headers = { ...defaultHeaders };
  for (const [k, v] of Object.entries(profile.headers ?? {})) headers[k] = fill(v, selection, `profile.headers.${k}`);
  for (const override of profile.overrides ?? []) {
    const matches = Object.entries(override.when).every(([dim, value]) => selection[dim] === value);
    if (!matches) continue;
    if (override.baseUrl) baseUrl = fill(override.baseUrl, selection, 'override baseUrl');
    for (const [k, v] of Object.entries(override.headers ?? {})) headers[k] = fill(v, selection, `override header ${k}`);
  }
  try {
    new URL(baseUrl);
  } catch {
    throw new Error(`resolved base URL "${baseUrl}" is not a valid URL`);
  }
  return { baseUrl, defaultHeaders: headers, selection };
}

// Applies the profile to a raw config object and returns it with plain baseUrl, defaultHeaders and
// selection, so everything downstream (safety guard included) sees one concrete host.
export function applyProfile<T extends { profile?: Profile; baseUrl?: string; defaultHeaders?: Record<string, string> }>(
  raw: T,
  selectionText: string | undefined,
): T & Resolved {
  const resolved = resolveProfile(raw, selectionText);
  return { ...raw, ...resolved };
}

// Test titles. A generated test title starts with its type tag ("[happy] list-products ..."). Tests that
// come from the team's test case sheet carry the sheet's case ID first ("[TC-001] [happy] List products"),
// and next to a sheet the agent's own suggestions carry "[agent]" ("[agent] [auth] ..."). A test the
// sheet describes too vaguely to automate is "[TC-010] [needs-review] ..." and never runs.
export const TEST_TYPES = ['happy', 'schema', 'invalid-input', 'auth', 'authz'] as const;
export const AGENT_CASE_PREFIX = 'agent';
const TITLE_RE = /^(?:\[([^[\]]{1,64})\]\s+)?\[(happy|schema|invalid-input|auth|authz|needs-review)\]/;

export function parseTestTitle(title: string): { caseId: string | null; type: string | null } {
  const m = title.match(TITLE_RE);
  if (!m) return { caseId: null, type: null };
  // A type tag is never a case ID: "[happy] [auth] x" is not a case "happy".
  if (m[1] !== undefined && (TEST_TYPES as readonly string[]).includes(m[1])) return { caseId: null, type: null };
  return { caseId: m[1] === undefined || m[1] === AGENT_CASE_PREFIX ? null : m[1], type: m[2] };
}

// The test type of a title, with or without a case ID prefix; null for a needs-review placeholder or an
// untagged title.
export function testTypeOf(title: string): string | null {
  const t = parseTestTitle(title).type;
  return t && t !== 'needs-review' ? t : null;
}

// Joins the base URL and a request path so the base URL's own path is kept:
// joinUrl of https://host/api/v2 and /items?x=1 is https://host/api/v2/items?x=1. Standard URL
// resolution would drop /api/v2 because of the leading slash. An absolute http(s)
// URL is returned as it is; an empty path gives the base URL itself. Pure string work, the same on
// every OS.
export function joinUrl(baseUrl: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const base = baseUrl.replace(/[?#].*$/, '').replace(/\/+$/, '');
  if (!path) return base;
  if (/^[?#]/.test(path)) return base + path;
  return `${base}/${path.replace(/^\/+/, '')}`;
}

// Methods that only read. An endpoint with one of these changes no data on the API.
export const READ_ONLY_METHODS = ['GET', 'HEAD', 'OPTIONS'] as const;
export function isReadOnlyMethod(method: string): boolean {
  return (READ_ONLY_METHODS as readonly string[]).includes(method.toUpperCase());
}

// A response body that is not text: images, PDFs, archives, application/octet-stream. JSON, XML,
// form data, HTML and every text/* type are text. No content type at all counts as text.
export function isBinaryContentType(contentType: string | null | undefined): boolean {
  const t = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  if (!t) return false;
  if (t.startsWith('text/')) return false;
  if (/[/+](json|xml|javascript|ecmascript|x-www-form-urlencoded|html|csv|yaml|x-yaml|graphql)$/.test(t)) return false;
  return true;
}

// A JSON response: application/json, application/problem+json, application/vnd.x+json.
export function isJsonContentType(contentType: string | null | undefined): boolean {
  return /[/+]json\b/i.test(String(contentType ?? '').split(';')[0]);
}

// The file type a body's first bytes show, or null. Used by the probe (so the prompt can say "a PNG
// image") and shown to the model as the hex prefix a test can assert.
export const FILE_SIGNATURES: { kind: string; hex: string; mime: string }[] = [
  { kind: 'png', hex: '89504e47', mime: 'image/png' },
  { kind: 'jpeg', hex: 'ffd8ff', mime: 'image/jpeg' },
  { kind: 'gif', hex: '47494638', mime: 'image/gif' },
  { kind: 'pdf', hex: '25504446', mime: 'application/pdf' },
  { kind: 'zip', hex: '504b0304', mime: 'application/zip' },
];
export function fileSignature(bytes: Uint8Array): { kind: string; hex: string } | null {
  const hex = Array.from(bytes.subarray(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
  // WebP: "RIFF" .... "WEBP"
  if (hex.startsWith('52494646') && hex.slice(16, 24) === '57454250') return { kind: 'webp', hex: '52494646' };
  const found = FILE_SIGNATURES.find((s) => hex.startsWith(s.hex));
  return found ? { kind: found.kind, hex: found.hex } : null;
}
