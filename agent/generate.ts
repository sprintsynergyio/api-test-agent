import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BudgetExceeded, callClaude } from './claude';
import type { Endpoint } from './config';
import { pathParams, setupSteps } from './model';
import { promptEndpoint, type Plan } from './plan';
import type { ProbeResult } from './probe';
import type { FrameworkAdapter } from './frameworks/types';

const GENERATED_DIR = 'generated';
const CANDIDATE_DIR = join(GENERATED_DIR, '.candidate');

export type GenerateResult = { ok: true; specFile: string } | { ok: false; reasons: string[] };

function system(fw: FrameworkAdapter): string {
  return `You are a senior QA engineer writing ${fw.label}. You answer with exactly one \`\`\`ts code block containing the full file, nothing else.`;
}

// Exported for the redaction tests: the prompt text must never carry client data.
export function buildPrompt(fw: FrameworkAdapter, endpoint: Endpoint, plan: Plan, probe: ProbeResult): string {
  const read = (p: string) => readFileSync(p, 'utf8');
  const shown = promptEndpoint(endpoint);
  const steps = setupSteps(endpoint);
  const params = pathParams(endpoint.path);
  const setupLine =
    steps.length > 1 || params.length > 1
      ? `- This endpoint's path has ${params.length} placeholders (${params.map((p) => `{${p}}`).join(', ')}) filled by setup (${steps.map((s) => `${s.endpointId} fills {${s.param}}`).join('; ')}). Each test that needs an existing resource calls \`const p = await ctx.setup();\` and builds the path as \`${endpoint.path.replace(/\{([^}]+)\}/g, '${p.$1}')}\`. Do not call ctx.createResource for these placeholders.`
      : steps.length === 1
        ? `- This endpoint has setup. Each test that needs an existing resource gets one with \`const id = await ctx.createResource('${steps[0].endpointId}');\` (returns the id as a string) and puts it in the path.`
        : '- This endpoint has no setup. Do not call ctx.createResource unless a test needs a resource.';
  const queryLine = shown.query
    ? `- This endpoint takes query parameters: ${JSON.stringify(shown.query)}. Send them with the \`params\` option, for example \`ctx.api.get(path, { params: ${JSON.stringify(shown.query)} })\`; invalid-input cases may send a wrong value or type for one of them instead of a body change.`
    : '';
  const headersLine = shown.headers
    ? `- This endpoint needs extra headers: ${JSON.stringify(shown.headers)}. Send them on every request with the \`headers\` option, for example \`{ headers: ${JSON.stringify(shown.headers)} }\` (auth tests too; only the auth header is left out there).`
    : '';
  const contextFiles = fw.contextFiles
    .map((f) => `FILE ${f} (shown for context, tests never import it):\n\`\`\`ts\n${read(f)}\n\`\`\`\n`)
    .join('\n');
  return `Write the test file generated/${endpoint.id}.spec.ts (${fw.label}) for this endpoint, implementing every case in the plan as one test.

ENDPOINT CONFIG:
${JSON.stringify(shown, null, 2)}

PROBE (a real call with the sample body; arrays truncated to 3 items):
${JSON.stringify(probe, null, 2)}

PLAN:
${JSON.stringify(plan, null, 2)}

FILE ${fw.ctxFile} (the fixture; tests get everything from ctx):
\`\`\`ts
${read(fw.ctxFile)}
\`\`\`

${contextFiles}FILE ${fw.templateFile} (THE EXAMPLE TO FOLLOW):
\`\`\`ts
${read(fw.templateFile)}
\`\`\`

RULES:
- The file lives in generated/, so import exactly: ${fw.importLine}
${setupLine}${queryLine ? `\n${queryLine}` : ''}${headersLine ? `\n${headersLine}` : ''}
- Paths are relative, for example \`${params.length > 1 ? endpoint.path.replace(/\{([^}]+)\}/g, '${p.$1}') : endpoint.path.replace(/\{[^}]+\}/, '${id}')}\`. The base URL comes from ctx.api. Never write http:// or https://.
- Use ctx.api for normal requests and ctx.noAuthApi for auth cases (the same valid request without the auth header).
- Never expect a 5xx. Assert status codes, field presence and field types. Assert exact values only for values the test itself sent.
- Tests run against a shared live API while other tests create, update and delete data. Never assert a list length or item count, never compare the results of two calls, and never assume a list is unchanged or contains (or lacks) a specific item you did not create in the same test. For lists, assert the array type and the shape of its items only.
${fw.generatorRules(endpoint, plan, probe).map((r) => `- ${r}`).join('\n')}

Answer with exactly one \`\`\`ts code block containing the whole file.`;
}

function extractCode(text: string): string | null {
  const m = text.match(/```(?:ts|typescript)\s*\n([\s\S]*?)```/);
  return m ? m[1].trimEnd() + '\n' : null;
}

export async function generateEndpoint(fw: FrameworkAdapter, endpoint: Endpoint, plan: Plan, probe: ProbeResult): Promise<GenerateResult> {
  mkdirSync(CANDIDATE_DIR, { recursive: true });
  const candidate = join(CANDIDATE_DIR, `${endpoint.id}.spec.ts`);
  const finalFile = join(GENERATED_DIR, `${endpoint.id}.spec.ts`);
  const prompt = buildPrompt(fw, endpoint, plan, probe);

  let reasons: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const user =
      attempt === 1
        ? prompt
        : `${prompt}\n\nYOUR PREVIOUS FILE WAS REJECTED BY THE STATIC GATE. Fix every problem below and answer again with the whole file:\n- ${reasons.join('\n- ')}`;
    let text: string;
    try {
      text = await callClaude(attempt === 1 ? 'generate' : 'generate-retry', endpoint.id, system(fw), user);
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
    const result = fw.validate(code, {
      name: endpoint.id,
      planTypes: plan.cases.map((c) => c.type),
      probeStatus: probe.status,
    });
    if (result.ok) {
      renameSync(candidate, finalFile);
      return { ok: true, specFile: finalFile };
    }
    reasons = result.reasons;
    rmSync(candidate, { force: true });
  }
  return { ok: false, reasons };
}
