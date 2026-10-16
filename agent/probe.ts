import 'dotenv/config';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, type Config, type Endpoint } from './config';
import { createClients, createResource, disposeClients, resolvePath, type Clients } from './http';

const PROBE_DIR = 'out/probes';
const REQUEST_TIMEOUT_MS = 30_000;

export type ProbeResult = {
  endpointId: string;
  method: string;
  path: string;
  requestBody: unknown;
  status: number | null;
  contentType: string | null;
  body?: unknown;
  bodyText?: string;
  durationMs: number;
  error?: string;
};

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
    status: null,
    contentType: null,
    durationMs: 0,
  };

  if (endpoint.setup) {
    try {
      const id = await createResource(config, clients, endpoint.setup.endpointId, endpoint.setup.idField);
      result.path = resolvePath(endpoint.path, id);
    } catch (err) {
      result.error = `setup via ${endpoint.setup.endpointId} failed: ${firstLine(err)}`;
      return result;
    }
  }

  const client = endpoint.requiresAuth ? clients.api : clients.noAuthApi;
  const started = Date.now();
  try {
    const response = await client.fetch(result.path, { method: endpoint.method, data: endpoint.body });
    const text = await response.text();
    result.durationMs = Date.now() - started;
    result.status = response.status();
    result.contentType = response.headers()['content-type'] ?? null;
    try {
      if (text.trim() === '') throw new Error('empty');
      result.body = truncateArrays(JSON.parse(text));
    } catch {
      result.bodyText = text;
    }
  } catch (err) {
    result.durationMs = Date.now() - started;
    result.error = `request ${endpoint.method} ${result.path} failed: ${firstLine(err)}`;
  }
  return result;
}

export async function probeAll(config: Config, authValue: string): Promise<ProbeResult[]> {
  rmSync(PROBE_DIR, { recursive: true, force: true });
  mkdirSync(PROBE_DIR, { recursive: true });

  const clients = await createClients(config, authValue, REQUEST_TIMEOUT_MS);
  const results: ProbeResult[] = [];
  try {
    for (const endpoint of config.endpoints) {
      const result = await probeEndpoint(config, clients, endpoint);
      writeFileSync(join(PROBE_DIR, `${endpoint.id}.json`), JSON.stringify(result, null, 2) + '\n');
      console.log(result.status === null ? `${endpoint.id} FAILED ${result.error}` : `${endpoint.id} OK ${result.status}`);
      results.push(result);
    }
  } finally {
    await disposeClients(clients);
  }
  return results;
}

async function main() {
  const inputFile = process.argv[2] || 'input/endpoints.json';
  const config = loadConfig(inputFile);
  const authValue = process.env[config.auth.valueEnv];
  if (!authValue) {
    throw new Error(`Missing auth value: environment variable ${config.auth.valueEnv} is not set (required by ${inputFile}).`);
  }
  await probeAll(config, authValue);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`probe FAILED ${(err as Error).message}`);
    process.exit(1);
  });
}
