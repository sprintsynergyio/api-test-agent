// Reading a test case sheet's "Expected Result" text: which status codes it expects, which ones it rules
// out ("not 500", "never 5xx", "must not be 502"), and the separate checks (clauses) it lists, so each
// clause can be mapped to an assertion (agent/plan.ts coverage, agent/traceability.ts "partially covered").
// Pure functions, no imports.

export type ExpectedStatus = {
  // Codes the case accepts: "400 or 404" gives [400, 404].
  expects: number[];
  // Codes the case rules out: "not 500 or 502" gives [500, 502].
  forbids: number[];
  // Ranges the case accepts or rules out: "a 4xx error" gives expectsRanges ["4xx"]; "never 5xx" forbidsRanges ["5xx"].
  expectsRanges: string[];
  forbidsRanges: string[];
};

// HTTP reason phrases that contain a negation word but negate nothing: "404 Not Found", "204 No Content".
const REASON_PHRASES = /\b(?:method\s+not\s+allowed|not\s+found|no\s+content|not\s+modified|not\s+acceptable|not\s+implemented|not\s+allowed|not\s+extended)\b/gi;
// Words that rule out what follows them in the same clause.
const NEGATION = /\b(?:not|never|no|without|isn'?t|aren'?t|wasn'?t|mustn'?t|shouldn'?t|cannot|can'?t|doesn'?t|don'?t|won'?t|instead\s+of|rather\s+than|other\s+than|except|excluding)\b/i;
const CODE = /(?<![\d.])([1-5]\d\d)(?![\d.])/g;
const RANGE = /(?<![\d.])([1-5])xx\b/gi;

function codesIn(text: string): number[] {
  return [...text.matchAll(CODE)].map((m) => Number(m[1]));
}
function rangesIn(text: string): string[] {
  return [...text.matchAll(RANGE)].map((m) => `${m[1]}xx`);
}

// "Response is 400 or 404 JSON error, not 500 or 502" -> expects [400, 404], forbids [500, 502].
// A negation word rules out every code after it up to the end of its clause (a comma, semicolon,
// period, line break, bracket or "but"); codes before it in the same clause are still expected.
export function parseExpectedStatus(text: string): ExpectedStatus {
  const out: ExpectedStatus = { expects: [], forbids: [], expectsRanges: [], forbidsRanges: [] };
  const cleaned = String(text ?? '').replace(REASON_PHRASES, (m) => m.replace(/\s+/g, '_'));
  for (const clause of cleaned.split(/[,;.\n()[\]]|\bbut\b|\bhowever\b/i)) {
    const neg = clause.search(NEGATION);
    const before = neg < 0 ? clause : clause.slice(0, neg);
    const after = neg < 0 ? '' : clause.slice(neg);
    out.expects.push(...codesIn(before));
    out.expectsRanges.push(...rangesIn(before));
    out.forbids.push(...codesIn(after));
    out.forbidsRanges.push(...rangesIn(after));
  }
  const uniq = <T>(a: T[]) => [...new Set(a)];
  out.forbids = uniq(out.forbids);
  out.forbidsRanges = uniq(out.forbidsRanges);
  // A code both expected and ruled out ("200, not 200") is ruled out.
  out.expects = uniq(out.expects).filter((c) => !out.forbids.includes(c));
  out.expectsRanges = uniq(out.expectsRanges).filter((r) => !out.forbidsRanges.includes(r));
  return out;
}

// One short sentence for the plan and the prompt: "400 or 404 (never 500 or 502)".
export function describeExpectedStatus(s: ExpectedStatus): string {
  const yes = [...s.expects.map(String), ...s.expectsRanges].join(' or ');
  const no = [...s.forbids.map(String), ...s.forbidsRanges].join(' or ');
  if (!yes && !no) return '';
  if (!no) return yes;
  return yes ? `${yes} (never ${no})` : `anything but ${no}`;
}

const MAX_CLAUSES = 12;

// The separate checks an expected result lists: lines, list items, semicolons and sentences.
// "200 with an array; each item has id and name" -> ["200 with an array", "each item has id and name"].
export function splitClauses(text: string): string[] {
  const parts = String(text ?? '')
    .replace(/\r/g, '')
    .split(/\n|;/)
    .map((line) => line.replace(/^\s*(?:[-*\u2022]|\(?\d{1,2}[.)]|[a-z][.)])\s+/i, ''))
    .flatMap((line) => line.split(/(?<=[a-z0-9)"'`][.!?])\s+(?=[A-Z"'`(])/))
    .map((p) => p.trim().replace(/[.\s]+$/, ''))
    .filter((p) => p.length > 0);
  return parts.slice(0, MAX_CLAUSES).map((p) => (p.length > 200 ? `${p.slice(0, 197)}...` : p));
}

// ---------- Expected response format ----------

const MEDIA_TYPE = /\b((?:application|text|image|audio|video|multipart|font)\/[a-z0-9][a-z0-9.+-]*)/i;
// Words that rule out a format named after them in the same clause: "not JSON", "non-JSON", "no HTML".
const FORMAT_NEGATION = /\b(?:not|never|no|non|without|instead\s+of|rather\s+than|other\s+than)\b[\s-]*$/i;

// The response format a sheet case's expected result asks for, as a media type, or null when it names
// none: "Content-Type application/json" and "a JSON error" give application/json, "plain text" gives
// text/plain, "Content-Type is image/png" gives image/png. A format that is ruled out ("not JSON") is
// ignored. The test then asserts the Content-Type header, and a test for a format that is not JSON
// never parses the body as JSON (agent/validate.ts).
export function expectedContentType(text: string): string | null {
  for (const clause of String(text ?? '').split(/[,;\n]|\bbut\b/i)) {
    const media = MEDIA_TYPE.exec(clause);
    if (media && !FORMAT_NEGATION.test(clause.slice(0, media.index))) return media[1].toLowerCase().replace(/[.+-]+$/, '');
    const plain = /\bplain[\s-]+text\b|\btext\/plain\b/i.exec(clause);
    if (plain && !FORMAT_NEGATION.test(clause.slice(0, plain.index))) return 'text/plain';
    const json = /\bjson\b/i.exec(clause);
    if (json && !FORMAT_NEGATION.test(clause.slice(0, json.index)) && !/\b(?:send|sends|sent|with|post|put|patch)\b[^.]*$/i.test(clause.slice(0, json.index))) return 'application/json';
  }
  return null;
}

// What a Content-Type assertion must contain for a media type: "json" for any JSON type
// (application/json, application/problem+json), else the media type itself.
export function contentTypeNeedle(mediaType: string): string {
  return /(?:^|[/+])json$/i.test(mediaType) ? 'json' : mediaType.toLowerCase();
}

export function isJsonMediaType(mediaType: string): boolean {
  return /(?:^|[/+])json$/i.test(mediaType);
}
