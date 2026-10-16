import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Static gate for a generated spec. No Claude call. Returns every reason, not just the first.

const TAGS = ['[happy]', '[schema]', '[invalid-input]', '[auth]'];
// Generated specs live in generated/, one level below the root. tsc resolves imports relative
// to the file, so the candidate is typechecked from a sibling folder at the same depth.
const TSCHECK_DIR = '.tscheck';

export type ValidationResult = { ok: boolean; reasons: string[] };

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

function findTests(code: string): TestCall[] {
  const tests: TestCall[] = [];
  for (const m of code.matchAll(/\btest(?:\.only|\.skip)?\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
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

export function validateSpec(code: string, opts: { planCaseCount: number; name: string }): ValidationResult {
  const reasons: string[] = [];

  const imp = code.match(/import\s*\{([^}]*)\}\s*from\s*['"](?:\.\.?\/)+(?:tests\/)?fixtures\/ctx(?:\.ts)?['"]/);
  const imported = imp ? imp[1].split(',').map((s) => s.trim()) : [];
  if (!imported.includes('test') || !imported.includes('expect')) {
    reasons.push('does not import test and expect from the ctx fixture file');
  }
  if (/@playwright\/test/.test(code)) reasons.push('imports from @playwright/test directly instead of the ctx fixture');
  if (/process\.env/.test(code)) reasons.push('contains process.env');
  if (/https?:\/\//.test(code)) reasons.push('contains http:// or https://');
  if (/\btest(?:\.describe)?\.only\b/.test(code)) reasons.push('contains test.only');
  if (/\btest(?:\.describe)?\.skip\b/.test(code)) reasons.push('contains test.skip');
  checkCatches(code, reasons);

  const tests = findTests(code);
  const helpers = annotationHelpers(code);
  tests.forEach((t, i) => {
    if (!TAGS.some((tag) => t.title.startsWith(tag))) reasons.push(`test title does not start with a type tag: "${t.title}"`);
    const body = code.slice(t.start, i + 1 < tests.length ? tests[i + 1].start : code.length);
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
  if (tests.length < opts.planCaseCount) {
    reasons.push(`has ${tests.length} tests but the plan has ${opts.planCaseCount} cases`);
  }

  const tsErrors = typecheck(code, opts.name);
  if (tsErrors) reasons.push(`fails TypeScript typecheck:\n${tsErrors}`);

  return { ok: reasons.length === 0, reasons };
}
