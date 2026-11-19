import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { extraRoles } from './auth';
import { BudgetExceeded, callClaude } from './claude';
import { loadConfig, PATH_PARAM, type Endpoint } from './config';
import { readProbe, type ProbeResult } from './probe';
import { redactValue } from './redact';
import { AGENT_CASE_PREFIX, isBinaryContentType, isReadOnlyMethod, PATH_PARAM as PATH_PLACEHOLDER } from './model';
import { describeExpectedStatus, expectedContentType, parseExpectedStatus, splitClauses } from './expected';
import type { SheetCase } from './test-cases';
import type { TestCaseMode } from './config';
import { untrusted, withUntrustedRule } from './untrusted';

// The endpoint as the prompt shows it: the sample request body with valid stand-ins for personal data
// (the generated tests copy it, so it must stay a body the API accepts).
export function promptEndpoint(endpoint: Endpoint): Endpoint {
  return redactValue(endpoint, undefined, { replaced: 0 }, 'request') as Endpoint;
}

const PLAN_DIR = 'out/plans';

const CaseSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['happy', 'schema', 'invalid-input', 'auth', 'authz']),
  title: z.string().min(1),
  requestDescription: z.string().min(1),
  expectedStatus: z.string().regex(/^(\d{3}|4xx|401\|403|403\|404)$/, 'must be an exact code like "200", "4xx", "401|403" or "403|404"'),
  assertions: z.array(z.string().min(1)).min(1),
  // Test case sheet runs only: the sheet case this test automates (its ID), or none for an agent
  // suggestion; source says which; expectedResult is the sheet's expected result, verbatim.
  caseId: z.string().min(1).optional(),
  source: z.enum(['sheet', 'agent']).optional(),
  expectedResult: z.string().optional(),
  // The case compares several calls (a paging walk, totals across filters). Only for endpoints with
  // stable data (dataStability). The case is one test that sends all its calls itself (never serial mode).
  crossCall: z.boolean().optional(),
  // Sheet cases: the 4xx codes the sheet names ("400 or 404"), which the test checks as a list.
  statusCodes: z.array(z.number().int()).optional(),
  // Sheet cases: the response format the expected result names ("Content-Type application/json",
  // "a JSON error", "plain text"), read by the agent (expectedContentType). The test asserts the
  // Content-Type header, and a test for a format that is not JSON never calls response.json().
  contentType: z.string().optional(),
  // Sheet cases, from the model: what it did with each clause of the expected result (numbered from 1).
  coverage: z
    .array(
      z.object({
        clause: z.number().int().min(1),
        check: z.string().optional(),
        notAsserted: z.string().optional(),
        disagrees: z.object({ expected: z.string(), actual: z.string() }).optional(),
      }),
    )
    .optional(),
  // Sheet cases, after finalizeSheetPlan and generation: every clause of the expected result and
  // whether a test assertion covers it. Any clause that is not asserted makes a passing test
  // "partially covered"; a clause the probe contradicts makes it "needs review" (agent/traceability.ts).
  clauses: z
    .array(
      z.object({
        n: z.number().int(),
        text: z.string(),
        status: z.enum(['asserted', 'not-asserted', 'probe-disagrees']),
        via: z.enum(['status', 'assertion']).optional(),
        check: z.string().optional(),
        reason: z.string().optional(),
        expected: z.string().optional(),
        actual: z.string().optional(),
      }),
    )
    .optional(),
});

// A sheet case the agent will not guess at: its steps or expected result are too vague, it needs a
// test type this endpoint cannot have, or what it expects contradicts the probe. It becomes a test
// marked needs review (never run, never passed) with the reason.
const NeedsReviewSchema = z.object({
  caseId: z.string().min(1),
  title: z.string().optional(),
  reason: z.string().min(1),
});

const PlanSchema = z.object({
  endpointId: z.string().min(1),
  cases: z.array(CaseSchema),
  needsReview: z.array(NeedsReviewSchema).optional(),
  // Planned cases whose test the static gate rejected and dropped from the file, each with its own
  // reason (the rest of the file still runs). Set by generation, never by the model.
  notAutomated: z.array(z.object({ caseId: z.string().optional(), title: z.string(), reason: z.string() })).optional(),
});

export type Plan = z.infer<typeof PlanSchema>;
export type PlanResult = { ok: true; plan: Plan } | { ok: false; reason: string };

export type PlanOptions = {
  // Extra auth roles from the input (auth.roles). With at least one, protected endpoints get [authz] cases.
  roles?: string[];
  // Test case sheet runs: this endpoint's sheet cases (may be empty) and the mode. Without a mode the
  // plan is the agent's own, exactly as before.
  sheetCases?: SheetCase[];
  testCaseMode?: TestCaseMode | null;
  // Whether tests may compare several calls to this endpoint (dataStability). Missing: not stable.
  stability?: Stability;
};

export type Stability = { stable: boolean; why: string };

// Can tests compare several calls to this endpoint (a paging walk, totals across filters, the same
// item on two pages)? Only when nothing changes its data while the tests run: the team marked it
// stableData, or it is a read-only endpoint (GET) and no endpoint in the run writes to the same
// resource (the first fixed part of the path: POST /products writes what GET /products/{id} reads).
export function dataStability(endpoint: Endpoint, inRun: Endpoint[]): Stability {
  if (endpoint.stableData) return { stable: true, why: 'the team marked this endpoint\'s data as stable (stableData)' };
  if (!isReadOnlyMethod(endpoint.method)) return { stable: false, why: `it is a ${endpoint.method} endpoint, which changes data` };
  const resource = (path: string) => path.split('/').filter((p) => p && !PATH_PLACEHOLDER.test(p))[0] ?? '';
  const mine = resource(endpoint.path);
  const writers = inRun.filter((e) => e.id !== endpoint.id && !isReadOnlyMethod(e.method) && (resource(e.path) === mine || !mine || !resource(e.path)));
  if (writers.length) return { stable: false, why: `the run also has ${writers.map((w) => `${w.id} (${w.method} ${w.path})`).join(', ')}, which change${writers.length === 1 ? 's' : ''} the same data` };
  return { stable: true, why: 'it is read-only (GET) and nothing in this run changes its data' };
}

// Why this endpoint may have [invalid-input] tests, or null. Something must be invalid to send: a body,
// a path id, a documented 4xx response, the team's explicit allowInvalidInput, or a sheet case for this
// endpoint that expects a 4xx.
export function invalidInputSource(endpoint: Endpoint, sheetCases: SheetCase[] = []): string | null {
  if (endpoint.body) return 'it has a request body';
  if (PATH_PARAM.test(endpoint.path)) return 'it has a path id';
  if (endpoint.allowInvalidInput) return 'allowInvalidInput is on';
  if (endpoint.errorStatuses?.length) return `its API spec documents ${endpoint.errorStatuses.join(', ')}`;
  const expects4xx = sheetCases.find((c) => clientErrorCodes(c.expected).length);
  if (expects4xx) return `sheet case ${expects4xx.id} expects ${describeExpectedStatus(parseExpectedStatus(expects4xx.expected))}`;
  return null;
}

// The 4xx codes an expected result accepts, other than 401 and 403 (those are auth tests).
function clientErrorCodes(expected: string): number[] {
  const s = parseExpectedStatus(expected);
  const codes = s.expects.filter((c) => c >= 400 && c <= 499 && c !== 401 && c !== 403);
  return codes.length || !s.expectsRanges.includes('4xx') ? codes : [400];
}

export const INVALID_INPUT_RULE =
  'invalid-input tests are on when the endpoint has a request body, a path id such as {id}, a documented 4xx response in its OpenAPI spec (errorStatuses), "allowInvalidInput": true, or a sheet case that expects a 4xx';

// invalid-input needs something to make invalid (invalidInputSource). authz needs another role to try.
function allowedTypes(endpoint: Endpoint, roles: string[], sheetCases: SheetCase[] = []): Plan['cases'][number]['type'][] {
  const types: Plan['cases'][number]['type'][] = ['happy', 'schema'];
  if (invalidInputSource(endpoint, sheetCases)) types.push('invalid-input');
  if (endpoint.requiresAuth) types.push('auth');
  if (endpoint.requiresAuth && roles.length) types.push('authz');
  return types;
}

// The rule about tests that compare calls, for both prompts.
function crossCallRule(endpoint: Endpoint, stability: Stability | undefined, sheet: boolean): string {
  if (stability?.stable) {
    return `- This endpoint's data is stable during the run: ${stability.why}. Cases may compare several calls to it (a paging walk across pages, totals that add up across filters, no item repeated across pages, the same item on two pages). Give such a case "crossCall": true; it is one test that sends all the calls it compares, never a chain of tests that depend on each other. Every other case is independent and checks one call.`;
  }
  const why = stability ? stability.why : 'its data is not known to be stable';
  return `- Tests run in parallel against a shared live API while other tests create, update and delete data. Never plan checks that compare two calls ("stable", "idempotent", "unchanged"), count items, or check the exact contents of a list. For list endpoints check the array type and the shape of its items only.${
    sheet
      ? ` Comparing calls needs stable data, and this endpoint does not qualify (${why}). A team case that compares calls goes to needsReview with the reason: "it compares several calls; turn on Stable data for ${endpoint.id} (stableData: true or --stable-data ${endpoint.id}) if its data does not change during the run".`
      : ''
  }`;
}

// What the probe says about a non-JSON response, for the rules of both prompts.
export function binaryRule(probe: ProbeResult): string {
  if (!probe.binary && !isBinaryContentType(probe.contentType)) return '';
  const what = probe.binary?.signature ? `a ${probe.binary.signature.toUpperCase()} file` : 'a binary body';
  return `- This endpoint answers with ${what} (${probe.contentType ?? 'unknown content type'}${probe.binary ? `, ${probe.binary.bytes} bytes` : ''}), not JSON. Its checks are the Content-Type and Cache-Control headers, the body size and the file signature${probe.binary?.signatureHex ? ` (the first bytes, hex ${probe.binary.signatureHex})` : ''}; never a JSON field.`;
}

function checkRules(plan: Plan, endpoint: Endpoint, probe: ProbeResult, roles: string[], covered: Plan['cases'][number]['type'][] = [], requireEveryType = true, sheetCases: SheetCase[] = [], stability?: Stability): string[] {
  const errors: string[] = [];
  const allowed = allowedTypes(endpoint, roles, sheetCases);
  const probeStatus = String(probe.status);

  if (plan.endpointId !== endpoint.id) errors.push(`endpointId must be "${endpoint.id}", got "${plan.endpointId}"`);
  if (plan.cases.length > 6) errors.push(`at most 6 cases allowed, got ${plan.cases.length}`);
  if (requireEveryType) {
    for (const type of allowed) {
      if (!plan.cases.some((c) => c.type === type) && !covered.includes(type)) errors.push(`missing a case of type "${type}"`);
    }
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
    if (c.crossCall && !stability?.stable) errors.push(`${where}: compares several calls, which this endpoint does not allow (${stability?.why ?? 'its data is not known to be stable'})`);
  });
  return errors;
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  return JSON.parse((fenced ? fenced[1] : text).trim());
}

const SYSTEM = withUntrustedRule('You are a senior QA engineer planning API tests. You answer with one JSON object only, no prose.');

// Exported for the redaction tests: the prompt text must never carry client data.
export function buildPrompt(endpoint: Endpoint, probe: ProbeResult, roles: string[], stability?: Stability): string {
  const types = allowedTypes(endpoint, roles);
  const invalidHow = endpoint.body
    ? ' This endpoint has a body: include one case with a required field missing and one with a field of the wrong type (for example a number field sent as text).'
    : PATH_PARAM.test(endpoint.path)
      ? ' This endpoint has no body: use an invalid or non-existent id in the path.'
      : endpoint.query
        ? ` This endpoint has no body and no path id: send an invalid value for one of its query parameters (a wrong type, an unknown value or an out-of-range number)${endpoint.errorStatuses?.length ? `; its API spec documents ${endpoint.errorStatuses.join(', ')}` : ''}.`
        : ` Send a request the API rejects${endpoint.errorStatuses?.length ? ` (its API spec documents ${endpoint.errorStatuses.join(', ')})` : ''}.`;
  const binary = binaryRule(probe);
  const authzLine = types.includes('authz')
    ? `- "authz" cases send the same valid request as another role (${roles.map((r) => `"${r}"`).join(', ')}; the test uses ctx.as(role)) against a resource the default role created, and expect "403|404" (a lower role must be rejected; some APIs hide the resource with 404). Exactly one authz case per role at most.\n`
    : '';
  return `Plan API test cases for one endpoint.

ENDPOINT CONFIG:
${untrusted('endpoint-config', JSON.stringify(promptEndpoint(endpoint), null, 2))}

PROBE (a real call to this endpoint with its sample body${endpoint.requiresAuth ? ' and the auth header' : ''}; arrays truncated to 3 items):
${untrusted('probe-response', JSON.stringify(probe, null, 2))}

RULES:
- Allowed case types for this endpoint: ${types.map((t) => `"${t}"`).join(', ')}. Include at least one case of each allowed type and no other types. Maximum 6 cases.
- "happy" and "schema" cases expect exactly "${probe.status}" (the probe status), even if it looks unusual.
- "invalid-input" cases expect "4xx".${invalidHow}
${binary ? `${binary}\n` : ''}${endpoint.requiresAuth ? '- "auth" cases send the same valid request without the auth header and expect "401|403".\n' : ''}${authzLine}- Never expect a 5xx status. If the probe shows a 5xx, do not copy it.
- expectedStatus is a string: an exact code like "200", or "4xx", or "401|403", or "403|404".
- Each title starts with its type tag in square brackets, e.g. "[happy] ${endpoint.id} ...".
- assertions are short, concrete checks: status, presence and type of response fields, and exact values only for values the test itself sent.
${crossCallRule(endpoint, stability, false)}

Answer with JSON only, exactly this shape:
{"endpointId":"${endpoint.id}","cases":[{"id":"short-kebab-id","type":"happy","title":"[happy] ...","requestDescription":"...","expectedStatus":"${probe.status}","assertions":["..."]}]}`;
}

export async function planEndpoint(endpoint: Endpoint, probe: ProbeResult, options: PlanOptions = {}): Promise<PlanResult> {
  if (!probe.usable) {
    return { ok: false, reason: `probe not usable: ${probe.status ?? probe.error ?? 'unknown'}` };
  }
  const roles = options.roles ?? [];
  const stability = options.stability;
  if (options.testCaseMode) return planWithSheet(endpoint, probe, roles, options.sheetCases ?? [], options.testCaseMode, stability);

  const prompt = buildPrompt(endpoint, probe, roles, stability);
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
    errors = checkRules(parsed.data, endpoint, probe, roles, [], true, [], stability);
    if (errors.length > 0) continue;

    mkdirSync(PLAN_DIR, { recursive: true });
    writeFileSync(join(PLAN_DIR, `${endpoint.id}.json`), JSON.stringify(parsed.data, null, 2) + '\n');
    return { ok: true, plan: parsed.data };
  }
  return { ok: false, reason: `plan invalid after retry: ${errors.join('; ')}` };
}

// ---------- Test case sheet planning ----------

const STATUS_FOR: Record<Plan['cases'][number]['type'], (probe: number | null) => string> = {
  happy: (s) => String(s),
  schema: (s) => String(s),
  'invalid-input': () => '4xx',
  auth: () => '401|403',
  authz: () => '403|404',
};

function typeNotAllowedReason(type: string, endpoint: Endpoint, roles: string[]): string {
  if (type === 'invalid-input') return `it needs an invalid-input test, which is off for ${endpoint.id}: ${INVALID_INPUT_RULE}. Turn on "Invalid-input tests" for ${endpoint.id} in Run options (or "allowInvalidInput": true, or --allow-invalid-input ${endpoint.id})`;
  if (type === 'auth') return 'it needs a no-auth test, but this endpoint is not marked requiresAuth in the input';
  if (type === 'authz') return endpoint.requiresAuth && !roles.length ? 'it needs another role, but the input has no auth.roles' : 'it needs another role, but this endpoint is not marked requiresAuth';
  return `it needs a "${type}" test, which this endpoint cannot have`;
}

// Status codes the sheet names in its expected result ("200", "HTTP 404", "401 Unauthorized").
// Codes after "not", "never" or "must not be" are ruled out, not expected (agent/expected.ts):
// "400 or 404, not 500 or 502" gives [400, 404].
export function sheetStatusCodes(expected: string): number[] {
  return parseExpectedStatus(expected).expects.filter((n) => n >= 100 && n <= 599);
}

// Why a sheet case of this type cannot be automated as written, or null. Rule 2 and 3: the agent never
// changes an expected status and never expects a 5xx, so a contradiction is for a person to decide.
export function sheetStatusConflict(type: Plan['cases'][number]['type'], expected: string, probeStatus: number | null): string | null {
  const parsed = parseExpectedStatus(expected);
  const codes = sheetStatusCodes(expected);
  if (parsed.expectsRanges.includes('5xx')) return 'the sheet expects a 5xx; the agent never writes a test that expects a 5xx';
  if (!codes.length) return null;
  if (codes.some((c) => c >= 500)) return `the sheet expects ${codes.filter((c) => c >= 500).join(' or ')}; the agent never writes a test that expects a 5xx`;
  const fits = (c: number) => {
    if (type === 'happy' || type === 'schema') return c === probeStatus;
    if (type === 'invalid-input') return c >= 400 && c <= 499;
    if (type === 'auth') return c === 401 || c === 403;
    return c === 403 || c === 404;
  };
  if (codes.some(fits)) return null;
  if (type === 'happy' || type === 'schema') return `the sheet expects ${codes.join(' or ')} but the API answered ${probeStatus ?? 'nothing'} when probed; check the sheet or the API`;
  return `the sheet expects ${codes.join(' or ')}, which does not fit a ${type} test (expected ${STATUS_FOR[type](probeStatus)})`;
}

// Words that say nothing beyond the status: a clause made only of these and a code ("Response is 400
// or 404 JSON error, not 500") is covered by the test's status assertion.
const STATUS_WORDS = new Set(['response', 'responds', 'status', 'code', 'http', 'is', 'are', 'be', 'should', 'must', 'returns', 'return', 'returned', 'with', 'a', 'an', 'the', 'or', 'and', 'not', 'never', 'no', 'json', 'error', 'errors', 'ok', 'success', 'successful', 'created', 'accepted', 'bad', 'request', 'unauthorized', 'forbidden', 'found', 'content', 'conflict', 'unprocessable', 'entity', 'for', 'each', 'every', 'value', 'values', 'body', 'message', 'answer', 'answers', 'expected', 'result', 'xx', 'of', 'only', 'one', 'either', 'any', 'it', 'gets', 'get', 'got', 'mean', 'means', 'valid', 'invalid']);
export function isStatusOnlyClause(text: string): boolean {
  const s = parseExpectedStatus(text);
  if (!s.expects.length && !s.expectsRanges.length && !s.forbids.length && !s.forbidsRanges.length) return false;
  const rest = text.toLowerCase().replace(/(?<![\d.])[1-5](?:\d\d|xx)(?![\d.])/g, ' ').split(/[^a-z]+/).filter(Boolean);
  return rest.every((w) => STATUS_WORDS.has(w));
}

// Every clause of the expected result with what the model said about it. A clause the model did not
// mention is not asserted (and makes a passing test "partially covered"); a status-only clause is
// covered by the status assertion every test has.
export function clausesFor(expected: string, coverage: Plan['cases'][number]['coverage']): NonNullable<Plan['cases'][number]['clauses']> {
  return splitClauses(expected).map((text, i) => {
    const n = i + 1;
    const m = (coverage ?? []).find((x) => x.clause === n);
    if (m?.disagrees) return { n, text, status: 'probe-disagrees' as const, expected: m.disagrees.expected, actual: m.disagrees.actual };
    if (isStatusOnlyClause(text)) return { n, text, status: 'asserted' as const, via: 'status' as const, check: m?.check ?? 'the status assertion' };
    if (m?.check && !m.notAsserted) return { n, text, status: 'asserted' as const, via: 'assertion' as const, check: m.check };
    return { n, text, status: 'not-asserted' as const, reason: m?.notAsserted ?? 'the AI did not turn it into an assertion' };
  });
}

function words(text: string): Set<string> {
  const stop = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'of', 'with', 'for', 'is', 'are', 'it', 'in', 'on', 'returns', 'return', 'request', 'test', 'case', 'when', 'send', 'sends', 'valid', 'api', 'endpoint']);
  return new Set(text.toLowerCase().replace(/\[[^\]]*\]/g, ' ').split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !stop.has(w)));
}

function similarity(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

// Agent suggestions next to a sheet: dropped when they repeat a sheet case of the same type.
export function duplicatesSheetCase(agentCase: Plan['cases'][number], sheetCases: Plan['cases'][number][]): boolean {
  const text = `${agentCase.title} ${agentCase.requestDescription}`;
  return sheetCases.some((s) => s.type === agentCase.type && similarity(text, `${s.title} ${s.requestDescription} ${s.expectedResult ?? ''}`) >= 0.5);
}

// "[agent] [auth] ..." : an agent suggestion next to a sheet, always with its type tag.
export function agentTitle(type: string, title: string): string {
  const rest = title.replace(/^\[agent\]\s*/, '');
  return `[${AGENT_CASE_PREFIX}] ${rest.startsWith(`[${type}]`) ? rest : `[${type}] ${rest}`}`;
}

export function sheetTitle(caseId: string, type: string, title: string): string {
  return `[${caseId}] [${type}] ${title}`;
}

export function buildSheetPrompt(endpoint: Endpoint, probe: ProbeResult, roles: string[], sheetCases: SheetCase[], mode: TestCaseMode, stability?: Stability): string {
  const types = allowedTypes(endpoint, roles, sheetCases);
  const shown = sheetCases.map((c) => {
    const status = describeExpectedStatus(parseExpectedStatus(c.expected));
    const clauses = splitClauses(c.expected);
    return {
      caseId: c.id,
      title: c.title,
      steps: c.steps || undefined,
      expected: c.expected || undefined,
      // Read by the agent from the expected result: the status codes it accepts and the ones it rules out.
      expectedStatus: status || undefined,
      // The expected result split into numbered clauses; coverage reports on each one.
      expectedClauses: clauses.length ? clauses.map((t, i) => `${i + 1}: ${t}`) : undefined,
      method: c.method || undefined,
      preconditions: c.preconditions || undefined,
      testData: c.testData || undefined,
    };
  });
  const binary = binaryRule(probe);
  const invalidSource = invalidInputSource(endpoint, sheetCases);
  const extras =
    mode === 'sheet-plus-agent'
      ? `- Then add your own cases (no caseId) only for what the sheet does not cover: at most 6, never a repeat of a sheet case. Together, the sheet cases and yours must include at least one case of each allowed type.`
      : `- Add no cases of your own: this run automates only the team's cases.`;
  return `Plan API tests for one endpoint from the team's manual test cases.

ENDPOINT CONFIG:
${untrusted('endpoint-config', JSON.stringify(promptEndpoint(endpoint), null, 2))}

PROBE (a real call to this endpoint with its sample body${endpoint.requiresAuth ? ' and the auth header' : ''}; arrays truncated to 3 items):
${untrusted('probe-response', JSON.stringify(probe, null, 2))}

TEAM TEST CASES (from their test case sheet; each must be planned or marked needsReview):
${untrusted('sheet-cases', JSON.stringify({ mode, cases: shown }, null, 2))}

RULES:
- Allowed case types for this endpoint: ${types.map((t) => `"${t}"`).join(', ')}.
- For every team test case, either plan exactly one case with its "caseId", or list it in "needsReview" with a short reason. Use needsReview when the steps do not say what to send, the expected result does not say what to check, or the case needs something this endpoint cannot do. Never guess.
- Pick the type from what the case checks: a valid request that succeeds is "happy" (or "schema" when it checks the response fields and their types); a bad body, a missing or wrong field, a bad query value, or a missing or non-existent id is "invalid-input"; a request without auth is "auth"; another role trying the request is "authz".${
    types.includes('invalid-input') ? ` invalid-input is on for this endpoint because ${invalidSource}.` : ` invalid-input is off for this endpoint (${INVALID_INPUT_RULE}).`
  }
- "happy" and "schema" expect exactly "${probe.status}" (the probe status). "invalid-input" expects "4xx".${endpoint.requiresAuth ? ' "auth" expects "401|403".' : ''}${types.includes('authz') ? ` "authz" expects "403|404" with one of these roles: ${roles.map((r) => `"${r}"`).join(', ')}.` : ''} Never expect a 5xx.
- Read each expected result carefully. Codes after "not", "never", "must not be", "instead of" or "other than" are ruled out, not expected: "Response is 400 or 404 JSON error, not 500 or 502" expects 400 or 404 (an invalid-input case) and rules out 500 and 502. "X or Y" means either code passes. The "expectedStatus" field shows how the agent read it.
- requestDescription says exactly what the test sends, using the case's steps and test data. assertions turn the case's expected result into concrete checks (status, response fields, their types, and exact values only for values the test itself sent).
- coverage: for every planned team case, one entry per numbered clause in its "expectedClauses": {"clause":N,"check":"the assertion that checks it"} when a test assertion will check it; {"clause":N,"notAsserted":"why"} when no assertion can check it (for example it needs a visual check or data the response does not have); {"clause":N,"disagrees":{"expected":"what the sheet says","actual":"what the probe returned"}} when the probe response contradicts it (never drop such a check silently). The status clause is checked by the status assertion.
${binary ? `${binary}\n` : ''}${extras}
${crossCallRule(endpoint, stability, true)}

Answer with JSON only, exactly this shape:
{"endpointId":"${endpoint.id}","cases":[{"caseId":"${sheetCases[0]?.id ?? 'TC-1'}","id":"short-kebab-id","type":"happy","title":"short title","requestDescription":"...","expectedStatus":"${probe.status}","assertions":["..."],"coverage":[{"clause":1,"check":"status is ${probe.status}"}]}],"needsReview":[{"caseId":"...","reason":"..."}]}`;
}

// Applies the deterministic rules to the model's sheet plan: titles, statuses, the type an endpoint
// allows, contradictions with the probe, deduplication of agent suggestions, and that every sheet case
// is either planned or marked needs review. Returns errors the model must fix (agent cases only).
export function finalizeSheetPlan(raw: Plan, endpoint: Endpoint, probe: ProbeResult, roles: string[], sheetCases: SheetCase[], mode: TestCaseMode, stability?: Stability): { plan: Plan; errors: string[] } {
  const allowed = allowedTypes(endpoint, roles, sheetCases);
  const byId = new Map(sheetCases.map((c) => [c.id.toLowerCase(), c]));
  const sheetPlanned: Plan['cases'] = [];
  const needsReview: NonNullable<Plan['needsReview']> = [];
  const done = new Set<string>();
  const errors: string[] = [];
  const review = (c: SheetCase, reason: string) => {
    needsReview.push({ caseId: c.id, title: sheetTitle(c.id, 'needs-review', c.title), reason: reason.replace(/\s+/g, ' ').trim() });
    done.add(c.id.toLowerCase());
  };
  for (const r of raw.needsReview ?? []) {
    const c = byId.get(r.caseId.trim().toLowerCase());
    if (c && !done.has(c.id.toLowerCase())) review(c, r.reason);
  }
  const agentCases: Plan['cases'] = [];
  for (const pc of raw.cases) {
    if (!pc.caseId) {
      agentCases.push(pc);
      continue;
    }
    const c = byId.get(pc.caseId.trim().toLowerCase());
    if (!c) {
      errors.push(`caseId "${pc.caseId}" is not one of this endpoint's team test cases; use one of: ${sheetCases.map((s) => s.id).join(', ')}, or plan it as your own case without caseId`);
      continue;
    }
    if (done.has(c.id.toLowerCase())) continue;
    if (!c.steps && !c.expected) {
      review(c, 'the sheet gives no steps and no expected result');
      continue;
    }
    if (!allowed.includes(pc.type)) {
      review(c, typeNotAllowedReason(pc.type, endpoint, roles));
      continue;
    }
    const conflict = sheetStatusConflict(pc.type, c.expected, probe.status);
    if (conflict) {
      review(c, conflict);
      continue;
    }
    if (pc.crossCall && !stability?.stable) {
      review(c, `it compares several calls, which needs stable data, and ${endpoint.id} does not qualify (${stability?.why ?? 'its data is not known to be stable'}). Turn on "Stable data" for ${endpoint.id} in Run options (or "stableData": true, or --stable-data ${endpoint.id}) if its data does not change during the run`);
      continue;
    }
    // "400 or 404, not 500": the test checks the sheet's own 4xx list on top of the 4xx range.
    const statusCodes = pc.type === 'invalid-input' ? clientErrorCodes(c.expected) : [];
    const ruledOut = parseExpectedStatus(c.expected);
    const statusLine = statusCodes.length ? [`status is one of ${statusCodes.join(', ')} (from the sheet${ruledOut.forbids.length || ruledOut.forbidsRanges.length ? `; never ${[...ruledOut.forbids, ...ruledOut.forbidsRanges].join(' or ')}` : ''})`] : [];
    const assertions = pc.assertions.length ? pc.assertions : [`status is ${STATUS_FOR[pc.type](probe.status)}`];
    const contentType = expectedContentType(c.expected);
    sheetPlanned.push({
      ...pc,
      id: pc.id || c.id.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      caseId: c.id,
      source: 'sheet',
      title: sheetTitle(c.id, pc.type, c.title),
      expectedStatus: STATUS_FOR[pc.type](probe.status),
      expectedResult: c.expected || undefined,
      ...(statusCodes.length ? { statusCodes } : {}),
      ...(contentType ? { contentType } : {}),
      ...(pc.crossCall ? { crossCall: true } : {}),
      assertions: [...assertions, ...statusLine.filter((l) => !assertions.includes(l))],
      clauses: clausesFor(c.expected, pc.coverage),
      coverage: undefined,
    });
    done.add(c.id.toLowerCase());
  }
  for (const c of sheetCases) if (!done.has(c.id.toLowerCase())) review(c, 'the AI did not plan this case');

  let extras: Plan['cases'] = [];
  if (mode === 'sheet-plus-agent') {
    const kept = agentCases.filter((a) => !duplicatesSheetCase(a, sheetPlanned));
    const check: Plan = { endpointId: raw.endpointId, cases: kept };
    errors.push(...checkRules(check, endpoint, probe, roles, sheetPlanned.map((c) => c.type), true, sheetCases, stability));
    extras = kept.map((a) => ({ ...a, source: 'agent' as const, caseId: undefined, title: agentTitle(a.type, a.title) }));
  }
  if (raw.endpointId !== endpoint.id) errors.push(`endpointId must be "${endpoint.id}", got "${raw.endpointId}"`);
  const plan: Plan = { endpointId: endpoint.id, cases: [...sheetPlanned, ...extras], ...(needsReview.length ? { needsReview } : {}) };
  return { plan, errors: [...new Set(errors)] };
}

async function planWithSheet(endpoint: Endpoint, probe: ProbeResult, roles: string[], sheetCases: SheetCase[], mode: TestCaseMode, stability?: Stability): Promise<PlanResult> {
  // No sheet case for this endpoint: the agent's own plan, labelled as suggestions (plus mode only; in
  // sheet-only mode the CLI keeps such endpoints out of scope).
  if (!sheetCases.length) {
    const own = await planEndpoint(endpoint, probe, { roles, stability });
    if (!own.ok) return own;
    const plan: Plan = { ...own.plan, cases: own.plan.cases.map((c) => ({ ...c, source: 'agent' as const, title: agentTitle(c.type, c.title) })) };
    savePlan(plan);
    return { ok: true, plan };
  }
  const prompt = buildSheetPrompt(endpoint, probe, roles, sheetCases, mode, stability);
  let errors: string[] = [];
  let last: Plan | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const user = attempt === 1 ? prompt : `${prompt}\n\nYOUR PREVIOUS ANSWER WAS REJECTED. Fix these problems and answer again with JSON only:\n- ${errors.join('\n- ')}`;
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
    const result = finalizeSheetPlan(parsed.data, endpoint, probe, roles, sheetCases, mode, stability);
    last = result.plan;
    errors = result.errors;
    if (!errors.length) break;
  }
  // The sheet's cases are kept even when the agent's own suggestions still break a rule after the retry:
  // those suggestions are dropped, and the sheet cases go on (they passed every rule themselves).
  if (!last) return { ok: false, reason: `plan invalid after retry: ${errors.join('; ')}` };
  if (errors.length) last = { ...last, cases: last.cases.filter((c) => c.source === 'sheet') };
  if (!last.cases.length && !last.needsReview?.length) return { ok: false, reason: `plan invalid after retry: ${errors.join('; ')}` };
  savePlan(last);
  return { ok: true, plan: last };
}

function savePlan(plan: Plan) {
  mkdirSync(PLAN_DIR, { recursive: true });
  writeFileSync(join(PLAN_DIR, `${plan.endpointId}.json`), JSON.stringify(plan, null, 2) + '\n');
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
