import { readFileSync } from 'node:fs';
import { z } from 'zod';

const SetupSchema = z.object({
  endpointId: z.string().min(1),
  idField: z.string().min(1),
});

const EndpointSchema = z.object({
  id: z.string().min(1),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().startsWith('/'),
  requiresAuth: z.boolean(),
  body: z.record(z.string(), z.unknown()).optional(),
  setup: SetupSchema.optional(),
});

const ConfigSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/, 'must use lowercase letters, numbers and dashes only').optional(),
  baseUrl: z.url(),
  defaultHeaders: z.record(z.string(), z.string()),
  auth: z
    .object({
      header: z.string().min(1),
      valueEnv: z.string().min(1),
    })
    .optional(),
  endpoints: z.array(EndpointSchema).min(1),
});

// A path placeholder such as {id} or {productId}; setup fills it with the created resource id.
export const PATH_PARAM = /\{[^}]+\}/;

export type Endpoint = z.infer<typeof EndpointSchema>;
export type Config = z.infer<typeof ConfigSchema>;

// The API name: config.name, else the input file name. A UI run without a name is "custom-api".
// Used for the framework folder and the Allure epic.
export function apiName(config: Config, inputFile: string): string {
  const fromFile = (inputFile.split(/[\\/]/).pop() ?? inputFile)
    .replace(/\.json$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-');
  const name = config.name ?? fromFile;
  return name === 'ui-run' ? 'custom-api' : name;
}

function fieldName(path: PropertyKey[]): string {
  return path.reduce<string>((acc, key) => {
    if (typeof key === 'number') return `${acc}[${key}]`;
    return acc ? `${acc}.${String(key)}` : String(key);
  }, '') || '(root)';
}

export function loadConfig(path: string): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read input file ${path}: ${(err as Error).message}`);
  }

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(`Invalid input file ${path}: field "${fieldName(issue.path)}" ${issue.message}`);
  }
  const config = result.data;

  const ids = new Set<string>();
  config.endpoints.forEach((ep, i) => {
    if (ids.has(ep.id)) {
      throw new Error(`Invalid input file ${path}: field "endpoints[${i}].id" duplicate id "${ep.id}"`);
    }
    ids.add(ep.id);
  });
  config.endpoints.forEach((ep, i) => {
    if (ep.requiresAuth && !config.auth) {
      throw new Error(
        `Invalid input file ${path}: field "endpoints[${i}].requiresAuth" endpoint "${ep.id}" requires auth but the input has no auth section`,
      );
    }
  });
  config.endpoints.forEach((ep, i) => {
    if (!ep.setup) return;
    const target = config.endpoints.find((e) => e.id === ep.setup!.endpointId);
    if (!target) {
      throw new Error(
        `Invalid input file ${path}: field "endpoints[${i}].setup.endpointId" references unknown endpoint "${ep.setup.endpointId}"`,
      );
    }
    if (!PATH_PARAM.test(ep.path)) {
      throw new Error(`Invalid input file ${path}: field "endpoints[${i}].path" has setup but no {id} placeholder`);
    }
  });

  return config;
}
