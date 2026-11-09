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

function isPrivateIPv4(host) {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m || m.slice(1).some((n) => Number(n) > 255)) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// "local", "non-production" or "production". Anything not recognised is production.
export function classifyHost(baseUrl) {
  const host = hostOf(baseUrl);
  if (!host) return "production";
  if (LOCAL_HOSTS.has(host) || host.endsWith(".local") || isPrivateIPv4(host)) return "local";
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
