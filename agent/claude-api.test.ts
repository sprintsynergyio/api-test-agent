import assert from 'node:assert/strict';
import { callClaudeOutsideBudget, claudeEnv, hostedWithoutApiKeyProblem, redact, setFetchForTests, usingApiKey } from './claude';

// npm run test:claude-api: the Messages API path of agent/claude.ts with a fake fetch. Offline, no key.
// Every case here is a way the API path could leak the key or make a failure look like a result.

let failed = 0;
let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`ok    ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}\n      ${String((err as Error)?.message ?? err).split('\n').join('\n      ')}`);
  }
}

const KEY = 'sk-ant-test-key-0123456789';
type Captured = { url: string; init: RequestInit };

function fakeFetch(status: number, body: unknown, captured: Captured[]) {
  setFetchForTests(async (url, init) => {
    captured.push({ url: String(url), init: init ?? {} });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
}

async function main() {
  process.env.ANTHROPIC_API_KEY = KEY;
  process.env.CLAUDE_MODEL = 'claude-test-model';

  await check('with ANTHROPIC_API_KEY set the API path is used', () => {
    assert.equal(usingApiKey(), true);
  });

  await check('request shape: URL, headers, model, system, user message; the key only in x-api-key', async () => {
    const captured: Captured[] = [];
    fakeFetch(200, { content: [{ type: 'text', text: '{"ok":true}' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 3 } }, captured);
    const out = await callClaudeOutsideBudget('plan', 'ep-1', 'SYSTEM PROMPT', 'USER PROMPT', 'test 1/1');
    assert.equal(out, '{"ok":true}');
    assert.equal(captured.length, 1);
    const { url, init } = captured[0];
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(init.method, 'POST');
    const headers = init.headers as Record<string, string>;
    assert.equal(headers['x-api-key'], KEY);
    assert.equal(headers['anthropic-version'], '2023-06-01');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    assert.equal(body.model, 'claude-test-model');
    assert.equal(body.system, 'SYSTEM PROMPT');
    assert.deepEqual(body.messages, [{ role: 'user', content: 'USER PROMPT' }]);
    assert.ok(typeof body.max_tokens === 'number' && body.max_tokens >= 8000, 'max_tokens leaves room for a full spec');
    assert.ok(!String(init.body).includes(KEY), 'the key is never in the body');
  });

  for (const status of [429, 500, 529]) {
    await check(`HTTP ${status} throws with the status in the message, no empty result`, async () => {
      fakeFetch(status, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, []);
      await assert.rejects(callClaudeOutsideBudget('plan', 'ep-1', 's', 'u', 'test'), (err: Error) => {
        assert.match(err.message, new RegExp(`HTTP ${status}`));
        assert.match(err.message, /Overloaded/);
        assert.ok(!err.message.includes(KEY), 'the key is never in an error');
        return true;
      });
    });
  }

  await check('401 with the key echoed back is redacted in the error', async () => {
    fakeFetch(401, { type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${KEY}` } }, []);
    await assert.rejects(callClaudeOutsideBudget('plan', 'ep-1', 's', 'u', 'test'), (err: Error) => {
      assert.match(err.message, /HTTP 401/);
      assert.ok(!err.message.includes(KEY), err.message);
      assert.match(err.message, /<redacted>/);
      return true;
    });
  });

  await check('an empty content array throws instead of returning ""', async () => {
    fakeFetch(200, { content: [], stop_reason: 'end_turn' }, []);
    await assert.rejects(callClaudeOutsideBudget('plan', 'ep-1', 's', 'u', 'test'), /returned no text/);
  });

  await check('a response cut off at max_tokens throws', async () => {
    fakeFetch(200, { content: [{ type: 'text', text: 'partial' }], stop_reason: 'max_tokens' }, []);
    await assert.rejects(callClaudeOutsideBudget('plan', 'ep-1', 's', 'u', 'test'), /cut off/);
  });

  await check('a non-JSON body throws', async () => {
    fakeFetch(200, '<html>gateway</html>', []);
    await assert.rejects(callClaudeOutsideBudget('plan', 'ep-1', 's', 'u', 'test'), /not valid JSON/);
  });

  await check('a network failure throws with the reason', async () => {
    setFetchForTests(async () => {
      throw new Error('ECONNRESET');
    });
    await assert.rejects(callClaudeOutsideBudget('plan', 'ep-1', 's', 'u', 'test'), /request failed: ECONNRESET/);
  });

  await check('child process environment drops ANTHROPIC_API_KEY and every AUTH variable', () => {
    process.env.SOME_API_AUTH_VALUE = 'Bearer abc';
    const env = claudeEnv();
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.SOME_API_AUTH_VALUE, undefined);
    assert.ok(env.PATH, 'PATH is kept');
    delete process.env.SOME_API_AUTH_VALUE;
  });

  await check('redact hides the API key value', () => {
    assert.equal(redact(`key is ${KEY} here`), 'key is <redacted> here');
  });

  await check('HOSTED=1 without a key is a named problem; with a key it is fine', () => {
    process.env.HOSTED = '1';
    delete process.env.ANTHROPIC_API_KEY;
    assert.match(hostedWithoutApiKeyProblem() ?? '', /HOSTED=1 requires ANTHROPIC_API_KEY/);
    process.env.ANTHROPIC_API_KEY = KEY;
    assert.equal(hostedWithoutApiKeyProblem(), null);
    delete process.env.HOSTED;
    delete process.env.ANTHROPIC_API_KEY;
    assert.equal(hostedWithoutApiKeyProblem(), null);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
