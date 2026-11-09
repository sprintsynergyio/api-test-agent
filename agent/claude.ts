import 'dotenv/config';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Calls Claude one of two ways, chosen by the environment:
//   - ANTHROPIC_API_KEY set: the Messages API over HTTPS with fetch (hosted mode requires this, so a
//     shared server never uses a personal login; billed to the key's Console workspace).
//   - otherwise: the Claude Code CLI in headless print mode with the machine's existing login.
// Both return the model's text and log the same "[claude] <step> <id> <secs>s tokens in= out= (call n/m)" line.

const TIMEOUT_MS = 180_000;
const DEFAULT_BUDGET = 30;
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const API_DEFAULT_MODEL = 'claude-sonnet-5-5';
const API_MAX_TOKENS = 16_000;
// Variables that must never reach a child process or a log line.
const SECRET_ENV = /AUTH|ANTHROPIC_API_KEY/i;

export function usingApiKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export function hostedWithoutApiKeyProblem(): string | null {
  if (process.env.HOSTED === '1' && !usingApiKey()) {
    return 'HOSTED=1 requires ANTHROPIC_API_KEY: the hosted agent never uses a personal Claude login.';
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

// Never let an auth value or the API key reach an error or log line: env values whose name contains
// AUTH or ANTHROPIC_API_KEY, plus any extra secrets the caller passes.
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
// included so the CLI can be found, minus CLAUDECODE, every variable with AUTH in its name and
// ANTHROPIC_API_KEY. Neither the model nor the tests ever need those values.
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

async function runClaude(stepName: string, endpointId: string, system: string, user: string, counter: string): Promise<string> {
  if (usingApiKey()) return runClaudeApi(stepName, endpointId, system, user, counter);
  return runClaudeCli(stepName, endpointId, system, user, counter);
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

async function runClaudeApi(stepName: string, endpointId: string, system: string, user: string, counter: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY as string;
  const model = process.env.CLAUDE_MODEL || API_DEFAULT_MODEL;
  const started = Date.now();
  const fail = (what: string) => new Error(redact(`[claude] ${stepName} ${endpointId}: ${what}`));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': API_VERSION },
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
