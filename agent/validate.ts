import { spawnSync } from 'node:child_process';
import { nodeBin } from './node-bin';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { contentTypeNeedle, isJsonMediaType } from './expected';
import { isJsonContentType, testTypeOf } from './model';

// Static gate for a generated spec. No Claude call. Returns every reason, not just the first.

const TYPES = ['happy', 'schema', 'invalid-input', 'auth', 'authz'] as const;
type CaseType = (typeof TYPES)[number];
const TAGS = TYPES.map((t) => `[${t}]`);
// Generated specs live in generated/, one level below the root. tsc resolves imports relative
// to the file, so the candidate is typechecked from a sibling folder at the same depth.
const TSCHECK_DIR = '.tscheck';

// reasons: every reason, as before. byTest: the reasons that belong to one test, by its title (a
// required title with no test gets one too). fileReasons: the reasons that belong to no single test
// (imports, code outside the tests): only those make the whole file unusable (see pruneFailingTests).
export type ValidationResult = { ok: boolean; reasons: string[]; byTest: Record<string, string[]>; fileReasons: string[] };

export type ValidateOptions = {
  name: string;
  // The plan's case types, one entry per case. The file needs at least this many tests of each type.
  planTypes: string[];
  // The probe status. happy and schema tests must assert exactly this status.
  probeStatus: number | null;
  // Did the probe get a response body? false (or a 204, 205 or 304 probe status) lifts the body-assertion
  // rule for [happy] and [schema] tests; anything else keeps it.
  probeHasBody?: boolean;
  // Required response fields from the documented response schema (endpoint.responseSchema). Every
  // [schema] test must assert each one.
  requiredFields?: string[];
  // Test case sheet runs: titles the file must contain exactly (each carries a sheet case ID or the
  // [agent] label, so results map back to the sheet). A test with any other title is rejected, so
  // "Only my test cases" never gets a test the sheet does not have.
  requiredTitles?: string[];
  // The probe's response content type. A response that is not JSON (an image, a PDF, plain text) lets
  // [happy] and [schema] tests check the headers, the body size or the file signature instead of a
  // JSON field.
  probeContentType?: string | null;
  // Sheet cases that name a response format (plan case contentType), by test title. Such a test must
  // assert the Content-Type header, and one for a format that is not JSON must never call .json().
  contentTypes?: Record<string, string>;
};

const NO_BODY_STATUSES = [204, 205, 304];

// A test for a sheet case that names its response format: an expect(...) that reads the Content-Type
// header (directly or through a variable) and checks it contains the format; for a format that is not
// JSON, no response.json() anywhere in the test.
export function checkContentType(title: string, body: string, mediaType: string, reasons: string[]) {
  const needle = contentTypeNeedle(mediaType);
  const ctVars = [...body.matchAll(/\b(?:const|let|var)\s+(\w+)(?:\s*:\s*[^=]+)?\s*=\s*[^;\n]*content-type/gi)].map((m) => m[1]);
  const checks = expectCalls(body).some((c) => {
    const readsHeader = /content-type/i.test(c.arg) || ctVars.some((v) => new RegExp(`(?<![.\\w$])${v}\\b`).test(c.arg));
    return readsHeader && c.text.toLowerCase().includes(needle);
  });
  if (!checks) reasons.push(`test "${title}": the sheet expects a ${mediaType} response: assert expect(String(response.headers()['content-type'])).toContain('${needle}')`);
  if (!isJsonMediaType(mediaType) && /\.json\s*\(\s*\)/.test(body)) reasons.push(`test "${title}": the sheet expects a ${mediaType} response, not JSON: never call response.json() here; use response.text() or response.body()`);
}

// Names of variables that hold a parsed response body, e.g. const body = (await response.json()) as X;
function bodyVariables(code: string): string[] {
  return [...code.matchAll(/\b(?:const|let|var)\s+(\w+)(?:\s*:\s*[^=]+)?\s*=\s*\(?\s*await\s+[\w.]+\.(?:json|text)\(\)/g)].map((m) => m[1]);
}

// An assertion about the body itself, not only that a body exists: expect(body.name).toBe(...),
// expect(typeof body.id).toBe('number'), expect(Array.isArray(body)).toBe(true), expect(body).toHaveProperty('id').
const EXISTENCE_ONLY = new Set(['toBeDefined', 'toBeTruthy', 'toBeNull', 'toBeUndefined', '']);
function isBodyAssertion(call: ExpectCall, bodyVars: string[]): boolean {
  const usesBody = /\.(?:json|text)\(\)/.test(call.arg) || bodyVars.some((v) => new RegExp(`(?<![.\\w$])${v}\\b`).test(call.arg));
  if (!usesBody) return false;
  return !EXISTENCE_ONLY.has(call.matcher);
}

// Variables assigned from response.headers() or from await response.body() (the raw bytes).
function headerVariables(code: string): string[] {
  return [...code.matchAll(/\b(?:const|let|var)\s+(\w+)(?:\s*:\s*[^=]+)?\s*=\s*[\w.]+\.headers\(\)/g)].map((m) => m[1]);
}
function bytesVariables(code: string): string[] {
  return [...code.matchAll(/\b(?:const|let|var)\s+(\w+)(?:\s*:\s*[^=]+)?\s*=\s*\(?\s*await\s+[\w.]+\.body\(\)/g)].map((m) => m[1]);
}

// For a response that is not JSON: an assertion on a response header (Content-Type, Cache-Control,
// Content-Length), on the body size or on the file signature (the first bytes) counts as a body check.
function isNonJsonAssertion(call: ExpectCall, headerVars: string[], bytesVars: string[]): boolean {
  if (EXISTENCE_ONLY.has(call.matcher)) return false;
  const uses = (vars: string[]) => vars.some((v) => new RegExp(`(?<![.\\w$])${v}\\b`).test(call.arg));
  return /\.headers\(\)/.test(call.arg) || /\.body\(\)/.test(call.arg) || uses(headerVars) || uses(bytesVars);
}

function matchingParen(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '(') depth++;
    else if (code[i] === ')' && --depth === 0) return i;
  }
  return code.length;
}

type ExpectCall = { arg: string; not: boolean; matcher: string; value: string; text: string };

// Every expect(...) call with its first matcher, e.g. expect(a).not.toBe(b) gives arg "a", not true,
// matcher "toBe", value "b". An expect without a matcher gets matcher "".
function expectCalls(body: string): ExpectCall[] {
  const calls: ExpectCall[] = [];
  for (const m of body.matchAll(/\bexpect(?:\.soft)?\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    const close = matchingParen(body, open);
    const arg = body.slice(open + 1, close).trim();
    const rest = body.slice(close + 1);
    const mm = rest.match(/^\s*(\.\s*not\s*)?\.\s*(\w+)\s*\(/);
    if (!mm) {
      calls.push({ arg, not: false, matcher: '', value: '', text: body.slice(m.index!, close + 1) });
      continue;
    }
    const mOpen = close + 1 + mm[0].length - 1;
    const mClose = matchingParen(body, mOpen);
    calls.push({
      arg,
      not: Boolean(mm[1]),
      matcher: mm[2],
      value: body.slice(mOpen + 1, mClose).trim(),
      text: body.slice(m.index!, mClose + 1).replace(/\s+/g, ' '),
    });
  }
  return calls;
}

// Names of variables that hold a response status, e.g. const status = response.status();
function statusVariables(code: string): string[] {
  return [...code.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*[\w.]+\.status\(\)/g)].map((m) => m[1]);
}

function isStatusExpr(expr: string, statusVars: string[]): boolean {
  const e = expr.trim();
  return /^[\w.]+\.status\(\)$/.test(e) || statusVars.includes(e);
}

type StatusAssertion =
  | { kind: 'exact'; code: number }
  | { kind: 'min'; code: number }
  | { kind: 'max'; code: number }
  | { kind: 'oneOf'; codes: number[] }
  | { kind: 'other' };

// null: not a status assertion. Otherwise the form it has; anything unusual is "other".
function statusAssertion(call: ExpectCall, statusVars: string[]): StatusAssertion | null {
  const list = call.arg.match(/^\[([\d\s,]*)\]$/);
  if (list && call.matcher === 'toContain' && isStatusExpr(call.value, statusVars)) {
    const codes = list[1].split(',').map((n) => n.trim()).filter(Boolean).map(Number);
    return call.not ? { kind: 'other' } : { kind: 'oneOf', codes };
  }
  if (!isStatusExpr(call.arg, statusVars)) return null;
  const num = /^\d{3}$/.test(call.value) ? Number(call.value) : null;
  if (call.not || num === null) return { kind: 'other' };
  if (['toBe', 'toEqual', 'toStrictEqual'].includes(call.matcher)) return { kind: 'exact', code: num };
  if (call.matcher === 'toBeGreaterThanOrEqual') return { kind: 'min', code: num };
  if (call.matcher === 'toBeLessThanOrEqual') return { kind: 'max', code: num };
  if (call.matcher === 'toBeLessThan') return { kind: 'max', code: num - 1 };
  return { kind: 'other' };
}

// Per test type, the only status assertions allowed and the ones that must be there.
// A test that checks something weaker, or the wrong thing, would pass against a broken API.
function checkTypeRules(type: CaseType, title: string, body: string, code: string, probeStatus: number | null, reasons: string[], probeHasBody = true, requiredFields: string[] = [], probeContentType: string | null = null) {
  const statusVars = statusVariables(code);
  const found = expectCalls(body)
    .map((call) => ({ call, a: statusAssertion(call, statusVars) }))
    .filter((x): x is { call: ExpectCall; a: StatusAssertion } => x.a !== null);
  const bad = (call: ExpectCall, why: string) => reasons.push(`[${type}] test "${title}": ${why}: ${call.text.slice(0, 120)}`);

  if (type === 'happy' || type === 'schema') {
    if (probeStatus === null) {
      reasons.push(`[${type}] test "${title}": the probe status is unknown, so the expected status cannot be checked`);
      return;
    }
    for (const { call, a } of found) {
      if (a.kind !== 'exact' || a.code !== probeStatus) bad(call, `status assertion must be exactly toBe(${probeStatus}), the probe status`);
    }
    if (!found.some(({ a }) => a.kind === 'exact' && a.code === probeStatus)) {
      reasons.push(`[${type}] test "${title}": must assert expect(response.status()).toBe(${probeStatus})`);
    }
    // A status check alone passes against an API that answers 200 with the wrong body.
    const bodyVars = bodyVariables(body);
    // A response that is not JSON (an image, a PDF, text): the headers, the size or the file signature
    // count too, since there is no JSON field to check.
    const nonJson = probeContentType !== null && !isJsonContentType(probeContentType);
    const headerVars = headerVariables(body);
    const bytesVars = bytesVariables(body);
    const checksBody = expectCalls(body).some((c) => isBodyAssertion(c, bodyVars) || (nonJson && isNonJsonAssertion(c, headerVars, bytesVars)));
    if (probeHasBody && !NO_BODY_STATUSES.includes(probeStatus) && !checksBody) {
      reasons.push(
        nonJson
          ? `[${type}] test "${title}": must assert something about the response, not only the status: this endpoint answers with ${probeContentType}, not JSON, so assert the Content-Type or Cache-Control header, the body size or the file signature (e.g. const bytes = await response.body(); expect(bytes.length).toBeGreaterThan(0); expect(response.headers()['content-type']).toContain('image/'))`
          : `[${type}] test "${title}": must assert something about the response body (a field value or type, e.g. expect(typeof body.id).toBe('number')), not only the status`,
      );
    }
    if (type === 'schema' && probeHasBody && requiredFields.length) {
      const asserted = expectCalls(body).map((c) => c.arg).join('\n');
      const missing = requiredFields.filter((f) => {
        const esc = f.replace(/[$]/g, '\\$');
        return !new RegExp(`\\.${esc}\\b|\\[\\s*['"\`]${esc}['"\`]\\s*\\]`).test(asserted) && !new RegExp(`toHaveProperty\\(\\s*['"\`]${esc}['"\`]`).test(body);
      });
      if (missing.length) {
        reasons.push(`[${type}] test "${title}": must assert every required field of the documented response schema; missing: ${missing.join(', ')}`);
      }
    }
  }

  if (type === 'invalid-input') {
    for (const { call, a } of found) {
      // A sheet case that names its 4xx codes ("400 or 404") may also check that list, which is still
      // a 4xx expectation: expect([400, 404]).toContain(response.status()).
      const ok = (a.kind === 'min' && a.code === 400) || (a.kind === 'max' && a.code === 499) || (a.kind === 'oneOf' && a.codes.length > 0 && a.codes.every((c) => c >= 400 && c <= 499));
      if (!ok) bad(call, 'status assertion must be toBeGreaterThanOrEqual(400), toBeLessThanOrEqual(499) or a list of 4xx codes such as expect([400, 404]).toContain(response.status())');
    }
    const hasMin = found.some(({ a }) => a.kind === 'min' && a.code === 400);
    const hasMax = found.some(({ a }) => a.kind === 'max' && a.code === 499);
    if (!hasMin || !hasMax) {
      reasons.push(`[${type}] test "${title}": must assert the status is between 400 and 499 (toBeGreaterThanOrEqual(400) and toBeLessThanOrEqual(499))`);
    }
  }

  if (type === 'auth') {
    const isAuthStatus = (a: StatusAssertion) =>
      (a.kind === 'oneOf' && a.codes.length > 0 && a.codes.every((c) => c === 401 || c === 403)) ||
      (a.kind === 'exact' && (a.code === 401 || a.code === 403));
    for (const { call, a } of found) {
      if (!isAuthStatus(a)) bad(call, 'status assertion must be expect([401, 403]).toContain(response.status())');
    }
    if (!found.some(({ a }) => isAuthStatus(a))) {
      reasons.push(`[${type}] test "${title}": must assert expect([401, 403]).toContain(response.status())`);
    }
    // The request under test must go without the auth header.
    if (/\bctx\s*\.\s*api\b/.test(body) || /\{[^}]*\bapi\b[^}]*\}\s*=\s*ctx\b/.test(body) || /\bctx\s*:\s*\{[^}]*\bapi\b/.test(body)) {
      reasons.push(`[${type}] test "${title}": uses ctx.api, which sends the auth header; auth tests use ctx.noAuthApi only`);
    }
    if (!/\bctx\s*\.\s*noAuthApi\b/.test(body)) {
      reasons.push(`[${type}] test "${title}": does not send its request with ctx.noAuthApi`);
    }
  }

  if (type === 'authz') {
    // Another role tries the request; only a rejection is a pass. 404 is allowed: many APIs hide
    // resources the caller may not see.
    const isAuthzStatus = (a: StatusAssertion) =>
      (a.kind === 'oneOf' && a.codes.length > 0 && a.codes.every((c) => c === 403 || c === 404)) ||
      (a.kind === 'exact' && (a.code === 403 || a.code === 404));
    for (const { call, a } of found) {
      if (!isAuthzStatus(a)) bad(call, 'status assertion must be expect([403, 404]).toContain(response.status())');
    }
    if (!found.some(({ a }) => isAuthzStatus(a))) {
      reasons.push(`[${type}] test "${title}": must assert expect([403, 404]).toContain(response.status())`);
    }
    if (!/\bctx\s*\.\s*as\s*\(\s*['"][^'"]+['"]\s*\)/.test(body)) {
      reasons.push(`[${type}] test "${title}": does not send its request with ctx.as('<role>')`);
    }
    if (/\bctx\s*\.\s*api\b/.test(body) || /\{[^}]*\bapi\b[^}]*\}\s*=\s*ctx\b/.test(body) || /\bctx\s*:\s*\{[^}]*\bapi\b/.test(body)) {
      reasons.push(`[${type}] test "${title}": uses ctx.api, the default role; authz tests send the request under test with ctx.as('<role>') (resources come from ctx.createResource)`);
    }
    if (/\bctx\s*\.\s*noAuthApi\b/.test(body)) {
      reasons.push(`[${type}] test "${title}": uses ctx.noAuthApi; that is an [auth] test, authz tests use ctx.as('<role>')`);
    }
  }
}

function matchingBrace(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}' && --depth === 0) return i;
  }
  return code.length;
}

function checkCatches(code: string, reasons: string[]) {
  for (const m of code.matchAll(/\bcatch\s*(\([^)]*\))?\s*\{/g)) {
    const open = m.index! + m[0].length - 1;
    const body = code.slice(open + 1, matchingBrace(code, open)).trim();
    if (body === '') reasons.push('has an empty catch block');
    else if (!/\bthrow\b/.test(body)) reasons.push('has a catch block that does not rethrow');
  }
  if (/\.catch\s*\(/.test(code)) reasons.push('uses .catch(), which can hide errors');
}

type TestCall = { title: string; start: number };

// testFn is "test" (Playwright) or "it" (Mocha).
export function findTests(code: string, testFn = 'test'): TestCall[] {
  const tests: TestCall[] = [];
  const re = new RegExp(`\\b${testFn}(?:\\.only|\\.skip)?\\(\\s*(['"\`])((?:\\\\.|(?!\\1)[^\\\\])*)\\1`, 'g');
  for (const m of code.matchAll(re)) {
    tests.push({ title: m[2], start: m.index! });
  }
  return tests;
}

// Names of local helpers that push the actual-status annotation (like recordStatus in the template).
function annotationHelpers(code: string): string[] {
  const names: string[] = [];
  for (const m of code.matchAll(/(?:function\s+(\w+)\s*\(|(?:const|let)\s+(\w+)\s*=)/g)) {
    const name = m[1] ?? m[2];
    const open = code.indexOf('{', m.index!);
    if (open < 0) continue;
    if (code.slice(open, matchingBrace(code, open)).includes('actual-status')) names.push(name);
  }
  return names;
}

function checkStatusExpectations(code: string, reasons: string[]) {
  for (const stmt of code.split(';')) {
    if (!/expect\s*\(/.test(stmt) || !/status/.test(stmt)) continue;
    const flat = stmt.replace(/\s+/g, ' ').trim();
    const num = (re: RegExp) => {
      const m = flat.match(re);
      return m ? Number(m[1]) : null;
    };
    const exact = num(/\.(?:toBe|toEqual|toStrictEqual)\(\s*(\d{3})\s*\)/);
    const gte = num(/\.toBeGreaterThanOrEqual\(\s*(\d{3})\s*\)/);
    const gt = num(/\.toBeGreaterThan\(\s*(\d{3})\s*\)/);
    const lte = num(/\.toBeLessThanOrEqual\(\s*(\d{3})\s*\)/);
    const lt = num(/\.toBeLessThan\(\s*(\d{3})\s*\)/);
    const list = flat.match(/expect\(\s*\[([^\]]*)\]\s*\)\.toContain/);
    const listHas5xx = list ? list[1].split(',').some((n) => Number(n.trim()) >= 500) : false;
    if (
      (exact !== null && exact >= 500) ||
      (gte !== null && gte >= 500) ||
      (gt !== null && gt >= 499) ||
      (lte !== null && lte >= 500) ||
      (lt !== null && lt > 500) ||
      listHas5xx
    ) {
      reasons.push(`expects a status of 500 or higher: ${flat.slice(0, 120)}`);
    }
  }
}

function typecheck(code: string, name: string): string | null {
  rmSync(TSCHECK_DIR, { recursive: true, force: true });
  mkdirSync(TSCHECK_DIR, { recursive: true });
  try {
    writeFileSync(join(TSCHECK_DIR, `${name}.spec.ts`), code);
    writeFileSync(
      join(TSCHECK_DIR, 'tsconfig.json'),
      JSON.stringify({ extends: '../tsconfig.json', include: [], files: [`${name}.spec.ts`] }),
    );
    const res = spawnSync(...nodeBin('tsc', ['-p', join(TSCHECK_DIR, 'tsconfig.json')]), { encoding: 'utf8' });
    if (res.status === 0) return null;
    return `${res.stdout}${res.stderr}`.trim().slice(0, 1500) || `tsc exited with ${res.status}`;
  } finally {
    rmSync(TSCHECK_DIR, { recursive: true, force: true });
  }
}

// The rules that differ per framework. Everything else in the gate is shared.
export type GateRules = {
  // "test" for Playwright, "it" for Mocha.
  testFn: string;
  // Checks the import line and anything else framework-specific; returns reasons.
  frameworkRules: (code: string) => string[];
  // Imported helpers that record the actual status (local helpers containing 'actual-status' are found automatically).
  statusRecorders?: string[];
  // The only module a generated spec may import: the framework's ctx file. Anything else is rejected.
  allowedImport: RegExp;
};

const PLAYWRIGHT_RULES: GateRules = {
  testFn: 'test',
  allowedImport: /^(?:\.\.?\/)+(?:tests\/)?fixtures\/ctx(?:\.ts)?$/,
  frameworkRules(code) {
    const reasons: string[] = [];
    const imp = code.match(/import\s*\{([^}]*)\}\s*from\s*['"](?:\.\.?\/)+(?:tests\/)?fixtures\/ctx(?:\.ts)?['"]/);
    const imported = imp ? imp[1].split(',').map((s) => s.trim()) : [];
    if (!imported.includes('test') || !imported.includes('expect')) {
      reasons.push('does not import test and expect from the ctx fixture file');
    }
    if (/@playwright\/test/.test(code)) reasons.push('imports from @playwright/test directly instead of the ctx fixture');
    if (/\btest(?:\.describe)?\.only\b/.test(code)) reasons.push('contains test.only');
    if (/\btest(?:\.describe)?\.skip\b/.test(code)) reasons.push('contains test.skip');
    // Serial mode skips every later test in the file after one failure, so one API bug would hide the
    // results of unrelated cases. A case that compares calls is one test that sends them all itself.
    if (/\btest\.describe\.serial\b/.test(code) || /\bdescribe\.configure\s*\(\s*\{[^}]*\bmode\s*:\s*['"`]serial['"`]/.test(code)) {
      reasons.push("uses serial mode (test.describe.configure({ mode: 'serial' }) or test.describe.serial): one failure would skip every later test; make each test independent");
    }
    // Playwright's own fixtures (request, page, browser, context, playwright) are clients outside the
    // guarded ctx: a test may only take { ctx }.
    for (const m of code.matchAll(/\basync\s*\(\s*\{([^}]*)\}/g)) {
      const names = m[1].split(',').map((n) => n.trim().split(':')[0].trim()).filter(Boolean);
      const other = names.filter((n) => n !== 'ctx');
      if (other.length) reasons.push(`uses Playwright fixtures other than ctx (${other.join(', ')}); every request must go through ctx`);
    }
    return reasons;
  },
};

// Generated code is model output built from API responses and imported text, so it is untrusted: a spec
// may only call the API through ctx. Anything that reaches the machine (modules, the process, the file
// system, the network outside ctx, code built from strings) is rejected, wherever it appears.
const NB = String.raw`(?<![.\w$])`; // not a property access: body.process or ctx.api.fetch stay allowed
// Identifier rules run on the code with string contents and comments blanked, so a test title like
// "[happy] starts the process" is not a match; rules about strings run on the raw code.
const UNSAFE_CODE: [RegExp, string, 'code' | 'raw'][] = [
  [new RegExp(String.raw`${NB}require\s*\(`), 'calls require()', 'code'],
  [/\bimport\s*\(/, 'uses a dynamic import()', 'code'],
  [/\bimport\s*\.\s*meta\b/, 'uses import.meta', 'code'],
  [new RegExp(String.raw`${NB}eval\s*\(`), 'calls eval()', 'code'],
  [new RegExp(String.raw`\bnew\s+Function\b|${NB}Function\s*\(`), 'builds a function from a string (Function)', 'code'],
  [/\bconstructor\s*\.\s*constructor\b|\[\s*['"`]constructor['"`]\s*\]|__proto__/, 'reaches a constructor or prototype (a way to build code from strings)', 'raw'],
  [new RegExp(String.raw`${NB}(?:setTimeout|setInterval|setImmediate)\s*\(\s*['"\x60]`), 'passes a string to a timer (runs it as code)', 'raw'],
  [new RegExp(String.raw`${NB}(?:globalThis|global|window|self)\s*(?:\??\.|\[)|\bglobalThis\b`), 'uses the global object', 'code'],
  [new RegExp(String.raw`${NB}process\b(?!\s*:)`), 'uses process', 'code'],
  [new RegExp(String.raw`${NB}(?:Deno|Bun)\s*(?:\??\.|\[)`), 'uses a runtime global', 'code'],
  [new RegExp(String.raw`${NB}fetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b`), 'sends a request outside ctx (fetch, XMLHttpRequest, WebSocket)', 'code'],
  [/\bnewContext\s*\(/, 'creates its own request context outside ctx', 'code'],
  [/['"`](?:node:)?(?:child_process|fs|fs\/promises|net|http|https|http2|dgram|dns|tls|vm|worker_threads|cluster|inspector)['"`]/, 'names a Node built-in module (child_process, fs, net, http, ...)', 'raw'],
  [/['"`]node:/, 'names a node: module', 'raw'],
  [/\bchild_process\b|\bexecSync\b|\bspawnSync\b|\bexecFile(?:Sync)?\b/, 'mentions child_process or a process-spawning function', 'code'],
];

// Every static import, export-from and side-effect import must name the framework's ctx file.
function importSpecifiers(code: string): string[] {
  const specs: string[] = [];
  for (const m of code.matchAll(/^\s*(?:import|export)\b[^'"`;]*?\bfrom\s*['"`]([^'"`]+)['"`]/gm)) specs.push(m[1]);
  for (const m of code.matchAll(/^\s*import\s*['"`]([^'"`]+)['"`]/gm)) specs.push(m[1]);
  return specs;
}

// The code with the contents of '...' and "..." strings and of comments blanked (template literals are
// kept: their \${...} parts are code).
function codeOnly(code: string): string {
  return code
    .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g, "''")
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

export function unsafeCodeReasons(code: string, allowedImport: RegExp): string[] {
  const reasons: string[] = [];
  const stripped = codeOnly(code);
  for (const spec of importSpecifiers(code)) {
    if (!allowedImport.test(spec)) reasons.push(`imports "${spec}"; a generated spec may only import the ctx file`);
  }
  for (const [re, why, on] of UNSAFE_CODE) if (re.test(on === 'raw' ? code : stripped)) reasons.push(`unsafe code: ${why}`);
  return reasons;
}

// The Playwright gate.
export function validateSpec(code: string, opts: ValidateOptions): ValidationResult {
  return validateWithRules(code, opts, PLAYWRIGHT_RULES);
}

// The shared gate: framework rules first, then every rule that is the same for all frameworks.
// Each reason is attributed to the test it is about when it can be: rules about one test run on that
// test's own code, the rest on the code outside the tests (imports, helpers) and count for the file.
export function validateWithRules(code: string, opts: ValidateOptions, rules: GateRules): ValidationResult {
  const fileReasons: string[] = [];
  const byTest: Record<string, string[]> = {};
  const addFor = (title: string, why: string) => (byTest[title] ??= []).push(why);

  fileReasons.push(...rules.frameworkRules(code));
  const tests = testRanges(code, rules.testFn);
  const outside = blankRanges(code, tests);
  // Code outside the tests: imports, helpers, top-level statements.
  fileReasons.push(...codeRules(outside, rules.allowedImport, true));

  const helpers = [...annotationHelpers(code), ...(rules.statusRecorders ?? [])];
  const testsPerType = new Map<string, number>();
  const required = opts.requiredTitles ? new Set(opts.requiredTitles) : null;
  for (const t of tests) {
    const body = code.slice(t.start, t.end);
    const own: string[] = [];
    // "[happy] ..." or, from a test case sheet, "[TC-001] [happy] ..." / "[agent] [happy] ...".
    const type = TYPES.find((ty) => testTypeOf(t.title) === ty);
    if (!type) own.push(`test title does not start with a type tag: "${t.title}"`);
    if (type) {
      testsPerType.set(type, (testsPerType.get(type) ?? 0) + 1);
      checkTypeRules(type, t.title, body, code, opts.probeStatus, own, opts.probeHasBody ?? true, opts.requiredFields ?? [], opts.probeContentType ?? null);
    }
    const wantType = opts.contentTypes?.[t.title.replace(/\\(.)/g, '$1')];
    if (wantType) checkContentType(t.title, body, wantType, own);
    const annotationAt = Math.min(
      ...[body.indexOf('actual-status'), ...helpers.map((h) => body.search(new RegExp(`\\b${h}\\s*\\(`)))].filter((n) => n >= 0),
    );
    const firstExpect = body.search(/\bexpect\s*\(/);
    if (!Number.isFinite(annotationAt)) own.push(`test does not record the actual-status annotation: "${t.title}"`);
    else if (firstExpect >= 0 && annotationAt > firstExpect) {
      own.push(`test records actual-status after its first assertion: "${t.title}"`);
    }
    for (const why of codeRules(body, rules.allowedImport, false)) own.push(`test "${t.title}": ${why}`);
    if (required && !required.has(t.title.replace(/\\(.)/g, '$1'))) {
      own.push(`test "${t.title}" is not one of the plan's cases; write exactly one test per plan case and no others`);
    }
    for (const why of own) addFor(t.title, why);
  }

  if (!required) {
    if (tests.length < opts.planTypes.length) {
      fileReasons.push(`has ${tests.length} tests but the plan has ${opts.planTypes.length} cases`);
    }
    // Each plan case type needs its own tests: four [happy] tests do not replace an [auth] test.
    for (const type of TYPES) {
      const planned = opts.planTypes.filter((t) => t === type).length;
      const written = testsPerType.get(type) ?? 0;
      if (written < planned) fileReasons.push(`the plan has ${planned} [${type}] case(s) but the file has ${written} [${type}] test(s)`);
    }
  } else {
    for (const title of opts.requiredTitles ?? []) {
      const n = tests.filter((t) => t.title.replace(/\\(.)/g, '$1') === title).length;
      if (n === 0) addFor(title, `has no test titled exactly "${title}" (copy the plan's title, case ID included)`);
      else if (n > 1) addFor(title, `has ${n} tests titled "${title}"; each plan case is one test`);
    }
  }

  const tsErrors = typecheck(code, opts.name);
  if (tsErrors) {
    // TypeScript errors are pinned to the test whose lines they are on; the rest count for the file.
    const lineStarts = tests.map((t) => ({ title: t.title, from: lineOf(code, t.start), to: lineOf(code, t.end) }));
    const loose: string[] = [];
    for (const line of tsErrors.split('\n')) {
      const m = line.match(/\.spec\.ts\((\d+),\d+\)/);
      const hit = m ? lineStarts.find((r) => Number(m[1]) >= r.from && Number(m[1]) <= r.to) : undefined;
      if (hit) addFor(hit.title, `fails TypeScript typecheck: ${line.replace(/^.*?\.spec\.ts/, '').trim()}`);
      else if (line.trim()) loose.push(line);
    }
    if (loose.length) fileReasons.push(`fails TypeScript typecheck:\n${loose.join('\n')}`);
  }

  const reasons = [...fileReasons, ...Object.values(byTest).flat()];
  return { ok: reasons.length === 0, reasons, byTest, fileReasons };
}

type TestRange = { title: string; start: number; end: number };

// Every test call with the source range of the whole call: test('<title>', async ({ ctx }) => { ... });
export function testRanges(code: string, testFn = 'test'): TestRange[] {
  const tests = findTests(code, testFn);
  return tests.map((t, i) => {
    const open = code.indexOf('(', t.start);
    const close = matchingParen(code, open);
    const next = i + 1 < tests.length ? tests[i + 1].start : code.length;
    let end = Math.min(close + 1, next);
    if (code[end] === ';') end++;
    return { title: t.title, start: t.start, end };
  });
}

function blankRanges(code: string, ranges: { start: number; end: number }[]): string {
  let out = code;
  for (const r of ranges) out = out.slice(0, r.start) + out.slice(r.start, r.end).replace(/[^\n]/g, ' ') + out.slice(r.end);
  return out;
}

function lineOf(code: string, index: number): number {
  return code.slice(0, index).split('\n').length;
}

// The code rules that apply wherever the code is (a test or the rest of the file).
function codeRules(part: string, allowedImport: RegExp, withImports: boolean): string[] {
  const reasons: string[] = [];
  if (/process\.env/.test(part)) reasons.push('contains process.env');
  const unsafe = unsafeCodeReasons(part, allowedImport);
  reasons.push(...(withImports ? unsafe : unsafe.filter((r) => !r.startsWith('imports '))));
  if (/https?:\/\//.test(part)) reasons.push('contains http:// or https://');
  checkCatches(part, reasons);
  checkStatusExpectations(part, reasons);
  return reasons;
}

// Removes these tests from the file (the whole call, with its line).
export function removeTests(code: string, titles: string[], testFn = 'test'): string {
  const drop = new Set(titles);
  const ranges = testRanges(code, testFn).filter((t) => drop.has(t.title) || drop.has(t.title.replace(/\\(.)/g, '$1')));
  let out = code;
  for (const r of [...ranges].reverse()) {
    const lineStart = out.lastIndexOf('\n', r.start - 1) + 1;
    const before = out.slice(lineStart, r.start);
    const from = /^\s*$/.test(before) ? lineStart : r.start;
    let to = r.end;
    while (to < out.length && (out[to] === ' ' || out[to] === '\t')) to++;
    if (out[to] === '\n') to++;
    out = out.slice(0, from) + out.slice(to);
  }
  return out.replace(/\n{3,}/g, '\n\n');
}
