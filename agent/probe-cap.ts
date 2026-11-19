// Default per-run cap of per-case GET probes (agent/probe.ts probeCases, --case-probes). Kept apart from
// probe.ts so the flag parser does not load the HTTP layer.
export const CASE_PROBE_CAP = 20;
