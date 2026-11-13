import assert from 'node:assert/strict';
import { buildPrompt as buildGeneratePrompt } from './generate';
import { playwrightAdapter } from './frameworks/playwright';
import { formatExchange } from './http';
import { buildPrompt as buildPlanPrompt, type Plan } from './plan';
import { redactProbe, type ProbeResult } from './probe';
import { fieldMatches, redactHeaders, redactText, redactValue } from './redact';
import type { Config, Endpoint } from './config';

// npm run test:redact: the redaction rules (agent/redact.ts) and the places that must apply them:
// the probe, the plan and generate prompts, the evidence attachments. Offline, no Claude, no network.

let failed = 0;
let passed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`ok    ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}\n      ${String((err as Error)?.message ?? err).split('\n').join('\n      ')}`);
  }
}

const counter = () => ({ replaced: 0 });

function goes(text: string, tag: string) {
  const c = counter();
  const out = redactText(text, c);
  assert.ok(out.includes(tag), `expected ${JSON.stringify(text)} to become ${tag}, got ${JSON.stringify(out)}`);
  assert.ok(c.replaced >= 1, 'counter must count the replacement');
}

function stays(text: string) {
  const c = counter();
  assert.equal(redactText(text, c), text);
  assert.equal(c.replaced, 0);
}

// --- built-in rules, positive and negative ---

check('emails go', () => goes('contact john.doe+orders@shop-mail.co.uk now', '<email>'));
check('a word with an at sign but no domain stays', () => stays('meet @ noon'));
check('a Luhn-valid 16 digit card goes', () => goes('card 4242424242424242', '<card>'));
check('a Luhn-valid card in groups of 4 goes', () => goes('card 4242 4242 4242 4242', '<card>'));
check('a 16 digit number that fails Luhn stays', () => stays('ref 4111111111111112'));
check('a 10 digit order number stays', () => stays('order 1234567890 shipped'));
check('a 13 digit epoch timestamp stays (fails Luhn)', () => stays('created 1762990885123'));
check('an ISO timestamp stays', () => stays('createdAt 2026-11-12T22:41:25.123Z'));
check('a date stays', () => stays('date 2026-11-12'));
check('a clock time stays', () => stays('at 22:41:25'));
check('a phone with a country code goes', () => goes('call +92 300 1234567', '<phone>'));
check('a phone with brackets and dashes goes', () => goes('call (415) 555-0132', '<phone>'));
check('a bare run of digits is an id and stays', () => stays('id 9876543210'));
check('a price stays', () => stays('price 19.99 total 1299'));
check('an IBAN goes', () => goes('iban GB82WEST12345698765432', '<iban>'));
check('an IPv4 address goes', () => goes('from 10.0.0.12', '<ip>'));
check('an IPv6 address goes', () => goes('from 2001:db8::1 and fe80::1', '<ip>'));
check('a JWT goes', () => goes('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefGHIJKLmnop', '<token>'));
check('a Bearer value goes and keeps the scheme', () => {
  const out = redactText('Authorization: Bearer abc123def456ghi', counter());
  assert.equal(out, 'Authorization: Bearer <token>');
});
check('a prefixed API key goes', () => goes('key sk-ant-api03-abcdefghijklmnopqrstuvwxyz', '<token>'));
check('plain words stay', () => stays('Classic Tee in stock, category tops, limit 5'));

check('redaction is idempotent', () => {
  const text = 'a@b.co 4242424242424242 +92 300 1234567 10.0.0.1 GB82WEST12345698765432 Bearer abcdefghijkl';
  const once = redactText(text, counter());
  assert.equal(redactText(once, counter()), once);
  const req = redactText(text, counter(), 'request');
  const c = counter();
  assert.equal(redactText(req, c, 'request'), req);
  assert.equal(c.replaced, 0, 'request stand-ins are not redacted again');
});

check('request context uses valid stand-ins', () => {
  const out = redactValue({ email: 'jane@client.com', phone: '+1 415 555 0132', card: '4242424242424242' }, undefined, counter(), 'request');
  assert.deepEqual(out, { email: 'redacted@example.com', phone: '+10000000000', card: '4111111111111111' });
});

// --- JSON values ---

check('a short word in a token field goes, a name stays (standard mode)', () => {
  const c = counter();
  const out = redactValue({ name: 'Classic Tee', token: 'x', apiKey: 'k', password: 'pw', refreshToken: 'r', id: 7, ok: true, none: null }, undefined, c);
  assert.deepEqual(out, { name: 'Classic Tee', token: '<token>', apiKey: '<token>', password: '<token>', refreshToken: '<token>', id: 7, ok: true, none: null });
  assert.equal(c.replaced, 4);
});

check('strict mode keeps keys, booleans, nulls and array lengths only', () => {
  const out = redactValue({ name: 'Classic Tee', price: 19.99, ok: true, none: null, tags: ['a', 'bb'], nested: { id: 3 } }, { mode: 'strict' }, counter());
  assert.deepEqual(out, { name: '<string:11>', price: '<number>', ok: true, none: null, tags: ['<string:1>', '<string:2>'], nested: { id: '<number>' } });
});

check('listed fields go with dot paths and wildcards, inside arrays too', () => {
  const body = { customer: { name: 'Jane', ssn: '123' }, items: [{ sku: 'A', note: 'n1' }, { sku: 'B', note: 'n2' }], address: { city: 'Lahore', zip: '54000' } };
  const out = redactValue(body, { fields: ['customer.name', 'address.*', 'items.*.note'] }, counter()) as typeof body;
  assert.equal(out.customer.name, '<redacted>');
  assert.equal(out.customer.ssn, '123', 'an unlisted field stays');
  assert.deepEqual(out.address, { city: '<redacted>', zip: '<redacted>' });
  assert.deepEqual(out.items, [{ sku: 'A', note: '<redacted>' }, { sku: 'B', note: '<redacted>' }]);
});

check('fieldMatches: * is one segment, lengths must match', () => {
  assert.ok(fieldMatches('a.*.c', ['a', '0', 'c']));
  assert.ok(!fieldMatches('a.*', ['a', 'b', 'c']));
  assert.ok(!fieldMatches('a.b', ['a']));
});

check('credential-looking headers are replaced whole, others get the text rules', () => {
  const out = redactHeaders({ 'Content-Type': 'application/json', Authorization: 'Bearer x', 'X-Api-Key': 'k', Cookie: 's=1', 'X-Session-Id': 'abc', 'X-Forwarded-For': '10.1.2.3' }, counter());
  assert.deepEqual(out, { 'Content-Type': 'application/json', Authorization: '<redacted>', 'X-Api-Key': '<redacted>', Cookie: '<redacted>', 'X-Session-Id': '<redacted>', 'X-Forwarded-For': '<ip>' });
});

// --- the places that must apply it ---

const endpoint: Endpoint = {
  id: 'create-order',
  method: 'POST',
  path: '/orders',
  requiresAuth: true,
  body: { email: 'jane@client.com', card: '4242424242424242', note: 'rush' },
  headers: { 'X-Trace': '10.9.8.7' },
};
const config: Config = { baseUrl: 'http://localhost:4700', defaultHeaders: {}, auth: { type: 'header', header: 'Authorization', valueEnv: 'X' }, endpoints: [endpoint], selection: null };
const rawProbe: ProbeResult = {
  endpointId: 'create-order',
  method: 'POST',
  path: '/orders',
  requestBody: endpoint.body,
  query: null,
  headers: endpoint.headers ?? null,
  status: 201,
  contentType: 'application/json',
  body: { id: 42, email: 'jane@client.com', card: '4242424242424242', phone: '+92 300 1234567', token: 'abc', createdAt: '2026-11-12T22:41:25.123Z' },
  durationMs: 3,
  usable: true,
};
const SECRETS = ['jane@client.com', '4242424242424242', '+92 300 1234567', '10.9.8.7'];

check('redactProbe hides the response values and keeps status, shape and timestamps', () => {
  const c = counter();
  const p = redactProbe(rawProbe, config, c);
  assert.equal(p.status, 201);
  assert.deepEqual(p.body, { id: 42, email: '<email>', card: '<card>', phone: '<phone>', token: '<token>', createdAt: '2026-11-12T22:41:25.123Z' });
  assert.deepEqual(p.requestBody, { email: 'redacted@example.com', card: '4111111111111111', note: 'rush' });
  assert.deepEqual(p.headers, { 'X-Trace': '<ip>' });
  assert.ok(c.replaced >= 6);
});

check('the plan prompt carries none of the client values', () => {
  const prompt = buildPlanPrompt(endpoint, redactProbe(rawProbe, config, counter()), []);
  for (const s of SECRETS) assert.ok(!prompt.includes(s), `plan prompt contains ${s}`);
  assert.ok(prompt.includes('redacted@example.com'), 'the sample body keeps a valid stand-in');
});

check('the generate prompt carries none of the client values', () => {
  const plan: Plan = {
    endpointId: 'create-order',
    cases: [{ id: 'h', type: 'happy', title: '[happy] create-order', requestDescription: 'valid body', expectedStatus: '201', assertions: ['status 201'] }],
  };
  const prompt = buildGeneratePrompt(playwrightAdapter, endpoint, plan, redactProbe(rawProbe, config, counter()));
  for (const s of SECRETS) assert.ok(!prompt.includes(s), `generate prompt contains ${s}`);
});

check('evidence attachments are redacted, with the per-API field rules', () => {
  const cfg: Config = { ...config, redaction: { fields: ['note'] } };
  const { body } = formatExchange(
    cfg,
    {
      method: 'POST',
      path: '/orders',
      role: 'default',
      requestHeaders: { Authorization: 'Bearer real-token', 'X-Trace': '10.9.8.7' },
      requestBody: endpoint.body,
      status: 201,
      responseBody: JSON.stringify(rawProbe.body),
    },
    'Bearer real-token',
  );
  for (const s of [...SECRETS, 'real-token']) assert.ok(!body.includes(s), `evidence contains ${s}`);
  const parsed = JSON.parse(body);
  assert.equal(parsed.response.body.email, '<email>');
  assert.equal(parsed.response.body.id, 42);
  assert.equal(parsed.request.body.note, '<redacted>', 'listed field in the request body');
  assert.equal(parsed.request.headers.Authorization, '<redacted>');
});

check('a failed exchange redacts the error text too', () => {
  const { body } = formatExchange(config, { method: 'GET', path: '/orders', role: null, requestHeaders: {}, requestBody: null, status: null, responseBody: '', error: 'connect to 10.9.8.7 failed for jane@client.com' }, undefined);
  assert.ok(!body.includes('10.9.8.7') && !body.includes('jane@client.com'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
