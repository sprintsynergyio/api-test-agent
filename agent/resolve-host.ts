import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { hostOf } from './safety';

// The addresses a base URL's host name resolves to, for the safety guard (assessSafety's resolved option).
// An IP literal or a name that does not resolve gives []: the name-based rules then decide alone, and a
// name that does not resolve fails at the first request anyway. Never throws.
export async function resolveHostAddresses(baseUrl: string, timeoutMs = 3000): Promise<string[]> {
  const host = hostOf(baseUrl);
  if (!host || isIP(host)) return [];
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      lookup(host, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      }),
    ]);
    return result.map((r) => r.address);
  } catch {
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}
