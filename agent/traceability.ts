import { deflateRawSync } from 'node:zlib';
import { splitClauses } from './expected';
import { crc32 } from './zip';

// The back-map from the team's sheet to the run: one row per sheet case with the test that automates it
// and what happened, then one row per agent suggestion. Written as CSV (out/traceability.csv) and XLSX
// (out/traceability.xlsx), listed in summary.testCases and copied into the exported framework.

// "partially covered": the test passed but some clauses of the case's expected result have no assertion
// (listed in the reason). It is never counted as passed.
// Cases that do not pass and do not fail, each with a reason code (Reason code column):
//   "skipped"         decided before the run: the test data has no value for a [NAME] placeholder (MISSING_TEST_DATA)
//   "manual"          the sheet marks it manual, or only a person can check it (MANUAL, MANUAL_VISUAL)
//   "blocked"         skipped while running: required data is not on this environment (DATA_NOT_ON_ENV)
//                     or could not be looked up (ENV_UNAVAILABLE)
//   "known issue"     a Known issue (Jira key) from the sheet whose test failed as expected (KNOWN_ISSUE)
//   "unexpected pass" a known issue whose test passed: the bug may be fixed; check it (KNOWN_ISSUE)
// None of them is ever counted as passed. needs review carries SPEC_UNCLEAR when the AI gave that code.
export type TraceStatus = 'passed' | 'partially covered' | 'failed' | 'needs review' | 'not automated' | 'skipped' | 'manual' | 'blocked' | 'known issue' | 'unexpected pass' | 'accepted 5xx';
// testFile is blank when no runnable test automates the row (needs review, dropped by the gate, not
// automated). coverage: how many clauses of the case's expected result a test assertion checks
// ("3/5 (60%)"; blank when the case has no test or no expected result). reason is never shortened.
// jira and confluence are copied from the sheet (or the Jira / Confluence / Zephyr Scale import).
export type TraceRow = {
  id: string;
  title: string;
  endpoint: string;
  testFile: string;
  status: TraceStatus;
  reasonCode?: string;
  reason: string;
  source: 'sheet' | 'agent';
  coverage?: string;
  asserted?: number;
  clauses?: number;
  jira?: string;
  confluence?: string;
};

export const TRACE_COLUMNS = ['ID', 'Title', 'Endpoint', 'Test file', 'Status', 'Reason code', 'Coverage', 'Reason', 'Jira', 'Confluence'] as const;

function cells(r: TraceRow): string[] {
  return [r.id, r.title, r.endpoint, r.testFile, r.status, r.reasonCode ?? '', r.coverage ?? '', r.reason, r.jira ?? '', r.confluence ?? ''];
}

// A cell that starts with = + - @ (or a tab or carriage return) is a formula to Excel and Google Sheets:
// prefixed with ' so opening the file can never run anything.
export function csvSafe(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

export function traceCsv(rows: TraceRow[]): string {
  const q = (v: string) => {
    const s = csvSafe(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [TRACE_COLUMNS.join(','), ...rows.map((r) => cells(r).map(q).join(','))].join('\r\n') + '\r\n';
}

function xmlEscape(s: string): string {
  // Characters XML 1.0 does not allow are dropped.
  return s
    .replace(/[^\x09\x0A\x0D\x20-\uD7FF\uE000-\uFFFD]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function colName(i: number): string {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// A minimal, valid .xlsx (one sheet, inline strings, bold header, filter, frozen header row). Text cells
// only, so nothing in it is a formula.
export function traceXlsx(rows: TraceRow[], sheetName = 'Traceability'): Buffer {
  const all = [[...TRACE_COLUMNS], ...rows.map(cells)];
  const widths = [14, 50, 22, 32, 18, 20, 14, 90, 28, 28];
  const sheetRows = all
    .map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => `<c r="${colName(ci)}${ri + 1}" t="inlineStr"${ri === 0 ? ' s="1"' : ''}><is><t xml:space="preserve">${xmlEscape(String(v))}</t></is></c>`).join('')}</row>`)
    .join('');
  const lastRef = `${colName(TRACE_COLUMNS.length - 1)}${all.length}`;
  const files: [string, string][] = [
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEscape(sheetName.slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${xmlEscape(sheetName.slice(0, 31))}'!$A$1:$${colName(TRACE_COLUMNS.length - 1)}$${all.length}</definedName></definedNames></workbook>`],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
    ['xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>'],
    ['xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${lastRef}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols><sheetData>${sheetRows}</sheetData><autoFilter ref="A1:${lastRef}"/></worksheet>`],
  ];
  return zipEntries(files.map(([name, text]) => [name, Buffer.from(text, 'utf8')]));
}

// In-memory zip of a few files (deflate), same format as agent/zip.ts.
function zipEntries(entries: [string, Buffer][], now = new Date()): Buffer {
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [n, raw] of entries) {
    const name = Buffer.from(n, 'utf8');
    const data = deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const size = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

// assertionCoverage: of all the clauses in the sheet's expected results, how many a test assertion
// checks. A case with no test counts its clauses as not checked, so the percentage is "how much of the
// sheet the tests prove", not "how good the tests we wrote are". percent is null with no clauses.
export type AssertionCoverage = { asserted: number; clauses: number; percent: number | null };
export type TraceTotals = {
  rows: number;
  automated: number;
  passed: number;
  partiallyCovered: number;
  failed: number;
  needsReview: number;
  notAutomated: number;
  skipped: number;
  manual: number;
  blocked: number;
  knownIssues: number;
  unexpectedPasses: number;
  accepted5xx: number;
  agentSuggestions: number;
  assertionCoverage: AssertionCoverage;
};

export function percentOf(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
}

export function traceTotals(rows: TraceRow[]): TraceTotals {
  const sheet = rows.filter((r) => r.source === 'sheet');
  const asserted = sheet.reduce((n, r) => n + (r.asserted ?? 0), 0);
  const clauses = sheet.reduce((n, r) => n + (r.clauses ?? 0), 0);
  return {
    rows: sheet.length,
    automated: sheet.filter((r) => ['passed', 'partially covered', 'failed', 'blocked', 'known issue', 'unexpected pass', 'accepted 5xx'].includes(r.status)).length,
    passed: sheet.filter((r) => r.status === 'passed').length,
    partiallyCovered: sheet.filter((r) => r.status === 'partially covered').length,
    failed: sheet.filter((r) => r.status === 'failed').length,
    needsReview: sheet.filter((r) => r.status === 'needs review').length,
    notAutomated: sheet.filter((r) => r.status === 'not automated').length,
    skipped: sheet.filter((r) => r.status === 'skipped').length,
    manual: sheet.filter((r) => r.status === 'manual').length,
    blocked: sheet.filter((r) => r.status === 'blocked').length,
    knownIssues: sheet.filter((r) => r.status === 'known issue').length,
    unexpectedPasses: sheet.filter((r) => r.status === 'unexpected pass').length,
    accepted5xx: sheet.filter((r) => r.status === 'accepted 5xx').length,
    agentSuggestions: rows.filter((r) => r.source === 'agent').length,
    assertionCoverage: { asserted, clauses, percent: percentOf(asserted, clauses) },
  };
}

// ---------- Building the rows ----------

export type ClauseLike = { n: number; text: string; status: 'asserted' | 'not-asserted' | 'probe-disagrees'; reason?: string; expected?: string; actual?: string };
type PlanCaseLike = { title: string; caseId?: string; source?: 'sheet' | 'agent'; expectedStatus: string; statusCodes?: number[]; clauses?: ClauseLike[]; accepted5xx?: boolean; probeNote?: string };
type PlanLike = { cases: PlanCaseLike[]; needsReview?: { caseId: string; reason: string; code?: string }[]; notAutomated?: { caseId?: string; title: string; reason: string }[] };
// caseReasons: when the whole spec was rejected, the gate's reasons for each planned test by title.
export type TraceEndpoint = { endpointId: string; specFile: string | null; plan?: PlanLike; failureReason: string | null; skippedReason: string | null; caseReasons?: Record<string, string[]> };

// What a passing test does not prove: the clauses of the expected result without an assertion, and
// the ones the probe response contradicted.
export function coverageGaps(pc: { clauses?: ClauseLike[] }): { missing: ClauseLike[]; disagrees: ClauseLike[] } {
  const clauses = pc.clauses ?? [];
  return { missing: clauses.filter((c) => c.status === 'not-asserted'), disagrees: clauses.filter((c) => c.status === 'probe-disagrees') };
}

// One line, whitespace collapsed, never shortened: the traceability files keep every word of a reason.
function flat(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function missingText(missing: ClauseLike[]): string {
  return missing.map((c) => `clause ${c.n} "${flat(c.text)}"${c.reason ? ` (${flat(c.reason)})` : ''}`).join('; ');
}

export function disagreeText(disagrees: ClauseLike[]): string {
  return disagrees.map((c) => `clause ${c.n} "${flat(c.text)}": expected ${flat(c.expected ?? c.text)}, actual ${flat(c.actual ?? 'different')}`).join('; ');
}

// The coverage status of a test that passed: needs review when the probe disagreed with the sheet,
// partially covered when a clause has no assertion, else passed.
export function passedStatus(pc: { clauses?: ClauseLike[] }): { status: TraceStatus; reason: string } {
  const { missing, disagrees } = coverageGaps(pc);
  if (disagrees.length) return { status: 'needs review', reason: `the API response disagrees with the sheet: ${disagreeText(disagrees)}${missing.length ? `; not asserted: ${missingText(missing)}` : ''}` };
  if (missing.length) return { status: 'partially covered', reason: `passed, but not every expected-result clause is asserted; not asserted: ${missingText(missing)}` };
  return { status: 'passed', reason: '' };
}

// How many clauses of a case's expected result its test asserts. With the plan's clause list when the
// case has a test; else every clause of the sheet's expected result counts as not asserted.
export function caseCoverage(expected: string | undefined, pc?: { clauses?: ClauseLike[] }, hasTest = false): { asserted: number; clauses: number; coverage: string } {
  const total = pc?.clauses?.length ?? splitClauses(expected ?? '').length;
  if (!total) return { asserted: 0, clauses: 0, coverage: '' };
  const asserted = hasTest ? (pc?.clauses ?? []).filter((c) => c.status === 'asserted').length : 0;
  return { asserted, clauses: total, coverage: hasTest ? `${asserted}/${total} (${percentOf(asserted, total)}%)` : '' };
}

export type TraceCase = { id: string; title: string; expected?: string; jira?: string; confluence?: string; documented5xx?: string };
export type TraceMatch = { endpointId: string | null; by: string | null; reason: string };
export type TraceOutcome = { endpointId: string; title: string; passed: boolean; actualStatus: number | null; error: string; kind?: 'passed' | 'failed' | 'blocked' | 'known-issue' | 'unexpected-pass'; reasonCode?: string; reason?: string };
export type TraceFinding = { endpointId: string; testTitle: string; classification: string; expectedStatus: string | null; actualStatus: number | null };

function failReason(o: TraceOutcome, f: TraceFinding | undefined, expected: string): string {
  const got = o.actualStatus ?? 'no status';
  const head = f?.classification === 'suspected API finding' ? `suspected API finding: expected ${expected}, got ${got}` : `needs review: expected ${expected}, got ${got}`;
  // With a status the line says it all; without one (the request failed, or the body check did), the
  // first line of the error explains it (later lines are Playwright's call log).
  const err = o.actualStatus === null || o.actualStatus === Number(expected) ? flat(o.error.split('\n')[0]) : '';
  return err ? `${head}; ${err}` : head;
}

export function buildTraceRows(o: {
  cases: TraceCase[];
  matches: Map<string, TraceMatch>;
  endpoints: TraceEndpoint[];
  // Endpoints left out of this run (--endpoints), with the reason.
  outOfScope?: Map<string, string>;
  outcomes: TraceOutcome[];
  findings: TraceFinding[];
  ran: boolean;
}): TraceRow[] {
  const rows: TraceRow[] = [];
  for (const c of o.cases) {
    const m = o.matches.get(c.id);
    const refs = { ...(c.jira ? { jira: c.jira } : {}), ...(c.confluence ? { confluence: c.confluence } : {}) };
    const untested = caseCoverage(c.expected);
    const base = { id: c.id, title: c.title, endpoint: m?.endpointId ?? '', testFile: '', source: 'sheet' as const, ...refs, asserted: 0, clauses: untested.clauses, coverage: '' };
    if (!m || !m.endpointId) {
      rows.push({ ...base, status: 'not automated', reason: flat(m?.reason ?? 'not matched to an endpoint') });
      continue;
    }
    const skippedScope = o.outOfScope?.get(m.endpointId);
    if (skippedScope) {
      rows.push({ ...base, status: 'not automated', reason: skippedScope });
      continue;
    }
    const e = o.endpoints.find((x) => x.endpointId === m.endpointId);
    if (!e) {
      rows.push({ ...base, status: 'not automated', reason: 'endpoint not in this run' });
      continue;
    }
    // A needs-review case has only a placeholder that never runs: no test file to point at.
    const review = e.plan?.needsReview?.find((n) => n.caseId === c.id);
    if (review) {
      const status: TraceStatus = review.code === 'MISSING_TEST_DATA' ? 'skipped' : review.code === 'MANUAL' || review.code === 'MANUAL_VISUAL' ? 'manual' : 'needs review';
      rows.push({ ...base, status, ...(review.code ? { reasonCode: review.code } : {}), reason: flat(review.reason) });
      continue;
    }
    const pc = e.plan?.cases.find((x) => x.caseId === c.id);
    if (e.skippedReason) {
      rows.push({ ...base, status: 'not automated', reason: e.skippedReason });
      continue;
    }
    // The gate dropped this case's test and kept the rest of the file: the file has no test for it.
    const dropped = e.plan?.notAutomated?.find((n) => n.caseId === c.id);
    if (dropped && !pc) {
      rows.push({ ...base, status: 'not automated', reason: flat(dropped.reason) });
      continue;
    }
    if (!pc || !e.specFile) {
      const own = pc && e.caseReasons?.[pc.title];
      const reason = own?.length ? `static gate: ${own.map((r) => r.replace(/^\[[a-z-]+\] test "[^"]*": /, '')).join(' | ')}` : (e.failureReason ?? (pc ? 'no spec was written' : 'not planned'));
      rows.push({ ...base, status: 'not automated', reason: flat(reason) });
      continue;
    }
    const outcome = o.outcomes.find((x) => x.endpointId === e.endpointId && x.title === pc.title);
    if (!outcome) {
      rows.push({ ...base, testFile: e.specFile, status: 'not automated', reason: o.ran ? flat(e.failureReason ?? 'the test did not run') : 'the tests were not run' });
      continue;
    }
    const cov = caseCoverage(c.expected, pc, true);
    const tested = { ...base, testFile: e.specFile, asserted: cov.asserted, clauses: cov.clauses, coverage: cov.coverage };
    const via = m.by === 'ai' ? 'endpoint matched by the AI; check it' : '';
    if (outcome.kind === 'blocked') {
      rows.push({ ...base, testFile: e.specFile, status: 'blocked', reasonCode: outcome.reasonCode ?? 'DATA_NOT_ON_ENV', reason: flat([outcome.reason ?? 'skipped while running', via].filter(Boolean).join('; ')) });
      continue;
    }
    if (outcome.kind === 'known-issue') {
      const err = flat(outcome.error.split('\n')[0]);
      rows.push({ ...tested, status: 'known issue', reasonCode: 'KNOWN_ISSUE', reason: flat([`${outcome.reason ?? 'known issue'}; failed as expected${outcome.actualStatus !== null ? ` (got ${outcome.actualStatus})` : ''}${err ? `: ${err}` : ''}`, via].filter(Boolean).join('; ')) });
      continue;
    }
    if (outcome.kind === 'unexpected-pass') {
      rows.push({ ...tested, status: 'unexpected pass', reasonCode: 'KNOWN_ISSUE', reason: flat([`${outcome.reason ?? 'known issue'}; the test passed, so the bug may be fixed: check it and remove the Known issue from the sheet`, via].filter(Boolean).join('; ')) });
      continue;
    }
    if (outcome.passed) {
      const cover = passedStatus(pc);
      if (pc.accepted5xx && cover.status === 'passed') {
        rows.push({ ...tested, status: 'accepted 5xx', reason: flat([`documented 5xx: the API answered ${outcome.actualStatus ?? pc.expectedStatus} as the sheet documents (${c.documented5xx ?? 'documented'})`, via].filter(Boolean).join('; ')) });
        continue;
      }
      rows.push({ ...tested, status: cover.status, reason: flat([cover.reason, via].filter(Boolean).join('; ')) });
    } else {
      const f = o.findings.find((x) => x.endpointId === e.endpointId && x.testTitle === pc.title);
      const { missing } = coverageGaps(pc);
      rows.push({ ...tested, status: 'failed', reason: flat([failReason(outcome, f, pc.statusCodes?.length ? pc.statusCodes.join('|') : pc.expectedStatus), missing.length ? `not asserted: ${missingText(missing)}` : '', pc.probeNote ? `probe warning before the run: ${pc.probeNote}` : '', via].filter(Boolean).join('; ')) });
    }
  }
  // Agent suggestions (sheet-plus-agent): listed after the sheet so the team can adopt them.
  for (const e of o.endpoints) {
    for (const pc of e.plan?.cases ?? []) {
      if (pc.source !== 'agent') continue;
      const outcome = o.outcomes.find((x) => x.endpointId === e.endpointId && x.title === pc.title);
      const f = o.findings.find((x) => x.endpointId === e.endpointId && x.testTitle === pc.title);
      const status: TraceStatus = !outcome ? 'not automated' : outcome.passed ? 'passed' : 'failed';
      const reason = !outcome ? flat(e.skippedReason ?? e.failureReason ?? (o.ran ? 'the test did not run' : 'the tests were not run')) : outcome.passed ? 'agent suggestion, not in the sheet' : `agent suggestion; ${failReason(outcome, f, pc.expectedStatus)}`;
      rows.push({ id: 'agent', title: pc.title.replace(/^\[agent\]\s*/, ''), endpoint: e.endpointId, testFile: outcome && e.specFile ? e.specFile : '', status, reason, source: 'agent' });
    }
  }
  return rows;
}
