// Input model helpers shared by the agent, both ctx files and the exported frameworks.
// No imports: the framework export copies this file as src/model.ts, so it must stand alone.
// Everything here is pure: no process.env, no files, no network.

export type Query = Record<string, string | number | boolean>;

// setup creates the resource a path placeholder needs. param names the placeholder it fills; a
// single setup object without param fills the first placeholder (the original shape).
export type Setup = { endpointId: string; idField: string; param?: string };

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
