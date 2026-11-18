import { z } from 'zod';
import { BudgetExceeded, callClaude } from './claude';
import { matchExplicit, type EndpointRef, type MatchResult, type SheetCase } from './test-cases';
import { untrusted, withUntrustedRule } from './untrusted';

// Matches each sheet case to one endpoint of the input: the Endpoint column or a request line in the
// steps first (agent/test-cases.ts matchExplicit, no model), then the model for the rest, 25 cases per
// call, counted against the run budget. A case nobody can match is returned with endpointId null and
// the reason; the caller reports it as "not automated", it is never dropped.

const BATCH = 25;

const AnswerSchema = z.object({
  matches: z.array(z.object({ caseId: z.string(), endpointId: z.string().nullable(), reason: z.string().optional() })),
});

const SYSTEM = withUntrustedRule('You are a senior QA engineer mapping manual API test cases to the endpoints of an API. You answer with one JSON object only, no prose.');

export function buildMatchPrompt(cases: SheetCase[], endpoints: EndpointRef[]): string {
  const shown = cases.map((c) => ({
    caseId: c.id,
    title: c.title,
    endpointHint: c.endpoint || undefined,
    method: c.method || undefined,
    steps: c.steps.slice(0, 500) || undefined,
    expected: c.expected.slice(0, 200) || undefined,
  }));
  return `Match each manual test case to the one API endpoint it tests.

ENDPOINTS:
${untrusted('endpoints', JSON.stringify({ endpoints }, null, 2))}

TEST CASES:
${untrusted('sheet-cases', JSON.stringify({ cases: shown }, null, 2))}

RULES:
- Use only the endpoint ids listed above. If a case tests something none of them does, or you are not sure, use null and say why in reason.
- One endpoint per case: the endpoint whose request the case sends and checks.
- Every caseId above appears exactly once in the answer.

Answer with JSON only, exactly this shape:
{"matches":[{"caseId":"${cases[0]?.id ?? 'TC-1'}","endpointId":"${endpoints[0]?.id ?? 'endpoint-id'}","reason":"short reason"}]}`;
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  return JSON.parse((fenced ? fenced[1] : text).trim());
}

export async function matchCases(cases: SheetCase[], endpoints: EndpointRef[], opts: { useModel: boolean }): Promise<{ results: Map<string, MatchResult>; budgetHit: boolean }> {
  const results = new Map<string, MatchResult>();
  const pending: { c: SheetCase; why: string }[] = [];
  for (const c of cases) {
    const m = matchExplicit(c, endpoints);
    if (m.endpointId) results.set(c.id, m);
    else pending.push({ c, why: m.reason });
  }
  let budgetHit = false;
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    if (!opts.useModel || budgetHit) {
      for (const { c, why } of batch) results.set(c.id, { endpointId: null, by: null, reason: budgetHit ? `${why}; budget reached before the AI could match it` : why });
      continue;
    }
    let answer: z.infer<typeof AnswerSchema> | null = null;
    let problem = '';
    for (let attempt = 1; attempt <= 2 && !answer; attempt++) {
      try {
        const text = await callClaude(attempt === 1 ? 'match' : 'match-retry', 'test-cases', SYSTEM, buildMatchPrompt(batch.map((b) => b.c), endpoints));
        const parsed = AnswerSchema.safeParse(extractJson(text));
        if (parsed.success) answer = parsed.data;
        else problem = 'the AI answer had the wrong shape';
      } catch (err) {
        if (err instanceof BudgetExceeded) {
          budgetHit = true;
          break;
        }
        problem = (err as Error).message.split('\n')[0].slice(0, 160);
      }
    }
    for (const { c, why } of batch) {
      const hit = answer?.matches.find((m) => m.caseId.trim().toLowerCase() === c.id.toLowerCase());
      const known = hit?.endpointId ? endpoints.find((e) => e.id === hit.endpointId) : undefined;
      if (known) results.set(c.id, { endpointId: known.id, by: 'ai', reason: `matched by the AI${hit?.reason ? `: ${hit.reason.slice(0, 160)}` : ''}` });
      else if (hit) results.set(c.id, { endpointId: null, by: null, reason: `${why}; the AI found no matching endpoint${hit.reason ? ` (${hit.reason.slice(0, 160)})` : ''}` });
      else results.set(c.id, { endpointId: null, by: null, reason: budgetHit ? `${why}; budget reached before the AI could match it` : `${why}; the AI could not match it${problem ? ` (${problem})` : ''}` });
    }
  }
  return { results, budgetHit };
}
