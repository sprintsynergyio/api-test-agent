import { readFileSync } from 'node:fs';
import { z } from 'zod';

import { authRoles, DEFAULT_ROLE, type AuthConfig } from './auth';
import { applyProfile, pathParams, setupSteps, type Selection } from './model';

const SetupSchema = z.object({
  endpointId: z.string().min(1),
  idField: z.string().min(1),
  // The placeholder this step fills. Missing: the placeholder at this step's position (first for a single setup).
  param: z.string().min(1).optional(),
  // The DELETE endpoint that removes what this step created, when it cannot be found by path (agent/http.ts cleanup).
  cleanup: z.object({ endpointId: z.string().min(1) }).optional(),
});

const QueryValue = z.union([z.string(), z.number(), z.boolean()]);

const EndpointSchema = z.object({
  id: z.string().min(1),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().startsWith('/').refine((p) => !p.includes('?'), 'must not contain a query string; use the endpoint\'s "query" field'),
  requiresAuth: z.boolean(),
  body: z.record(z.string(), z.unknown()).optional(),
  // Sent with every request to this endpoint (probe, createResource, and the tests' happy path).
  query: z.record(z.string(), QueryValue).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  setup: z.union([SetupSchema, z.array(SetupSchema).min(1)]).optional(),
});

const ProfileSchema = z.object({
  dimensions: z.record(z.string().min(1), z.array(z.string().min(1)).min(1)),
  baseUrl: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
  overrides: z
    .array(
      z.object({
        when: z.record(z.string(), z.string()),
        baseUrl: z.string().min(1).optional(),
        headers: z.record(z.string(), z.string()).optional(),
      }),
    )
    .optional(),
});

// Auth (agent/auth.ts). An auth section without "type" is the original { header, valueEnv } form.
const RoleSchema = z.object({
  valueEnv: z.string().min(1).optional(),
  credentialsEnv: z.record(z.string().min(1), z.string().min(1)).optional(),
  clientIdEnv: z.string().min(1).optional(),
  clientSecretEnv: z.string().min(1).optional(),
});
const roles = z.record(z.string().min(1), RoleSchema).optional();
const ApplySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('header'), header: z.string().min(1), prefix: z.string().optional() }),
  z.object({ type: z.literal('cookie'), name: z.string().min(1) }),
  z.object({ type: z.literal('query'), param: z.string().min(1) }),
]);
const AuthUnion = z.discriminatedUnion('type', [
  z.object({ type: z.literal('header'), header: z.string().min(1), valueEnv: z.string().min(1), roles }),
  z.object({ type: z.literal('query'), param: z.string().min(1), valueEnv: z.string().min(1), roles }),
  z.object({ type: z.literal('cookie'), name: z.string().min(1), valueEnv: z.string().min(1), roles }),
  z.object({
    type: z.literal('login'),
    request: z.object({
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
      path: z.string().startsWith('/'),
      body: z.record(z.string(), z.unknown()).optional(),
      headers: z.record(z.string(), z.string()).optional(),
    }),
    credentialsEnv: z.record(z.string().min(1), z.string().min(1)),
    tokenPath: z.string().min(1),
    apply: ApplySchema,
    refresh: z.object({ statuses: z.array(z.number().int().min(100).max(599)).min(1), once: z.literal(true).optional() }).optional(),
    roles,
  }),
  z.object({
    type: z.literal('oauth2_client'),
    tokenUrl: z.string().regex(/^(\/|https?:\/\/)/, 'must be a path starting with / or an absolute http(s) URL'),
    clientIdEnv: z.string().min(1),
    clientSecretEnv: z.string().min(1),
    scope: z.string().min(1).optional(),
    audience: z.string().min(1).optional(),
    clientAuth: z.enum(['body', 'basic']).optional(),
    tokenPath: z.string().min(1).optional(),
    apply: ApplySchema.optional(),
    refresh: z.object({ statuses: z.array(z.number().int().min(100).max(599)).min(1), once: z.literal(true).optional() }).optional(),
    roles,
  }),
]);
const AuthSchema = z.preprocess((raw) => (raw && typeof raw === 'object' && !Array.isArray(raw) && !('type' in raw) ? { ...raw, type: 'header' } : raw), AuthUnion);

export const ConfigSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/, 'must use lowercase letters, numbers and dashes only').optional(),
  // One of baseUrl or profile is required (checked in configProblems). With a profile, baseUrl is the
  // resolved value for the selected dimensions and is filled in by loadConfig.
  baseUrl: z.url().optional(),
  profile: ProfileSchema.optional(),
  defaultHeaders: z.record(z.string(), z.string()),
  auth: AuthSchema.optional(),
  // Safety guard (agent/safety.ts). Missing means false.
  allowProduction: z.boolean().optional(),
  allowWrites: z.boolean().optional(),
  // Output framework for the generated tests. Missing means playwright.
  framework: z.enum(['playwright', 'pactum']).optional(),
  // Client data redaction before anything reaches Claude or the disk (agent/redact.ts). The built-in
  // rules are always on; fields lists dot paths (with * wildcards) whose values are always hidden;
  // strict hides every string and number in response bodies and keeps only the shape.
  redaction: z
    .object({
      fields: z.array(z.string().min(1)).optional(),
      mode: z.enum(['standard', 'strict']).optional(),
    })
    .optional(),
  endpoints: z.array(EndpointSchema).min(1),
});

// A path placeholder such as {id} or {productId}; setup fills it with the created resource id.
export { PATH_PARAM } from './model';

export type Endpoint = z.infer<typeof EndpointSchema>;
export type Setup = z.infer<typeof SetupSchema>;
export type Profile = z.infer<typeof ProfileSchema>;
// A loaded config always has a concrete baseUrl (resolved from the profile when there is one) and the
// selection that produced it (null without a profile).
export type Config = Omit<z.infer<typeof ConfigSchema>, 'baseUrl' | 'auth'> & { baseUrl: string; auth?: AuthConfig; selection?: Selection | null };

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

// Rules zod cannot express, in the order loadConfig reports them. Shared with the importers.
export function configProblems(config: Omit<Config, 'baseUrl' | 'selection'> & { baseUrl?: string }): string[] {
  const problems: string[] = [];
  if (config.baseUrl === undefined && !config.profile) problems.push('field "baseUrl" is required when there is no profile');
  const ids = new Set<string>();
  config.endpoints.forEach((ep, i) => {
    if (ids.has(ep.id)) problems.push(`field "endpoints[${i}].id" duplicate id "${ep.id}"`);
    ids.add(ep.id);
  });
  config.endpoints.forEach((ep, i) => {
    if (ep.requiresAuth && !config.auth) {
      problems.push(`field "endpoints[${i}].requiresAuth" endpoint "${ep.id}" requires auth but the input has no auth section`);
    }
  });
  problems.push(...authProblems(config.auth));
  config.endpoints.forEach((ep, i) => {
    if (!ep.setup) return;
    const params = pathParams(ep.path);
    if (!params.length) problems.push(`field "endpoints[${i}].path" has setup but no {id} placeholder`);
    const steps = setupSteps(ep);
    const seen = new Set<string>();
    steps.forEach((step, j) => {
      const where = Array.isArray(ep.setup) ? `endpoints[${i}].setup[${j}]` : `endpoints[${i}].setup`;
      if (!config.endpoints.some((e) => e.id === step.endpointId)) {
        problems.push(`field "${where}.endpointId" references unknown endpoint "${step.endpointId}"`);
      }
      if (params.length && !params.includes(step.param!)) {
        problems.push(`field "${where}.param" names {${step.param}}, which is not a placeholder of ${ep.path} (${params.map((p) => `{${p}}`).join(', ')})`);
      }
      if (seen.has(step.param!)) problems.push(`field "${where}.param" fills {${step.param}} twice`);
      seen.add(step.param!);
      if (step.cleanup) {
        const target = config.endpoints.find((e) => e.id === step.cleanup!.endpointId);
        if (!target) problems.push(`field "${where}.cleanup.endpointId" references unknown endpoint "${step.cleanup.endpointId}"`);
        else if (target.method !== 'DELETE') problems.push(`field "${where}.cleanup.endpointId" must name a DELETE endpoint, "${target.id}" is ${target.method}`);
      }
    });
  });
  return problems;
}

// Role shapes must match the auth type: a login auth needs credentialsEnv with the same fields per
// role, the other types need valueEnv. "default" is the main auth section and cannot be a role name.
export function authProblems(auth: AuthConfig | undefined): string[] {
  const problems: string[] = [];
  if (!auth) return problems;
  if (auth.type === 'login') {
    if (!Object.keys(auth.credentialsEnv).length) problems.push('field "auth.credentialsEnv" must name at least one field');
    if (auth.request.body) {
      for (const field of Object.keys(auth.credentialsEnv)) {
        if (field in auth.request.body) problems.push(`field "auth.request.body.${field}" is also in credentialsEnv; credential values come from the environment only`);
      }
    }
  }
  for (const role of authRoles(auth)) {
    if (role === DEFAULT_ROLE) continue;
    const r = auth.roles![role];
    if (auth.type === 'oauth2_client') {
      if (!r.clientIdEnv || !r.clientSecretEnv) problems.push(`field "auth.roles.${role}" needs clientIdEnv and clientSecretEnv for an oauth2_client auth`);
      if (r.valueEnv || r.credentialsEnv) problems.push(`field "auth.roles.${role}" uses valueEnv or credentialsEnv, which an oauth2_client auth does not read; use clientIdEnv and clientSecretEnv`);
      continue;
    }
    if (r.clientIdEnv || r.clientSecretEnv) problems.push(`field "auth.roles.${role}" uses clientIdEnv or clientSecretEnv, which only an oauth2_client auth reads`);
    if (auth.type === 'login') {
      const fields = Object.keys(auth.credentialsEnv).sort();
      const own = Object.keys(r.credentialsEnv ?? {}).sort();
      if (JSON.stringify(fields) !== JSON.stringify(own)) {
        problems.push(`field "auth.roles.${role}.credentialsEnv" must name the same fields as auth.credentialsEnv (${fields.join(', ')})`);
      }
      if (r.valueEnv) problems.push(`field "auth.roles.${role}.valueEnv" is not used by a login auth; use credentialsEnv`);
    } else {
      if (!r.valueEnv) problems.push(`field "auth.roles.${role}.valueEnv" is required for a ${auth.type} auth`);
      if (r.credentialsEnv) problems.push(`field "auth.roles.${role}.credentialsEnv" is not used by a ${auth.type} auth; use valueEnv`);
    }
  }
  if (auth.roles && DEFAULT_ROLE in auth.roles) problems.push(`field "auth.roles.${DEFAULT_ROLE}" is reserved for the main auth section`);
  return problems;
}

export function zodProblems(error: z.ZodError): string[] {
  return error.issues.map((issue) => `field "${fieldName(issue.path)}" ${issue.message}`);
}

// selectionText: the --select flag or AGENT_SELECT ("env=staging,brand=alpha"). Needed only with a profile.
export function loadConfig(path: string, selectionText: string | undefined = process.env.AGENT_SELECT): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read input file ${path}: ${(err as Error).message}`);
  }

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) throw new Error(`Invalid input file ${path}: ${zodProblems(result.error)[0]}`);
  const problems = configProblems(result.data);
  if (problems.length) throw new Error(`Invalid input file ${path}: ${problems[0]}`);
  let config: Config;
  try {
    config = applyProfile(result.data, selectionText) as Config;
  } catch (err) {
    throw new Error(`Invalid input file ${path}: ${(err as Error).message}`);
  }
  const url = z.url().safeParse(config.baseUrl);
  if (!url.success) throw new Error(`Invalid input file ${path}: resolved baseUrl "${config.baseUrl}" is not a valid URL`);
  return config;
}

// Reads --select <text> (or --select=<text>) out of argv, puts it in AGENT_SELECT so the test runner
// and the ctx fixture see the same selection, and returns the remaining arguments.
export function takeSelectFlag(argv: string[]): string[] {
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--select') {
      if (i + 1 >= argv.length) throw new Error('--select needs a value, for example --select env=staging,brand=alpha');
      process.env.AGENT_SELECT = argv[++i];
    } else if (arg.startsWith('--select=')) {
      process.env.AGENT_SELECT = arg.slice('--select='.length);
    } else rest.push(arg);
  }
  return rest;
}

export function selectionLine(config: Config): string | null {
  if (!config.selection) return null;
  return `selection: ${Object.entries(config.selection).map(([k, v]) => `${k}=${v}`).join(', ')} -> ${config.baseUrl}`;
}
