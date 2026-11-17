import 'dotenv/config';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeModelAnswer } from './fake-model';
import { redactText, type RedactionCounter } from './redact';

// Calls the model one of three ways, chosen by the environment (see modelChoice):
//   - LLM_PROVIDER=openai with OPENAI_API_KEY: the OpenAI Chat Completions API over HTTPS.
//   - LLM_PROVIDER=anthropic (default) with ANTHROPIC_API_KEY: the Anthropic Messages API over HTTPS
//     (hosted mode requires a key, so a shared server never uses a personal login).
//   - LLM_PROVIDER=anthropic without a key: the Claude Code CLI in headless print mode with the
//     machine's existing login.
// All three return the model's text and log the same "[claude] <step> <id> <secs>s tokens in= out= (call n/m)"
// line (the label stays "[claude]" because the UI reads it, see ui/CONTRACT.md).

const TIMEOUT_MS = 180_000;
// Raised from 30 in the scale work: about 2 calls per endpoint, so 60 covers roughly 25 endpoints.
// --budget N or MAX_CLAUDE_CALLS overrides it per run.
const DEFAULT_BUDGET = 60;
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-5-5';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
// OpenAI's current balanced model (intelligence and cost). Override with LLM_MODEL.
const OPENAI_DEFAULT_MODEL = 'gpt-6.1-sol';
const API_MAX_TOKENS = 16_000;
// Variables that must never reach a child process or a log line.
const SECRET_ENV = /AUTH|ANTHROPIC_API_KEY|OPENAI_API_KEY/i;

export type Provider = 'anthropic' | 'openai';
export const PROVIDERS: Provider[] = ['anthropic', 'openai'];
export type ModelChoice = { provider: Provider; model: string; via: 'api' | 'cli' };

export function providerFromEnv(): Provider {
  const raw = (process.env.LLM_PROVIDER || 'anthropic').trim().toLowerCase();
  if (raw === 'openai') return 'openai';
  if (raw === 'anthropic' || raw === 'claude' || raw === '') return 'anthropic';
  throw new Error(`LLM_PROVIDER must be "anthropic" or "openai", got "${raw}"`);
}

export function keyEnvName(provider: Provider): string {
  return provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
}

export function defaultModel(provider: Provider): string {
  return provider === 'openai' ? OPENAI_DEFAULT_MODEL : ANTHROPIC_DEFAULT_MODEL;
}

function configuredModel(provider: Provider): string | undefined {
  // LLM_MODEL wins; CLAUDE_MODEL stays as the old name for the Anthropic model.
  return process.env.LLM_MODEL || (provider === 'anthropic' ? process.env.CLAUDE_MODEL : undefined) || undefined;
}

// What this process will call, decided once from the environment.
export function modelChoice(): ModelChoice {
  const provider = providerFromEnv();
  const key = process.env[keyEnvName(provider)];
  const model = configuredModel(provider) || defaultModel(provider);
  if (provider === 'openai') return { provider, model, via: 'api' };
  return { provider, model: key ? model : configuredModel(provider) || 'default', via: key ? 'api' : 'cli' };
}

export function describeModelChoice(c: ModelChoice = modelChoice()): string {
  const how = c.via === 'api' ? 'API key' : 'Claude Code login';
  return `model: ${c.provider} ${c.model} (${how})`;
}

export function usingApiKey(): boolean {
  return modelChoice().via === 'api';
}

// A provider was selected but its key is missing: the one case the environment cannot satisfy.
export function providerProblem(): string | null {
  let provider: Provider;
  try {
    provider = providerFromEnv();
  } catch (err) {
    return (err as Error).message;
  }
  if (provider === 'openai' && !process.env.OPENAI_API_KEY) return 'LLM_PROVIDER=openai requires OPENAI_API_KEY in .env';
  return null;
}

// FAKE_MODEL=1 answers every prompt locally (agent/fake-model.ts). Test mode only: refused when hosted.
export function fakeModelEnabled(): boolean {
  return process.env.FAKE_MODEL === '1';
}

export function hostedWithoutApiKeyProblem(): string | null {
  const p = providerProblem();
  if (p) return p;
  if (process.env.HOSTED === '1' && fakeModelEnabled()) {
    return 'FAKE_MODEL=1 is a test mode and is refused in hosted mode: a shared server never reports fake results.';
  }
  if (process.env.HOSTED === '1' && !usingApiKey()) {
    return 'HOSTED=1 requires ANTHROPIC_API_KEY (or LLM_PROVIDER=openai with OPENAI_API_KEY): the hosted agent never uses a personal Claude login.';
  }
  return null;
}

export class BudgetExceeded extends Error {
  constructor(used: number, budget: number) {
    super(`Claude call budget reached: ${used} of ${budget} calls used (MAX_CLAUDE_CALLS)`);
    this.name = 'BudgetExceeded';
  }
}

let callsUsed = 0;

export function claudeBudget(): number {
  const n = Number(process.env.MAX_CLAUDE_CALLS);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_BUDGET;
}

export function claudeCallsUsed(): number {
  return callsUsed;
}

// Never let an auth value or a provider key reach an error or log line: env values whose name contains
// AUTH, ANTHROPIC_API_KEY or OPENAI_API_KEY, plus any extra secrets the caller passes.
export function redact(text: string, extraSecrets: string[] = []): string {
  const secrets = [
    ...Object.entries(process.env)
      .filter(([name]) => SECRET_ENV.test(name))
      .map(([, value]) => value),
    ...extraSecrets,
  ];
  let out = text;
  for (const value of secrets) {
    if (value && value.length >= 6) out = out.split(value).join('<redacted>');
  }
  return out;
}

// Environment for every child process (claude CLI, Playwright): the parent's environment, PATH
// included so the CLI can be found, minus CLAUDECODE, every variable with AUTH in its name and the
// provider keys. Neither the model nor the tests ever need those values.
export function claudeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  for (const name of Object.keys(env)) if (SECRET_ENV.test(name)) delete env[name];
  return env;
}

type CliOutput = {
  result?: unknown;
  is_error?: boolean;
  subtype?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  total_cost_usd?: number;
};

export async function callClaude(stepName: string, endpointId: string, system: string, user: string): Promise<string> {
  const budget = claudeBudget();
  // Check and increment with no await in between, so parallel callers cannot overshoot the budget.
  if (callsUsed >= budget) throw new BudgetExceeded(callsUsed, budget);
  const callNumber = ++callsUsed;
  return runClaude(stepName, endpointId, system, user, `call ${callNumber}/${budget}`);
}

// For the text importer, which runs before any agent run: it caps its own calls, they do not count
// against the run budget, and each one is logged with its own counter.
export function callClaudeOutsideBudget(stepName: string, label: string, system: string, user: string, counter: string): Promise<string> {
  return runClaude(stepName, label, system, user, counter);
}

// Every prompt gets the built-in redaction rules once more, right before it leaves the process, so
// nothing that bypassed the structured redaction in the probe (importer text, error messages) can
// carry an email, card number or token to Claude. Counted in promptRedaction for the summary.
export const promptRedaction: RedactionCounter = { replaced: 0 };

async function runClaude(stepName: string, endpointId: string, system: string, user: string, counter: string): Promise<string> {
  const safeSystem = redactText(system, promptRedaction);
  const safeUser = redactText(user, promptRedaction);
  if (fakeModelEnabled()) {
    if (process.env.HOSTED === '1') throw new Error('FAKE_MODEL=1 is refused in hosted mode');
    const started = Date.now();
    const text = await fakeModelAnswer(stepName, safeSystem, safeUser);
    console.log(`[claude] ${stepName} ${endpointId} ${((Date.now() - started) / 1000).toFixed(1)}s fake model (${counter})`);
    return text;
  }
  const choice = modelChoice();
  if (choice.provider === 'openai') return runOpenAiApi(stepName, endpointId, safeSystem, safeUser, counter, choice.model);
  if (choice.via === 'api') return runClaudeApi(stepName, endpointId, safeSystem, safeUser, counter, choice.model);
  return runClaudeCli(stepName, endpointId, safeSystem, safeUser, counter);
}

type ApiResponse = {
  content?: { type: string; text?: string }[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  error?: { type?: string; message?: string };
};

// Tests replace this with a fake. Production code never touches it.
export let fetchImpl: typeof fetch = (...args) => fetch(...args);
export function setFetchForTests(f: typeof fetch) {
  fetchImpl = f;
}

// ANTHROPIC_BASE_URL and OPENAI_BASE_URL point the calls at a proxy or, in tests, a fake server.
function anthropicUrl(): string {
  const base = (process.env.ANTHROPIC_BASE_URL || '').trim().replace(/\/$/, '');
  return base ? `${base}/v1/messages` : ANTHROPIC_URL;
}

function openaiUrl(): string {
  const base = (process.env.OPENAI_BASE_URL || '').trim().replace(/\/$/, '');
  return base ? `${base}/v1/chat/completions` : OPENAI_URL;
}

async function runClaudeApi(stepName: string, endpointId: string, system: string, user: string, counter: string, model: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY as string;
  const started = Date.now();
  const fail = (what: string) => new Error(redact(`[claude] ${stepName} ${endpointId}: ${what}`));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(anthropicUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      body: JSON.stringify({ model, max_tokens: API_MAX_TOKENS, system, messages: [{ role: 'user', content: user }] }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (controller.signal.aborted) throw fail(`Messages API timed out after ${TIMEOUT_MS / 1000}s`);
    throw fail(`Messages API request failed: ${(err as Error).message}`);
  }
  clearTimeout(timer);
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as ApiResponse;
      if (parsed.error?.message) detail = `${parsed.error.type ?? 'error'}: ${parsed.error.message}`;
    } catch {
      // keep the raw text
    }
    throw fail(`Messages API returned HTTP ${res.status}: ${detail}`);
  }
  let parsed: ApiResponse;
  try {
    parsed = JSON.parse(text) as ApiResponse;
  } catch {
    throw fail(`Messages API response is not valid JSON: ${text.slice(0, 200)}`);
  }
  const result = (parsed.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
  if (result.trim() === '') throw fail(`Messages API returned no text (stop_reason ${parsed.stop_reason ?? 'unknown'})`);
  if (parsed.stop_reason === 'max_tokens') throw fail(`Messages API output was cut off at ${API_MAX_TOKENS} tokens`);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const u = parsed.usage;
  const tokens = u
    ? ` tokens in=${(u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)} out=${u.output_tokens ?? 0}`
    : '';
  console.log(`[claude] ${stepName} ${endpointId} ${secs}s${tokens} (${counter})`);
  return result;
}


type OpenAiResponse = {
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { type?: string; code?: string; message?: string };
};

async function runOpenAiApi(stepName: string, endpointId: string, system: string, user: string, counter: string, model: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY as string;
  const started = Date.now();
  const fail = (what: string) => new Error(redact(`[claude] ${stepName} ${endpointId}: ${what}`));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(openaiUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        max_completion_tokens: API_MAX_TOKENS,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (controller.signal.aborted) throw fail(`Chat Completions API timed out after ${TIMEOUT_MS / 1000}s`);
    throw fail(`Chat Completions API request failed: ${(err as Error).message}`);
  }
  clearTimeout(timer);
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as OpenAiResponse;
      if (parsed.error?.message) detail = `${parsed.error.type ?? parsed.error.code ?? 'error'}: ${parsed.error.message}`;
    } catch {
      // keep the raw text
    }
    throw fail(`Chat Completions API returned HTTP ${res.status}: ${detail}`);
  }
  let parsed: OpenAiResponse;
  try {
    parsed = JSON.parse(text) as OpenAiResponse;
  } catch {
    throw fail(`Chat Completions API response is not valid JSON: ${text.slice(0, 200)}`);
  }
  const choice = parsed.choices?.[0];
  const result = choice?.message?.content ?? '';
  if (result.trim() === '') throw fail(`Chat Completions API returned no text (finish_reason ${choice?.finish_reason ?? 'unknown'})`);
  if (choice?.finish_reason === 'length') throw fail(`Chat Completions API output was cut off at ${API_MAX_TOKENS} tokens`);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const u = parsed.usage;
  const tokens = u ? ` tokens in=${u.prompt_tokens ?? 0} out=${u.completion_tokens ?? 0}` : '';
  console.log(`[claude] ${stepName} ${endpointId} ${secs}s${tokens} (${counter})`);
  return result;
}

export type KeyCheck = { ok: boolean; provider: Provider; model: string; error: string | null };

// One minimal request with the given key, for the setup screen. Never throws; the error text names
// the usual causes in plain words and never contains the key.
export async function verifyProviderKey(provider: Provider, key: string, model?: string): Promise<KeyCheck> {
  const useModel = (model || '').trim() || defaultModel(provider);
  const result = (ok: boolean, error: string | null): KeyCheck => ({ ok, provider, model: useModel, error: error ? redact(error, [key]) : null });
  if (!key || key.trim().length < 8) return result(false, 'Paste the full API key first.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let res: Response;
  try {
    if (provider === 'openai') {
      res = await fetchImpl(openaiUrl(), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: useModel, max_completion_tokens: 5, messages: [{ role: 'user', content: 'Reply with OK' }] }),
        signal: controller.signal,
      });
    } else {
      res = await fetchImpl(anthropicUrl(), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION },
        body: JSON.stringify({ model: useModel, max_tokens: 5, messages: [{ role: 'user', content: 'Reply with OK' }] }),
        signal: controller.signal,
      });
    }
  } catch (err) {
    clearTimeout(timer);
    if (controller.signal.aborted) return result(false, 'The provider did not answer within 30 seconds. Check your network or proxy.');
    return result(false, `Could not reach the provider: ${(err as Error).message}. Check your network, VPN or proxy.`);
  }
  clearTimeout(timer);
  const text = await res.text();
  let detail = '';
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    detail = parsed.error?.message ?? '';
  } catch {
    detail = text.slice(0, 120);
  }
  const suffix = detail ? ` (${detail})` : '';
  if (res.status === 401) return result(false, `The key was rejected (HTTP 401). Check that you pasted the whole key${suffix}.`);
  if (res.status === 402 || res.status === 403) return result(false, `The key is valid but the account cannot use it (HTTP ${res.status}): billing, credits or permissions${suffix}.`);
  if (res.status === 404) return result(false, `Model "${useModel}" was not found (HTTP 404). Leave the model empty for the default or check the name${suffix}.`);
  if (res.status === 429) return result(false, `Rate limited or out of quota (HTTP 429). Wait a minute or check the account limits${suffix}.`);
  if (!res.ok) return result(false, `The provider returned HTTP ${res.status}${suffix}.`);
  return result(true, null);
}

async function runClaudeCli(stepName: string, endpointId: string, system: string, user: string, counter: string): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), 'api-test-agent-'));
  const env = claudeEnv();

  const args = [
    '-p',
    '--output-format', 'json',
    '--system-prompt', system,
    '--tools', '',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
  ];
  if (process.env.CLAUDE_MODEL) args.push('--model', process.env.CLAUDE_MODEL);

  const started = Date.now();
  try {
    const { code, stdout, stderr, timedOut } = await new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
      timedOut: boolean;
    }>((resolve, reject) => {
      const child = spawn('claude', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, TIMEOUT_MS);
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`[claude] ${stepName} ${endpointId}: could not start claude CLI: ${err.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr, timedOut });
      });
      child.stdin.end(user);
    });

    const fail = (what: string) =>
      new Error(redact(`[claude] ${stepName} ${endpointId}: ${what} (exit code ${code}); stderr: ${stderr.slice(0, 500)}`));

    if (timedOut) throw fail(`timed out after ${TIMEOUT_MS / 1000}s`);
    if (code !== 0) throw fail('non-zero exit');

    let parsed: CliOutput;
    try {
      parsed = JSON.parse(stdout) as CliOutput;
    } catch {
      throw fail(`output is not valid JSON: ${stdout.slice(0, 200)}`);
    }
    if (parsed.is_error) throw fail(`CLI reported an error (${parsed.subtype}): ${String(parsed.result).slice(0, 300)}`);
    if (typeof parsed.result !== 'string' || parsed.result.trim() === '') throw fail('empty result field');

    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const u = parsed.usage;
    const tokens = u
      ? ` tokens in=${(u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)} out=${u.output_tokens ?? 0}`
      : '';
    console.log(`[claude] ${stepName} ${endpointId} ${secs}s${tokens} (${counter})`);
    return parsed.result;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
