import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { readSheet } from 'read-excel-file/node';
import { AGENT_CASE_PREFIX, TEST_TYPES } from './model';

// The team's own test case sheet: CSV, TSV (what Excel and Google Sheets put on the clipboard) or XLSX,
// including CSV exported from Jira, Xray, Zephyr, TestRail or a Confluence table. Each row becomes one
// sheet case; the agent matches it to an endpoint, plans it as one test named "[<ID>] [<type>] <Title>",
// and writes the result back per row (agent/traceability.ts). Nothing here calls a model or the network.

export { DEFAULT_TEST_CASE_MODE, TEST_CASE_MODES, type TestCaseMode, type TestCasesConfig } from './config';

// Limits. A sheet is untrusted input: it may be huge, a zip bomb, or carry formulas.
export const MAX_SHEET_BYTES = 5 * 1024 * 1024;
export const MAX_SHEET_ROWS = 1000;
export const MAX_SHEET_COLUMNS = 100;
export const MAX_CELL_CHARS = 4000;
const MAX_XLSX_UNCOMPRESSED = 60 * 1024 * 1024;
const MAX_XLSX_ENTRIES = 2000;
const MAX_ID_CHARS = 40;
const MAX_TITLE_CHARS = 150;

export type CaseField = 'id' | 'title' | 'steps' | 'expected' | 'endpoint' | 'method' | 'priority' | 'preconditions' | 'testData' | 'jira' | 'confluence';

// Header aliases, compared after lowercasing and turning every non-letter, non-digit run into one space.
// Common Jira, Xray, Zephyr Scale, TestRail and Confluence export names are included.
const ALIASES: Record<CaseField, string[]> = {
  id: ['id', 'test case id', 'testcase id', 'test case', 'tc id', 'tc', 'tc no', 'tc number', 'test id', 'case id', 'test case no', 'test case number', 'key', 'issue key', 'test key', 'issue id', 'jira key', 'zephyr key', 'ref', 'reference'],
  title: ['title', 'name', 'summary', 'test case name', 'test name', 'test title', 'test case title', 'test summary', 'scenario', 'test scenario', 'case name', 'subject'],
  steps: ['steps', 'step', 'steps request', 'request', 'description', 'action', 'actions', 'test steps', 'steps to reproduce', 'procedure', 'test procedure', 'step action', 'test script step by step step', 'test script steps', 'manual test steps', 'how to test'],
  expected: ['expected', 'expected result', 'expected results', 'expected outcome', 'expected response', 'expected behaviour', 'expected behavior', 'expected status', 'step expected result', 'test script step by step expected result'],
  endpoint: ['endpoint', 'endpoint id', 'api', 'api endpoint', 'url', 'path', 'resource', 'operation', 'route', 'uri'],
  method: ['method', 'http method', 'verb', 'http verb'],
  priority: ['priority', 'severity', 'importance'],
  preconditions: ['preconditions', 'precondition', 'pre condition', 'pre conditions', 'prerequisites', 'prerequisite', 'setup', 'given'],
  testData: ['test data', 'data', 'input', 'input data', 'payload', 'body', 'request body', 'step data', 'test script step by step test data'],
  // Where the case is tracked, copied to the traceability report as it is (a key such as QA-12 or a link).
  // "Jira key" / "Issue key" stay the case ID; these are extra reference columns.
  jira: ['jira', 'jira link', 'jira url', 'jira issue', 'jira ticket', 'jira story', 'jira ref', 'jira reference', 'story', 'user story', 'requirement', 'requirement id'],
  confluence: ['confluence', 'confluence link', 'confluence url', 'confluence page', 'confluence id', 'confluence ref', 'confluence reference', 'spec page', 'spec link'],
};
// Looser rules for exports that wrap names, e.g. "Custom field (Expected Result)".
const CONTAINS: [CaseField, RegExp][] = [
  ['expected', /\bexpected\b/],
  ['steps', /\bsteps?\b|\baction\b/],
  ['testData', /\btest data\b/],
  ['preconditions', /\bpre ?conditions?\b/],
];

export const FIELD_LABELS: Record<CaseField, string> = {
  id: 'ID',
  title: 'Title',
  steps: 'Steps / Request',
  expected: 'Expected Result',
  endpoint: 'Endpoint',
  method: 'Method',
  priority: 'Priority',
  preconditions: 'Preconditions',
  testData: 'Test Data',
  jira: 'Jira',
  confluence: 'Confluence',
};

export type SheetCase = {
  id: string;
  // The sheet row (1 = the header row, so the first case is row 2).
  row: number;
  title: string;
  steps: string;
  expected: string;
  endpoint: string;
  method: string;
  priority: string;
  preconditions: string;
  testData: string;
  // Reference columns for the traceability report (absent when the sheet has none, so the sheet hash of
  // older sheets stays the same).
  jira?: string;
  confluence?: string;
};

export type SheetWarning = { row: number | null; caseId: string | null; message: string };

// Where live cases came from (agent/atlassian.ts); absent for a file or pasted sheet.
export type CaseSource = { kind: 'jira' | 'confluence' | 'zephyr'; link: string; label: string; steps: string | null };

export type ParsedSheet = {
  format: 'csv' | 'tsv' | 'xlsx' | 'jira' | 'confluence' | 'zephyr';
  source?: CaseSource;
  // Field -> the header it was read from.
  columns: Partial<Record<CaseField, string>>;
  // Headers that map to no field (ignored).
  ignored: string[];
  cases: SheetCase[];
  warnings: SheetWarning[];
  // sha256 of the normalized cases, for the checkpoint.
  hash: string;
};

export class SheetError extends Error {}

function norm(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function mapColumns(headers: string[]): { index: Partial<Record<CaseField, number>>; columns: Partial<Record<CaseField, string>>; ignored: string[] } {
  const index: Partial<Record<CaseField, number>> = {};
  const used = new Set<number>();
  const normalized = headers.map(norm);
  const fields = Object.keys(ALIASES) as CaseField[];
  // Exact aliases first, in alias order, so "Test Case ID" wins over a later "Key".
  for (const field of fields) {
    for (const alias of ALIASES[field]) {
      const i = normalized.findIndex((h, j) => h === alias && !used.has(j));
      if (i >= 0) {
        index[field] = i;
        used.add(i);
        break;
      }
    }
  }
  for (const [field, re] of CONTAINS) {
    if (index[field] !== undefined) continue;
    const i = normalized.findIndex((h, j) => !used.has(j) && re.test(h));
    if (i >= 0) {
      index[field] = i;
      used.add(i);
    }
  }
  const columns: Partial<Record<CaseField, string>> = {};
  for (const field of fields) if (index[field] !== undefined) columns[field] = headers[index[field]!];
  const ignored = headers.filter((h, i) => !used.has(i) && h.trim() !== '');
  return { index, columns, ignored };
}

// RFC 4180 CSV, or TSV / semicolon-separated text: quoted fields, doubled quotes, CRLF, line breaks
// inside quotes, a UTF-8 BOM. The delimiter is the most common of tab, comma and semicolon in the header
// line (outside quotes).
export function parseDelimited(text: string): { rows: string[][]; delimiter: string } {
  const src = text.replace(/^\uFEFF/, '');
  const firstLine = (() => {
    let inQuote = false;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (c === '"') inQuote = !inQuote;
      else if ((c === '\n' || c === '\r') && !inQuote) return src.slice(0, i);
    }
    return src;
  })().replace(/"[^"]*"/g, '');
  const count = (ch: string) => firstLine.split(ch).length - 1;
  const delimiter = [['\t', count('\t')], [',', count(',')], [';', count(';')]].sort((a, b) => (b[1] as number) - (a[1] as number))[0];
  const d = (delimiter[1] as number) > 0 ? (delimiter[0] as string) : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldStarted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
    } else if (c === d) {
      row.push(field);
      field = '';
      fieldStarted = false;
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      fieldStarted = false;
      if (rows.length > MAX_SHEET_ROWS + 50) throw new SheetError(`the sheet has more than ${MAX_SHEET_ROWS} rows; split it into smaller sheets`);
    } else {
      field += c;
      fieldStarted = true;
    }
  }
  if (inQuotes) throw new SheetError('the sheet has a quoted field that never ends (an odd number of " characters)');
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return { rows, delimiter: d };
}

// Reads the zip central directory of an .xlsx file and refuses it before decompressing anything when it
// is not a zip, has too many entries, or would expand past the limit (a zip bomb).
export function checkXlsxContainer(buf: Buffer): void {
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) throw new SheetError('this is not an .xlsx file (an .xlsx file is a zip archive). Save the sheet as .xlsx or .csv');
  const from = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new SheetError('the .xlsx file is damaged (no zip directory found)');
  const entries = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (entries > MAX_XLSX_ENTRIES) throw new SheetError(`the .xlsx file has ${entries} parts; at most ${MAX_XLSX_ENTRIES} are allowed`);
  let p = cdOffset;
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new SheetError('the .xlsx file is damaged (bad zip directory)');
    total += buf.readUInt32LE(p + 24);
    if (total > MAX_XLSX_UNCOMPRESSED) throw new SheetError(`the .xlsx file expands to more than ${MAX_XLSX_UNCOMPRESSED / 1024 / 1024} MB; refused`);
    p += 46 + buf.readUInt16LE(p + 28) + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().replace(/T00:00:00\.000Z$/, '');
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

// Reads only stored cell values (never evaluates a formula: a formula cell gives its cached result or
// nothing), from the first worksheet.
export async function parseXlsxRows(buf: Buffer): Promise<string[][]> {
  if (buf.length > MAX_SHEET_BYTES) throw new SheetError(`the file is larger than ${MAX_SHEET_BYTES / 1024 / 1024} MB`);
  checkXlsxContainer(buf);
  let data: unknown[][];
  try {
    data = (await readSheet(buf)) as unknown[][];
  } catch (err) {
    throw new SheetError(`could not read the .xlsx file: ${(err as Error).message.split('\n')[0].slice(0, 200)}`);
  }
  if (data.length > MAX_SHEET_ROWS + 50) throw new SheetError(`the sheet has more than ${MAX_SHEET_ROWS} rows; split it into smaller sheets`);
  return data.map((r) => (Array.isArray(r) ? r.slice(0, MAX_SHEET_COLUMNS + 1).map(cellText) : []));
}

const ID_UNSAFE = /[[\]'"`\\\r\n\t]/g;

function cleanId(raw: string): string {
  return raw.replace(ID_UNSAFE, '-').replace(/\s+/g, ' ').trim().slice(0, MAX_ID_CHARS);
}

// Titles become part of a test name in TypeScript source: no quotes, backticks, backslashes or line breaks.
export function cleanTitle(raw: string): string {
  return raw
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\\/g, '/')
    .replace(/'/g, '\u2019')
    .replace(/"/g, '\u201d')
    .replace(/`/g, '\u2019')
    .replace(/\$\{/g, '$ {')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE_CHARS);
}

// Turns raw rows (first row: headers) into sheet cases. Never drops a row silently: a row without an ID
// gets "ROW-<n>" and a warning; a row with only steps or expected text and no ID or title continues the
// case above it (step-per-row exports such as Xray and Zephyr); an empty row is skipped.
export function casesFromRows(rows: string[][], format: ParsedSheet['format']): ParsedSheet {
  const nonEmpty = (r: string[]) => r.some((c) => c.trim() !== '');
  const headerAt = rows.findIndex(nonEmpty);
  if (headerAt < 0) throw new SheetError('the sheet is empty');
  const headers = rows[headerAt].map((h) => h.trim());
  if (headers.length > MAX_SHEET_COLUMNS) throw new SheetError(`the sheet has ${headers.length} columns; at most ${MAX_SHEET_COLUMNS} are allowed`);
  const { index, columns, ignored } = mapColumns(headers);
  if (index.title === undefined && index.steps === undefined) {
    throw new SheetError(`no Title or Steps column found. Headers seen: ${headers.filter(Boolean).slice(0, 12).join(', ') || '(none)'}. Use columns like ID, Title, Steps / Request, Expected Result (download the template)`);
  }
  const warnings: SheetWarning[] = [];
  if (index.id === undefined) warnings.push({ row: null, caseId: null, message: 'no ID column found: every case gets an ID from its row number (ROW-2, ROW-3, ...)' });
  if (index.expected === undefined) warnings.push({ row: null, caseId: null, message: 'no Expected Result column found: cases without an expected result are marked needs review' });
  const cases: SheetCase[] = [];
  const seen = new Map<string, number>();
  let truncated = 0;
  for (let r = headerAt + 1; r < rows.length; r++) {
    const raw = rows[r];
    if (!nonEmpty(raw)) continue;
    const rowNo = r + 1;
    const get = (f: CaseField) => {
      const i = index[f];
      if (i === undefined) return '';
      const v = (raw[i] ?? '').trim();
      if (v.length > MAX_CELL_CHARS) {
        truncated++;
        return v.slice(0, MAX_CELL_CHARS);
      }
      return v;
    };
    const rawId = get('id');
    const title = get('title');
    if (!rawId && !title && cases.length && (get('steps') || get('expected') || get('testData'))) {
      const prev = cases[cases.length - 1];
      const join = (a: string, b: string) => (a && b ? `${a}\n${b}` : a || b);
      prev.steps = join(prev.steps, get('steps'));
      prev.expected = join(prev.expected, get('expected'));
      prev.testData = join(prev.testData, get('testData'));
      continue;
    }
    if (cases.length >= MAX_SHEET_ROWS) throw new SheetError(`the sheet has more than ${MAX_SHEET_ROWS} test cases; split it into smaller sheets`);
    let id = cleanId(rawId);
    if (!id) {
      id = `ROW-${rowNo}`;
      if (index.id !== undefined) warnings.push({ row: rowNo, caseId: id, message: `missing ID, using ${id}` });
    } else if (id !== rawId.trim()) {
      warnings.push({ row: rowNo, caseId: id, message: `ID "${rawId.trim().slice(0, 50)}" changed to "${id}" (brackets, quotes and line breaks are not allowed in a test name)` });
    }
    if (id.toLowerCase() === AGENT_CASE_PREFIX || (TEST_TYPES as readonly string[]).includes(id.toLowerCase()) || id.toLowerCase() === 'needs-review') {
      const renamed = `ROW-${rowNo}`;
      warnings.push({ row: rowNo, caseId: renamed, message: `ID "${id}" is reserved for test types, using ${renamed}` });
      id = renamed;
    }
    const n = seen.get(id.toLowerCase()) ?? 0;
    if (n > 0) {
      const renamed = `${id}-${n + 1}`.slice(0, MAX_ID_CHARS);
      warnings.push({ row: rowNo, caseId: renamed, message: `duplicate ID "${id}", using ${renamed}` });
      seen.set(id.toLowerCase(), n + 1);
      id = renamed;
    }
    seen.set(id.toLowerCase(), (seen.get(id.toLowerCase()) ?? 0) + 1);
    const steps = get('steps');
    const c: SheetCase = {
      id,
      row: rowNo,
      title: cleanTitle(title || steps.split('\n')[0] || id),
      steps,
      expected: get('expected'),
      endpoint: get('endpoint'),
      method: get('method').toUpperCase(),
      priority: get('priority'),
      preconditions: get('preconditions'),
      testData: get('testData'),
    };
    const jira = get('jira');
    const confluence = get('confluence');
    if (jira) c.jira = jira;
    if (confluence) c.confluence = confluence;
    if (!title) warnings.push({ row: rowNo, caseId: id, message: 'no title, using the first line of the steps' });
    if (!c.steps && !c.expected) warnings.push({ row: rowNo, caseId: id, message: 'no steps and no expected result: it will be marked needs review' });
    cases.push(c);
  }
  if (truncated) warnings.push({ row: null, caseId: null, message: `${truncated} cell(s) longer than ${MAX_CELL_CHARS} characters were shortened` });
  if (!cases.length) throw new SheetError('the sheet has a header row but no test cases');
  const hash = createHash('sha256').update(JSON.stringify(cases)).digest('hex').slice(0, 16);
  return { format, columns, ignored, cases, warnings, hash };
}

function looksLikeXlsx(buf: Buffer): boolean {
  return buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50;
}

// A sheet from bytes (an upload) or pasted text. name is the file name, used for the format only.
export async function parseSheet(input: Buffer | string, name = ''): Promise<ParsedSheet> {
  const ext = extname(name).toLowerCase();
  if (typeof input !== 'string' && (ext === '.xlsx' || ext === '.xlsm' || looksLikeXlsx(input))) {
    return casesFromRows(await parseXlsxRows(input), 'xlsx');
  }
  if (ext === '.xls') throw new SheetError('old .xls files are not supported; save the sheet as .xlsx or .csv');
  const text = typeof input === 'string' ? input : input.toString('utf8');
  if (Buffer.byteLength(text, 'utf8') > MAX_SHEET_BYTES) throw new SheetError(`the sheet is larger than ${MAX_SHEET_BYTES / 1024 / 1024} MB`);
  if (/^\s*https?:\/\/\S+\s*$/.test(text)) {
    throw new SheetError('a link was pasted where a sheet was expected. Paste Jira and Confluence links in the "Jira or Confluence link" box (or pass the link to --test-cases), or upload a CSV export');
  }
  const { rows, delimiter } = parseDelimited(text);
  return casesFromRows(rows, delimiter === '\t' ? 'tsv' : 'csv');
}

export const SHEET_EXTENSIONS = ['.csv', '.tsv', '.txt', '.xlsx'];

export async function loadSheetFile(file: string): Promise<ParsedSheet> {
  const ext = extname(file).toLowerCase();
  if (ext === '.xls') throw new SheetError('old .xls files are not supported; save the sheet as .xlsx or .csv');
  // Only sheet files: a typo or a hostile input can never make the agent read .env or a key file.
  if (!SHEET_EXTENSIONS.includes(ext)) throw new SheetError(`the test case sheet must be a ${SHEET_EXTENSIONS.join(', ')} file, got ${file}`);
  let size: number;
  try {
    size = statSync(file).size;
  } catch (err) {
    throw new SheetError(`cannot read the test case sheet ${file}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
  }
  if (size > MAX_SHEET_BYTES) throw new SheetError(`the test case sheet ${file} is larger than ${MAX_SHEET_BYTES / 1024 / 1024} MB`);
  return parseSheet(readFileSync(file), file);
}

// Matching a case to an endpoint, without a model: the Endpoint column (an endpoint id, "METHOD /path",
// a path or a full URL), else a "METHOD /path" request line in the steps. Paths compare segment by
// segment; {id}, :id and {{id}} are placeholders, and a number or UUID matches a placeholder.

export type EndpointRef = { id: string; method: string; path: string };
export type MatchResult = { endpointId: string | null; by: 'column' | 'steps' | 'ai' | null; reason: string };

function pathSegments(p: string): string[] {
  let path = p.trim();
  path = path.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '');
  path = path.split(/[?#]/)[0];
  return path.split('/').filter(Boolean);
}

const PLACEHOLDER = /^(\{\{?[^}]+\}?\}|:[A-Za-z_][\w-]*|<[^>]+>)$/;
const CONCRETE_ID = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{24})$/i;

function pathMatches(candidate: string, endpointPath: string): boolean {
  const a = pathSegments(candidate);
  const b = pathSegments(endpointPath);
  if (a.length !== b.length) return false;
  return a.every((seg, i) => {
    const want = b[i];
    if (PLACEHOLDER.test(want)) return PLACEHOLDER.test(seg) || CONCRETE_ID.test(seg) || /^[\w.~-]+$/.test(seg);
    return seg.toLowerCase() === want.toLowerCase();
  });
}

// Literal segments must equal; prefer an endpoint whose literal segments match exactly over one where a
// placeholder swallowed a word ("/products/import" is not "/products/{id}" when the sheet says import).
function bestPathMatch(method: string, path: string, endpoints: EndpointRef[]): EndpointRef[] {
  const segs = pathSegments(path);
  return endpoints.filter((e) => {
    if (method && e.method !== method) return false;
    if (!pathMatches(path, e.path)) return false;
    // A plain word where the endpoint has a placeholder only matches a real-looking id or placeholder.
    const want = pathSegments(e.path);
    return segs.every((seg, i) => !PLACEHOLDER.test(want[i]) || PLACEHOLDER.test(seg) || CONCRETE_ID.test(seg) || /\d/.test(seg));
  });
}

const REQUEST_LINE = /\b(GET|POST|PUT|PATCH|DELETE)\s+((?:https?:\/\/[^\s/]+)?\/[^\s"'`,;)]*)/i;

export function matchExplicit(c: SheetCase, endpoints: EndpointRef[]): MatchResult {
  const ref = c.endpoint.trim();
  const method = /^(GET|POST|PUT|PATCH|DELETE)$/.test(c.method) ? c.method : '';
  if (ref) {
    const byId = endpoints.find((e) => e.id.toLowerCase() === ref.toLowerCase());
    if (byId) return { endpointId: byId.id, by: 'column', reason: `Endpoint column "${ref}"` };
    const line = ref.match(/^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)$/i);
    const m = line ? line[1].toUpperCase() : method;
    const p = line ? line[2] : ref;
    if (/^(https?:\/\/|\/)/i.test(p)) {
      const hits = bestPathMatch(m, p, endpoints);
      if (hits.length === 1) return { endpointId: hits[0].id, by: 'column', reason: `Endpoint column "${ref}"` };
      if (hits.length > 1) return { endpointId: null, by: null, reason: `Endpoint column "${ref}" fits ${hits.map((h) => h.id).join(', ')}; add a Method column or use the endpoint id` };
    }
    return { endpointId: null, by: null, reason: `unknown endpoint "${ref}" (not an endpoint id, method and path of this API)` };
  }
  const inSteps = `${c.steps}\n${c.title}`.match(REQUEST_LINE);
  if (inSteps) inSteps[2] = inSteps[2].replace(/[.:]+$/, '');
  if (inSteps) {
    const hits = bestPathMatch(inSteps[1].toUpperCase(), inSteps[2], endpoints);
    if (hits.length === 1) return { endpointId: hits[0].id, by: 'steps', reason: `request line "${inSteps[1].toUpperCase()} ${inSteps[2]}" in the steps` };
    if (!hits.length) return { endpointId: null, by: null, reason: `the request in the steps (${inSteps[1].toUpperCase()} ${inSteps[2]}) is not an endpoint of this API` };
  }
  return { endpointId: null, by: null, reason: 'no Endpoint column value and no "METHOD /path" in the steps' };
}

// For the UI preview: the first rows with how each would be matched without a model.
export function previewSheet(sheet: ParsedSheet, endpoints: EndpointRef[] | null) {
  const rows = sheet.cases.map((c) => {
    const warnings = sheet.warnings.filter((w) => w.row === c.row).map((w) => w.message);
    let endpoint: string | null = null;
    let matchedBy: string | null = null;
    if (endpoints) {
      const m = matchExplicit(c, endpoints);
      endpoint = m.endpointId;
      matchedBy = m.by;
      if (!m.endpointId) {
        if (c.endpoint || /^the request in the steps/.test(m.reason) || /fits /.test(m.reason)) warnings.push(`${m.reason}; the AI will try to match it at run time`);
        else warnings.push('no endpoint given: the AI will match it at run time');
      }
    }
    return { id: c.id, row: c.row, title: c.title, endpoint, matchedBy, expected: c.expected.slice(0, 120), warnings };
  });
  return {
    format: sheet.format,
    ...(sheet.source ? { source: { kind: sheet.source.kind, label: sheet.source.label, steps: sheet.source.steps } } : {}),
    columns: Object.fromEntries((Object.keys(sheet.columns) as CaseField[]).map((f) => [f, { label: FIELD_LABELS[f], header: sheet.columns[f] }])),
    ignored: sheet.ignored,
    count: sheet.cases.length,
    matched: rows.filter((r) => r.endpoint).length,
    rows,
    warnings: sheet.warnings.filter((w) => w.row === null).map((w) => w.message),
    rowWarnings: rows.reduce((n, r) => n + r.warnings.length, 0),
  };
}
