import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { extraRoles } from './auth';
import { BudgetExceeded, callClaude } from './claude';
import { loadConfig, PATH_PARAM, type Endpoint } from './config';
import { readProbe, type ProbeResult } from './probe';

const PLAN_DIR = 'out/plans';

const CaseSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['happy', 'schema', 'invalid-input', 'auth', 'authz']),
  title: z.string().min(1),
  requestDescription: z.string().min(1),
  expectedStatus: z.string().regex(/^(\d{3}|4xx|401\|403|403\|404)$/, 'must be an exact code like "200", "4xx", "401|403" or "403|404"'),
  assertions: z.array(z.string().min(1)).min(1),
});

const PlanSchema = z.object({
  endpointId: z.string().min(1),
  cases: z.array(CaseSchema).min(1),
});

export type Plan = z.infer<typeof PlanSchema>;
export type PlanResult = { ok: true; plan: Plan } | { ok: false; reason: string };

export type PlanOptions = {
  // Extra auth roles from the input (auth.roles). With at least one, protected endpoints get [authz] cases.
  roles?: string[];
};

// invalid-input needs something to make invalid: a body or a path id. authz needs another role to try.
function allowedTypes(endpoint: Endpoint, roles: string[]): Plan['cases'][number]['type'][] {
  const types: Plan['cases'][number]['type'][] = ['happy', 'schema'];
  if (endpoint.body || PATH_PARAM.test(endpoint.path)) types.push('invalid-input');
  if (endpoint.requiresAuth) types.push('auth');
  if (endpoint.requiresAuth && roles.length) types.push('authz');
  return types;
}

function checkRules(plan: Plan, endpoint: Endpoint, probe: ProbeResult, roles: string[]): string[] {
  const errors: string[] = [];
  const allowed = allowedTypes(endpoint, roles);
  const probeStatus = String(probe.status);

  if (plan.endpointId !== endpoint.id) errors.push(`endpointId must be "${endpoint.id}", got "${plan.endpointId}"`);
  if (plan.cases.length > 6) errors.push(`at most 6 cases allowed, got ${plan.cases.length}`);
  for (const type of allowed) {
    if (!plan.cases.some((c) => c.type === type)) errors.push(`missing a case of type "${type}"`);
  }
  plan.cases.forEach((c, i) => {
    const where = `cases[${i}] (${c.id})`;
    if (!allowed.includes(c.type)) errors.push(`${where}: type "${c.type}" is not allowed for this endpoint`);
    if (/^5/.test(c.expectedStatus)) errors.push(`${where}: never expect a 5xx status`);
    if ((c.type === 'happy' || c.type === 'schema') && c.expectedStatus !== probeStatus) {
      errors.push(`${where}: ${c.type} must expect the probe status "${probeStatus}", got "${c.expectedStatus}"`);
    }
    if (c.type === 'invalid-input' && c.expectedStatus !== '4xx') errors.push(`${where}: invalid-input must expect "4xx"`);
    if (c.type === 'auth' && c.expectedStatus !== '401|403') errors.push(`${where}: auth must expect "401|403"`);
    if (c.type === 'authz' && c.expectedStatus !== '403|404') errors.push(`${where}: authz must expect "403|404"`);
  });
  return errors;
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  return JSON.parse((fenced ? fenced[1] : text).trim());
}

const SYSTEM = 'You are a senior QA engineer planning API tests. You answer with one JSON object only, no prose.';

function buildPrompt(endpoint: Endpoint, probe: ProbeResult, roles: string[]): string {
  const types = allowedTypes(endpoint, roles);
  const authzLine = types.includes('authz')
    ? `- "authz" cases send the same valid request as another role (${roles.map((r) => `"${r}"`).join(', ')}; the test uses ctx.as(role)) against a resource the default role created, and expect "403|404" (a lower role must be rejected; some APIs hide the resource with 404). Exactly one authz case per role at most.\n`
    : '';
  return `Plan API test cases for one endpoint.

ENDPOINT CONFIG:
${JSON.stringify(endpoint, null, 2)}

PROBE (a real call to this endpoint with its sample body${endpoint.requiresAuth ? ' and the auth header' : ''}; arrays truncated to 3 items):
${JSON.stringify(probe, null, 2)}

RULES:
- Allowed case types for this endpoint: ${types.map((t) => `"${t}"`).join(', ')}. Include at least one case of each allowed type and no other types. Maximum 6 cases.
- "happy" and "schema" cases expect exactly "${probe.status}" (the probe status), even if it looks unusual.
- "invalid-input" cases expect "4xx".${endpoint.body ? ' This endpoint has a body: include one case with a required field missing and one with a field of the wrong type (for example a number field sent as text).' : ' This endpoint has no body: use an invalid or non-existent id in the path.'}
${endpoint.requiresAuth ? '- "auth" cases send the same valid request without the auth header and expect "401|403".\n' : ''}${authzLine}- Never expect a 5xx status. If the probe shows a 5xx, do not copy it.
- expectedStatus is a string: an exact code like "200", or "4xx", or "401|403", or "403|404".
- Each title starts with its type tag in square brackets, e.g. "[happy] ${endpoint.id} ...".
- assertions are short, concrete checks: status, presence and type of response fields, and exact values only for values the test itself sent.
- Tests run in parallel against a shared live API while other tests create, update and delete data. Every case must be independent of that. Never plan cases that compare two calls ("stable", "idempotent", "unchanged"), count items, or check the exact contents of a list. For list endpoints check the array type and the shape of its items only.

Answer with JSON only, exactly this shape:
{"endpointId":"${endpoint.id}","cases":[{"id":"short-kebab-id","type":"happy","title":"[happy] ...","requestDescription":"...","expectedStatus":"${probe.status}","assertions":["..."]}]}`;
}

export async function planEndpoint(endpoint: Endpoint, probe: ProbeResult, options: PlanOptions = {}): Promise<PlanResult> {
  if (!probe.usable) {
    return { ok: false, reason: `probe not usable: ${probe.status ?? probe.error ?? 'unknown'}` };
  }
  const roles = options.roles ?? [];

  const prompt = buildPrompt(endpoint, probe, roles);
  let errors: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const user =
      attempt === 1
        ? prompt
        : `${prompt}\n\nYOUR PREVIOUS ANSWER WAS REJECTED. Fix these problems and answer again with JSON only:\n- ${errors.join('\n- ')}`;
    let text: string;
    try {
      text = await callClaude(attempt === 1 ? 'plan' : 'plan-retry', endpoint.id, SYSTEM, user);
    } catch (err) {
      if (err instanceof BudgetExceeded) throw err;
      return { ok: false, reason: (err as Error).message };
    }

    let raw: unknown;
    try {
      raw = extractJson(text);
    } catch (err) {
      errors = [`answer is not valid JSON: ${(err as Error).message}`];
      continue;
    }
    const parsed = PlanSchema.safeParse(raw);
    if (!parsed.success) {
      errors = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
      continue;
    }
    errors = checkRules(parsed.data, endpoint, probe, roles);
    if (errors.length > 0) continue;

    mkdirSync(PLAN_DIR, { recursive: true });
    writeFileSync(join(PLAN_DIR, `${endpoint.id}.json`), JSON.stringify(parsed.data, null, 2) + '\n');
    return { ok: true, plan: parsed.data };
  }
  return { ok: false, reason: `plan invalid after retry: ${errors.join('; ')}` };
}

// Usage: tsx agent/plan.ts <inputFile> <endpointId> [probeFile]
async function main() {
  const [inputFile = 'input/endpoints.json', endpointId, probeFile] = process.argv.slice(2);
  if (!endpointId) throw new Error('usage: tsx agent/plan.ts <inputFile> <endpointId> [probeFile]');
  const config = loadConfig(inputFile);
  const endpoint = config.endpoints.find((e) => e.id === endpointId);
  if (!endpoint) throw new Error(`unknown endpoint "${endpointId}" in ${inputFile}`);
  const result = await planEndpoint(endpoint, readProbe(endpointId, probeFile), { roles: extraRoles(config.auth) });
  if (result.ok) console.log(`${endpointId} OK ${result.plan.cases.length} cases`);
  else console.log(`${endpointId} FAILED ${result.reason}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`plan FAILED ${(err as Error).message}`);
    process.exit(1);
  });
}
