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
export type Safety = { host: string; hostClass: HostClass; mode: SafetyMode; allowProduction: boolean; allowWrites: boolean; hosted?: boolean; resolvesToLocal?: string[] };

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

// IPv4 ranges that are this machine or a private network: 0/8, 10/8, 100.64/10 (CGNAT, Tailscale),
// 127/8 (loopback), 169.254/16 (link-local, cloud metadata), 172.16/12, 192.168/16.
function ipv4Parts(host: string): number[] | null {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.some((n) => n > 255) ? null : parts;
}

function isLocalIPv4(host: string): boolean {
  const p = ipv4Parts(host);
  if (!p) return false;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// The 8 hextets of an IPv6 address (an embedded dotted IPv4 tail included), or null.
function ipv6Hextets(host: string): number[] | null {
  if (!host.includes(':') || !/^[0-9a-f:.]+$/.test(host)) return null;
  let text = host;
  const v4 = text.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) {
    const p = ipv4Parts(v4[2]);
    if (!p) return null;
    text = `${v4[1]}${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (all.some((h) => !/^[0-9a-f]{1,4}$/.test(h))) return null;
  return all.map((h) => parseInt(h, 16));
}

// IPv6 that is this machine or a private network: :: and ::1, fc00::/7 (unique local), fe80::/10
// (link-local), and IPv4-mapped or IPv4-compatible addresses whose IPv4 part is local.
function isLocalIPv6(host: string): boolean {
  const h = ipv6Hextets(host);
  if (!h) return false;
  if (h.slice(0, 7).every((x) => x === 0) && (h[7] === 0 || h[7] === 1)) return true;
  if ((h[0] & 0xfe00) === 0xfc00 || (h[0] & 0xffc0) === 0xfe80) return true;
  const mapped = h.slice(0, 5).every((x) => x === 0) && (h[5] === 0xffff || h[5] === 0);
  if (mapped) return isLocalIPv4(`${h[6] >> 8}.${h[6] & 255}.${h[7] >> 8}.${h[7] & 255}`);
  return false;
}

// An IP address (no brackets) that is this machine or a private network.
export function isLocalAddress(address: string): boolean {
  const a = address.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  return isLocalIPv4(a) || isLocalIPv6(a);
}

// Anything not recognised, an unparseable URL included, is production.
export function classifyHost(baseUrl: string): HostClass {
  const host = hostOf(baseUrl);
  if (!host) return 'production';
  if (LOCAL_HOSTS.has(host) || host.endsWith('.local') || isLocalAddress(host)) return 'local';
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
  // resolved: the addresses the host name resolved to (resolve-host.ts in the agent). They can only make the result
  // stricter: a name that resolves to a local or private address keeps its class by name (so a production
  // name never gets full mode by DNS), is marked resolvesToLocal, and is refused in hosted mode.
  opts: { forceProduction?: boolean; hosted?: boolean; resolved?: string[] } = {},
): Safety {
  const hostClass: HostClass = opts.forceProduction ? 'production' : classifyHost(config.baseUrl);
  const hosted = isHosted() || opts.hosted === true;
  const allowProduction = config.allowProduction === true;
  const allowWrites = config.allowWrites === true;
  let mode: SafetyMode = 'full';
  if (hostClass === 'production') mode = !allowProduction ? 'refused' : allowWrites && !hosted ? 'full' : 'read-only';
  if (hostClass === 'local' && hosted) mode = 'refused';
  const resolvesToLocal = hostClass === 'local' ? [] : (opts.resolved ?? []).filter(isLocalAddress);
  if (resolvesToLocal.length && hosted) mode = 'refused';
  const safety: Safety = { host: hostOf(config.baseUrl) || config.baseUrl, hostClass, mode, allowProduction, allowWrites };
  if (hosted) safety.hosted = true;
  if (resolvesToLocal.length) safety.resolvesToLocal = resolvesToLocal;
  return safety;
}

export function refusalMessage(safety: Safety): string {
  if (safety.hosted && safety.resolvesToLocal?.length) return `REFUSED: ${safety.host} resolves to a local or private address (${safety.resolvesToLocal.join(', ')}); the hosted agent only tests public non-production hosts.`;
  if (safety.hostClass === 'local') return `REFUSED: ${safety.host} is a local or private address; the hosted agent only tests public non-production hosts.`;
  return `REFUSED: ${safety.host} looks like a production host. Set allowProduction to run read-only tests.`;
}

// In read-only mode only reads without setup run: a setup step would POST to create the resource.
export function endpointAllowed(safety: Safety, endpoint: { method: string; setup?: unknown }): boolean {
  return safety.mode === 'full' || (safety.mode === 'read-only' && READ_METHODS.has(endpoint.method.toUpperCase()) && !endpoint.setup);
}
