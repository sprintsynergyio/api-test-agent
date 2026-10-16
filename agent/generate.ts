import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BudgetExceeded, callClaude } from './claude';
import type { Endpoint } from './config';
import type { Plan } from './plan';
import type { ProbeResult } from './probe';
import { validateSpec } from './validate';

const GENERATED_DIR = 'generated';
const CANDIDATE_DIR = join(GENERATED_DIR, '.candidate');

export type GenerateResult = { ok: true; specFile: string } | { ok: false; reasons: string[] };

const SYSTEM =
  'You are a senior QA engineer writing Playwright API tests in TypeScript. You answer with exactly one ```ts code block containing the full file, nothing else.';

function buildPrompt(endpoint: Endpoint, plan: Plan, probe: ProbeResult): string {
  const read = (p: string) => readFileSync(p, 'utf8');
  const setupLine = endpoint.setup
    ? `- This endpoint has setup. Each test that needs an existing resource gets one with \`const id = await ctx.createResource('${endpoint.setup.endpointId}');\` (returns the id as a string) and puts it in the path.`
    : '- This endpoint has no setup. Do not call ctx.createResource unless a test needs a resource.';
  return `Write the Playwright test file generated/${endpoint.id}.spec.ts for this endpoint, implementing every case in the plan as one test.

ENDPOINT CONFIG:
${JSON.stringify(endpoint, null, 2)}

PROBE (a real call with the sample body; arrays truncated to 3 items):
${JSON.stringify(probe, null, 2)}

PLAN:
${JSON.stringify(plan, null, 2)}

FILE tests/fixtures/ctx.ts (the fixture; tests get everything from ctx):
\`\`\`ts
${read('tests/fixtures/ctx.ts')}
\`\`\`

FILE agent/http.ts (createResource implementation used by ctx):
\`\`\`ts
${read('agent/http.ts')}
\`\`\`

FILE tests/template/update-booking.spec.ts (THE EXAMPLE TO FOLLOW):
\`\`\`ts
${read('tests/template/update-booking.spec.ts')}
\`\`\`

RULES:
- The file lives in generated/, so import exactly: import { test, expect } from '../tests/fixtures/ctx';
${setupLine}
- Paths are relative, for example \`${endpoint.path.replace('{id}', '${id}')}\`. The base URL comes from ctx.api. Never write http:// or https://.
- Use ctx.api for normal requests and ctx.noAuthApi for auth cases (the same valid request without the auth header).
- Copy the template's structure: one test.describe block, every test title starts with its type tag ([happy], [schema], [invalid-input], [auth]), and every test records test.info().annotations.push({ type: 'actual-status', description: String(response.status()) }) (or a helper like recordStatus) before its first expect.
- Status assertions, exactly in the template's style: happy and schema expect(response.status()).toBe(<exact probe status ${probe.status}>); invalid-input expect status toBeGreaterThanOrEqual(400) and toBeLessThanOrEqual(499); auth expect([401, 403]).toContain(response.status()).
- Never expect a 5xx. Assert status codes, field presence and field types. Assert exact values only for values the test itself sent.
- Tests run in parallel against a shared live API while other tests create, update and delete data. Never assert a list length or item count, never compare the results of two calls, and never assume a list is unchanged or contains (or lacks) a specific item you did not create in the same test. For lists, assert the array type and the shape of its items only.
- Response bodies may be empty or not JSON (see the probe). Only call response.json() when the probe shows a JSON body for that status.
- No process.env, no test.only, no test.skip, no try/catch, no .catch(). Do not import from @playwright/test.
- One test per plan case: ${plan.cases.length} tests in total.

Answer with exactly one \`\`\`ts code block containing the whole file.`;
}

function extractCode(text: string): string | null {
  const m = text.match(/```(?:ts|typescript)\s*\n([\s\S]*?)```/);
  return m ? m[1].trimEnd() + '\n' : null;
}

export async function generateEndpoint(endpoint: Endpoint, plan: Plan, probe: ProbeResult): Promise<GenerateResult> {
  mkdirSync(CANDIDATE_DIR, { recursive: true });
  const candidate = join(CANDIDATE_DIR, `${endpoint.id}.spec.ts`);
  const finalFile = join(GENERATED_DIR, `${endpoint.id}.spec.ts`);
  const prompt = buildPrompt(endpoint, plan, probe);

  let reasons: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const user =
      attempt === 1
        ? prompt
        : `${prompt}\n\nYOUR PREVIOUS FILE WAS REJECTED BY THE STATIC GATE. Fix every problem below and answer again with the whole file:\n- ${reasons.join('\n- ')}`;
    let text: string;
    try {
      text = await callClaude(attempt === 1 ? 'generate' : 'generate-retry', endpoint.id, SYSTEM, user);
    } catch (err) {
      if (err instanceof BudgetExceeded) throw err;
      return { ok: false, reasons: [(err as Error).message] };
    }

    const code = extractCode(text);
    if (!code) {
      reasons = ['answer did not contain a ```ts code block'];
      continue;
    }
    writeFileSync(candidate, code);
    const result = validateSpec(code, { planCaseCount: plan.cases.length, name: endpoint.id });
    if (result.ok) {
      renameSync(candidate, finalFile);
      return { ok: true, specFile: finalFile };
    }
    reasons = result.reasons;
    rmSync(candidate, { force: true });
  }
  return { ok: false, reasons };
}
