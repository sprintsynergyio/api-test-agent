import { writeFileSync } from 'node:fs';

// FAKE_MODEL=1: a deterministic stand-in for the model, for tests of the pipeline itself (checkpoint,
// resume, budget, concurrency, parallel test runs). It reads the same prompts the real model gets and
// answers with a plan that follows the plan rules and a spec that follows the static gate, built from
// the endpoint config alone. It never calls a network. It is refused in hosted mode: a shared server
// must never report fake results as a run. The findings a fake run produces come only from how the
// target API answers the simple requests the fake spec sends; they prove the plumbing, not the model.

type Json = Record<string, unknown>;

function block(user: string, header: string): Json | null {
  const start = user.indexOf(`${header}\n`);
  if (start < 0) return null;
  const from = user.indexOf('{', start);
  if (from < 0) return null;
  // Pretty-printed JSON ends with a "}" alone on its line.
  const end = user.indexOf('\n}\n', from);
  if (end < 0) return null;
  try {
    return JSON.parse(user.slice(from, end + 2)) as Json;
  } catch {
    return null;
  }
}

function endpointBlock(user: string): Json {
  const e = block(user, 'ENDPOINT CONFIG:');
  if (!e) throw new Error('FAKE_MODEL: prompt has no ENDPOINT CONFIG block');
  return e;
}

function probeBlock(user: string): Json {
  const start = user.indexOf('PROBE (');
  if (start < 0) throw new Error('FAKE_MODEL: prompt has no PROBE block');
  const lineEnd = user.indexOf('\n', start);
  return block(user.slice(lineEnd), '') ?? (() => { throw new Error('FAKE_MODEL: PROBE block is not JSON'); })();
}

// Test case sheet prompts. The fake picks each case's type from the words and status codes in the
// case, the way a reader would, and marks a case needs review when it names no status code and none of
// the words below: the same contract the real model gets, kept deliberately simple.
function sheetBlock(user: string): { mode: string; cases: { caseId: string; title: string; steps?: string; expected?: string }[] } | null {
  const b = block(user, 'TEAM TEST CASES (from their test case sheet; each must be planned or marked needsReview):');
  return b ? (b as unknown as { mode: string; cases: { caseId: string; title: string; steps?: string; expected?: string }[] }) : null;
}

export function fakeSheetType(c: { title: string; steps?: string; expected?: string }, allowed: string[]): string | null {
  const text = `${c.title}\n${c.steps ?? ''}\n${c.expected ?? ''}`.toLowerCase();
  const expected = (c.expected ?? '').toLowerCase();
  const codes = [...expected.matchAll(/(?<![\d.])([1-5]\d\d)(?![\d.])/g)].map((m) => Number(m[1]));
  const noAuth = /\b(without|no|missing|invalid|expired)\b[^.\n]{0,30}\b(auth|token|authorization|credentials|api key|login)\b/.test(text);
  const otherRole = /\b(viewer|another role|other role|other user|different user|lower role|read-only user)\b/.test(text);
  if (noAuth || (codes.includes(401) && !otherRole)) return allowed.includes('auth') ? 'auth' : 'auth';
  if (otherRole || codes.includes(403)) return 'authz';
  if (codes.some((n) => n >= 400 && n < 500) || /\b(invalid|missing|wrong|bad|not found|non-existent|nonexistent|does not exist|reject)/.test(text)) return 'invalid-input';
  if (codes.some((n) => n >= 200 && n < 300) || /\b(success|returns|created|updated|deleted|list)\b/.test(expected)) {
    return /\b(fields?|schema|shape|each (item|product|record) has|types?)\b/.test(expected) ? 'schema' : 'happy';
  }
  return null;
}

function fakeSheetPlan(user: string, sheet: NonNullable<ReturnType<typeof sheetBlock>>): string {
  const endpoint = endpointBlock(user);
  const probe = probeBlock(user);
  const id = String(endpoint.id);
  const status = Number(probe.status);
  const allowed = allowedTypesLine(user);
  const roles = [...(user.match(/"authz" expects "403\|404" with one of these roles: ([^.]+)\./)?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const cases: Record<string, unknown>[] = [];
  const needsReview: { caseId: string; reason: string }[] = [];
  const covered = new Set<string>();
  for (const c of sheet.cases) {
    const words = `${c.steps ?? ''}`.trim().split(/\s+/).filter(Boolean).length;
    const type = words < 3 && !c.expected ? null : fakeSheetType(c, allowed);
    if (!type || words < 3) {
      needsReview.push({ caseId: c.caseId, reason: !type ? 'the expected result names no status code and nothing to check' : 'the steps do not say what request to send' });
      continue;
    }
    const role = type === 'authz' ? roles[0] : undefined;
    cases.push({
      caseId: c.caseId,
      id: type === 'authz' && role ? `authz-${role}` : `${type}-${c.caseId.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      type,
      title: c.title,
      requestDescription: `${endpoint.method} ${endpoint.path} as the ${type} case${role ? ` using role ${role}` : ''}: ${c.steps ?? ''}`.slice(0, 300),
      expectedStatus: EXPECTED[type](status),
      assertions: [`status is ${EXPECTED[type](status)}`, ...(c.expected ? [`expected: ${c.expected}`] : [])],
    });
    covered.add(type);
  }
  if (sheet.mode === 'sheet-plus-agent') {
    for (const type of allowed) {
      if (covered.has(type)) continue;
      if (type === 'authz' && !roleNames(user).length && !roles.length) continue;
      const role = type === 'authz' ? (roles[0] ?? roleNames(user)[0]) : '';
      cases.push({
        id: type === 'authz' ? `authz-${role}` : type,
        type,
        title: `[${type}] ${id} ${titleFor(type, role)}`,
        requestDescription: `${endpoint.method} ${endpoint.path} as the ${type} case${role ? ` using role ${role}` : ''}`,
        expectedStatus: EXPECTED[type](status),
        assertions: [`status is ${EXPECTED[type](status)}`],
      });
    }
  }
  return JSON.stringify({ endpointId: id, cases, needsReview }, null, 2);
}

function allowedTypesLine(user: string): string[] {
  const m = user.match(/Allowed case types for this endpoint: ([^\n]+?)\.(?: Include|\n)/);
  if (!m) throw new Error('FAKE_MODEL: prompt has no allowed case types line');
  return [...m[1].matchAll(/"([a-z-]+)"/g)].map((x) => x[1]);
}

// The match step: an endpoint id from the case's words (id words, verbs for the method), or null.
export function fakeMatch(user: string): string {
  const eps = block(user, 'ENDPOINTS:') as { endpoints: { id: string; method: string; path: string }[] } | null;
  const cs = block(user, 'TEST CASES:') as { cases: { caseId: string; title: string; endpointHint?: string; method?: string; steps?: string; expected?: string }[] } | null;
  if (!eps || !cs) throw new Error('FAKE_MODEL: match prompt has no ENDPOINTS or TEST CASES block');
  const verbs: Record<string, string[]> = { GET: ['get', 'view', 'read', 'fetch', 'show', 'list', 'preview', 'find', 'search', 'open'], POST: ['create', 'add', 'new', 'post', 'submit', 'register'], PUT: ['update', 'edit', 'change', 'modify', 'replace', 'put'], PATCH: ['patch', 'update', 'edit'], DELETE: ['delete', 'remove', 'destroy'] };
  const matches = cs.cases.map((c) => {
    // A request line the agent could not find in the API stays unmatched: guessing would hide it.
    if (/\b(GET|POST|PUT|PATCH|DELETE)\s+\//i.test(c.steps ?? '')) return { caseId: c.caseId, endpointId: null, reason: 'fake model: the request in the steps is not one of the endpoints' };
    const text = `${c.title} ${c.endpointHint ?? ''} ${c.steps ?? ''}`.toLowerCase();
    const words = new Set(text.split(/[^a-z0-9]+/).filter(Boolean));
    let best: { id: string; score: number } | null = null;
    for (const e of eps.endpoints) {
      const idWords = e.id.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      const nouns = idWords.filter((w) => !Object.values(verbs).flat().includes(w));
      const nounHit = nouns.some((n) => words.has(n) || words.has(n.replace(/s$/, '')) || words.has(`${n}s`));
      if (!nounHit) continue;
      let score = 1 + idWords.filter((w) => words.has(w)).length;
      if ((verbs[e.method] ?? []).some((v) => words.has(v))) score += 2;
      if (c.method && c.method === e.method) score += 2;
      if (!best || score > best.score) best = { id: e.id, score };
    }
    return best && best.score >= 3 ? { caseId: c.caseId, endpointId: best.id, reason: 'fake model: words of the endpoint id and its method' } : { caseId: c.caseId, endpointId: null, reason: 'fake model: no endpoint shares enough words with this case' };
  });
  return JSON.stringify({ matches }, null, 2);
}

function allowedTypes(user: string): string[] {
  const m = user.match(/Allowed case types for this endpoint: ([^\n]+?)\. Include/);
  if (!m) throw new Error('FAKE_MODEL: prompt has no allowed case types line');
  return [...m[1].matchAll(/"([a-z-]+)"/g)].map((x) => x[1]);
}

function roleNames(user: string): string[] {
  const m = user.match(/same valid request as another role \(([^;]+);/);
  if (!m) return [];
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

const EXPECTED: Record<string, (probeStatus: number) => string> = {
  happy: (s) => String(s),
  schema: (s) => String(s),
  'invalid-input': () => '4xx',
  auth: () => '401|403',
  authz: () => '403|404',
};

export function fakePlan(user: string): string {
  const sheet = sheetBlock(user);
  if (sheet) return fakeSheetPlan(user, sheet);
  const endpoint = endpointBlock(user);
  const probe = probeBlock(user);
  const id = String(endpoint.id);
  const status = Number(probe.status);
  const roles = roleNames(user);
  const cases = allowedTypes(user).flatMap((type) => {
    const one = (suffix: string, roleNote = '') => ({
      id: `${type}${suffix}`,
      type,
      title: `[${type}] ${id} ${titleFor(type, roleNote)}`,
      requestDescription: `${endpoint.method} ${endpoint.path} as the ${type} case${roleNote ? ` using role ${roleNote}` : ''}`,
      expectedStatus: EXPECTED[type](status),
      assertions: [`status is ${EXPECTED[type](status)}`],
    });
    if (type === 'authz') return roles.slice(0, 1).map((r) => one(`-${r}`, r));
    return [one('')];
  });
  return JSON.stringify({ endpointId: id, cases }, null, 2);
}

function titleFor(type: string, role: string): string {
  switch (type) {
    case 'happy':
      return 'returns the probe status for a valid request';
    case 'schema':
      return 'answers with the probe status and a well-formed response';
    case 'invalid-input':
      return 'rejects an invalid request with a 4xx';
    case 'auth':
      return 'rejects a request without auth';
    default:
      return `rejects the ${role} role`;
  }
}

type SetupKind = { kind: 'none' } | { kind: 'single'; endpointId: string } | { kind: 'multi' };

function setupKind(user: string): SetupKind {
  if (/This endpoint's path has \d+ placeholders/.test(user)) return { kind: 'multi' };
  // The setup rule line, not the template shown earlier in the prompt (which has its own createResource).
  const m = user.match(/This endpoint has setup\. Each test that needs an existing resource gets one with `const id = await ctx\.createResource\('([^']+)'\);`/);
  if (m) return { kind: 'single', endpointId: m[1] };
  return { kind: 'none' };
}

export function fakeSpec(user: string, pactum: boolean): string {
  const endpoint = endpointBlock(user);
  const probe = probeBlock(user);
  const plan = block(user, 'PLAN:');
  if (!plan) throw new Error('FAKE_MODEL: prompt has no PLAN block');
  const id = String(endpoint.id);
  const method = String(endpoint.method).toLowerCase();
  const path = String(endpoint.path);
  const status = Number(probe.status);
  const setup = setupKind(user);
  const body = endpoint.body as Json | undefined;
  const query = endpoint.query as Json | undefined;
  const headers = endpoint.headers as Json | undefined;
  const cases = (plan.cases as { type: string; title: string; id: string; requestDescription?: string }[]) ?? [];
  const params = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);

  const pathExpr =
    setup.kind === 'multi'
      ? '`' + path.replace(/\{([^}]+)\}/g, '${p.$1}') + '`'
      : setup.kind === 'single'
        ? '`' + path.replace(/\{[^}]+\}/, '${id}') + '`'
        : `'${path}'`;
  const invalidPathExpr =
    setup.kind === 'multi'
      ? '`' + path.replace(/\{([^}]+)\}/g, (_m, p: string) => (p === params[params.length - 1] ? 'not-a-valid-id' : '${p.' + p + '}')) + '`'
      : setup.kind === 'single'
        ? `'${path.replace(/\{[^}]+\}/, 'not-a-valid-id')}'`
        : `'${path}'`;

  const resourceLines = (indent: string) =>
    setup.kind === 'multi' ? `${indent}const p = await ctx.setup();\n` : setup.kind === 'single' ? `${indent}const id = await ctx.createResource('${setup.endpointId}');\n` : '';

  const optsParts: string[] = [];
  if (query) optsParts.push(`params: ${JSON.stringify(query)}`);
  if (headers) optsParts.push(`headers: ${JSON.stringify(headers)}`);
  const opts = optsParts.length ? `{ ${optsParts.join(', ')} }` : '';

  const hasBody = body !== undefined && ['post', 'put', 'patch'].includes(method);
  const invalidBody = hasBody ? '{}' : null;

  const call = (client: string, p: string, b: string | null) => {
    if (pactum) {
      if (hasBody) return `${client}.${method}(${p}, ${b ?? 'validBody'}${opts ? `, ${opts}` : ''})`;
      return `${client}.${method}(${p}${opts ? `, ${opts}` : ''})`;
    }
    const parts: string[] = [];
    if (hasBody) parts.push(`data: ${b ?? 'validBody'}`);
    if (query) parts.push(`params: ${JSON.stringify(query)}`);
    if (headers) parts.push(`headers: ${JSON.stringify(headers)}`);
    return `${client}.${method}(${p}${parts.length ? `, { ${parts.join(', ')} }` : ''})`;
  };

  // happy and schema tests also check the body (the gate requires it when the probe got one): the array
  // type for a list, or the type of the first field the probe saw.
  const probeBody = probe.body as Json | undefined;
  const bodyCheck = (() => {
    if ([204, 205, 304].includes(status) || probeBody === undefined || probeBody === null) return '';
    if (Array.isArray(probeBody)) return `\n    const body = (await response.json()) as unknown;\n    expect(Array.isArray(body)).toBe(true);`;
    if (typeof probeBody === 'object') {
      const key = Object.keys(probeBody)[0];
      if (key === undefined) return `\n    const body = (await response.json()) as unknown;\n    expect(typeof body).toBe('object');`;
      const kind = typeof (probeBody as Record<string, unknown>)[key];
      return `\n    const body = (await response.json()) as Record<string, unknown>;\n    expect(typeof body[${JSON.stringify(key)}]).toBe('${kind}');`;
    }
    return `\n    const body = (await response.json()) as unknown;\n    expect(typeof body).toBe('${typeof probeBody}');`;
  })();
  // schema tests check every field the probe saw (so every documented required field the API returns).
  const schemaCheck = (() => {
    if (!bodyCheck) return '';
    const sampleItem = Array.isArray(probeBody) ? probeBody[0] : probeBody;
    if (!sampleItem || typeof sampleItem !== 'object' || Array.isArray(sampleItem)) return bodyCheck;
    const lines = Object.entries(sampleItem as Record<string, unknown>).map(([k, v]) => `expect(typeof item[${JSON.stringify(k)}]).toBe('${v === null ? 'object' : typeof v}');`);
    if (Array.isArray(probeBody)) {
      return `\n    const body = (await response.json()) as Record<string, unknown>[];\n    expect(Array.isArray(body)).toBe(true);\n    for (const item of body) {\n${lines.map((l) => `      ${l}`).join('\n')}\n    }`;
    }
    return `\n    const item = (await response.json()) as Record<string, unknown>;\n${lines.map((l) => `    ${l}`).join('\n')}`;
  })();
  const statusLines = (type: string) => {
    if (type === 'schema') return `    expect(response.status()).toBe(${status});${schemaCheck}`;
    if (type === 'happy') return `    expect(response.status()).toBe(${status});${bodyCheck}`;
    if (type === 'invalid-input') return `    expect(response.status()).toBeGreaterThanOrEqual(400);\n    expect(response.status()).toBeLessThanOrEqual(499);`;
    if (type === 'auth') return `    expect([401, 403]).toContain(response.status());`;
    return `    expect([403, 404]).toContain(response.status());`;
  };

  const tests = cases
    .map((c) => {
      const role = c.type === 'authz' ? (c.requestDescription?.match(/using role (\S+?)[:\s]/)?.[1] ?? c.id.replace(/^authz-/, '')) : null;
      const client = c.type === 'auth' ? 'ctx.noAuthApi' : c.type === 'authz' ? `ctx.as('${role}')` : 'ctx.api';
      const invalid = c.type === 'invalid-input';
      const p = invalid && !hasBody ? invalidPathExpr : pathExpr;
      const b = invalid && hasBody ? invalidBody : null;
      const open = pactum ? `  it('${c.title.replace(/'/g, "\\'")}', async () => {` : `  test('${c.title.replace(/'/g, "\\'")}', async ({ ctx }) => {`;
      return `${open}\n${resourceLines('    ')}    const response = await ${call(client, p, b)};\n\n    recordStatus(response.status());\n${statusLines(c.type)}\n  });`;
    })
    .join('\n\n');

  const header = pactum
    ? `import { ctx, expect, recordStatus } from '../tests-pactum/setup/ctx';\n`
    : `import { test, expect } from '../tests/fixtures/ctx';\n\nfunction recordStatus(status: number) {\n  test.info().annotations.push({ type: 'actual-status', description: String(status) });\n}\n`;
  const bodyConst = hasBody ? `\nconst validBody = ${JSON.stringify(body)};\n` : '';
  const describe = pactum ? `describe('${id} ${endpoint.method} ${path}', () => {` : `test.describe('${id} ${endpoint.method} ${path}', () => {`;
  return `${header}${bodyConst}\n${describe}\n${tests}\n});\n`;
}

// Tests can watch how many fake calls were in flight at once (the --concurrency flag). With
// FAKE_MODEL_STATS_FILE set, the numbers are written there after every call.
export const fakeStats = { calls: 0, inFlight: 0, maxInFlight: 0 };

function writeStats() {
  const file = process.env.FAKE_MODEL_STATS_FILE;
  if (file) writeFileSync(file, JSON.stringify(fakeStats) + '\n');
}

export async function fakeModelAnswer(stepName: string, system: string, user: string): Promise<string> {
  fakeStats.calls++;
  fakeStats.inFlight++;
  fakeStats.maxInFlight = Math.max(fakeStats.maxInFlight, fakeStats.inFlight);
  try {
    // A short pause so concurrent callers overlap, which is what the concurrency test measures.
    await new Promise((r) => setTimeout(r, Number(process.env.FAKE_MODEL_DELAY_MS ?? 25)));
    if (stepName.startsWith('match')) return fakeMatch(user);
    if (stepName.startsWith('plan')) return fakePlan(user);
    if (stepName.startsWith('generate')) return '```ts\n' + fakeSpec(user, /Pactum/i.test(system)) + '```\n';
    throw new Error(`FAKE_MODEL: unknown step "${stepName}"`);
  } finally {
    fakeStats.inFlight--;
    writeStats();
  }
}
