// Production safety guard. Decides from the base URL whether the agent may send requests, and which.
// No imports: the framework export copies this file as it is. ui/host-class.mjs repeats classifyHost
// for the UI; agent/safety.test.ts checks that both give the same answer.
//
//   local or non-production host            -> mode "full"
//   production host, allowProduction false  -> mode "refused": no request is sent at all
//   production host, allowProduction true   -> mode "read-only": GET, HEAD and OPTIONS only
//   production host, allowWrites true too   -> mode "full", with a warning
//
// Hosted mode (HOSTED=1, the agent running on a shared server for other people): local and private
// hosts are refused too, since they would be the server's own network, and a production host never
// gets full mode (allowWrites is ignored there). Hosted mode can only make the result stricter.

export type HostClass = 'local' | 'non-production' | 'production';
export type SafetyMode = 'full' | 'read-only' | 'refused';
export type Safety = { host: string; hostClass: HostClass; mode: SafetyMode; allowProduction: boolean; allowWrites: boolean; hosted?: boolean };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'host.docker.internal']);
const NON_PRODUCTION_PARTS = new Set(['dev', 'test', 'qa', 'staging', 'stage', 'sandbox', 'uat', 'preprod']);
export const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const READ_ONLY_SKIP = 'skipped: read-only mode';
export const PRODUCTION_WRITES_WARNING = 'WARNING: write requests enabled against a production host';

export class ProductionRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProductionRefused';
  }
}

export class ReadOnlyBlocked extends Error {
  constructor(method: string, path: string) {
    super(`ReadOnlyBlocked: ${method} ${path} is not sent in read-only mode (production host)`);
    this.name = 'ReadOnlyBlocked';
  }
}

// Lowercase hostname without IPv6 brackets or a trailing dot. "" when the URL cannot be parsed.
export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  } catch {
    return '';
  }
}

function isPrivateIPv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m || m.slice(1).some((n) => Number(n) > 255)) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// Anything not recognised, an unparseable URL included, is production.
export function classifyHost(baseUrl: string): HostClass {
  const host = hostOf(baseUrl);
  if (!host) return 'production';
  if (LOCAL_HOSTS.has(host) || host.endsWith('.local') || isPrivateIPv4(host)) return 'local';
  // Whole parts only: "api-staging.example.com" is non-production, "latest.example.com" is not.
  if (host.split(/[.-]/).some((part) => NON_PRODUCTION_PARTS.has(part))) return 'non-production';
  return 'production';
}

// forceProduction (AGENT_FORCE_PRODUCTION=1, for testing) can only make the result stricter.
// hosted defaults to the HOSTED=1 environment variable so every caller (probe, ctx fixture, export,
// UI) applies it without being told; passing hosted: false never relaxes it when HOSTED=1 is set.
export function isHosted(): boolean {
  return typeof process !== 'undefined' && process.env?.HOSTED === '1';
}

export function assessSafety(
  config: { baseUrl: string; allowProduction?: boolean; allowWrites?: boolean },
  opts: { forceProduction?: boolean; hosted?: boolean } = {},
): Safety {
  const hostClass: HostClass = opts.forceProduction ? 'production' : classifyHost(config.baseUrl);
  const hosted = isHosted() || opts.hosted === true;
  const allowProduction = config.allowProduction === true;
  const allowWrites = config.allowWrites === true;
  let mode: SafetyMode = 'full';
  if (hostClass === 'production') mode = !allowProduction ? 'refused' : allowWrites && !hosted ? 'full' : 'read-only';
  if (hostClass === 'local' && hosted) mode = 'refused';
  const safety: Safety = { host: hostOf(config.baseUrl) || config.baseUrl, hostClass, mode, allowProduction, allowWrites };
  if (hosted) safety.hosted = true;
  return safety;
}

export function refusalMessage(safety: Safety): string {
  if (safety.hostClass === 'local') return `REFUSED: ${safety.host} is a local or private address; the hosted agent only tests public non-production hosts.`;
  return `REFUSED: ${safety.host} looks like a production host. Set allowProduction to run read-only tests.`;
}

// In read-only mode only reads without setup run: a setup step would POST to create the resource.
export function endpointAllowed(safety: Safety, endpoint: { method: string; setup?: unknown }): boolean {
  return safety.mode === 'full' || (safety.mode === 'read-only' && READ_METHODS.has(endpoint.method.toUpperCase()) && !endpoint.setup);
}
