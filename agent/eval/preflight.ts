import { pickAuthEnv } from '../auth';
import { loadConfig } from '../config';
import { createClients, disposeClients } from '../http';
import { probeAll } from '../probe';

// Preflight for `npm run eval`: before any model call is paid for, prove that the eval input works
// against the local API as it is running now. No model, a handful of requests.
//
//   1. every endpoint probes with a usable (2xx) answer, with the default role's credentials
//   2. every extra role can authenticate (one read request per role)
//
// Returns the list of problems; empty means the runs may start. Nothing is swallowed: a thrown error
// (a failed login, a missing env variable) becomes a problem with its reason.
export async function preflight(inputFile: string, env: Record<string, string | undefined> = process.env): Promise<string[]> {
  const problems: string[] = [];
  const config = loadConfig(inputFile);
  const authEnv = pickAuthEnv(config.auth, env);

  try {
    const probe = await probeAll(config, authEnv);
    for (const endpoint of config.endpoints) {
      const result = probe.results.get(endpoint.id);
      if (!result) problems.push(`${endpoint.id}: not probed`);
      else if (!result.usable) problems.push(`${endpoint.id}: ${result.error ?? `returned ${result.status}`}`);
    }
  } catch (err) {
    problems.push(`probe: ${(err as Error).message}`);
  }

  // A role that cannot log in would make every [authz] test throw before its request: no actual
  // status, so never a finding, and the authz bug would read as "missed" in a run that looks valid.
  const readEndpoint = config.endpoints.find((e) => e.method === 'GET' && !e.path.includes('{'));
  let clients;
  try {
    clients = await createClients(config, authEnv);
    for (const role of clients.roles.filter((r) => r !== 'default')) {
      if (!readEndpoint) {
        problems.push(`role "${role}": not checked, the input has no GET endpoint without a path parameter`);
        continue;
      }
      try {
        const response = await clients.as(role).fetch(readEndpoint.path, { method: 'GET', params: readEndpoint.query, headers: readEndpoint.headers });
        if (response.status() === 401) problems.push(`role "${role}": ${readEndpoint.id} answered 401, its credentials are not accepted`);
      } catch (err) {
        problems.push(`role "${role}": ${(err as Error).message}`);
      }
    }
  } catch (err) {
    problems.push(`roles: ${(err as Error).message}`);
  } finally {
    if (clients) await disposeClients(clients);
  }
  return problems;
}
