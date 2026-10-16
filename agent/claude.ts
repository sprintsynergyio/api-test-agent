import 'dotenv/config';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Calls the Claude Code CLI in headless print mode with the user's existing login.
// No SDK, no API key.

const TIMEOUT_MS = 180_000;
const DEFAULT_BUDGET = 30;

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

// Defensive: never let an auth value from the environment reach an error or log line.
function redact(text: string): string {
  let out = text;
  for (const [name, value] of Object.entries(process.env)) {
    if (/AUTH/i.test(name) && value && value.length >= 6) out = out.split(value).join('<redacted>');
  }
  return out;
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
  if (callsUsed >= budget) throw new BudgetExceeded(callsUsed, budget);
  callsUsed++;

  const cwd = mkdtempSync(join(tmpdir(), 'api-test-agent-'));
  const env = { ...process.env };
  delete env.CLAUDECODE;

  const args = [
    '-p',
    '--output-format', 'json',
    '--system-prompt', system,
    '--tools', '',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
  ];

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
    console.log(`[claude] ${stepName} ${endpointId} ${secs}s${tokens} (call ${callsUsed}/${budget})`);
    return parsed.result;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
