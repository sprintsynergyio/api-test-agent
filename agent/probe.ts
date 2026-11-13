import 'dotenv/config';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, selectionLine, takeSelectFlag, type Config, type Endpoint } from './config';
import { cleanupLine, cleanupResources, createClients, disposeClients, resolvePath, runSetup, type CleanupTotals, type Clients } from './http';
import { queryString, setupSteps } from './model';
import { describeRedaction, redactHeaders, redactText, redactValue, type RedactionCounter } from './redact';
import { endpointAllowed } from './safety';

const PROBE_DIR = 'out/probes';
const REQUEST_TIMEOUT_MS = 30_000;

export type ProbeResult = {
  endpointId: string;
  method: string;
  path: string;
  requestBody: unknown;
  query: Record<string, string | number | boolean> | null;
  headers: Record<string, string> | null;
  status: number | null;
  contentType: string | null;
  body?: unknown;
  bodyText?: string;
  durationMs: number;
  usable: boolean;
  error?: string;
};

const isSuccess = (status: number | null) => status !== null && status >= 200 && status < 300;

export function readProbe(endpointId: string, file = join(PROBE_DIR, `${endpointId}.json`)): ProbeResult {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as ProbeResult;
  } catch (err) {
    throw new Error(`Cannot read probe file ${file} (run npm run probe first): ${firstLine(err)}`);
  }
}

// Playwright errors append a multi-line call log that includes request headers (auth value).
// Keep only the first line so the console line stays parseable and no secret is written out.
function firstLine(err: unknown): string {
  return String((err as Error)?.message ?? err).split('\n')[0];
}

function truncateArrays(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 3).map(truncateArrays);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, truncateArrays(v)]));
  }
  return value;
}

async function probeEndpoint(config: Config, clients: Clients, endpoint: Endpoint): Promise<ProbeResult> {
  const result: ProbeResult = {
    endpointId: endpoint.id,
    method: endpoint.method,
    path: endpoint.path,
    requestBody: endpoint.body ?? null,
    query: endpoint.query ?? null,
    headers: endpoint.headers ?? null,
    status: null,
    contentType: null,
    durationMs: 0,
    usable: false,
  };

  if (endpoint.setup) {
    try {
      const params = await runSetup(config, clients, endpoint);
      result.path = resolvePath(endpoint.path, params);
    } catch (err) {
      const via = setupSteps(endpoint).map((s) => s.endpointId).join(', ');
      result.error = `setup via ${via} failed: ${firstLine(err)}`;
      return result;
    }
  }

  const client = endpoint.requiresAuth ? clients.api : clients.noAuthApi;
  const started = Date.now();
  try {
    const response = await client.fetch(result.path, { method: endpoint.method, data: endpoint.body, params: endpoint.query, headers: endpoint.headers });
    const text = await response.text();
    result.durationMs = Date.now() - started;
    result.status = response.status();
    result.contentType = response.headers()['content-type'] ?? null;
    result.usable = isSuccess(result.status);
    try {
      if (text.trim() === '') throw new Error('empty');
      result.body = truncateArrays(JSON.parse(text));
    } catch {
      result.bodyText = text;
    }
  } catch (err) {
    result.durationMs = Date.now() - started;
    result.error = `request ${endpoint.method} ${result.path}${queryString(endpoint.query)} failed: ${firstLine(err)}`;
  }
  return result;
}

export type ProbeRun = { results: Map<string, ProbeResult>; requestsSent: number; redaction: RedactionCounter; cleanup: CleanupTotals };

// What the plan and generate prompts and out/probes/*.json see: the redacted probe (agent/redact.ts).
// Status, content type, timing and the shape of the body are kept; personal and secret-looking values
// are not. The request body gets valid stand-ins because the generated tests copy it.
export function redactProbe(result: ProbeResult, config: Config, counter: RedactionCounter): ProbeResult {
  return {
    ...result,
    path: redactText(result.path, counter),
    requestBody: redactValue(result.requestBody, config.redaction, counter, 'request'),
    headers: redactHeaders(result.headers, counter) ?? null,
    ...(result.body !== undefined ? { body: redactValue(result.body, config.redaction, counter) } : {}),
    ...(result.bodyText !== undefined ? { bodyText: redactText(result.bodyText, counter) } : {}),
    ...(result.error !== undefined ? { error: redactText(result.error, counter) } : {}),
  };
}

// Endpoints the safety guard does not allow (read-only mode) are not probed: "<id> SKIPPED read-only mode".
// createClients throws ProductionRefused before any request when the host is refused.
export async function probeAll(config: Config, authValue: string | undefined, opts: { forceProduction?: boolean } = {}): Promise<ProbeRun> {
  rmSync(PROBE_DIR, { recursive: true, force: true });
  mkdirSync(PROBE_DIR, { recursive: true });

  const clients = await createClients(config, authValue, { timeoutMs: REQUEST_TIMEOUT_MS, forceProduction: opts.forceProduction });
  const results = new Map<string, ProbeResult>();
  const redaction: RedactionCounter = { replaced: 0 };
  let cleanup: CleanupTotals;
  try {
    for (const endpoint of config.endpoints) {
      if (!endpointAllowed(clients.safety, endpoint)) {
        console.log(`${endpoint.id} SKIPPED read-only mode`);
        continue;
      }
      let result = await probeEndpoint(config, clients, endpoint);
      // A non-2xx probe is not usable for planning. Retry once (setup runs again, so a fresh id).
      if (result.status !== null && !result.usable) {
        result = await probeEndpoint(config, clients, endpoint);
      }
      // Only the redacted probe is kept: on disk, in the prompts, in memory.
      result = redactProbe(result, config, redaction);
      writeFileSync(join(PROBE_DIR, `${endpoint.id}.json`), JSON.stringify(result, null, 2) + '\n');
      if (result.status === null) console.log(`${endpoint.id} FAILED ${result.error}`);
      else if (!result.usable) console.log(`${endpoint.id} FAILED returned ${result.status} after retry`);
      else console.log(`${endpoint.id} OK ${result.status}`);
      results.set(endpoint.id, result);
    }
    console.log(describeRedaction(config.redaction, redaction));
    // The probe's setup steps created resources on the target API: delete them now.
    cleanup = await cleanupResources(config, clients);
    console.log(cleanupLine(cleanup));
    for (const f of cleanup.failures) console.log(`  cleanup failed: ${f}`);
  } finally {
    await disposeClients(clients);
  }
  return { results, requestsSent: clients.counter.sent, redaction, cleanup };
}

async function main() {
  const inputFile = takeSelectFlag(process.argv.slice(2))[0] || 'input/endpoints.json';
  const config = loadConfig(inputFile);
  const line = selectionLine(config);
  if (line) console.log(line);
  const authValue = config.auth ? process.env[config.auth.valueEnv] : undefined;
  if (config.auth && !authValue) {
    throw new Error(`Missing auth value: environment variable ${config.auth.valueEnv} is not set (required by ${inputFile}).`);
  }
  await probeAll(config, authValue, { forceProduction: process.env.AGENT_FORCE_PRODUCTION === '1' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`probe FAILED ${(err as Error).message}`);
    process.exit(1);
  });
}
