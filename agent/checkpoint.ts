import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Config, Endpoint } from './config';
import type { Plan } from './plan';
import type { ProbeResult } from './probe';

// out/checkpoint.json: where a run got to, per endpoint, so a stopped run (budget, crash, Ctrl+C) can
// continue with --resume instead of paying for every plan and spec again, and so --only-new can
// regenerate just the endpoints whose definition changed. Written atomically (temp file, then rename)
// after the probe, after every plan and after every spec, so a crash never leaves a half-written file.
//
// Rule 5 still holds: the checkpoint records failures as failures. A resume redoes every endpoint that
// did not reach the "generated" stage, and the summary of a stopped run says "stopped-budget".

export const CHECKPOINT_FILE = 'out/checkpoint.json';
const VERSION = 1;

export type Stage = 'probed' | 'planned' | 'generated' | 'failed';

export type EndpointCheckpoint = {
  hash: string;
  stage: Stage;
  probe?: ProbeResult;
  plan?: Plan;
  specFile?: string;
  failureReason?: string;
  skippedReason?: string;
};

export type Checkpoint = {
  version: number;
  inputFile: string;
  inputHash: string;
  framework: string;
  startedAt: string;
  updatedAt: string;
  endpoints: Record<string, EndpointCheckpoint>;
};

function sha(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

// The whole resolved input: a different base URL, auth section, framework or endpoint list is a
// different run, so --resume starts fresh.
export function inputHash(config: Config): string {
  return sha(config);
}

// The parts of one endpoint that change what its tests look like.
export function endpointHash(endpoint: Endpoint): string {
  return sha({
    id: endpoint.id,
    method: endpoint.method,
    path: endpoint.path,
    requiresAuth: endpoint.requiresAuth,
    body: endpoint.body ?? null,
    query: endpoint.query ?? null,
    headers: endpoint.headers ?? null,
    setup: endpoint.setup ?? null,
  });
}

export function newCheckpoint(config: Config, inputFile: string, framework: string): Checkpoint {
  const now = new Date().toISOString();
  return { version: VERSION, inputFile, inputHash: inputHash(config), framework, startedAt: now, updatedAt: now, endpoints: {} };
}

export function loadCheckpoint(file = CHECKPOINT_FILE): Checkpoint | null {
  if (!existsSync(file)) return null;
  let parsed: Checkpoint;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as Checkpoint;
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${(err as Error).message}); delete it or run without --resume`);
  }
  if (parsed.version !== VERSION || typeof parsed.inputHash !== 'string' || typeof parsed.endpoints !== 'object') {
    throw new Error(`${file} has an unknown shape; delete it or run without --resume`);
  }
  return parsed;
}

// Atomic: the temp file is fully written and flushed before it replaces the old checkpoint.
export function saveCheckpoint(cp: Checkpoint, file = CHECKPOINT_FILE): void {
  cp.updatedAt = new Date().toISOString();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.${Date.now()}-${process.pid}.checkpoint.tmp`);
  writeFileSync(tmp, JSON.stringify(cp, null, 2) + '\n', { flush: true });
  renameSync(tmp, file);
}

export type ScopeMode = 'fresh' | 'resume' | 'only-new';

// What --resume or --only-new can reuse from a checkpoint for one endpoint. An endpoint that is not
// "generated" is redone from its last good stage; a changed definition is redone from the start.
export function reusable(cp: Checkpoint | null, endpoint: Endpoint, mode: ScopeMode): EndpointCheckpoint | null {
  if (!cp || mode === 'fresh') return null;
  const entry = cp.endpoints[endpoint.id];
  if (!entry) return null;
  if (entry.hash !== endpointHash(endpoint)) return null;
  if (entry.stage === 'generated' && entry.specFile && !existsSync(join('generated', entry.specFile))) {
    // The spec file is gone: back to the plan.
    return { ...entry, stage: entry.plan ? 'planned' : entry.probe ? 'probed' : 'failed', specFile: undefined };
  }
  return entry;
}
