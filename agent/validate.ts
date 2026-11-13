import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Static gate for a generated spec. No Claude call. Returns every reason, not just the first.

const TYPES = ['happy', 'schema', 'invalid-input', 'auth', 'authz'] as const;
type CaseType = (typeof TYPES)[number];
const TAGS = TYPES.map((t) => `[${t}]`);
// Generated specs live in generated/, one level below the root. tsc resolves imports relative
// to the file, so the candidate is typechecked from a sibling folder at the same depth.
const TSCHECK_DIR = '.tscheck';

export type ValidationResult = { ok: boolean; reasons: string[] };

export type ValidateOptions = {
  name: string;
  // The plan's case types, one entry per case. The file needs at least this many tests of each type.
  planTypes: string[];
  // The probe status. happy and schema tests must assert exactly this status.
  probeStatus: number | null;
};

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
function checkTypeRules(type: CaseType, title: string, body: string, code: string, probeStatus: number | null, reasons: string[]) {
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
  }

  if (type === 'invalid-input') {
    for (const { call, a } of found) {
      const ok = (a.kind === 'min' && a.code === 400) || (a.kind === 'max' && a.code === 499);
      if (!ok) bad(call, 'status assertion must be toBeGreaterThanOrEqual(400) or toBeLessThanOrEqual(499)');
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
    const res = spawnSync('node_modules/.bin/tsc', ['-p', join(TSCHECK_DIR, 'tsconfig.json')], { encoding: 'utf8' });
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
};

const PLAYWRIGHT_RULES: GateRules = {
  testFn: 'test',
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
    return reasons;
  },
};

// The Playwright gate.
export function validateSpec(code: string, opts: ValidateOptions): ValidationResult {
  return validateWithRules(code, opts, PLAYWRIGHT_RULES);
}

// The shared gate: framework rules first, then every rule that is the same for all frameworks.
export function validateWithRules(code: string, opts: ValidateOptions, rules: GateRules): ValidationResult {
  const reasons: string[] = [];

  reasons.push(...rules.frameworkRules(code));
  if (/process\.env/.test(code)) reasons.push('contains process.env');
  if (/https?:\/\//.test(code)) reasons.push('contains http:// or https://');
  checkCatches(code, reasons);

  const tests = findTests(code, rules.testFn);
  const helpers = [...annotationHelpers(code), ...(rules.statusRecorders ?? [])];
  const testsPerType = new Map<string, number>();
  tests.forEach((t, i) => {
    const type = TYPES.find((ty) => t.title.startsWith(`[${ty}]`));
    if (!type) reasons.push(`test title does not start with a type tag: "${t.title}"`);
    const body = code.slice(t.start, i + 1 < tests.length ? tests[i + 1].start : code.length);
    if (type) {
      testsPerType.set(type, (testsPerType.get(type) ?? 0) + 1);
      checkTypeRules(type, t.title, body, code, opts.probeStatus, reasons);
    }
    const annotationAt = Math.min(
      ...[body.indexOf('actual-status'), ...helpers.map((h) => body.search(new RegExp(`\\b${h}\\s*\\(`)))].filter((n) => n >= 0),
    );
    const firstExpect = body.search(/\bexpect\s*\(/);
    if (!Number.isFinite(annotationAt)) reasons.push(`test does not record the actual-status annotation: "${t.title}"`);
    else if (firstExpect >= 0 && annotationAt > firstExpect) {
      reasons.push(`test records actual-status after its first assertion: "${t.title}"`);
    }
  });
  checkStatusExpectations(code, reasons);
  if (tests.length < opts.planTypes.length) {
    reasons.push(`has ${tests.length} tests but the plan has ${opts.planTypes.length} cases`);
  }
  // Each plan case type needs its own tests: four [happy] tests do not replace an [auth] test.
  for (const type of TYPES) {
    const planned = opts.planTypes.filter((t) => t === type).length;
    const written = testsPerType.get(type) ?? 0;
    if (written < planned) reasons.push(`the plan has ${planned} [${type}] case(s) but the file has ${written} [${type}] test(s)`);
  }

  const tsErrors = typecheck(code, opts.name);
  if (tsErrors) reasons.push(`fails TypeScript typecheck:\n${tsErrors}`);

  return { ok: reasons.length === 0, reasons };
}
