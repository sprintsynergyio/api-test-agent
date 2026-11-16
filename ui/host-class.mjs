// classifyHost for the UI server and the browser: the same rules as agent/safety.ts, which is the
// source of truth. agent/safety.test.ts runs every case against both, so they cannot drift apart.

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "host.docker.internal"]);
const NON_PRODUCTION_PARTS = new Set(["dev", "test", "qa", "staging", "stage", "sandbox", "uat", "preprod"]);

export function hostOf(baseUrl) {
  try {
    return new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  } catch {
    return "";
  }
}

// IPv4 ranges that are this machine or a private network: 0/8, 10/8, 100.64/10 (CGNAT, Tailscale),
// 127/8 (loopback), 169.254/16 (link-local, cloud metadata), 172.16/12, 192.168/16.
function ipv4Parts(host) {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.some((n) => n > 255) ? null : parts;
}

function isLocalIPv4(host) {
  const p = ipv4Parts(host);
  if (!p) return false;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// The 8 hextets of an IPv6 address (an embedded dotted IPv4 tail included), or null.
function ipv6Hextets(host) {
  if (!host.includes(":") || !/^[0-9a-f:.]+$/.test(host)) return null;
  let text = host;
  const v4 = text.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) {
    const p = ipv4Parts(v4[2]);
    if (!p) return null;
    text = `${v4[1]}${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (all.some((h) => !/^[0-9a-f]{1,4}$/.test(h))) return null;
  return all.map((h) => parseInt(h, 16));
}

// IPv6 that is this machine or a private network: :: and ::1, fc00::/7 (unique local), fe80::/10
// (link-local), and IPv4-mapped or IPv4-compatible addresses whose IPv4 part is local.
function isLocalIPv6(host) {
  const h = ipv6Hextets(host);
  if (!h) return false;
  if (h.slice(0, 7).every((x) => x === 0) && (h[7] === 0 || h[7] === 1)) return true;
  if ((h[0] & 0xfe00) === 0xfc00 || (h[0] & 0xffc0) === 0xfe80) return true;
  const mapped = h.slice(0, 5).every((x) => x === 0) && (h[5] === 0xffff || h[5] === 0);
  if (mapped) return isLocalIPv4(`${h[6] >> 8}.${h[6] & 255}.${h[7] >> 8}.${h[7] & 255}`);
  return false;
}

// An IP address (no brackets) that is this machine or a private network.
export function isLocalAddress(address) {
  const a = address.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  return isLocalIPv4(a) || isLocalIPv6(a);
}

// "local", "non-production" or "production". Anything not recognised is production.
export function classifyHost(baseUrl) {
  const host = hostOf(baseUrl);
  if (!host) return "production";
  if (LOCAL_HOSTS.has(host) || host.endsWith(".local") || isLocalAddress(host)) return "local";
  if (host.split(/[.-]/).some((part) => NON_PRODUCTION_PARTS.has(part))) return "non-production";
  return "production";
}

export function refusalMessage(baseUrl) {
  return `REFUSED: ${hostOf(baseUrl) || baseUrl} looks like a production host. Set allowProduction to run read-only tests.`;
}

export function localRefusalMessage(baseUrl) {
  return `REFUSED: ${hostOf(baseUrl) || baseUrl} is a local or private address; the hosted agent only tests public non-production hosts.`;
}

// The mode the agent will pick, with the same rules as assessSafety in agent/safety.ts.
// hosted: local hosts are refused and a production host never gets full mode.
export function safetyMode(baseUrl, cfg, { forceProduction = false, hosted = false } = {}) {
  const hostClass = forceProduction ? "production" : classifyHost(baseUrl);
  let mode = "full";
  if (hostClass === "production") mode = cfg.allowProduction !== true ? "refused" : cfg.allowWrites === true && !hosted ? "full" : "read-only";
  if (hostClass === "local" && hosted) mode = "refused";
  return { hostClass, mode };
}
