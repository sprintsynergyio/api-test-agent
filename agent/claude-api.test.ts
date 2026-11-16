import assert from 'node:assert/strict';
import { callClaudeOutsideBudget, claudeCliArgs, claudeEnv, modelRetries, retryDelayMs, describeModelChoice, hostedWithoutApiKeyProblem, modelChoice, redact, setFetchForTests, usingApiKey, verifyProviderKey } from './claude';

// npm run test:claude-api: the Messages API and Chat Completions paths of agent/claude.ts with a fake
// fetch, plus verifyProviderKey. Offline, no key.
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
  // Retries wait 1 ms here instead of seconds.
  process.env.MODEL_RETRY_BASE_MS = '1';

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

  await check('429 and 5xx are retried with backoff and the call succeeds when the provider recovers', async () => {
    for (const status of [429, 500, 502, 503, 504, 529]) {
      const captured: Captured[] = [];
      let n = 0;
      setFetchForTests(async (url, init) => {
        captured.push({ url: String(url), init: init ?? {} });
        n++;
        if (n < 3) return new Response(JSON.stringify({ error: { message: 'busy' } }), { status, headers: { 'retry-after': '0' } });
        return new Response(JSON.stringify({ content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' }), { status: 200 });
      });
      assert.equal(await callClaudeOutsideBudget('plan', 'ep-1', 's', 'u', 'test'), 'done', `HTTP ${status}`);
      assert.equal(captured.length, 3, `HTTP ${status}: two retries then success`);
    }
  });
  await check('a persistent 429 gives up after MODEL_RETRIES retries (default 3) with the status in the error', async () => {
    const captured: Captured[] = [];
    fakeFetch(429, { error: { message: 'rate limited' } }, captured);
    await assert.rejects(callClaudeOutsideBudget('plan', 'ep-1', 's', 'u', 'test'), /HTTP 429/);
    assert.equal(modelRetries(), 3);
    assert.equal(captured.length, 4);
    process.env.MODEL_RETRIES = '0';
    const once: Captured[] = [];
    fakeFetch(429, { error: { message: 'rate limited' } }, once);
    await assert.rejects(callClaudeOutsideBudget('plan', 'ep-1', 's', 'u', 'test'), /HTTP 429/);
    assert.equal(once.length, 1, 'MODEL_RETRIES=0 turns retries off');
    delete process.env.MODEL_RETRIES;
  });
  await check('other 4xx (400, 401, 404) are not retried', async () => {
    for (const status of [400, 401, 404]) {
      const captured: Captured[] = [];
      fakeFetch(status, { error: { message: 'no' } }, captured);
      await assert.rejects(callClaudeOutsideBudget('plan', 'ep-1', 's', 'u', 'test'), new RegExp(`HTTP ${status}`));
      assert.equal(captured.length, 1, `HTTP ${status} sent once`);
    }
  });
  await check('a network error is retried; the OpenAI path retries too', async () => {
    let n = 0;
    setFetchForTests(async () => {
      if (n++ === 0) throw new Error('ECONNRESET');
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }), { status: 200 });
    });
    assert.equal(await callClaudeOutsideBudget('plan', 'ep-1', 's', 'u', 'test'), 'ok');
    assert.equal(n, 2);
    const prevProvider = process.env.LLM_PROVIDER;
    process.env.LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-openai-test-key-0123456789';
    let m = 0;
    setFetchForTests(async () => {
      if (m++ === 0) return new Response('{}', { status: 503 });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] }), { status: 200 });
    });
    try {
      assert.equal(await callClaudeOutsideBudget('plan', 'ep-1', 's', 'u', 'test'), 'hi');
      assert.equal(m, 2);
    } finally {
      if (prevProvider === undefined) delete process.env.LLM_PROVIDER;
      else process.env.LLM_PROVIDER = prevProvider;
      delete process.env.OPENAI_API_KEY;
    }
  });
  await check('retryDelayMs: exponential with jitter, capped; Retry-After seconds or date wins', () => {
    process.env.MODEL_RETRY_BASE_MS = '2000';
    try {
      assert.equal(retryDelayMs(1, null, 0, () => 1), 2000);
      assert.equal(retryDelayMs(2, null, 0, () => 1), 4000);
      assert.equal(retryDelayMs(3, null, 0, () => 0), 4000);
      assert.equal(retryDelayMs(10, null, 0, () => 1), 30_000);
      assert.equal(retryDelayMs(1, '7', 0), 7000);
      assert.equal(retryDelayMs(1, new Date(10_000).toUTCString(), 0), 10_000);
      assert.equal(retryDelayMs(1, '9999', 0), 60_000);
    } finally {
      process.env.MODEL_RETRY_BASE_MS = '1';
    }
  });
  await check('Claude Code CLI path: LLM_MODEL is passed as --model, CLAUDE_MODEL as the fallback, none by default', () => {
    const prevL = process.env.LLM_MODEL;
    const prevC = process.env.CLAUDE_MODEL;
    try {
      process.env.LLM_MODEL = 'claude-from-llm-model';
      process.env.CLAUDE_MODEL = 'claude-old-name';
      let args = claudeCliArgs('SYS');
      assert.equal(args[args.indexOf('--model') + 1], 'claude-from-llm-model');
      delete process.env.LLM_MODEL;
      args = claudeCliArgs('SYS');
      assert.equal(args[args.indexOf('--model') + 1], 'claude-old-name');
      delete process.env.CLAUDE_MODEL;
      args = claudeCliArgs('SYS');
      assert.ok(!args.includes('--model'));
      assert.equal(args[args.indexOf('--system-prompt') + 1], 'SYS');
    } finally {
      if (prevL === undefined) delete process.env.LLM_MODEL;
      else process.env.LLM_MODEL = prevL;
      if (prevC === undefined) delete process.env.CLAUDE_MODEL;
      else process.env.CLAUDE_MODEL = prevC;
    }
  });

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

  // ---------- OpenAI path ----------
  const OPENAI_KEY = 'sk-proj-test-key-9876543210';

  await check('LLM_PROVIDER=openai without OPENAI_API_KEY is a named problem', () => {
    process.env.LLM_PROVIDER = 'openai';
    delete process.env.OPENAI_API_KEY;
    assert.match(hostedWithoutApiKeyProblem() ?? '', /LLM_PROVIDER=openai requires OPENAI_API_KEY/);
    process.env.OPENAI_API_KEY = OPENAI_KEY;
    assert.equal(hostedWithoutApiKeyProblem(), null);
  });

  await check('model choice: openai with a key is via api with the default model; LLM_MODEL overrides; CLAUDE_MODEL does not', () => {
    delete process.env.LLM_MODEL;
    process.env.CLAUDE_MODEL = 'claude-test-model';
    assert.deepEqual(modelChoice(), { provider: 'openai', model: 'gpt-6.1-sol', via: 'api' });
    process.env.LLM_MODEL = 'gpt-custom';
    assert.deepEqual(modelChoice(), { provider: 'openai', model: 'gpt-custom', via: 'api' });
    assert.equal(describeModelChoice(), 'model: openai gpt-custom (API key)');
    assert.equal(usingApiKey(), true);
  });

  await check('openai request shape: Chat Completions URL, Bearer header, system and user messages, max_completion_tokens', async () => {
    const captured: Captured[] = [];
    fakeFetch(200, { choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3 } }, captured);
    const out = await callClaudeOutsideBudget('plan', 'ep-1', 'SYSTEM PROMPT', 'USER PROMPT', 'test 1/1');
    assert.equal(out, '{"ok":true}');
    const { url, init } = captured[0];
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    const headers = init.headers as Record<string, string>;
    assert.equal(headers.authorization, `Bearer ${OPENAI_KEY}`);
    assert.equal(headers['x-api-key'], undefined);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    assert.equal(body.model, 'gpt-custom');
    assert.deepEqual(body.messages, [
      { role: 'system', content: 'SYSTEM PROMPT' },
      { role: 'user', content: 'USER PROMPT' },
    ]);
    assert.ok(typeof body.max_completion_tokens === 'number' && body.max_completion_tokens >= 8000);
    assert.equal(body.max_tokens, undefined, 'current OpenAI models reject max_tokens');
    assert.ok(!String(init.body).includes(OPENAI_KEY));
  });

  await check('OPENAI_BASE_URL redirects the call (tests and proxies)', async () => {
    const captured: Captured[] = [];
    process.env.OPENAI_BASE_URL = 'http://127.0.0.1:1234/';
    fakeFetch(200, { choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] }, captured);
    await callClaudeOutsideBudget('plan', 'ep-1', 's', 'u', 'test');
    assert.equal(captured[0].url, 'http://127.0.0.1:1234/v1/chat/completions');
    delete process.env.OPENAI_BASE_URL;
  });

  for (const status of [401, 429, 500]) {
    await check(`openai HTTP ${status} throws with the status, key redacted`, async () => {
      fakeFetch(status, { error: { type: 'x', message: `bad ${OPENAI_KEY}` } }, []);
      await assert.rejects(callClaudeOutsideBudget('plan', 'ep-1', 's', 'u', 'test'), (err: Error) => {
        assert.match(err.message, new RegExp(`HTTP ${status}`));
        assert.ok(!err.message.includes(OPENAI_KEY), err.message);
        return true;
      });
    });
  }

  await check('openai empty content and a length cut-off both throw', async () => {
    fakeFetch(200, { choices: [{ message: { content: '' }, finish_reason: 'stop' }] }, []);
    await assert.rejects(callClaudeOutsideBudget('plan', 'ep-1', 's', 'u', 'test'), /returned no text/);
    fakeFetch(200, { choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] }, []);
    await assert.rejects(callClaudeOutsideBudget('plan', 'ep-1', 's', 'u', 'test'), /cut off/);
  });

  await check('child process environment drops OPENAI_API_KEY too', () => {
    const env = claudeEnv();
    assert.equal(env.OPENAI_API_KEY, undefined);
  });

  await check('redact hides the OpenAI key value', () => {
    assert.equal(redact(`k ${OPENAI_KEY}`), 'k <redacted>');
  });

  delete process.env.LLM_PROVIDER;
  delete process.env.LLM_MODEL;
  delete process.env.OPENAI_API_KEY;

  // ---------- verifyProviderKey ----------
  for (const provider of ['anthropic', 'openai'] as const) {
    const okBody = provider === 'anthropic' ? { content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' } : { choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] };
    await check(`verifyProviderKey ${provider}: 200 is ok with the default model and a minimal request`, async () => {
      const captured: Captured[] = [];
      fakeFetch(200, okBody, captured);
      const r = await verifyProviderKey(provider, 'sk-verify-key-123456789');
      assert.deepEqual(r, { ok: true, provider, model: provider === 'anthropic' ? 'claude-sonnet-5-5' : 'gpt-6.1-sol', error: null });
      const body = JSON.parse(String(captured[0].init.body)) as Record<string, unknown>;
      assert.equal(provider === 'anthropic' ? body.max_tokens : body.max_completion_tokens, 5);
    });
    await check(`verifyProviderKey ${provider}: 401, 404, 429 and a network error give plain messages without the key`, async () => {
      const key = 'sk-verify-key-123456789';
      fakeFetch(401, { error: { message: `invalid ${key}` } }, []);
      let r = await verifyProviderKey(provider, key);
      assert.equal(r.ok, false);
      assert.match(r.error ?? '', /rejected \(HTTP 401\)/);
      assert.ok(!(r.error ?? '').includes(key), r.error ?? '');
      fakeFetch(404, { error: { message: 'no such model' } }, []);
      r = await verifyProviderKey(provider, key, 'nope-1');
      assert.match(r.error ?? '', /"nope-1" was not found \(HTTP 404\)/);
      fakeFetch(429, { error: { message: 'slow down' } }, []);
      r = await verifyProviderKey(provider, key);
      assert.match(r.error ?? '', /Rate limited or out of quota \(HTTP 429\)/);
      fakeFetch(403, { error: { message: 'no credits' } }, []);
      r = await verifyProviderKey(provider, key);
      assert.match(r.error ?? '', /billing, credits or permissions/);
      setFetchForTests(async () => {
        throw new Error('ENOTFOUND api.example');
      });
      r = await verifyProviderKey(provider, key);
      assert.match(r.error ?? '', /Could not reach the provider: ENOTFOUND/);
    });
  }

  await check('verifyProviderKey refuses an empty key without calling the provider', async () => {
    let called = 0;
    setFetchForTests(async () => {
      called++;
      return new Response('{}', { status: 200 });
    });
    const r = await verifyProviderKey('openai', '');
    assert.equal(r.ok, false);
    assert.equal(called, 0);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
