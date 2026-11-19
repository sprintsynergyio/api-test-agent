import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BudgetExceeded, callClaude } from './claude';
import type { Endpoint } from './config';
import { pathParams, setupSteps } from './model';
import { binaryRule, promptEndpoint, type Plan, type Stability } from './plan';
import { matchingParen, removeTests, testRanges, type ValidateOptions, type ValidationResult } from './validate';
import { isBinaryContentType, isJsonContentType, testTypeOf } from './model';
import type { ProbeResult } from './probe';
import type { FrameworkAdapter } from './frameworks/types';
import { untrusted, withUntrustedRule } from './untrusted';
import { requiredResponseFields } from './response-schema';

const GENERATED_DIR = 'generated';
const CANDIDATE_DIR = join(GENERATED_DIR, '.candidate');

// ok: the spec was written; plan is the plan with each sheet case's clause coverage checked against the
// code and any test the gate dropped moved to plan.notAutomated with its own reason.
// not ok: reasons for the whole file, and byTitle the reasons of each planned test that had its own.
export type GenerateResult = { ok: true; specFile: string; plan: Plan } | { ok: false; reasons: string[]; byTitle?: Record<string, string[]> };

export type GenerateOptions = { stability?: Stability };

function system(fw: FrameworkAdapter): string {
  return withUntrustedRule(`You are a senior QA engineer writing ${fw.label}. You answer with exactly one \`\`\`ts code block containing the full file, nothing else.`);
}

// Exported for the redaction tests: the prompt text must never carry client data.
export function buildPrompt(fw: FrameworkAdapter, endpoint: Endpoint, plan: Plan, probe: ProbeResult, opts: GenerateOptions = {}): string {
  const read = (p: string) => readFileSync(p, 'utf8');
  // The response schema gets its own block below, so it is not repeated in the endpoint config.
  const { responseSchema: _documented, ...shown } = promptEndpoint(endpoint);
  const steps = setupSteps(endpoint);
  const params = pathParams(endpoint.path);
  const fixed = Object.keys(endpoint.pathParams ?? {}).filter((p) => !steps.some((s) => s.param === p));
  const fillers = [...steps.map((s) => `${s.endpointId} fills {${s.param}}`), ...fixed.map((p) => `{${p}} has the fixed value ${JSON.stringify(endpoint.pathParams![p])}`)];
  const setupLine =
    steps.length > 1 || params.length > 1 || fixed.length
      ? `- This endpoint's path has ${params.length} placeholder${params.length === 1 ? '' : 's'} (${params.map((p) => `{${p}}`).join(', ')}) filled by setup (${fillers.join('; ')}). Each test that needs an existing resource calls \`const p = await ctx.setup();\` and builds the path as \`${endpoint.path.replace(/\{([^}]+)\}/g, '${p.$1}')}\`. Do not call ctx.createResource for these placeholders.`
      : steps.length === 1
        ? `- This endpoint has setup. Each test that needs an existing resource gets one with \`const id = await ctx.createResource('${steps[0].endpointId}');\` (returns the id as a string) and puts it in the path.`
        : '- This endpoint has no setup. Do not call ctx.createResource unless a test needs a resource.';
  const queryLine = shown.query
    ? `- This endpoint takes query parameters: ${JSON.stringify(shown.query)}. Send them with the \`params\` option, for example \`ctx.api.get(path, { params: ${JSON.stringify(shown.query)} })\`; invalid-input cases may send a wrong value or type for one of them instead of a body change.`
    : '';
  const headersLine = shown.headers
    ? `- This endpoint needs extra headers: ${JSON.stringify(shown.headers)}. Send them on every request with the \`headers\` option, for example \`{ headers: ${JSON.stringify(shown.headers)} }\` (auth tests too; only the auth header is left out there).`
    : '';
  const contextFiles = fw.contextFiles
    .map((f) => `FILE ${f} (shown for context, tests never import it):\n\`\`\`ts\n${read(f)}\n\`\`\`\n`)
    .join('\n');
  const fields = documentedFields(endpoint, probe);
  const schemaBlock = endpoint.responseSchema
    ? `\nRESPONSE SCHEMA (the documented ${endpoint.responseSchema.status} response, from the API's OpenAPI spec):\n${untrusted('response-schema', JSON.stringify(endpoint.responseSchema.schema, null, 2))}\n${
        fields.length
          ? `Every [schema] test must assert each required field of this schema with its type (${fields.map((f) => `\`${f}\``).join(', ')}${endpoint.responseSchema.schema.items ? ', on the array items' : ''}).\n`
          : `The probe answered ${probe.status}, not the documented ${endpoint.responseSchema.status}, so assert the shape the probe shows.\n`
      }`
    : '';
  const sheetRun = plan.cases.some((c) => c.source);
  const sheetRules = sheetRun
    ? `\n- This plan comes from the team's test case sheet. Use every plan case's title exactly as written, character for character, including the leading [ID] or [agent] part: it maps each result back to the sheet. The type tag after it decides the status rules below. Write exactly one test per plan case and no other tests.\n- A case with "expectedResult" is the team's agreed expectation: turn it into assertions on the response wherever the response allows (field presence, types, and values the test itself sent), on top of the status rule for its type. Never change the expected status to match the sheet.\n- A case with "clauses": for every clause with status "asserted" and via "assertion", put the comment \`// covers clause <n>\` on the line right before the expect(...) that checks it (\`// covers clauses 2, 3\` when one assertion checks several). The agent reads these comments to report which clauses the test really checks; a clause without its comment and assertion is reported as not covered. Never write the comment for a clause the test does not check.\n- A case with "statusCodes" also asserts that list after the range checks: \`expect([${'${codes}'}]).toContain(response.status())\` with the case's codes, for example \`expect([400, 404]).toContain(response.status())\`.\n- A case with "contentType" also asserts the response format: \`expect(String(response.headers()['content-type'])).toContain('<text>')\` where <text> is "json" for any JSON type and the case's contentType otherwise (for example 'text/plain' or 'image/png'). When contentType is not JSON, never call response.json() in that test: read response.text() for text or response.body() for files.`
    : '';
  const binary = binaryRule(probe);
  const binaryLines = binary
    ? `\n${binary}\n- For this endpoint never call response.json() on the success response. Assert the content type (\`expect(response.headers()['content-type']).toContain('${probe.contentType?.split(';')[0] ?? 'image/'}')\`), the body size (\`const bytes = await response.body(); expect(bytes.length).toBeGreaterThan(0);\`)${probe.binary?.signatureHex ? ` and the file signature (\`expect(bytes.subarray(0, ${probe.binary.signatureHex.length / 2}).toString('hex')).toBe('${probe.binary.signatureHex}');\`)` : ''}${probe.responseHeaders?.['cache-control'] ? ', and Cache-Control when the case asks for it (`expect(response.headers()[\'cache-control\']).toBeTruthy()` is not enough on its own; check its value, for example `.toContain(\'max-age\')`)' : ''}. Error responses (4xx) may still be JSON: only call json() in a test whose response is JSON.`
    : '';
  const crossCallLine = opts.stability?.stable
    ? `\n- This endpoint's data is stable during the run (${opts.stability.why}). A plan case with "crossCall": true may send several requests and compare them (paging walks, totals across filters, no item repeated across pages); each such case is one test that sends all its requests itself, so it never depends on another test or on the order tests run in. Never use serial mode (test.describe.configure({ mode: 'serial' })): one failure there skips every later test in the file.`
    : '';
  return `Write the test file generated/${endpoint.id}.spec.ts (${fw.label}) for this endpoint, implementing every case in the plan as one test.

ENDPOINT CONFIG:
${untrusted('endpoint-config', JSON.stringify(shown, null, 2))}

PROBE (a real call with the sample body; arrays truncated to 3 items):
${untrusted('probe-response', JSON.stringify(probe, null, 2))}

PLAN:
${untrusted('plan', JSON.stringify(plan, null, 2))}
${schemaBlock}
FILE ${fw.ctxFile} (the fixture; tests get everything from ctx):
\`\`\`ts
${read(fw.ctxFile)}
\`\`\`

${contextFiles}FILE ${fw.templateFile} (THE EXAMPLE TO FOLLOW):
\`\`\`ts
${read(fw.templateFile)}
\`\`\`

RULES:
- The file lives in generated/, so import exactly: ${fw.importLine}
${setupLine}${queryLine ? `\n${queryLine}` : ''}${headersLine ? `\n${headersLine}` : ''}
- Paths are relative, for example \`${params.length > 1 ? endpoint.path.replace(/\{([^}]+)\}/g, '${p.$1}') : endpoint.path.replace(/\{[^}]+\}/, '${id}')}\`. The base URL comes from ctx.api. Never write http:// or https://.
- Use ctx.api for normal requests and ctx.noAuthApi for auth cases (the same valid request without the auth header).
- Never expect a 5xx, except a plan case with "accepted5xx": true: the team documented that 5xx, so that one test asserts exactly expect(response.status()).toBe(<its expectedStatus>) and nothing else about the status.
- Every [happy] and [schema] test asserts exactly its plan case's "expectedStatus" (the team's sheet decides it; it may differ from the probe status, and then the probe does not show that response's body: assert only what the case's expected result says).
- A plan case with "pathValues" sends its own values in the path placeholders (for example { "id": "42" } means the path uses 42), instead of creating a resource or calling ctx.setup() for those placeholders. Assert status codes, field presence and field types. Every [happy] and [schema] test must assert at least one field value or type of the response body${probeHasBody(probe) && ![204, 205, 304].includes(probe.status ?? 0) ? '' : ' (this endpoint answered without a body, so here the status is enough)'}. Assert exact values only for values the test itself sent.
- Tests run against a shared live API while other tests create, update and delete data. Never assert a list length or item count, never compare the results of two calls, and never assume a list is unchanged or contains (or lacks) a specific item you did not create in the same test${opts.stability?.stable ? ' (except in the plan cases marked "crossCall": true, see below)' : ''}. For lists, assert the array type and the shape of its items only.
${fw.generatorRules(endpoint, plan, probe).map((r) => `- ${r}`).join('\n')}${binaryLines}${crossCallLine}${sheetRules}

Answer with exactly one \`\`\`ts code block containing the whole file.`;
}

// The required fields a [schema] test must assert, when the documented success status is the one the
// probe saw (otherwise the documented shape may not apply to this response).
export function documentedFields(endpoint: Endpoint, probe: ProbeResult): string[] {
  const doc = endpoint.responseSchema;
  if (!doc || doc.status !== probe.status) return [];
  return requiredResponseFields(doc.schema);
}

// The probe got a response body worth asserting on.
export function probeHasBody(probe: ProbeResult): boolean {
  if (probe.binary) return probe.binary.bytes > 0;
  if (probe.body !== undefined && probe.body !== null && probe.body !== '') return true;
  return typeof probe.bodyText === 'string' && probe.bodyText.trim() !== '';
}

function extractCode(text: string): string | null {
  const m = text.match(/```(?:ts|typescript)\s*\n([\s\S]*?)```/);
  return m ? m[1].trimEnd() + '\n' : null;
}

// Sheet cases the agent will not guess at, written by the agent itself (not the model) after the gate:
// a Playwright test.fixme or a pending Mocha test, titled "[<ID>] [needs-review] <Title>", with the
// reason. They never run and never count as passed; the traceability file lists them as needs review.
//
// Cases with a reason code that does not run (MISSING_TEST_DATA: skipped; MANUAL, MANUAL_VISUAL: manual)
// go in a second block, "[<ID>] [skipped] ..." / "[<ID>] [manual] ...", with a skip-reason annotation
// ("<CODE>: <reason>") or a "// skipped: <CODE>: <reason>" comment for Pactum. Never run, never passed.
export function needsReviewBlock(fw: FrameworkAdapter, all: NonNullable<Plan['needsReview']>): string {
  const coded = all.filter((n) => n.code && n.code !== 'SPEC_UNCLEAR');
  const items = all.filter((n) => !n.code || n.code === 'SPEC_UNCLEAR');
  return reviewBlock(fw, items) + skippedBlock(fw, coded);
}

function skippedBlock(fw: FrameworkAdapter, items: NonNullable<Plan['needsReview']>): string {
  if (!items.length) return '';
  const lines = items.map((n) => {
    const title = JSON.stringify(n.title ?? `[${n.caseId}] [skipped]`);
    const why = n.reason.replace(/\s+/g, ' ');
    const text = why.startsWith(`${n.code}:`) ? why : `${n.code}: ${why}`;
    return fw.name === 'pactum' ? `  // skipped: ${text}\n  it(${title});` : `  test.fixme(${title}, { annotation: { type: 'skip-reason', description: ${JSON.stringify(text)} } }, async () => {});`;
  });
  const open = fw.name === 'pactum' ? `describe('skipped', () => {` : `test.describe('skipped', () => {`;
  return `\n// From the team's test case sheet: cases that do not run here, each with its reason code (missing test\n// data, manual). Written by the agent, never by the model. They never run and never pass.\n${open}\n${lines.join('\n')}\n});\n`;
}

function reviewBlock(fw: FrameworkAdapter, items: NonNullable<Plan['needsReview']>): string {
  if (!items.length) return '';
  const lines = items.map((n) => {
    const title = JSON.stringify(n.title ?? `[${n.caseId}] [needs-review]`);
    const reason = JSON.stringify(n.reason.replace(/\s+/g, ' '));
    return fw.name === 'pactum'
      ? `  // needs review: ${n.reason.replace(/\s+/g, ' ')}\n  it(${title});`
      : `  test.fixme(${title}, { annotation: { type: 'needs-review', description: ${reason} } }, async () => {});`;
  });
  const open = fw.name === 'pactum' ? `describe('needs review', () => {` : `test.describe('needs review', () => {`;
  return `\n// From the team's test case sheet: cases too ambiguous to automate without a person (needs review).\n// Written by the agent, never by the model. They never run and never pass.\n${open}\n${lines.join('\n')}\n});\n`;
}

function emptySpecHeader(fw: FrameworkAdapter): string {
  return fw.name === 'pactum' ? `import { expect } from '../tests-pactum/setup/ctx';\n\nvoid expect;\n` : `import { test } from '../tests/fixtures/ctx';\n`;
}

// The sheet decides the expected status (agent/plan.ts sheetStatusDecision): [happy] / [schema] cases
// whose status is not the probe's, and documented 5xx cases, get their own status rule in the gate.
export function sheetStatusGate(plan: Plan, probe: ProbeResult): Pick<ValidateOptions, 'expectedStatuses' | 'accepted5xx' | 'bodyOptional'> {
  const exact = plan.cases.filter((c) => (c.type === 'happy' || c.type === 'schema') && /^\d{3}$/.test(c.expectedStatus));
  const own = exact.filter((c) => Number(c.expectedStatus) !== probe.status || !probe.usable);
  const expectedStatuses = Object.fromEntries(own.filter((c) => !c.accepted5xx).map((c) => [c.title, Number(c.expectedStatus)]));
  const accepted5xx = Object.fromEntries(exact.filter((c) => c.accepted5xx && Number(c.expectedStatus) >= 500).map((c) => [c.title, Number(c.expectedStatus)]));
  const bodyOptional = own.map((c) => c.title);
  return {
    ...(Object.keys(expectedStatuses).length ? { expectedStatuses } : {}),
    ...(Object.keys(accepted5xx).length ? { accepted5xx } : {}),
    ...(bodyOptional.length ? { bodyOptional } : {}),
  };
}

export async function generateEndpoint(fw: FrameworkAdapter, endpoint: Endpoint, plan: Plan, probe: ProbeResult, genOpts: GenerateOptions = {}): Promise<GenerateResult> {
  mkdirSync(CANDIDATE_DIR, { recursive: true });
  const candidate = join(CANDIDATE_DIR, `${endpoint.id}.spec.ts`);
  const finalFile = join(GENERATED_DIR, `${endpoint.id}.spec.ts`);
  const review = needsReviewBlock(fw, plan.needsReview ?? []);
  // Only needs-review cases: nothing for the model to write.
  if (!plan.cases.length) {
    if (!review) return { ok: false, reasons: ['the plan has no cases'] };
    writeFileSync(finalFile, emptySpecHeader(fw) + review);
    return { ok: true, specFile: finalFile, plan };
  }
  const prompt = buildPrompt(fw, endpoint, plan, probe, genOpts);
  const gateOpts: ValidateOptions = {
    name: endpoint.id,
    planTypes: plan.cases.map((c) => c.type),
    probeStatus: probe.status,
    probeHasBody: probeHasBody(probe),
    requiredFields: documentedFields(endpoint, probe),
    requiredTitles: plan.cases.some((c) => c.source) ? plan.cases.map((c) => c.title) : undefined,
    contentTypes: contentTypesOf(plan),
    probeContentType: probeContentType(probe),
    ...sheetStatusGate(plan, probe),
  };

  let reasons: string[] = [];
  let lastCode: string | null = null;
  let lastResult: ValidationResult | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const user =
      attempt === 1
        ? prompt
        : `${prompt}\n\nYOUR PREVIOUS FILE WAS REJECTED BY THE STATIC GATE. Fix every problem below and answer again with the whole file:\n- ${reasons.join('\n- ')}`;
    let text: string;
    try {
      text = await callClaude(attempt === 1 ? 'generate' : 'generate-retry', endpoint.id, system(fw), user);
    } catch (err) {
      if (err instanceof BudgetExceeded) throw err;
      return { ok: false, reasons: [(err as Error).message] };
    }

    const code = extractCode(text);
    if (!code) {
      reasons = ['answer did not contain a ```ts code block'];
      continue;
    }
    writeFileSync(candidate, code);
    const result = fw.validate(code, gateOpts);
    if (result.ok) {
      rmSync(candidate, { force: true });
      return writeSpec(fw, finalFile, code, plan, [], genOpts, review);
    }
    reasons = result.reasons;
    lastCode = code;
    lastResult = result;
    rmSync(candidate, { force: true });
  }
  // Still rejected after the retry: drop only the tests the gate rejected and keep the rest of the
  // file, when the file itself (imports, helpers) is fine. Each dropped case keeps its own reasons.
  if (lastCode && lastResult) {
    const pruned = pruneFailingTests(fw, lastCode, gateOpts, lastResult);
    if (pruned) return writeSpec(fw, finalFile, pruned.code, plan, pruned.dropped, genOpts, review);
    return { ok: false, reasons, byTitle: lastResult.byTest };
  }
  return { ok: false, reasons };
}

// Sheet cases that name a response format: title -> media type, for the gate's Content-Type rule.
export function contentTypesOf(plan: Plan): Record<string, string> | undefined {
  const pairs = plan.cases.filter((c) => c.contentType).map((c) => [c.title, c.contentType!] as [string, string]);
  return pairs.length ? Object.fromEntries(pairs) : undefined;
}

// The probe's content type when it matters to the gate (a response that is not JSON), else null.
function probeContentType(probe: ProbeResult): string | null {
  if (probe.binary) return probe.contentType ?? 'application/octet-stream';
  if (probe.contentType && !isJsonContentType(probe.contentType) && probe.body === undefined) return probe.contentType;
  return null;
}

export type DroppedTest = { title: string; reasons: string[] };

// Removes the tests the gate rejected (and notes the plan cases that have no test) and checks the rest
// of the file again. null when the file itself is the problem or nothing would be left.
export function pruneFailingTests(fw: FrameworkAdapter, code: string, opts: ValidateOptions, result: ValidationResult): { code: string; dropped: DroppedTest[] } | null {
  if (result.ok) return { code, dropped: [] };
  if (result.fileReasons.length) return null;
  const testFn = fw.name === 'pactum' ? 'it' : 'test';
  const present = new Set(testRanges(code, testFn).map((t) => t.title.replace(/\\(.)/g, '$1')));
  const failing = Object.keys(result.byTest);
  const pruned = removeTests(code, failing.filter((t) => present.has(t)), testFn);
  const left = testRanges(pruned, testFn);
  if (!left.length) return null;
  const dropped = new Set(failing);
  const again = fw.validate(pruned, {
    ...opts,
    planTypes: opts.requiredTitles ? opts.planTypes : left.map((t) => testTypeOf(t.title) ?? 'happy'),
    requiredTitles: opts.requiredTitles?.filter((t) => !dropped.has(t)),
  });
  if (!again.ok) return null;
  return { code: pruned, dropped: failing.map((title) => ({ title, reasons: result.byTest[title] })) };
}

// A gate reason without the "[type] test "<title>": " prefix, for one case's own reason.
function shortReason(title: string, reason: string): string {
  return reason.replace(/^\[[a-z-]+\] test "[^"]*": /, '').replace(/^test "[^"]*":? /, '').replace(`"${title}"`, 'this test');
}

// Writes the spec (needs-review placeholders after it) and returns
// the plan with the gate's dropped tests and each sheet case's clause coverage as written.
function writeSpec(fw: FrameworkAdapter, finalFile: string, code: string, plan: Plan, gateDropped: DroppedTest[], genOpts: GenerateOptions, review: string): GenerateResult {
  // Known issues and precondition checks from the sheet, added by the agent after the gate. A test the
  // marker cannot be added to is dropped (never run unmarked: a known bug would show as a plain failure).
  const marked = addCaseMarkers(fw, code, plan);
  const dropped = [...gateDropped, ...marked.failed.map((f) => ({ title: f.title, reasons: [f.reason] }))];
  const droppedTitles = new Set(dropped.map((d) => d.title));
  let out = marked.failed.length ? removeTests(marked.code, marked.failed.map((f) => f.title), fw.name === 'pactum' ? 'it' : 'test') : marked.code;
  writeFileSync(finalFile, out + review);
  const notAutomated = dropped.map((d) => {
    const pc = plan.cases.find((c) => c.title === d.title);
    const marker = marked.failed.some((f) => f.title === d.title);
    return { ...(pc?.caseId ? { caseId: pc.caseId } : {}), title: d.title, reason: marker ? d.reasons.join(' | ') : `static gate: ${d.reasons.map((r) => shortReason(d.title, r)).join(' | ')}` };
  });
  const cases = plan.cases.filter((c) => !droppedTitles.has(c.title)).map((c) => withWrittenCoverage(fw, out, c));
  return { ok: true, specFile: finalFile, plan: { ...plan, cases, ...(notAutomated.length ? { notAutomated: [...(plan.notAutomated ?? []), ...notAutomated] } : {}) } };
}

// Adds the sheet's markers to the tests that need them, by the agent (never the model):
//   Known issue   Playwright: test.fail(true, "KNOWN_ISSUE QA-1: ...") as the test's first line.
//                 Pactum: it(title, knownIssue("KNOWN_ISSUE QA-1: ...", async () => { ... })).
//   Required data Playwright: await ctx.requireData([...]) as the test's first line.
//                 Pactum: requireDataFor(title, [...]) before the it(...) (the root hook checks it).
// failed: tests the marker could not be added to (an unusual test shape), with the reason.
export function addCaseMarkers(fw: FrameworkAdapter, code: string, plan: Plan): { code: string; failed: { title: string; reason: string }[] } {
  const wanted = plan.cases.filter((c) => c.knownIssue || c.requiredData?.length);
  if (!wanted.length) return { code, failed: [] };
  const pactum = fw.name === 'pactum';
  const ranges = testRanges(code, pactum ? 'it' : 'test');
  const failed: { title: string; reason: string }[] = [];
  const edits: { at: number; text: string }[] = [];
  for (const c of wanted) {
    const r = ranges.find((t) => t.title.replace(/\\(.)/g, '$1') === c.title);
    if (!r) continue;
    const open = code.indexOf('(', r.start);
    const close = matchingParen(code, open);
    if (close < 0) {
      failed.push({ title: c.title, reason: 'could not add the known-issue or required-data marker to this test' });
      continue;
    }
    const call = code.slice(open, close);
    if (pactum) {
      if (c.requiredData?.length) {
        const lineStart = code.lastIndexOf('\n', r.start - 1) + 1;
        const indent = /^[ \t]*/.exec(code.slice(lineStart))![0];
        edits.push({ at: lineStart, text: `${indent}requireDataFor(${JSON.stringify(c.title)}, ${JSON.stringify(c.requiredData)});\n` });
      }
      if (c.knownIssue) {
        const head = /^\(\s*(['"`])(?:\\.|(?!\1)[\s\S])*?\1\s*,\s*/.exec(call);
        if (!head) {
          failed.push({ title: c.title, reason: 'could not add the known-issue marker to this test (unusual test shape)' });
          continue;
        }
        edits.push({ at: open + head[0].length, text: `knownIssue(${JSON.stringify(c.knownIssue)}, ` }, { at: close, text: ')' });
      }
    } else {
      const fn = /async\s*\(\s*\{([^}]*)\}\s*\)\s*=>\s*\{/.exec(call);
      if (!fn || !fn[1].split(',').some((n) => n.trim().split(':')[0].trim() === 'ctx')) {
        failed.push({ title: c.title, reason: 'could not add the known-issue or required-data marker to this test (it does not take { ctx })' });
        continue;
      }
      const body = open + fn.index + fn[0].length;
      const lines = [
        ...(c.requiredData?.length ? [`    await ctx.requireData(${JSON.stringify(c.requiredData)});`] : []),
        ...(c.knownIssue ? [`    test.fail(true, ${JSON.stringify(c.knownIssue)});`] : []),
      ];
      edits.push({ at: body, text: `\n${lines.join('\n')}` });
    }
  }
  let out = code;
  for (const e of [...edits].sort((a, b) => b.at - a.at)) out = out.slice(0, e.at) + e.text + out.slice(e.at);
  if (pactum && edits.length) {
    const need = [...(wanted.some((c) => c.knownIssue) ? ['knownIssue'] : []), ...(wanted.some((c) => c.requiredData?.length) ? ['requireDataFor'] : [])];
    out = out.replace(/import\s*\{([^}]*)\}\s*from\s*(['"](?:\.\.?\/)+(?:tests-pactum\/)?setup\/ctx(?:\.ts)?['"])/, (whole, names: string, from: string) => {
      const have = names.split(',').map((n) => n.trim()).filter(Boolean);
      const all = [...have, ...need.filter((n) => !have.includes(n))];
      return `import { ${all.join(', ')} } from ${from}`;
    });
  }
  return { code: out, failed };
}

// Which of a sheet case's clauses the written test really checks: a clause marked asserted needs its
// "// covers clause <n>" comment followed by an expect(...) in the case's own test; the status-only
// clauses are covered by the status assertion.
export function withWrittenCoverage(fw: FrameworkAdapter, code: string, c: Plan['cases'][number]): Plan['cases'][number] {
  if (!c.clauses?.length) return c;
  const testFn = fw.name === 'pactum' ? 'it' : 'test';
  const range = testRanges(code, testFn).find((t) => t.title.replace(/\\(.)/g, '$1') === c.title);
  const body = range ? code.slice(range.start, range.end) : '';
  const marked = coveredClauses(body);
  return {
    ...c,
    clauses: c.clauses.map((cl) => {
      if (cl.status !== 'asserted' || cl.via === 'status') return cl;
      if (marked.has(cl.n)) return cl;
      return { n: cl.n, text: cl.text, status: 'not-asserted' as const, reason: 'no assertion was written for it' };
    }),
  };
}

// Clause numbers that have a "// covers clause N" (or "clauses N, M") comment followed by an expect.
export function coveredClauses(body: string): Set<number> {
  const out = new Set<number>();
  const marks = [...body.matchAll(/\/\/\s*covers\s+clauses?\s+([\d,\s]+(?:and\s+\d+)?)/gi)];
  marks.forEach((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].index! : body.length;
    if (!/\bexpect(?:\.soft)?\s*\(/.test(body.slice(m.index! + m[0].length, end))) return;
    for (const n of m[1].split(/[,\s]+|and/).map((x) => Number(x.trim())).filter((x) => Number.isInteger(x) && x > 0)) out.add(n);
  });
  return out;
}
