import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config, Endpoint } from './config';
import { pathParams } from './model';
import { promptEndpoint } from './plan';

// The client layer (input "layout": "clients", Playwright only for now).
//
// The flat layout writes every path and request body inside the tests. With the client layer the agent
// writes one class per resource (ProductsClient) with one method per endpoint, and one data file per
// resource with the sample request bodies. Tests then read
//
//   const response = await new ProductsClient(ctx.api).updateProduct(id, updateProductBody());
//
// so a path, a default query value or a sample body lives in one place.
//
// Everything in this file is written by code from the input file, never by the model: the same input
// always gives the same files. The class takes the request context it is given (ctx.api, ctx.noAuthApi
// or ctx.as('<role>')), so every request still goes through the guarded ctx clients (safety guard,
// counting, evidence, cleanup) and the static gate's rules about which client a test may use still
// read the test text as before.

export type ClientMethod = {
  endpointId: string;
  httpMethod: Endpoint['method'];
  path: string;
  // The method name on the class, e.g. updateProduct for the endpoint id "update-product".
  name: string;
  // Path placeholders in order, with the argument name each one gets.
  params: { placeholder: string; arg: string }[];
  // POST, PUT and PATCH methods take a body argument.
  takesBody: boolean;
  // The data function that returns the endpoint's sample body, when the input has one.
  bodyFactory: string | null;
  query: Record<string, string | number | boolean> | null;
  headers: Record<string, string> | null;
  body: Record<string, unknown> | null;
};

export type ClientClass = {
  // The resource the class covers: the last fixed segment of its endpoints' paths ("products").
  resource: string;
  className: string;
  // File name without extension, used for both clients/<file>.ts and data/<file>.ts.
  file: string;
  methods: ClientMethod[];
  hasData: boolean;
};

export type ClientLayer = { classes: ClientClass[] };

// Where the files live while the agent runs, and the import paths a generated spec uses. Specs are
// typechecked from a sibling folder of generated/ (agent/validate.ts), so the path names generated/
// itself; the exporter rewrites it to ../src/.
export const CLIENTS_DIR = join('generated', 'clients');
export const DATA_DIR = join('generated', 'data');
export const clientImport = (file: string) => `../generated/clients/${file}`;
export const dataImport = (file: string) => `../generated/data/${file}`;

const words = (text: string) => text.split(/[^A-Za-z0-9]+/).filter(Boolean);
const upper = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
const pascal = (text: string) => words(text).map(upper).join('');
const camel = (text: string) => {
  const p = pascal(text);
  return p.charAt(0).toLowerCase() + p.slice(1);
};

// Names a method or an argument must not take: members of the base class and words that cannot be an
// argument name.
const RESERVED = new Set(['constructor', 'send', 'api', 'body', 'options', 'defaults', 'default', 'delete', 'new', 'class', 'function', 'return', 'import', 'export', 'in', 'of', 'this', 'super', 'void', 'typeof', 'var', 'let', 'const', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'try', 'catch', 'finally', 'throw', 'with', 'yield', 'await', 'enum', 'null', 'true', 'false', 'instanceof', 'debugger', 'static', 'interface', 'package', 'private', 'protected', 'public', 'implements', 'arguments', 'eval']);

function identifier(text: string, fallback: string, suffix: string): string {
  let name = camel(text) || fallback;
  if (/^\d/.test(name)) name = `${fallback}${upper(name)}`;
  if (RESERVED.has(name)) name = `${name}${suffix}`;
  return name;
}

// The resource an endpoint belongs to: the last path segment that is not a placeholder. /products,
// /products/{id} and /api/v1/products/{id} are all "products"; /products/{id}/reviews is "reviews".
export function resourceOf(path: string): string {
  const fixed = path.split('/').filter((s) => s && !/^\{[^}]+\}$/.test(s));
  const last = fixed[fixed.length - 1];
  return last && words(last).length ? words(last).join('-').toLowerCase() : 'root';
}

export function buildClientLayer(config: Pick<Config, 'endpoints'>): ClientLayer {
  const byClass = new Map<string, ClientClass>();
  for (const raw of config.endpoints) {
    // The same redacted view of the endpoint the model is shown (agent/plan.ts): sample bodies, query
    // values and headers carry valid stand-ins, never client data.
    const endpoint = promptEndpoint(raw);
    const resource = resourceOf(endpoint.path);
    // BaseClient is the base class every client extends, so a resource called "base" gets another name.
    const plain = `${/^\d/.test(pascal(resource)) ? 'Api' : ''}${pascal(resource)}Client`;
    const className = plain === 'BaseClient' ? 'BaseResourceClient' : plain;
    let cls = byClass.get(className);
    if (!cls) {
      // clients/base.ts holds the base class, so that resource's file gets another name too.
      cls = { resource, className, file: resource === 'base' ? 'base-resource' : resource, methods: [], hasData: false };
      byClass.set(className, cls);
    }
    const name = identifier(endpoint.id, 'call', 'Request');
    const other = cls.methods.find((m) => m.name === name);
    if (other) throw new Error(`client layer: endpoints "${other.endpointId}" and "${endpoint.id}" would both become ${className}.${name}(); give them ids that differ in more than punctuation`);
    const taken = new Set<string>();
    const params = pathParams(endpoint.path).map((placeholder) => {
      let arg = identifier(placeholder, 'param', 'Param');
      while (taken.has(arg)) arg = `${arg}Param`;
      taken.add(arg);
      return { placeholder, arg };
    });
    const takesBody = ['POST', 'PUT', 'PATCH'].includes(endpoint.method);
    const body = takesBody && endpoint.body ? endpoint.body : null;
    cls.methods.push({
      endpointId: endpoint.id,
      httpMethod: endpoint.method,
      path: endpoint.path,
      name,
      params,
      takesBody,
      bodyFactory: body ? `${name}Body` : null,
      query: endpoint.query && Object.keys(endpoint.query).length ? endpoint.query : null,
      headers: endpoint.headers && Object.keys(endpoint.headers).length ? endpoint.headers : null,
      body,
    });
    if (body) cls.hasData = true;
  }
  return { classes: [...byClass.values()] };
}

export function clientFor(layer: ClientLayer, endpointId: string): { cls: ClientClass; method: ClientMethod } {
  for (const cls of layer.classes) {
    const method = cls.methods.find((m) => m.endpointId === endpointId);
    if (method) return { cls, method };
  }
  throw new Error(`client layer: no client method for endpoint "${endpointId}"`);
}

const HEADER = '// Written by API Test Agent from the API definition (the input file), not by the model.\n';

export function baseSource(): string {
  return `${HEADER}import type { APIRequestContext, APIResponse } from '@playwright/test';

// Per-call options, merged over the endpoint's defaults.
export type CallOptions = {
  // Query parameters. A key set to undefined removes that default parameter from the request.
  params?: Record<string, string | number | boolean | undefined>;
  // Extra headers. The auth header never goes here: it comes from the request context.
  headers?: Record<string, string>;
};

type Defaults = { params?: Record<string, string | number | boolean>; headers?: Record<string, string> };

// Every client class extends this. \`api\` is the request context the test passes in: ctx.api (the
// default role), ctx.noAuthApi (no auth) or ctx.as('<role>'). The client never creates a context of its
// own, so every request keeps the safety guard, the evidence and the cleanup of the ctx fixture.
export class BaseClient {
  constructor(protected readonly api: APIRequestContext) {}

  protected send(method: string, path: string, defaults: Defaults, body: unknown, options: CallOptions = {}): Promise<APIResponse> {
    const params: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries({ ...defaults.params, ...options.params })) {
      if (value !== undefined) params[key] = value;
    }
    const headers = { ...defaults.headers, ...options.headers };
    return this.api.fetch(path, {
      method,
      ...(body !== undefined ? { data: body } : {}),
      ...(Object.keys(params).length ? { params } : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
    });
  }
}

// A path value as one URL segment.
export function segment(value: string | number): string {
  return encodeURIComponent(String(value));
}
`;
}

const quote = (text: string) => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')}'`;

// Text from the input file inside a // comment: one line, whatever the text holds.
const commentText = (text: string) => text.replace(/[\r\n\u2028\u2029]+/g, ' ');
// Text from the input file inside a template literal: no backtick, no \${, no stray backslash.
const templateText = (text: string) => text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${').replace(/[\r\n\u2028\u2029]/g, '');

// A JSON value as TypeScript source in the house style: single quotes, plain keys where they are valid
// identifiers, two-space indent. indent is the indent of the line the value starts on.
export function literal(value: unknown, indent: string): string {
  if (typeof value === 'string') return quote(value);
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return `[\n${value.map((v) => `${inner}${literal(v, inner)},`).join('\n')}\n${indent}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length) return '{}';
  const key = (k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : quote(k));
  return `{\n${entries.map(([k, v]) => `${inner}${key(k)}: ${literal(v, inner)},`).join('\n')}\n${indent}}`;
}

export function methodSignature(m: ClientMethod): string {
  const args = [...m.params.map((p) => `${p.arg}: string | number`), ...(m.takesBody ? ['body?: unknown'] : []), 'options?: CallOptions'];
  return `${m.name}(${args.join(', ')}): Promise<APIResponse>`;
}

export function clientSource(cls: ClientClass): string {
  const methods = cls.methods.map((m) => {
    const hasParams = m.params.length > 0;
    // The path comes from the input file (often an imported spec), so its fixed parts are escaped for
    // the template literal: a backtick or \${ in a path must stay text, never become code.
    const path = hasParams
      ? '`' +
        m.path
          .split(/(\{[^}]+\})/)
          .map((part) => {
            const ph = /^\{([^}]+)\}$/.exec(part);
            return ph ? '${segment(' + m.params.find((x) => x.placeholder === ph[1])!.arg + ')}' : templateText(part);
          })
          .join('') +
        '`'
      : quote(m.path);
    // The sample query and the extra headers from the input: sent on every call unless the test overrides one.
    const defaults = { ...(m.query ? { params: m.query } : {}), ...(m.headers ? { headers: m.headers } : {}) };
    const hasDefaults = Object.keys(defaults).length > 0;
    const defaultsLine = hasDefaults ? `    const defaults = ${literal(defaults, '    ')};\n` : '';
    return `  // ${commentText(`${m.endpointId}: ${m.httpMethod} ${m.path}`)}\n  ${methodSignature(m)} {\n${defaultsLine}    return this.send('${m.httpMethod}', ${path}, ${hasDefaults ? 'defaults' : '{}'}, ${m.takesBody ? 'body' : 'undefined'}, options);\n  }`;
  });
  const usesSegment = cls.methods.some((m) => m.params.length > 0);
  return `${HEADER}import type { APIResponse } from '@playwright/test';
import { BaseClient, ${usesSegment ? 'segment, ' : ''}type CallOptions } from './base';

// One method per endpoint of the "${cls.resource}" resource. A path or a default query value changes here, in one place.
export class ${cls.className} extends BaseClient {
${methods.join('\n\n')}
}
`;
}

export function dataSource(cls: ClientClass): string | null {
  const withBody = cls.methods.filter((m) => m.bodyFactory && m.body);
  if (!withBody.length) return null;
  const blocks = withBody.map((m) => {
    const type = upper(m.bodyFactory!);
    return `// ${commentText(`${m.endpointId}: the sample body for ${m.httpMethod} ${m.path}.`)}\nexport function ${m.bodyFactory}() {\n  return ${literal(m.body, '  ')};\n}\nexport type ${type} = ReturnType<typeof ${m.bodyFactory}>;`;
  });
  return `${HEADER}
// Sample request bodies for the "${cls.resource}" resource. Each function returns a new object, so a test
// can change or remove a field without affecting another test:
//   { ...${withBody[0].bodyFactory}(), someField: 'another value' }

${blocks.join('\n\n')}
`;
}

// Every file of the layer, by path relative to the folder that holds clients/ and data/.
export function clientLayerFiles(layer: ClientLayer): { path: string; content: string }[] {
  const files = [{ path: 'clients/base.ts', content: baseSource() }];
  for (const cls of layer.classes) {
    files.push({ path: `clients/${cls.file}.ts`, content: clientSource(cls) });
    const data = dataSource(cls);
    if (data) files.push({ path: `data/${cls.file}.ts`, content: data });
  }
  return files;
}

// Writes the layer under root (generated/ during a run, the export's src/ afterwards). The two folders
// are replaced whole, so a class for an endpoint that left the input does not stay behind.
export function writeClientLayer(layer: ClientLayer, root: string): string[] {
  rmSync(join(root, 'clients'), { recursive: true, force: true });
  rmSync(join(root, 'data'), { recursive: true, force: true });
  mkdirSync(join(root, 'clients'), { recursive: true });
  const written: string[] = [];
  for (const file of clientLayerFiles(layer)) {
    if (file.path.startsWith('data/')) mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, file.path), file.content);
    written.push(file.path);
  }
  return written;
}

// What the generator prompt and the static gate need to know about one endpoint's client.
export type ClientUse = {
  className: string;
  clientModule: string;
  method: string;
  signature: string;
  params: string[];
  takesBody: boolean;
  bodyFactory: string | null;
  dataModule: string | null;
  // Every client class of the run and the modules a spec may import, for the gate.
  knownClasses: string[];
  allowedModules: string[];
  // The files the test will call, shown to the model as they are.
  sources: { base: string; client: string; data: string | null };
};

export function clientUse(layer: ClientLayer, endpointId: string): ClientUse {
  const { cls, method } = clientFor(layer, endpointId);
  return {
    className: cls.className,
    clientModule: clientImport(cls.file),
    method: method.name,
    signature: methodSignature(method),
    params: method.params.map((p) => p.arg),
    takesBody: method.takesBody,
    bodyFactory: method.bodyFactory,
    dataModule: cls.hasData ? dataImport(cls.file) : null,
    knownClasses: layer.classes.map((c) => c.className),
    allowedModules: layer.classes.flatMap((c) => [clientImport(c.file), ...(c.hasData ? [dataImport(c.file)] : [])]),
    sources: { base: baseSource(), client: clientSource(cls), data: dataSource(cls) },
  };
}
