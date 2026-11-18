import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BudgetExceeded, callClaude } from './claude';
import type { Endpoint } from './config';
import { pathParams, setupSteps } from './model';
import { binaryRule, promptEndpoint, type Plan, type Stability } from './plan';
import { removeTests, testRanges, type ValidateOptions, type ValidationResult } from './validate';
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
  const setupLine =
    steps.length > 1 || params.length > 1
      ? `- This endpoint's path has ${params.length} placeholders (${params.map((p) => `{${p}}`).join(', ')}) filled by setup (${steps.map((s) => `${s.endpointId} fills {${s.param}}`).join('; ')}). Each test that needs an existing resource calls \`const p = await ctx.setup();\` and builds the path as \`${endpoint.path.replace(/\{([^}]+)\}/g, '${p.$1}')}\`. Do not call ctx.createResource for these placeholders.`
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
    ? `\n- This plan comes from the team's test case sheet. Use every plan case's title exactly as written, character for character, including the leading [ID] or [agent] part: it maps each result back to the sheet. The type tag after it decides the status rules below. Write exactly one test per plan case and no other tests.\n- A case with "expectedResult" is the team's agreed expectation: turn it into assertions on the response wherever the response allows (field presence, types, and values the test itself sent), on top of the status rule for its type. Never change the expected status to match the sheet.\n- A case with "clauses": for every clause with status "asserted" and via "assertion", put the comment \`// covers clause <n>\` on the line right before the expect(...) that checks it (\`// covers clauses 2, 3\` when one assertion checks several). The agent reads these comments to report which clauses the test really checks; a clause without its comment and assertion is reported as not covered. Never write the comment for a clause the test does not check.\n- A case with "statusCodes" also asserts that list after the range checks: \`expect([${'${codes}'}]).toContain(response.status())\` with the case's codes, for example \`expect([400, 404]).toContain(response.status())\`.`
    : '';
  const binary = binaryRule(probe);
  const binaryLines = binary
    ? `\n${binary}\n- For this endpoint never call response.json() on the success response. Assert the content type (\`expect(response.headers()['content-type']).toContain('${probe.contentType?.split(';')[0] ?? 'image/'}')\`), the body size (\`const bytes = await response.body(); expect(bytes.length).toBeGreaterThan(0);\`)${probe.binary?.signatureHex ? ` and the file signature (\`expect(bytes.subarray(0, ${probe.binary.signatureHex.length / 2}).toString('hex')).toBe('${probe.binary.signatureHex}');\`)` : ''}${probe.responseHeaders?.['cache-control'] ? ', and Cache-Control when the case asks for it (`expect(response.headers()[\'cache-control\']).toBeTruthy()` is not enough on its own; check its value, for example `.toContain(\'max-age\')`)' : ''}. Error responses (4xx) may still be JSON: only call json() in a test whose response is JSON.`
    : '';
  const crossCallLine = opts.stability?.stable
    ? `\n- This endpoint's data is stable during the run (${opts.stability.why}). A plan case with "crossCall": true may send several requests and compare them (paging walks, totals across filters, no item repeated across pages); the agent runs this file's tests serially. Other tests stay independent.`
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
- Never expect a 5xx. Assert status codes, field presence and field types. Every [happy] and [schema] test must assert at least one field value or type of the response body${probeHasBody(probe) && ![204, 205, 304].includes(probe.status ?? 0) ? '' : ' (this endpoint answered without a body, so here the status is enough)'}. Assert exact values only for values the test itself sent.
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
export function needsReviewBlock(fw: FrameworkAdapter, items: NonNullable<Plan['needsReview']>): string {
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
    probeContentType: probeContentType(probe),
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

// Writes the spec (needs-review placeholders after it, serial mode when it compares calls) and returns
// the plan with the gate's dropped tests and each sheet case's clause coverage as written.
function writeSpec(fw: FrameworkAdapter, finalFile: string, code: string, plan: Plan, dropped: DroppedTest[], genOpts: GenerateOptions, review: string): GenerateResult {
  const droppedTitles = new Set(dropped.map((d) => d.title));
  let out = code;
  const crossCall = plan.cases.some((c) => c.crossCall && !droppedTitles.has(c.title));
  if (crossCall && genOpts.stability?.stable) out = serialMode(fw, out);
  writeFileSync(finalFile, out + review);
  const notAutomated = dropped.map((d) => {
    const pc = plan.cases.find((c) => c.title === d.title);
    return { ...(pc?.caseId ? { caseId: pc.caseId } : {}), title: d.title, reason: `static gate: ${d.reasons.map((r) => shortReason(d.title, r)).join(' | ')}` };
  });
  const cases = plan.cases.filter((c) => !droppedTitles.has(c.title)).map((c) => withWrittenCoverage(fw, out, c));
  return { ok: true, specFile: finalFile, plan: { ...plan, cases, ...(notAutomated.length ? { notAutomated: [...(plan.notAutomated ?? []), ...notAutomated] } : {}) } };
}

// Tests that compare several calls run one after another, in order, in one worker: Playwright's
// serial mode. Mocha runs a file's tests in order already (the Pactum adapter never runs in parallel).
export function serialMode(fw: FrameworkAdapter, code: string): string {
  if (fw.name === 'pactum') return code;
  if (/test\.describe\.configure\(\s*\{\s*mode:\s*['"]serial['"]/.test(code)) return code;
  const lines = code.split('\n');
  let lastImport = -1;
  lines.forEach((l, i) => {
    if (/^\s*import\b/.test(l)) lastImport = i;
  });
  lines.splice(lastImport + 1, 0, '', "// Some tests compare several calls to the API, so this file's tests run one after another (serial).", "test.describe.configure({ mode: 'serial' });");
  return lines.join('\n');
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
