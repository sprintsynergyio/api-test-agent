import { existsSync, readFileSync } from 'node:fs';

// The per-environment test data file (README "Test data per environment"). One file per environment,
// named in the input ("testData": "test-data.dev.json", relative to the input), with --test-data, or
// with TEST_DATA_FILE for the test run:
//
//   {
//     "environment": "dev",
//     "values": { "OTHER_BRAND": "savage" },
//     "lookup": { "endpointId": "list-badges", "query": { "page_size": 100 } }
//   }
//
// values fill [NAME] placeholders in the sheet's steps, test data and expected result before planning.
// A case with a placeholder that has no value is skipped with MISSING_TEST_DATA (never run, never
// passed). lookup is the GET endpoint whose response lists the named data ("Required data" column, e.g.
// file names); before such a test runs, ctx checks the names are in that response and skips the test
// with DATA_NOT_ON_ENV when one is missing, or ENV_UNAVAILABLE when the lookup itself fails.
//
// No imports beyond node:fs: the exported frameworks copy this file as src/test-data.ts.

export type TestData = {
  environment?: string;
  values: Record<string, string>;
  lookup?: { endpointId: string; query?: Record<string, string | number | boolean> };
};

// The reason codes a test that does not run (or a known issue) carries, in the traceability file, the
// summary and the reports. Never counted as passed.
export const REASON_CODES = ['MISSING_TEST_DATA', 'DATA_NOT_ON_ENV', 'ENV_UNAVAILABLE', 'MANUAL', 'MANUAL_VISUAL', 'SPEC_UNCLEAR', 'KNOWN_ISSUE'] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

// Codes set while the tests run (the precondition check); the rest are decided before generation.
export const RUNTIME_CODES: ReasonCode[] = ['DATA_NOT_ON_ENV', 'ENV_UNAVAILABLE'];

export function parseTestData(raw: unknown, where = 'test data file'): TestData {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${where}: must be a JSON object with "values" and/or "lookup"`);
  const o = raw as Record<string, unknown>;
  const known = new Set(['environment', 'values', 'lookup', '$comment']);
  const extra = Object.keys(o).filter((k) => !known.has(k));
  if (extra.length) throw new Error(`${where}: unknown key(s) ${extra.join(', ')} (allowed: environment, values, lookup)`);
  if (o.environment !== undefined && typeof o.environment !== 'string') throw new Error(`${where}: "environment" must be a string`);
  const values: Record<string, string> = {};
  if (o.values !== undefined) {
    if (!o.values || typeof o.values !== 'object' || Array.isArray(o.values)) throw new Error(`${where}: "values" must be an object of NAME: value`);
    for (const [k, v] of Object.entries(o.values as Record<string, unknown>)) {
      if (!/^[A-Z][A-Z0-9_]{2,}$/.test(k)) throw new Error(`${where}: value name "${k}" must be UPPER_CASE (letters, digits, _; at least 3 characters), as in [${k.toUpperCase()}] in the sheet`);
      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') throw new Error(`${where}: value ${k} must be a string, number or boolean`);
      values[k] = String(v);
    }
  }
  let lookup: TestData['lookup'];
  if (o.lookup !== undefined) {
    const l = o.lookup as Record<string, unknown>;
    if (!l || typeof l !== 'object' || typeof l.endpointId !== 'string' || !l.endpointId) throw new Error(`${where}: "lookup" needs "endpointId" (a GET endpoint of the input)`);
    if (l.query !== undefined && (!l.query || typeof l.query !== 'object' || Array.isArray(l.query))) throw new Error(`${where}: "lookup.query" must be an object`);
    lookup = { endpointId: l.endpointId, ...(l.query ? { query: l.query as Record<string, string | number | boolean> } : {}) };
  }
  return { ...(typeof o.environment === 'string' ? { environment: o.environment } : {}), values, ...(lookup ? { lookup } : {}) };
}

export function loadTestData(file: string): TestData {
  if (!existsSync(file)) throw new Error(`test data file not found: ${file}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`test data file ${file} is not valid JSON: ${(err as Error).message}`);
  }
  return parseTestData(raw, file);
}

// [OTHER_BRAND], [BADGE_UUID]: upper case, at least 3 characters, so [] [0] [id] [OK] are left alone.
const PLACEHOLDER = /\[([A-Z][A-Z0-9_]{2,})\]/g;

export function placeholdersIn(text: string | undefined): string[] {
  return [...new Set([...String(text ?? '').matchAll(PLACEHOLDER)].map((m) => m[1]))];
}

// Fills the placeholders that have a value; returns the names that have none.
export function fillPlaceholders(text: string, values: Record<string, string>): { text: string; missing: string[] } {
  const missing = new Set<string>();
  const out = text.replace(PLACEHOLDER, (whole, name: string) => {
    if (Object.prototype.hasOwnProperty.call(values, name)) return values[name];
    missing.add(name);
    return whole;
  });
  return { text: out, missing: [...missing] };
}

// "Test_A.png; kk-coming-soon.png" or one per line: the names a test needs on the environment.
export function requiredDataNames(cell: string | undefined): string[] {
  return [...new Set(String(cell ?? '').split(/[;\n,|]+/).map((s) => s.trim()).filter(Boolean))];
}

// The skip reason for a test whose required data is not on the environment, or null when all of it is
// there. response: the lookup's answer (status and body text), or the error when the request failed.
export function requiredDataVerdict(names: string[], lookupId: string, environment: string | undefined, response: { status: number | null; text: string; error?: string }): string | null {
  const env = environment ? ` (${environment})` : '';
  if (response.status === null) return `ENV_UNAVAILABLE: the data lookup ${lookupId} failed${env}: ${response.error ?? 'no response'}`;
  if (response.status === 401 || response.status === 403 || response.status === 429 || response.status >= 500) {
    return `ENV_UNAVAILABLE: the data lookup ${lookupId} answered ${response.status}${env}, so the required data could not be checked`;
  }
  if (response.status >= 400) return `ENV_UNAVAILABLE: the data lookup ${lookupId} answered ${response.status}${env}; check "lookup" in the test data file`;
  const missing = names.filter((n) => !response.text.includes(n));
  if (!missing.length) return null;
  return `DATA_NOT_ON_ENV: not on this environment${env} (looked up with ${lookupId}): ${missing.join(', ')}`;
}

// The code at the start of a skip or known-issue description ("DATA_NOT_ON_ENV: ..."), or null.
export function reasonCodeOf(text: string | undefined): ReasonCode | null {
  const m = /^\s*([A-Z_]+)\b/.exec(String(text ?? ''));
  return m && (REASON_CODES as readonly string[]).includes(m[1]) ? (m[1] as ReasonCode) : null;
}

// A Jira key in a Known issue cell ("QA-123", "QA-123: 500 for an unknown brand", a browse link).
export function jiraKeyIn(text: string | undefined): string | null {
  const m = /\b([A-Z][A-Z0-9]+-\d+)\b/.exec(String(text ?? ''));
  return m ? m[1] : null;
}
