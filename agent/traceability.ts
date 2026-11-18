import { deflateRawSync } from 'node:zlib';
import { crc32 } from './zip';

// The back-map from the team's sheet to the run: one row per sheet case with the test that automates it
// and what happened, then one row per agent suggestion. Written as CSV (out/traceability.csv) and XLSX
// (out/traceability.xlsx), listed in summary.testCases and copied into the exported framework.

// "partially covered": the test passed but some clauses of the case's expected result have no assertion
// (listed in the reason). It is never counted as passed.
export type TraceStatus = 'passed' | 'partially covered' | 'failed' | 'needs review' | 'not automated';
export type TraceRow = { id: string; title: string; endpoint: string; testFile: string; status: TraceStatus; reason: string; source: 'sheet' | 'agent' };

export const TRACE_COLUMNS = ['ID', 'Title', 'Endpoint', 'Test file', 'Status', 'Reason'] as const;

function cells(r: TraceRow): string[] {
  return [r.id, r.title, r.endpoint, r.testFile, r.status, r.reason];
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
  const widths = [14, 50, 22, 32, 14, 70];
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

export type TraceTotals = { rows: number; automated: number; passed: number; partiallyCovered: number; failed: number; needsReview: number; notAutomated: number; agentSuggestions: number };

export function traceTotals(rows: TraceRow[]): TraceTotals {
  const sheet = rows.filter((r) => r.source === 'sheet');
  return {
    rows: sheet.length,
    automated: sheet.filter((r) => r.status === 'passed' || r.status === 'partially covered' || r.status === 'failed').length,
    passed: sheet.filter((r) => r.status === 'passed').length,
    partiallyCovered: sheet.filter((r) => r.status === 'partially covered').length,
    failed: sheet.filter((r) => r.status === 'failed').length,
    needsReview: sheet.filter((r) => r.status === 'needs review').length,
    notAutomated: sheet.filter((r) => r.status === 'not automated').length,
    agentSuggestions: rows.filter((r) => r.source === 'agent').length,
  };
}

// ---------- Building the rows ----------

export type ClauseLike = { n: number; text: string; status: 'asserted' | 'not-asserted' | 'probe-disagrees'; reason?: string; expected?: string; actual?: string };
type PlanCaseLike = { title: string; caseId?: string; source?: 'sheet' | 'agent'; expectedStatus: string; statusCodes?: number[]; clauses?: ClauseLike[] };
type PlanLike = { cases: PlanCaseLike[]; needsReview?: { caseId: string; reason: string }[]; notAutomated?: { caseId?: string; title: string; reason: string }[] };
// caseReasons: when the whole spec was rejected, the gate's reasons for each planned test by title.
export type TraceEndpoint = { endpointId: string; specFile: string | null; plan?: PlanLike; failureReason: string | null; skippedReason: string | null; caseReasons?: Record<string, string[]> };

// What a passing test does not prove: the clauses of the expected result without an assertion, and
// the ones the probe response contradicted.
export function coverageGaps(pc: { clauses?: ClauseLike[] }): { missing: ClauseLike[]; disagrees: ClauseLike[] } {
  const clauses = pc.clauses ?? [];
  return { missing: clauses.filter((c) => c.status === 'not-asserted'), disagrees: clauses.filter((c) => c.status === 'probe-disagrees') };
}

function clip(text: string, max = 80): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function missingText(missing: ClauseLike[]): string {
  return missing.map((c) => `clause ${c.n} "${clip(c.text)}"${c.reason ? ` (${clip(c.reason, 60)})` : ''}`).join('; ');
}

export function disagreeText(disagrees: ClauseLike[]): string {
  return disagrees.map((c) => `clause ${c.n} "${clip(c.text)}": expected ${clip(c.expected ?? c.text, 60)}, actual ${clip(c.actual ?? 'different', 60)}`).join('; ');
}

// The coverage status of a test that passed: needs review when the probe disagreed with the sheet,
// partially covered when a clause has no assertion, else passed.
export function passedStatus(pc: { clauses?: ClauseLike[] }): { status: TraceStatus; reason: string } {
  const { missing, disagrees } = coverageGaps(pc);
  if (disagrees.length) return { status: 'needs review', reason: `the API response disagrees with the sheet: ${disagreeText(disagrees)}${missing.length ? `; not asserted: ${missingText(missing)}` : ''}` };
  if (missing.length) return { status: 'partially covered', reason: `passed, but not every expected-result clause is asserted; not asserted: ${missingText(missing)}` };
  return { status: 'passed', reason: '' };
}
export type TraceCase = { id: string; title: string };
export type TraceMatch = { endpointId: string | null; by: string | null; reason: string };
export type TraceOutcome = { endpointId: string; title: string; passed: boolean; actualStatus: number | null; error: string };
export type TraceFinding = { endpointId: string; testTitle: string; classification: string; expectedStatus: string | null; actualStatus: number | null };

function oneLine(text: string, max = 300): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}

function failReason(o: TraceOutcome, f: TraceFinding | undefined, expected: string): string {
  const got = o.actualStatus ?? 'no status';
  const head = f?.classification === 'suspected API finding' ? `suspected API finding: expected ${expected}, got ${got}` : `needs review: expected ${expected}, got ${got}`;
  // With a status the line says it all; without one (the request failed, or the body check did), the
  // first line of the error explains it.
  const err = o.actualStatus === null || o.actualStatus === Number(expected) ? oneLine(o.error.split('\n')[0], 160) : '';
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
    const base = { id: c.id, title: c.title, endpoint: m?.endpointId ?? '', testFile: '', source: 'sheet' as const };
    if (!m || !m.endpointId) {
      rows.push({ ...base, status: 'not automated', reason: oneLine(m?.reason ?? 'not matched to an endpoint') });
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
    const review = e.plan?.needsReview?.find((n) => n.caseId === c.id);
    if (review) {
      rows.push({ ...base, testFile: e.specFile ?? '', status: 'needs review', reason: oneLine(review.reason) });
      continue;
    }
    const pc = e.plan?.cases.find((x) => x.caseId === c.id);
    if (e.skippedReason) {
      rows.push({ ...base, status: 'not automated', reason: e.skippedReason });
      continue;
    }
    // The gate dropped this case's test and kept the rest of the file.
    const dropped = e.plan?.notAutomated?.find((n) => n.caseId === c.id);
    if (dropped && !pc) {
      rows.push({ ...base, testFile: e.specFile ?? '', status: 'not automated', reason: oneLine(dropped.reason) });
      continue;
    }
    if (!pc || !e.specFile) {
      const own = pc && e.caseReasons?.[pc.title];
      const reason = own?.length ? `static gate: ${own.map((r) => r.replace(/^\[[a-z-]+\] test "[^"]*": /, '')).join(' | ')}` : (e.failureReason ?? (pc ? 'no spec was written' : 'not planned'));
      rows.push({ ...base, status: 'not automated', reason: oneLine(reason) });
      continue;
    }
    const outcome = o.outcomes.find((x) => x.endpointId === e.endpointId && x.title === pc.title);
    if (!outcome) {
      rows.push({ ...base, testFile: e.specFile, status: 'not automated', reason: o.ran ? oneLine(e.failureReason ?? 'the test did not run') : 'the tests were not run' });
      continue;
    }
    const via = m.by === 'ai' ? 'endpoint matched by the AI; check it' : '';
    if (outcome.passed) {
      const cover = passedStatus(pc);
      rows.push({ ...base, testFile: e.specFile, status: cover.status, reason: oneLine([cover.reason, via].filter(Boolean).join('; '), 600) });
    } else {
      const f = o.findings.find((x) => x.endpointId === e.endpointId && x.testTitle === pc.title);
      const { missing } = coverageGaps(pc);
      rows.push({ ...base, testFile: e.specFile, status: 'failed', reason: oneLine([failReason(outcome, f, pc.statusCodes?.length ? pc.statusCodes.join('|') : pc.expectedStatus), missing.length ? `not asserted: ${missingText(missing)}` : '', via].filter(Boolean).join('; '), 600) });
    }
  }
  // Agent suggestions (sheet-plus-agent): listed after the sheet so the team can adopt them.
  for (const e of o.endpoints) {
    for (const pc of e.plan?.cases ?? []) {
      if (pc.source !== 'agent') continue;
      const outcome = o.outcomes.find((x) => x.endpointId === e.endpointId && x.title === pc.title);
      const f = o.findings.find((x) => x.endpointId === e.endpointId && x.testTitle === pc.title);
      const status: TraceStatus = !outcome ? 'not automated' : outcome.passed ? 'passed' : 'failed';
      const reason = !outcome ? oneLine(e.skippedReason ?? e.failureReason ?? (o.ran ? 'the test did not run' : 'the tests were not run')) : outcome.passed ? 'agent suggestion, not in the sheet' : `agent suggestion; ${failReason(outcome, f, pc.expectedStatus)}`;
      rows.push({ id: 'agent', title: pc.title.replace(/^\[agent\]\s*/, ''), endpoint: e.endpointId, testFile: e.specFile ?? '', status, reason, source: 'agent' });
    }
  }
  return rows;
}
