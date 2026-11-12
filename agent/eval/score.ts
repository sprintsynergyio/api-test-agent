import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Scores one agent run (out/summary.json) against the planted bugs that were active.
// Pure: no Claude call, no HTTP, no file writes.

export type DetectableBy = 'invalid-input' | 'auth' | 'authz' | 'schema' | 'flow' | 'none-yet';

export type PlantedBug = {
  id: string;
  description: string;
  endpointId: string;
  detectableBy: DetectableBy;
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
  return raw;
}

// Which finding types count as evidence for a bug type.
function matchesType(bugType: DetectableBy, findingType: string): boolean {
  if (bugType === 'none-yet') return false;
  return bugType === findingType;
}

export function scoreRun(summary: Summary, activeBugIds: string[], catalog: BugCatalog): Score {
  const known = new Map(catalog.bugs.map((b) => [b.id, b]));
  const unknown = activeBugIds.filter((id) => !known.has(id));
  if (unknown.length) throw new Error(`scoreRun: unknown bug id(s): ${unknown.join(', ')}`);
  const active = activeBugIds.map((id) => known.get(id)!);

  const suspected = summary.findings.filter((f) => f.classification === 'suspected API finding');

  const bugs: BugOutcome[] = active.map((bug) => {
    const matching = suspected.filter((f) => f.endpointId === bug.endpointId && matchesType(bug.detectableBy, f.type));
    const outcome: BugOutcome['outcome'] =
      bug.detectableBy === 'none-yet' ? 'expected-miss' : matching.length > 0 ? 'detected' : 'missed';
    return { id: bug.id, endpointId: bug.endpointId, detectableBy: bug.detectableBy, outcome, findings: matching.map((f) => f.testTitle) };
  });

  // A suspected finding is a false alarm when no active bug explains it (same endpoint and type).
  const explained = (f: SummaryFinding) => active.some((b) => b.endpointId === f.endpointId && matchesType(b.detectableBy, f.type));
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

// The set of (endpointId, type) pairs reported as suspected findings, for comparing runs.
export function findingKey(summary: Summary): string {
  return summary.findings
    .filter((f) => f.classification === 'suspected API finding')
    .map((f) => `${f.endpointId}:${f.type}`)
    .sort()
    .join('|');
}
