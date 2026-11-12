import { readFileSync } from 'node:fs';
import { z } from 'zod';

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

export const ConfigSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/, 'must use lowercase letters, numbers and dashes only').optional(),
  // One of baseUrl or profile is required (checked in configProblems). With a profile, baseUrl is the
  // resolved value for the selected dimensions and is filled in by loadConfig.
  baseUrl: z.url().optional(),
  profile: ProfileSchema.optional(),
  defaultHeaders: z.record(z.string(), z.string()),
  auth: z
    .object({
      header: z.string().min(1),
      valueEnv: z.string().min(1),
    })
    .optional(),
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
export type Config = Omit<z.infer<typeof ConfigSchema>, 'baseUrl'> & { baseUrl: string; selection?: Selection | null };

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
