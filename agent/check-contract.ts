import { readFileSync } from 'node:fs';

// npm run check:contract [summary file]: checks out/summary.json against ui/CONTRACT.md (sections 2, 4,
// 5 and 7) and the rules in CLAUDE.md. Lists every problem and exits 1 when there is any.

const file = process.argv[2] || 'out/summary.json';
const problems: string[] = [];
const need = (ok: boolean, msg: string) => {
  if (!ok) problems.push(msg);
};

type Json = Record<string, unknown>;
const kind = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const isObj = (v: unknown): v is Json => kind(v) === 'object';
const isInt = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;

function field(where: string, obj: Json, key: string, kinds: string[], allowed?: unknown[]) {
  const v = obj[key];
  if (!kinds.includes(kind(v))) problems.push(`${where}.${key} is ${kind(v)}, expected ${kinds.join(' or ')}`);
  else if (allowed && !allowed.includes(v)) problems.push(`${where}.${key} is ${JSON.stringify(v)}, expected one of ${allowed.map((a) => JSON.stringify(a)).join(', ')}`);
}

let s: Json;
try {
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!isObj(raw)) throw new Error('not a JSON object');
  s = raw;
} catch (err) {
  console.log(`contract check FAILED\n- cannot read ${file}: ${(err as Error).message.split('\n')[0]}`);
  process.exit(1);
}

// Top level
field('summary', s, 'status', ['string'], ['completed', 'stopped-budget', 'no-tests', 'refused']);
field('summary', s, 'testFramework', ['string'], ['playwright', 'pactum']);
field('summary', s, 'inputFile', ['string']);
field('summary', s, 'baseUrl', ['string']);
field('summary', s, 'selection', ['object', 'null']);
// Model (Phase 8): which provider and model produced the plans and specs, and how it was reached.
need(isObj(s.model), 'summary.model is missing');
if (isObj(s.model)) {
  field('summary.model', s.model, 'provider', ['string'], ['anthropic', 'openai']);
  field('summary.model', s.model, 'model', ['string']);
  field('summary.model', s.model, 'via', ['string'], ['api', 'cli']);
}
if (isObj(s.selection)) {
  for (const [k, v] of Object.entries(s.selection)) need(typeof v === 'string' && v.length > 0, `summary.selection.${k} must be a non-empty string`);
}
field('summary', s, 'startedAt', ['string']);
need(typeof s.startedAt !== 'string' || !Number.isNaN(Date.parse(s.startedAt)), 'summary.startedAt is not a date');
need(isInt(s.durationSec), `summary.durationSec is ${JSON.stringify(s.durationSec)}, expected a whole number of seconds`);
need(isInt(s.requestsSent), `summary.requestsSent is ${JSON.stringify(s.requestsSent)}, expected a count`);

// Redaction and cleanup (section 9), on every run
const redaction = isObj(s.redaction) ? s.redaction : {};
need(isObj(s.redaction), 'summary.redaction is missing');
field('summary.redaction', redaction, 'mode', ['string'], ['standard', 'strict']);
need(isInt(redaction.fields), 'summary.redaction.fields is not a count');
need(isInt(redaction.replaced), 'summary.redaction.replaced is not a count');
const cleanup = isObj(s.cleanup) ? s.cleanup : {};
need(isObj(s.cleanup), 'summary.cleanup is missing');
for (const k of ['created', 'deleted', 'failed', 'skippedNoDeleteEndpoint']) need(isInt(cleanup[k]), `summary.cleanup.${k} is not a count`);
field('summary.cleanup', cleanup, 'failures', ['array']);
const counts = ['created', 'deleted', 'failed', 'skippedNoDeleteEndpoint'].map((k) => cleanup[k]);
if (counts.every(isInt)) {
  const [created, deleted, failed, skipped] = counts as number[];
  need(created === deleted + failed + skipped, 'summary.cleanup: created must equal deleted + failed + skippedNoDeleteEndpoint');
}
if (Array.isArray(cleanup.failures) && isInt(cleanup.failed)) need(cleanup.failures.length === cleanup.failed, 'summary.cleanup.failures must list every failed deletion');
field('summary', s, 'endpoints', ['array']);
field('summary', s, 'findings', ['array']);
field('summary', s, 'framework', ['object', 'null']);
field('summary', s, 'allureReport', ['string', 'null'], ['reports/allure-report', null]);
if (s.testFramework === 'pactum') need(s.allureReport === null, 'a pactum run has no Allure report yet, allureReport must be null');

const claudeCalls = isObj(s.claudeCalls) ? s.claudeCalls : {};
need(isObj(s.claudeCalls), 'summary.claudeCalls is missing');
for (const k of ['used', 'budget']) need(isInt(claudeCalls[k]), `summary.claudeCalls.${k} is not a count`);

const totals = isObj(s.totals) ? s.totals : {};
need(isObj(s.totals), 'summary.totals is missing');
for (const k of ['endpoints', 'testsGenerated', 'passed', 'failed']) need(isInt(totals[k]), `summary.totals.${k} is not a count`);

// Safety (section 7)
const safety = isObj(s.safety) ? s.safety : {};
need(isObj(s.safety), 'summary.safety is missing');
field('summary.safety', safety, 'hostClass', ['string'], ['local', 'non-production', 'production']);
field('summary.safety', safety, 'mode', ['string'], ['full', 'read-only', 'refused']);
field('summary.safety', safety, 'allowProduction', ['boolean']);
field('summary.safety', safety, 'allowWrites', ['boolean']);
const mode = safety.mode;
need((s.status === 'refused') === (mode === 'refused'), `status "${s.status}" and safety.mode "${mode}": a run is refused exactly when the mode is "refused"`);
if (safety.hostClass !== 'production') need(mode === 'full', `safety.mode is "${mode}" for a ${safety.hostClass} host, expected "full"`);
else if (!safety.allowProduction) need(mode === 'refused', `production host without allowProduction must be "refused", got "${mode}"`);
else need(mode === (safety.allowWrites ? 'full' : 'read-only'), `production host with allowProduction${safety.allowWrites ? ' and allowWrites' : ''} must be "${safety.allowWrites ? 'full' : 'read-only'}", got "${mode}"`);
if (mode === 'refused') need(s.requestsSent === 0, `a refused run sent ${s.requestsSent} requests, expected 0`);

// Endpoints
const endpoints = (Array.isArray(s.endpoints) ? s.endpoints : []).filter(isObj);
need(totals.endpoints === endpoints.length, `totals.endpoints is ${totals.endpoints} but there are ${endpoints.length} endpoints`);
need(endpoints.length === (Array.isArray(s.endpoints) ? s.endpoints.length : 0), 'summary.endpoints has entries that are not objects');
let sumPassed = 0;
let sumFailed = 0;
const skippedIds = new Set<string>();
for (const [i, e] of endpoints.entries()) {
  const where = `endpoints[${i}] (${String(e.id)})`;
  field(where, e, 'id', ['string']);
  field(where, e, 'method', ['string'], ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
  field(where, e, 'path', ['string']);
  field(where, e, 'requiresAuth', ['boolean']);
  field(where, e, 'probeStatus', ['number', 'null']);
  field(where, e, 'specWritten', ['boolean']);
  field(where, e, 'specFile', ['string', 'null']);
  field(where, e, 'failureReason', ['string', 'null']);
  field(where, e, 'skippedReason', ['string', 'null']);
  for (const k of ['casesPlanned', 'passed', 'failed']) need(isInt(e[k]), `${where}.${k} is not a count`);
  need((e.specFile === null) === (e.specWritten === false), `${where}: specFile must be null exactly when specWritten is false`);
  sumPassed += Number(e.passed) || 0;
  sumFailed += Number(e.failed) || 0;
  if (e.skippedReason !== null && e.skippedReason !== undefined) {
    skippedIds.add(String(e.id));
    need(e.skippedReason === 'skipped: read-only mode', `${where}.skippedReason is ${JSON.stringify(e.skippedReason)}, expected "skipped: read-only mode"`);
    need(mode === 'read-only', `${where} is skipped but safety.mode is "${mode}"`);
    need(e.passed === 0 && e.failed === 0, `${where} is skipped but counts ${e.passed} passed, ${e.failed} failed`);
    need(e.specWritten === false && e.casesPlanned === 0 && e.probeStatus === null, `${where} is skipped but was probed, planned or generated`);
  }
}
need(sumPassed === totals.passed, `endpoints pass counts add up to ${sumPassed}, totals.passed is ${totals.passed}`);
need(sumFailed === totals.failed, `endpoints fail counts add up to ${sumFailed}, totals.failed is ${totals.failed}`);
need(Number(totals.passed) + Number(totals.failed) === totals.testsGenerated, 'totals.passed + totals.failed must equal totals.testsGenerated');

// Findings (rule 4 in CLAUDE.md)
const findings = (Array.isArray(s.findings) ? s.findings : []).filter(isObj);
for (const [i, f] of findings.entries()) {
  const where = `findings[${i}] (${String(f.testTitle)})`;
  for (const k of ['endpointId', 'testTitle', 'type', 'error']) field(where, f, k, ['string']);
  field(where, f, 'expectedStatus', ['string', 'null']);
  field(where, f, 'actualStatus', ['number', 'null']);
  field(where, f, 'classification', ['string'], ['suspected API finding', 'needs review']);
  const actual = typeof f.actualStatus === 'number' ? f.actualStatus : null;
  const apiFinding = actual !== null && (actual >= 500 || ((f.type === 'auth' || f.type === 'authz' || f.type === 'invalid-input') && actual >= 200 && actual < 300));
  need((f.classification === 'suspected API finding') === apiFinding, `${where}: classification "${f.classification}" breaks rule 4 for type ${f.type}, actual ${actual}`);
  need(!skippedIds.has(String(f.endpointId)), `${where}: finding for a skipped endpoint`);
}
need(findings.length === totals.failed, `${findings.length} findings but totals.failed is ${totals.failed}`);

// Framework (section 4)
if (isObj(s.framework)) {
  const fw = s.framework;
  for (const k of ['name', 'dir', 'zip']) field('framework', fw, k, ['string']);
  need(Array.isArray(fw.files) && fw.files.every((x) => typeof x === 'string'), 'framework.files must be a list of paths');
  need(isInt(fw.specCount), 'framework.specCount is not a count');
}
if (s.status === 'refused' || s.status === 'no-tests') {
  need(s.framework === null, `a ${s.status} run must have framework null`);
  need(totals.testsGenerated === 0, `a ${s.status} run must have 0 tests`);
}

if (problems.length) {
  console.log(`contract check FAILED (${file})\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(
  `contract check clean (${file}): status ${s.status}, ${safety.hostClass} host, ${mode} mode, ${endpoints.length} endpoints (${skippedIds.size} skipped), ${findings.length} findings, ${s.requestsSent} requests sent`,
);
