import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Scores one agent run (out/summary.json) against the planted bugs that were active.
// Pure: no Claude call, no HTTP, no file writes.

export type DetectableBy = 'invalid-input' | 'auth' | 'authz' | 'schema' | 'flow' | 'none-yet';

// The status class of the buggy answer: "5xx" (the API crashes) or "2xx" (the API accepts what it
// must reject). Every detectable bug has one; none-yet bugs do not need one.
export type Symptom = '5xx' | '2xx';

export type PlantedBug = {
  id: string;
  description: string;
  endpointId: string;
  detectableBy: DetectableBy;
  symptom?: Symptom;
};

export type BugCatalog = { default: string[]; bugs: PlantedBug[] };

// The parts of out/summary.json the scorer reads (ui/CONTRACT.md section 2).
export type SummaryFinding = {
  endpointId: string;
  testTitle: string;
  type: string;
  actualStatus: number | null;
  classification: 'suspected API finding' | 'needs review';
};

export type Summary = {
  status: string;
  durationSec: number;
  claudeCalls: { used: number; budget: number };
  totals: { endpoints: number; testsGenerated: number; passed: number; failed: number };
  findings: SummaryFinding[];
  // Per endpoint: why it was not tested (failureReason, skippedReason) and whether a spec exists.
  endpoints?: { id: string; specWritten?: boolean; failureReason?: string | null; skippedReason?: string | null }[];
};

export type BugOutcome = {
  id: string;
  endpointId: string;
  detectableBy: DetectableBy;
  // "detected": a matching suspected API finding exists.
  // "missed": detectable by today's test types, but no matching finding.
  // "expected-miss": detectableBy is none-yet; today's agent is not expected to catch it.
  outcome: 'detected' | 'missed' | 'expected-miss';
  findings: string[]; // test titles of the matching findings
};

export type FalseAlarm = { endpointId: string; type: string; testTitle: string; actualStatus: number | null };

export type Score = {
  bugs: BugOutcome[];
  falseAlarms: FalseAlarm[];
  // Over detectable bugs only (none-yet bugs are excluded from both numbers).
  detectable: number;
  detected: number;
  expectedMisses: number;
  suspectedFindings: number;
  claudeCalls: number;
  durationSec: number;
  status: string;
};

export function loadCatalog(file = fileURLToPath(new URL('../../local-api/bugs.json', import.meta.url))): BugCatalog {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as BugCatalog;
  if (!Array.isArray(raw.bugs) || !Array.isArray(raw.default)) throw new Error(`${file}: expected { default: [], bugs: [] }`);
  // A bug is credited by its signature: endpoint, test type and symptom. Two detectable bugs with the
  // same signature could not be told apart (one finding would credit both), so the catalog refuses them.
  const seen = new Map<string, string>();
  for (const bug of raw.bugs) {
    if (bug.detectableBy === 'none-yet') continue;
    if (bug.symptom !== '5xx' && bug.symptom !== '2xx') throw new Error(`${file}: bug "${bug.id}" needs "symptom": "5xx" or "2xx" (the status class of the buggy answer)`);
    const signature = `${bug.endpointId} [${bug.detectableBy}] ${bug.symptom}`;
    const other = seen.get(signature);
    if (other) throw new Error(`${file}: bugs "${other}" and "${bug.id}" share the signature ${signature}; the scorer could not tell them apart`);
    seen.set(signature, bug.id);
  }
  return raw;
}

export function statusClass(status: number | null): Symptom | null {
  if (status === null) return null;
  if (status >= 500) return '5xx';
  if (status >= 200 && status <= 299) return '2xx';
  return null;
}

// A finding is evidence for a bug when it is on the bug's endpoint, has the bug's test type and shows
// the bug's symptom. Endpoint and type alone are not enough: price-text-500 (500) and
// create-accepts-missing-name (201) are both invalid-input bugs on create-product.
function isEvidence(bug: PlantedBug, f: SummaryFinding): boolean {
  if (bug.detectableBy === 'none-yet') return false;
  return f.endpointId === bug.endpointId && f.type === bug.detectableBy && statusClass(f.actualStatus) === bug.symptom;
}

export function scoreRun(summary: Summary, activeBugIds: string[], catalog: BugCatalog): Score {
  const known = new Map(catalog.bugs.map((b) => [b.id, b]));
  const unknown = activeBugIds.filter((id) => !known.has(id));
  if (unknown.length) throw new Error(`scoreRun: unknown bug id(s): ${unknown.join(', ')}`);
  const active = activeBugIds.map((id) => known.get(id)!);

  const suspected = summary.findings.filter((f) => f.classification === 'suspected API finding');

  const bugs: BugOutcome[] = active.map((bug) => {
    const matching = suspected.filter((f) => isEvidence(bug, f));
    const outcome: BugOutcome['outcome'] =
      bug.detectableBy === 'none-yet' ? 'expected-miss' : matching.length > 0 ? 'detected' : 'missed';
    return { id: bug.id, endpointId: bug.endpointId, detectableBy: bug.detectableBy, outcome, findings: matching.map((f) => f.testTitle) };
  });

  // A suspected finding is a false alarm when no active bug explains it (same endpoint, type and symptom).
  const explained = (f: SummaryFinding) => active.some((b) => isEvidence(b, f));
  const falseAlarms: FalseAlarm[] = suspected
    .filter((f) => !explained(f))
    .map((f) => ({ endpointId: f.endpointId, type: f.type, testTitle: f.testTitle, actualStatus: f.actualStatus }));

  const detectableBugs = bugs.filter((b) => b.detectableBy !== 'none-yet');
  return {
    bugs,
    falseAlarms,
    detectable: detectableBugs.length,
    detected: detectableBugs.filter((b) => b.outcome === 'detected').length,
    expectedMisses: bugs.length - detectableBugs.length,
    suspectedFindings: suspected.length,
    claudeCalls: summary.claudeCalls?.used ?? 0,
    durationSec: summary.durationSec ?? 0,
    status: summary.status,
  };
}

export type Validity = { valid: true } | { valid: false; reason: string };

// A run may be scored only when the agent tested every endpoint of the input. Anything else is an
// invalid run, never a score: a bug on an endpoint that was never probed, planned or generated would
// read as "missed" and the detection rate would look like a measurement when it is a setup problem
// (a wrong auth value in .env once produced 0 of 36 that way). An invalid run fails the eval.
export function runValidity(summary: Summary): Validity {
  if (summary.status !== 'completed') return { valid: false, reason: `agent status "${summary.status}"` };
  const endpoints = summary.endpoints;
  if (!Array.isArray(endpoints) || endpoints.length === 0) return { valid: false, reason: 'the summary lists no endpoints, so nothing proves they were tested' };
  const untested = endpoints.filter((e) => e.failureReason || e.skippedReason || e.specWritten === false);
  if (untested.length === 0) return { valid: true };
  const why = untested.map((e) => `${e.id}: ${e.failureReason || e.skippedReason || 'no spec written'}`).join('; ');
  return { valid: false, reason: `${untested.length} of ${endpoints.length} endpoint(s) not tested (${why})` };
}

// The set of (endpointId, type, status class) triples reported as suspected findings, for comparing runs.
export function findingKey(summary: Summary): string {
  return summary.findings
    .filter((f) => f.classification === 'suspected API finding')
    .map((f) => `${f.endpointId}:${f.type}:${statusClass(f.actualStatus) ?? f.actualStatus}`)
    .sort()
    .join('|');
}
