import { parseDocument } from 'yaml';
import {
  buildInput,
  ImportError,
  isCredentialHeader,
  isCredentialParam,
  lineAndColumn,
  parseJsonSource,
  type Credential,
  type ImportResult,
  type RawBody,
  type RawRequest,
} from './core';

// OpenAPI 3.x and Swagger 2.0, JSON or YAML. One endpoint per operation. The sample body comes from
// the request example, else it is built from the schema's required properties. requiresAuth comes
// from security (global or per operation). Base URL from servers[0], or Swagger host + basePath.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

function parseSpec(content: string): Obj {
  let doc: unknown;
  if (content.trimStart().startsWith('{')) doc = parseJsonSource(content, 'The OpenAPI document');
  else {
    const parsed = parseDocument(content, { prettyErrors: false });
    if (parsed.errors.length) {
      // YAML error messages can quote the source: report the position and the error code only.
      const e = parsed.errors[0];
      throw new ImportError(`The OpenAPI document is not valid YAML (${lineAndColumn(content, e.pos[0])}, ${e.code}).`);
    }
    doc = parsed.toJS({ maxAliasCount: 100 });
  }
  if (!isObj(doc) || (doc.openapi === undefined && doc.swagger === undefined)) {
    throw new ImportError('Not an OpenAPI 3.x or Swagger 2.0 document: it has no "openapi" or "swagger" field.');
  }
  const version = String(doc.openapi ?? doc.swagger);
  if (doc.openapi !== undefined ? !version.startsWith('3') : !version.startsWith('2')) {
    throw new ImportError(`Unsupported version ${version}: OpenAPI 3.x and Swagger 2.0 are supported.`);
  }
  return doc;
}

const SAMPLE_BY_FORMAT: Record<string, string> = {
  email: 'user@example.com',
  uuid: '00000000-0000-4000-8000-000000000000',
  date: '2026-01-01',
  'date-time': '2026-01-01T00:00:00Z',
  uri: 'https://example.com',
  url: 'https://example.com',
  ipv4: '192.0.2.1',
};

export function importOpenApi(content: string): ImportResult {
  const doc = parseSpec(content);
  const swagger = doc.swagger !== undefined;
  const warnings: string[] = [];
  const external = new Set<string>();

  // Local $ref only ("#/components/..."). External or circular references are not followed.
  const deref = (node: unknown): unknown => {
    let cur = node;
    const seen = new Set<string>();
    while (isObj(cur) && typeof cur.$ref === 'string') {
      const ref = cur.$ref;
      if (!ref.startsWith('#/') || seen.has(ref)) {
        if (!ref.startsWith('#/')) external.add(ref);
        return undefined;
      }
      seen.add(ref);
      cur = ref
        .slice(2)
        .split('/')
        .reduce<unknown>((o, key) => (isObj(o) ? o[key.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined), doc);
    }
    return cur;
  };

  // A value of the schema's type: example, default, enum, else a simple typed value. Objects get
  // their required, non-readOnly properties only.
  const sample = (schemaRef: unknown, depth = 0): unknown => {
    const s = deref(schemaRef);
    if (!isObj(s) || depth > 6) return undefined;
    if (s.example !== undefined) return s.example;
    if (s.default !== undefined) return s.default;
    if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
    if (s.const !== undefined) return s.const;
    if (Array.isArray(s.allOf)) {
      const parts = s.allOf.map((part) => sample(part, depth + 1));
      return parts.every((p) => p === undefined || isObj(p)) ? Object.assign({}, ...parts.filter(isObj)) : parts.find((p) => p !== undefined);
    }
    const choice = Array.isArray(s.oneOf) ? s.oneOf : Array.isArray(s.anyOf) ? s.anyOf : null;
    if (choice) return sample(choice[0], depth + 1);
    const type = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type ?? (s.properties ? 'object' : s.items ? 'array' : undefined);
    if (type === 'object') {
      const props = isObj(s.properties) ? s.properties : {};
      const out: Obj = {};
      for (const name of Array.isArray(s.required) ? s.required.map(String) : []) {
        const prop = deref(props[name]);
        if (isObj(prop) && prop.readOnly === true) continue;
        const value = sample(prop, depth + 1);
        out[name] = value === undefined ? 'string' : value;
      }
      return out;
    }
    if (type === 'array') {
      const item = sample(s.items, depth + 1);
      return item === undefined ? [] : [item];
    }
    if (type === 'string') return SAMPLE_BY_FORMAT[String(s.format)] ?? 'string';
    if (type === 'integer' || type === 'number') return 1;
    if (type === 'boolean') return true;
    return undefined;
  };

  const exampleOf = (mediaRef: unknown): unknown => {
    const media = deref(mediaRef);
    if (!isObj(media)) return undefined;
    if (media.example !== undefined) return media.example;
    if (isObj(media.examples)) {
      const first = deref(Object.values(media.examples)[0]);
      if (isObj(first) && first.value !== undefined) return first.value;
    }
    const schema = deref(media.schema);
    return isObj(schema) && schema.example !== undefined ? schema.example : undefined;
  };

  // Base URL. Relative or missing means an empty baseUrl and a warning; the user fills it in.
  let origin = '';
  let prefix = '';
  let noBase: string | undefined;
  if (swagger) {
    const host = typeof doc.host === 'string' ? doc.host.trim() : '';
    prefix = typeof doc.basePath === 'string' ? doc.basePath.replace(/\/+$/, '') : '';
    const scheme = (Array.isArray(doc.schemes) ? doc.schemes.map(String) : []).find((s) => /^https?$/i.test(s));
    if (!host) noBase = 'The spec has no host. Enter the base URL before running.';
    else if (!scheme) noBase = `The spec gives the host ${host} but no http or https scheme. Enter the base URL before running.`;
    else origin = `${scheme.toLowerCase()}://${host}`;
  } else {
    const server = Array.isArray(doc.servers) ? doc.servers.find(isObj) : undefined;
    let url = typeof server?.url === 'string' ? server.url.trim() : '';
    const vars = isObj(server?.variables) ? server.variables : {};
    let missing: string | undefined;
    url = url.replace(/\{([^}]+)\}/g, (m, name: string) => {
      const v = vars[name];
      if (isObj(v) && v.default !== undefined) return String(v.default);
      missing ??= name;
      return m;
    });
    const abs = url.match(/^(https?:\/\/[^/?#]+)([^?#]*)/i);
    if (!url) noBase = 'The spec has no servers entry. Enter the base URL before running.';
    else if (missing) noBase = `servers[0].url uses the variable {${missing}} without a default. Enter the base URL before running.`;
    else if (abs) {
      origin = abs[1];
      prefix = abs[2].replace(/\/+$/, '');
    } else {
      noBase = `servers[0].url is relative (${url}). Enter the base URL before running.`;
      if (url.startsWith('/')) prefix = url.replace(/\/+$/, '');
    }
  }

  const schemes = deref(swagger ? doc.securityDefinitions : isObj(doc.components) ? doc.components.securitySchemes : undefined);
  const schemeCredential = (name: string): Credential | null => {
    const scheme = isObj(schemes) ? deref(schemes[name]) : undefined;
    if (!isObj(scheme)) return { name: 'Authorization', where: 'header', declared: true };
    if (scheme.type === 'apiKey' && typeof scheme.name === 'string') {
      if (scheme.in === 'query') return { name: scheme.name, where: 'query', declared: true };
      return { name: scheme.in === 'cookie' ? 'Cookie' : scheme.name, where: 'header', declared: true };
    }
    if (scheme.type === 'mutualTLS') return null;
    return { name: 'Authorization', where: 'header', declared: true };
  };

  const requests: RawRequest[] = [];
  const secrets: string[] = [];
  const built: string[] = [];
  const emptyBuilt: string[] = [];
  let mutualTls = false;
  const paths = isObj(doc.paths) ? doc.paths : {};
  for (const [path, rawItem] of Object.entries(paths)) {
    const item = deref(rawItem);
    if (!isObj(item)) continue;
    for (const [key, rawOp] of Object.entries(item)) {
      if (!HTTP_METHODS.has(key.toLowerCase())) continue;
      const op = deref(rawOp);
      if (!isObj(op)) continue;
      const method = key.toUpperCase();
      const label = typeof op.operationId === 'string' && op.operationId ? op.operationId : `${method} ${path}`;

      // Operation parameters override path-level ones with the same name and location.
      const params = new Map<string, Obj>();
      for (const raw of [...(Array.isArray(item.parameters) ? item.parameters : []), ...(Array.isArray(op.parameters) ? op.parameters : [])]) {
        const p = deref(raw);
        if (isObj(p) && typeof p.name === 'string') params.set(`${p.in}:${p.name}`, p);
      }

      const credentials: Credential[] = [];
      const headers: { name: string; value: string }[] = [];
      const query: string[] = [];
      for (const p of params.values()) {
        const name = String(p.name);
        const value = p.example ?? p['x-example'] ?? (isObj(p.schema) ? p.schema.example ?? p.schema.default : p.default);
        const text = value === undefined ? undefined : String(value);
        if ((p.in === 'header' && isCredentialHeader(name)) || (p.in === 'query' && isCredentialParam(name)) || p.in === 'cookie') {
          if (text) secrets.push(text);
          credentials.push({ name: p.in === 'cookie' ? 'Cookie' : name, where: p.in === 'query' ? 'query' : 'header', value: text, declared: !text });
        } else if (p.in === 'header' && p.required === true) headers.push({ name, value: text ?? '' });
        else if (p.in === 'query' && p.required === true) {
          query.push(`${encodeURIComponent(name)}=${encodeURIComponent(text ?? String(sample(p.schema ?? p) ?? 'string'))}`);
        }
      }

      const security = Array.isArray(op.security) ? op.security : Array.isArray(doc.security) ? doc.security : undefined;
      const anonymousAllowed = security?.some((r) => isObj(r) && Object.keys(r).length === 0);
      const requiresAuth = Boolean(security?.length) && !anonymousAllowed;
      if (requiresAuth) {
        const requirement = security!.find(isObj) ?? {};
        for (const name of Object.keys(requirement)) {
          const c = schemeCredential(name);
          if (c) credentials.push(c);
          else mutualTls = true;
        }
      }

      let body: RawBody | undefined;
      const takeExample = (example: unknown, schema: unknown) => {
        if (example !== undefined) return { json: example };
        const value = sample(schema);
        if (value === undefined) return undefined;
        built.push(label);
        if (isObj(value) && !Object.keys(value).length) emptyBuilt.push(label);
        return { json: value };
      };
      if (swagger) {
        const consumes = (Array.isArray(op.consumes) ? op.consumes : Array.isArray(doc.consumes) ? doc.consumes : []).map(String);
        const bodyParam = [...params.values()].find((p) => p.in === 'body');
        if ([...params.values()].some((p) => p.in === 'formData')) body = { unsupported: consumes.find((c) => /form/i.test(c)) ?? 'form data' };
        else if (bodyParam) {
          if (consumes.length && !consumes.some((c) => /json/i.test(c))) body = { unsupported: consumes[0] };
          else body = takeExample(bodyParam['x-example'] ?? (isObj(deref(bodyParam.schema)) ? (deref(bodyParam.schema) as Obj).example : undefined), bodyParam.schema);
        }
      } else {
        const requestBody = deref(op.requestBody);
        const contentMap = isObj(requestBody) && isObj(requestBody.content) ? requestBody.content : {};
        const types = Object.keys(contentMap);
        const jsonType =
          types.find((t) => t.split(';')[0].trim().toLowerCase() === 'application/json') ?? types.find((t) => /[/+]json\b/i.test(t));
        if (jsonType) {
          const media = deref(contentMap[jsonType]);
          body = takeExample(exampleOf(media), isObj(media) ? media.schema : undefined);
        } else if (types.length) body = { unsupported: types[0] };
      }

      const url = `${origin}${prefix}${path}${query.length ? `?${query.join('&')}` : ''}`;
      requests.push({ item: label, method, url, headers, body, credentials, requiresAuth });
    }
  }

  if (built.length) warnings.push(`Sample body built from the schema (no example in the spec) for: ${built.join(', ')}. Check the values before running.`);
  if (emptyBuilt.length) warnings.push(`The body schema has no required fields, so the sample body is empty, for: ${emptyBuilt.join(', ')}.`);
  if (external.size) warnings.push(`External $ref values are not followed: ${[...external].join(', ')}.`);
  if (mutualTls) warnings.push('Some operations use mutual TLS, which the agent cannot send. Their requiresAuth is set, but no header can satisfy it.');
  const title = isObj(doc.info) && typeof doc.info.title === 'string' ? doc.info.title : undefined;
  return buildInput(requests, { name: title, warnings, secrets, noBaseUrlWarning: noBase });
}
