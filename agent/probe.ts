import 'dotenv/config';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pickAuthEnv } from './auth';
import { loadConfig, selectionLine, takeSelectFlag, type Config, type Endpoint } from './config';
import { cleanupLine, cleanupResources, createClients, disposeClients, resolvePath, runSetup, type CleanupTotals, type Clients } from './http';
import { fileSignature, isBinaryContentType, queryString, setupSteps } from './model';
import { describeRedaction, redactHeaders, redactText, redactValue, type RedactionCounter } from './redact';
import { CASE_PROBE_CAP } from './probe-cap';
import { endpointAllowed } from './safety';

const PROBE_DIR = 'out/probes';
// Response headers the probe keeps for the prompts (all safe to show: no auth, no cookies).
const PROBE_HEADERS = ['content-type', 'cache-control', 'content-length', 'content-disposition', 'etag', 'last-modified'];
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
  // A binary body (an image, a PDF, ...): its size and file signature instead of the bytes. Tests of
  // such an endpoint assert the headers, the size and the signature, never a JSON field.
  binary?: { bytes: number; signature: string | null; signatureHex: string | null };
  // A few response headers tests may assert (content type, caching, size, file name). Never auth.
  responseHeaders?: Record<string, string>;
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

  if (endpoint.setup || endpoint.pathParams) {
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
    const headers = response.headers();
    result.contentType = headers['content-type'] ?? null;
    const shownHeaders = Object.fromEntries(PROBE_HEADERS.filter((h) => headers[h] !== undefined).map((h) => [h, headers[h]]));
    if (Object.keys(shownHeaders).length) result.responseHeaders = shownHeaders;
    if (isBinaryContentType(result.contentType)) {
      const bytes = await response.body();
      result.durationMs = Date.now() - started;
      result.status = response.status();
      result.usable = isSuccess(result.status);
      const sig = fileSignature(bytes);
      result.binary = { bytes: bytes.length, signature: sig?.kind ?? null, signatureHex: sig?.hex ?? null };
      return result;
    }
    const text = await response.text();
    result.durationMs = Date.now() - started;
    result.status = response.status();
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

export type ProbeRun = { results: Map<string, ProbeResult>; requestsSent: number; secrets: string[]; redaction: RedactionCounter; cleanup: CleanupTotals };

// What the plan and generate prompts and out/probes/*.json see: the redacted probe (agent/redact.ts).
// Status, content type, timing and the shape of the body are kept; personal and secret-looking values
// are not. The request body gets valid stand-ins because the generated tests copy it.
export function redactProbe(result: ProbeResult, config: Config, counter: RedactionCounter): ProbeResult {
  return {
    ...result,
    path: redactText(result.path, counter),
    requestBody: redactValue(result.requestBody, config.redaction, counter, 'request'),
    headers: redactHeaders(result.headers, counter) ?? null,
    ...(result.responseHeaders ? { responseHeaders: redactHeaders(result.responseHeaders, counter) ?? undefined } : {}),
    ...(result.body !== undefined ? { body: redactValue(result.body, config.redaction, counter) } : {}),
    ...(result.bodyText !== undefined ? { bodyText: redactText(result.bodyText, counter) } : {}),
    ...(result.error !== undefined ? { error: redactText(result.error, counter) } : {}),
  };
}

// Endpoints the safety guard does not allow (read-only mode) are not probed: "<id> SKIPPED read-only mode".
// createClients throws ProductionRefused before any request when the host is refused. authEnv holds
// only the environment variables the auth section names (pickAuthEnv); the default role probes.
// opts.only (resume): probe just these endpoint ids and keep the other out/probes files.
export async function probeAll(config: Config, authEnv: Record<string, string | undefined>, opts: { forceProduction?: boolean; only?: Set<string> } = {}): Promise<ProbeRun> {
  if (!opts.only) rmSync(PROBE_DIR, { recursive: true, force: true });
  mkdirSync(PROBE_DIR, { recursive: true });
  const endpoints = opts.only ? config.endpoints.filter((e) => opts.only!.has(e.id)) : config.endpoints;

  const clients = await createClients(config, authEnv, { timeoutMs: REQUEST_TIMEOUT_MS, forceProduction: opts.forceProduction });
  const results = new Map<string, ProbeResult>();
  const redaction: RedactionCounter = { replaced: 0 };
  let cleanup: CleanupTotals;
  try {
    for (const endpoint of endpoints) {
      if (!endpointAllowed(clients.safety, endpoint)) {
        console.log(`${endpoint.id} SKIPPED read-only mode`);
        continue;
      }
      let result = await probeEndpoint(config, clients, endpoint);
      // A non-2xx probe is not usable for planning. Retry once (setup runs again, so a fresh id).
      // A 429 was already retried by the HTTP layer (Retry-After, then back-off): the endpoint is
      // rate limited, not retried again here.
      if (result.status === 429) result.error = 'rate limited: still 429 after the HTTP layer retried with back-off';
      else if (result.status !== null && !result.usable) {
        result = await probeEndpoint(config, clients, endpoint);
      }
      // Only the redacted probe is kept: on disk, in the prompts, in memory.
      result = redactProbe(result, config, redaction);
      writeFileSync(join(PROBE_DIR, `${endpoint.id}.json`), JSON.stringify(result, null, 2) + '\n');
      if (result.status === null) console.log(`${endpoint.id} FAILED ${result.error}`);
      else if (result.status === 429) console.log(`${endpoint.id} FAILED ${result.error}`);
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
  return { results, requestsSent: clients.counter.sent, secrets: clients.secrets(), redaction, cleanup };
}

// Per-case probes: a sheet case whose own request puts other values in the path (GET /products/42 for
// /products/{id}) gets one GET of exactly that request, so the plan sees what that case's response
// looks like. Safe by default:
// - GET only. Write cases (POST, PUT, PATCH, DELETE) are never probed; they use the endpoint's probe.
// - No setup: a case whose path still needs a created resource is not probed (that would write).
// - At most `cap` requests per run (--case-probes, default 20; 0 turns them off), DELAY_MS apart, all
//   counted in requestsSent. Read-only mode and the production guard apply (createClients, endpointAllowed).
// The sheet still decides the expected status (agent/plan.ts sheetStatusDecision); a probe that disagrees
// is an early warning, and the test run is the evidence.
export { CASE_PROBE_CAP };
const CASE_PROBE_DELAY_MS = 200;

export type CaseProbeRequest = { caseId: string; endpoint: Endpoint; pathValues: Record<string, string> };
export type CaseProbeRun = { results: Map<string, ProbeResult>; notProbed: { caseId: string; endpointId: string; reason: string }[]; requestsSent: number; secrets: string[]; redaction: RedactionCounter };

export function caseProbePlan(requests: CaseProbeRequest[], cap: number): { send: CaseProbeRequest[]; notProbed: CaseProbeRun['notProbed'] } {
  const send: CaseProbeRequest[] = [];
  const notProbed: CaseProbeRun['notProbed'] = [];
  for (const r of requests) {
    const why =
      r.endpoint.method !== 'GET'
        ? `a ${r.endpoint.method} request is never probed per case (it would write); the endpoint's probe shows the response shape`
        : missingValues(r)
          ? `its path still needs ${missingValues(r)}, which only a setup step (a write) can create`
          : send.length >= cap
            ? `the per-run cap of ${cap} case probes is reached (--case-probes)`
            : null;
    if (why) notProbed.push({ caseId: r.caseId, endpointId: r.endpoint.id, reason: why });
    else send.push(r);
  }
  return { send, notProbed };
}

function missingValues(r: CaseProbeRequest): string {
  const known = { ...(r.endpoint.pathParams ?? {}), ...r.pathValues };
  return [...r.endpoint.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]).filter((n) => !(n in known)).map((n) => `{${n}}`).join(', ');
}

export async function probeCases(config: Config, authEnv: Record<string, string | undefined>, requests: CaseProbeRequest[], opts: { cap?: number; forceProduction?: boolean } = {}): Promise<CaseProbeRun> {
  const cap = opts.cap ?? CASE_PROBE_CAP;
  const { send, notProbed } = caseProbePlan(requests, cap);
  const results = new Map<string, ProbeResult>();
  const redaction: RedactionCounter = { replaced: 0 };
  if (!send.length) return { results, notProbed, requestsSent: 0, secrets: [], redaction };
  mkdirSync(PROBE_DIR, { recursive: true });
  const clients = await createClients(config, authEnv, { timeoutMs: REQUEST_TIMEOUT_MS, forceProduction: opts.forceProduction });
  const byEndpoint = new Map<string, Record<string, ProbeResult>>();
  try {
    for (const [i, r] of send.entries()) {
      if (!endpointAllowed(clients.safety, r.endpoint)) {
        notProbed.push({ caseId: r.caseId, endpointId: r.endpoint.id, reason: 'read-only mode' });
        continue;
      }
      if (i > 0) await new Promise((done) => setTimeout(done, CASE_PROBE_DELAY_MS));
      const path = resolvePath(r.endpoint.path, { ...(r.endpoint.pathParams ?? {}), ...r.pathValues });
      // The endpoint's own request with this case's path; never its setup.
      const result = redactProbe(await probeEndpoint(config, clients, { ...r.endpoint, path, setup: undefined, pathParams: undefined }), config, redaction);
      results.set(r.caseId, result);
      byEndpoint.set(r.endpoint.id, { ...(byEndpoint.get(r.endpoint.id) ?? {}), [r.caseId]: result });
      console.log(`  case ${r.caseId} (${r.endpoint.id}) ${result.status === null ? `FAILED ${result.error}` : `${result.usable ? 'OK' : 'answered'} ${result.status}`}`);
    }
    for (const [id, cases] of byEndpoint) writeFileSync(join(PROBE_DIR, `${id}.cases.json`), JSON.stringify(cases, null, 2) + '\n');
  } finally {
    await disposeClients(clients);
  }
  return { results, notProbed, requestsSent: clients.counter.sent, secrets: clients.secrets(), redaction };
}

async function main() {
  const inputFile = takeSelectFlag(process.argv.slice(2))[0] || 'input/endpoints.json';
  const config = loadConfig(inputFile);
  const line = selectionLine(config);
  if (line) console.log(line);
  await probeAll(config, pickAuthEnv(config.auth, process.env), { forceProduction: process.env.AGENT_FORCE_PRODUCTION === '1' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`probe FAILED ${(err as Error).message}`);
    process.exit(1);
  });
}
