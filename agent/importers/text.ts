import { z } from 'zod';
import { callClaudeOutsideBudget } from '../claude';
import { ConfigSchema, zodProblems } from '../config';
import { buildInput, ImportError, isCredentialHeader, isCredentialParam, type ImportResult, type RawRequest, type Skipped } from './core';

// Jira / Confluence text pasted by the user. Claude reads it and returns the input file shape, with
// at most 2 calls per import (one retry with the zod errors). The calls are logged but do not count
// against the run budget. Claude never sees a credential: values are masked before the text is sent.
// Nothing Claude adds is trusted: a base URL, path or body field that is not in the text is dropped.

const MAX_CALLS = 2;
const MAX_TEXT = 200_000;
const REMOVED = '<removed>';

// The input file shape, with what Claude may leave out or get slightly wrong relaxed: no name rule,
// optional defaultHeaders, empty baseUrl allowed, and an empty endpoint list meaning "none found".
const AnswerSchema = ConfigSchema.extend({
  name: z.string().optional(),
  baseUrl: z.union([z.literal(''), ConfigSchema.shape.baseUrl]),
  defaultHeaders: ConfigSchema.shape.defaultHeaders.optional(),
  endpoints: z.array(ConfigSchema.shape.endpoints.element),
});
export type TextAnswer = z.infer<typeof AnswerSchema>;

// Masks credential values with the same rules as the other importers: a scheme token (Bearer x),
// a credential-named header or field on its own line (X-API-Key: x), a credential query parameter.
export function maskCredentials(text: string): { text: string; removed: string[] } {
  const removed: string[] = [];
  const mask = (value: string) => {
    if (value === REMOVED) return value;
    removed.push(value);
    return REMOVED;
  };
  let out = text.replace(/\b(Bearer|Basic|Token|Digest)(\s+)([A-Za-z0-9._~+/=-]{6,})/gi, (_m, scheme: string, space: string, value: string) => `${scheme}${space}${mask(value)}`);
  out = out.replace(
    /^(\s*[-*]?\s*["'`]?)([A-Za-z0-9_-]+)(["'`]?\s*[:=]\s*["'`]?)([^\s"'`]{8,})(["'`]?,?\s*)$/gm,
    (m, start: string, name: string, sep: string, value: string, end: string) =>
      isCredentialHeader(name) || isCredentialParam(name) ? `${start}${name}${sep}${mask(value)}${end}` : m,
  );
  out = out.replace(/([?&])([A-Za-z0-9_.-]+)=([^&\s"'`#)]+)/g, (m, sign: string, name: string, value: string) =>
    isCredentialParam(name) ? `${sign}${name}=${mask(value)}` : m,
  );
  return { text: out, removed };
}

const SYSTEM = 'You extract HTTP API endpoints from tickets and wiki pages. You answer with one JSON object only, no prose.';

function buildPrompt(text: string): string {
  return `Extract the HTTP API endpoints described in the text below, in this JSON shape (an API test agent's input file):
{"name":"short-api-name","baseUrl":"https://api.example.com","defaultHeaders":{"Accept":"application/json","Content-Type":"application/json"},"auth":{"header":"Authorization","valueEnv":"CUSTOM_API_AUTH"},"endpoints":[{"id":"get-items","method":"GET","path":"/items/{id}","requiresAuth":false,"body":{"field":"value"}}]}

RULES:
- Only endpoints the text literally describes, each with an HTTP method and a path written in the text. Never invent endpoints, paths, query parameters or body fields.
- baseUrl: only a base URL written in the text. If the text gives none, use "". Never guess one.
- path: as written in the text, starting with /. Write path parameters as {name}, for example /items/{id}.
- method: one of GET, POST, PUT, PATCH, DELETE.
- requiresAuth: true only when the text says the endpoint needs auth (a token, an auth header, a login, a role); otherwise false.
- auth: only if some endpoint requires auth. header is the auth header the text names, else "Authorization". valueEnv is always "CUSTOM_API_AUTH". Never write a token, password or other credential value anywhere; values in the text appear as ${REMOVED}.
- body: only when the text describes the request body. Use only fields the text names, with the example values the text gives; a field without an example gets a simple value of its type ("string", 1, true). Leave body out otherwise.
- Do not add a setup field.
- If the text describes no endpoints, answer {"baseUrl":"","endpoints":[]}.

TEXT:
<<<
${text}
>>>`;
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  return JSON.parse((fenced ? fenced[1] : text).trim());
}

// Keeps only body fields whose names appear in the text. Records the dropped ones.
function namedFieldsOnly(value: unknown, lowerText: string, dropped: string[]): unknown {
  if (Array.isArray(value)) return value.map((v) => namedFieldsOnly(v, lowerText, dropped));
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (lowerText.includes(k.toLowerCase())) out[k] = namedFieldsOnly(v, lowerText, dropped);
    else dropped.push(k);
  }
  return out;
}

// Turns Claude's answer into the import result, checking it against the original text.
export function fromAnswer(answer: TextAnswer, original: string, removed: string[]): ImportResult {
  if (!answer.endpoints.length) throw new ImportError('No endpoints found in the text');
  const lower = original.toLowerCase();
  const warnings: string[] = [];
  const skipped: Skipped[] = [];

  let baseUrl = answer.baseUrl.replace(/\/+$/, '');
  if (baseUrl) {
    const host = URL.canParse(baseUrl) ? new URL(baseUrl).host.toLowerCase() : '';
    if (!lower.includes(baseUrl.toLowerCase()) && !(host && lower.includes(host))) {
      warnings.push("The base URL in Claude's answer is not in the text, so it was dropped.");
      baseUrl = '';
    }
  }

  const authHeader = answer.auth?.header && !answer.auth.header.includes(REMOVED) ? answer.auth.header : 'Authorization';
  // Credential headers never come from Claude's defaultHeaders: auth is set from requiresAuth.
  const headers = Object.entries(answer.defaultHeaders ?? {})
    .filter(([name]) => !/^(accept|content-type)$/i.test(name) && !isCredentialHeader(name))
    .map(([name, value]) => ({ name, value }));
  const droppedFields: string[] = [];
  const requests: RawRequest[] = [];
  for (const ep of answer.endpoints) {
    const item = `${ep.method} ${ep.path}`;
    // Every literal part of the path (between placeholders) must be in the text.
    const parts = ep.path
      .split(/\{[^}]*\}|:[A-Za-z_][A-Za-z0-9_]*/)
      .map((part) => part.replace(/^\/+|\/+$/g, '').toLowerCase())
      .filter(Boolean);
    if (parts.some((part) => !lower.includes(part))) {
      skipped.push({ item, reason: 'path not found in the text (paths are never invented)' });
      continue;
    }
    const dropped: string[] = [];
    const body = ep.body ? (namedFieldsOnly(ep.body, lower, dropped) as Record<string, unknown>) : undefined;
    if (dropped.length) droppedFields.push(`${item} (${[...new Set(dropped)].join(', ')})`);
    requests.push({
      item,
      method: ep.method,
      url: `${baseUrl}${ep.path}`,
      headers,
      body: body ? { json: body } : undefined,
      requiresAuth: ep.requiresAuth,
      credentials: ep.requiresAuth ? [{ name: authHeader, where: 'header', declared: removed.length === 0 }] : [],
    });
  }
  if (droppedFields.length) warnings.push(`Body fields not named in the text were removed: ${droppedFields.join('; ')}.`);
  return buildInput(requests, {
    name: answer.name,
    skipped,
    warnings,
    secrets: removed,
    authHeader,
    noBaseUrlWarning: 'The text gives no base URL. Enter the base URL before running.',
    noEndpointsMessage: 'No endpoints found in the text',
  });
}

export async function importText(content: string): Promise<ImportResult> {
  if (content.length > MAX_TEXT) {
    throw new ImportError(`The text is too long (${content.length} characters, at most ${MAX_TEXT}). Paste only the part that describes the API.`);
  }
  const { text, removed } = maskCredentials(content);
  const prompt = buildPrompt(text);
  let errors: string[] = [];
  for (let attempt = 1; attempt <= MAX_CALLS; attempt++) {
    const user =
      attempt === 1 ? prompt : `${prompt}\n\nYOUR PREVIOUS ANSWER WAS REJECTED. Fix these problems and answer again with JSON only:\n- ${errors.join('\n- ')}`;
    let reply: string;
    try {
      reply = await callClaudeOutsideBudget(
        attempt === 1 ? 'import-text' : 'import-text-retry',
        'text',
        SYSTEM,
        user,
        `import call ${attempt}/${MAX_CALLS}, not counted in the run budget`,
      );
    } catch (err) {
      throw new ImportError(`Claude call failed: ${String((err as Error)?.message ?? err).split('\n')[0]}`);
    }
    let raw: unknown;
    try {
      // The answer gets the same masking, in case it holds anything credential-like.
      raw = extractJson(maskCredentials(reply).text);
    } catch {
      errors = ['the answer is not valid JSON'];
      continue;
    }
    const parsed = AnswerSchema.safeParse(raw);
    if (!parsed.success) {
      errors = zodProblems(parsed.error);
      continue;
    }
    return fromAnswer(parsed.data, content, removed);
  }
  throw new ImportError(`Claude's answer was still invalid after ${MAX_CALLS} calls: ${errors.join('; ')}`);
}
