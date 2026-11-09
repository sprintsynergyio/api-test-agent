import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configProblems, ConfigSchema, loadConfig, takeSelectFlag } from './config';
import { parseSelection, pathParams, queryString, resolvePath, resolveProfile, setupSteps, type Profile } from './model';
import { assessSafety } from './safety';

// npm run test:config: the input model (placeholders, setup steps, query, headers, profiles).
// Plain node:assert, offline, no network, no Claude.

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

const dir = mkdtempSync(join(tmpdir(), 'config-test-'));
function inputFile(name: string, content: unknown): string {
  const file = join(dir, `${name}.json`);
  writeFileSync(file, JSON.stringify(content));
  return file;
}

const HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json' };
const PROFILE: Profile = {
  dimensions: { env: ['dev', 'staging'], brand: ['alpha', 'beta'], region: ['us', 'eu'] },
  baseUrl: 'https://{brand}-{region}.{env}.example.test',
  headers: { 'X-Brand': '{brand}', 'X-Region': '{region}', Accept: 'application/vnd.shop+json' },
  overrides: [
    { when: { region: 'eu' }, headers: { 'Accept-Language': 'en-GB' } },
    { when: { env: 'dev', brand: 'beta' }, baseUrl: 'https://beta-{region}.dev-internal.example.test', headers: { 'X-Region': 'dev-{region}' } },
  ],
};
const ENDPOINTS = [
  { id: 'list', method: 'GET', path: '/products', requiresAuth: false },
  { id: 'create', method: 'POST', path: '/products', requiresAuth: false, body: { name: 'x' } },
  { id: 'get', method: 'GET', path: '/products/{id}', requiresAuth: false, setup: { endpointId: 'create', idField: 'id' } },
];

console.log('Placeholders and paths');

check('pathParams lists placeholders in order', () => {
  assert.deepEqual(pathParams('/products/{id}/reviews/{reviewId}'), ['id', 'reviewId']);
  assert.deepEqual(pathParams('/products'), []);
});

check('resolvePath with a string fills only the first placeholder (original behaviour)', () => {
  assert.equal(resolvePath('/products/{id}', '4'), '/products/4');
  assert.equal(resolvePath('/products/{id}/reviews/{reviewId}', '4'), '/products/4/reviews/{reviewId}');
});

check('resolvePath with a map fills every placeholder and URL-encodes the values', () => {
  assert.equal(resolvePath('/products/{id}/reviews/{reviewId}', { id: '4', reviewId: 'a b/c' }), '/products/4/reviews/a%20b%2Fc');
});

check('resolvePath with a map throws when a placeholder is left unfilled', () => {
  assert.throws(() => resolvePath('/products/{id}/reviews/{reviewId}', { id: '4' }), /unfilled placeholder\(s\): \{reviewId\}/);
});

console.log('Setup steps');

check('a single setup object fills the first placeholder', () => {
  assert.deepEqual(setupSteps({ path: '/products/{id}', setup: { endpointId: 'create', idField: 'id' } }), [
    { endpointId: 'create', idField: 'id', param: 'id' },
  ]);
});

check('a setup array keeps its order and its param names', () => {
  const steps = setupSteps({
    path: '/products/{id}/reviews/{reviewId}',
    setup: [
      { endpointId: 'create-product', idField: 'id', param: 'id' },
      { endpointId: 'create-review', idField: 'id', param: 'reviewId' },
    ],
  });
  assert.deepEqual(
    steps.map((s) => `${s.endpointId}->${s.param}`),
    ['create-product->id', 'create-review->reviewId'],
  );
});

check('a setup array without param names fills placeholders by position', () => {
  const steps = setupSteps({
    path: '/a/{x}/b/{y}',
    setup: [
      { endpointId: 'make-a', idField: 'id' },
      { endpointId: 'make-b', idField: 'id' },
    ],
  });
  assert.deepEqual(steps.map((s) => s.param), ['x', 'y']);
});

check('configProblems rejects a setup param that is not a placeholder of the path', () => {
  const config = ConfigSchema.parse({
    baseUrl: 'http://localhost:4000',
    defaultHeaders: HEADERS,
    endpoints: [...ENDPOINTS, { id: 'bad', method: 'GET', path: '/products/{id}', requiresAuth: false, setup: [{ endpointId: 'create', idField: 'id', param: 'productId' }] }],
  });
  assert.match(configProblems(config).join('\n'), /setup\[0\]\.param" names \{productId\}, which is not a placeholder of \/products\/\{id\}/);
});

check('configProblems rejects two setup steps filling the same placeholder', () => {
  const config = ConfigSchema.parse({
    baseUrl: 'http://localhost:4000',
    defaultHeaders: HEADERS,
    endpoints: [
      ...ENDPOINTS,
      { id: 'bad', method: 'GET', path: '/products/{id}/reviews/{reviewId}', requiresAuth: false, setup: [{ endpointId: 'create', idField: 'id', param: 'id' }, { endpointId: 'create', idField: 'id', param: 'id' }] },
    ],
  });
  assert.match(configProblems(config).join('\n'), /fills \{id\} twice/);
});

check('the schema rejects a query string inside path', () => {
  const result = ConfigSchema.safeParse({
    baseUrl: 'http://localhost:4000',
    defaultHeaders: HEADERS,
    endpoints: [{ id: 'list', method: 'GET', path: '/products?limit=5', requiresAuth: false }],
  });
  assert.equal(result.success, false);
  assert.match(JSON.stringify(result.success ? '' : result.error.issues), /must not contain a query string/);
});

console.log('Query parameters and headers');

check('queryString encodes keys and values and keeps the order', () => {
  assert.equal(queryString({ category: 'shoes & boots', limit: 5, inStock: true }), '?category=shoes%20%26%20boots&limit=5&inStock=true');
  assert.equal(queryString(undefined), '');
  assert.equal(queryString({}), '');
});

check('queryString refuses arrays and objects with a clear message', () => {
  assert.throws(() => queryString({ ids: [1, 2] as unknown as string }), /query parameter "ids" must be a string, number or boolean/);
});

check('the schema accepts query and headers on an endpoint and loadConfig keeps them', () => {
  const file = inputFile('query', {
    baseUrl: 'http://localhost:4000',
    defaultHeaders: HEADERS,
    endpoints: [{ id: 'list', method: 'GET', path: '/products', requiresAuth: false, query: { limit: 5, category: 'shoes' }, headers: { 'X-Request-Source': 'test' } }],
  });
  const config = loadConfig(file, undefined);
  assert.deepEqual(config.endpoints[0].query, { limit: 5, category: 'shoes' });
  assert.deepEqual(config.endpoints[0].headers, { 'X-Request-Source': 'test' });
  assert.equal(config.selection, null);
});

console.log('Profiles and selection');

check('parseSelection reads dimension=value pairs', () => {
  assert.deepEqual(parseSelection('env=staging, brand=alpha,region=eu'), { env: 'staging', brand: 'alpha', region: 'eu' });
  assert.deepEqual(parseSelection(undefined), {});
  assert.throws(() => parseSelection('env'), /not in the form dimension=value/);
});

check('without a profile the plain baseUrl is kept and selection is null', () => {
  const r = resolveProfile({ baseUrl: 'http://localhost:4000', defaultHeaders: HEADERS }, undefined);
  assert.deepEqual(r, { baseUrl: 'http://localhost:4000', defaultHeaders: HEADERS, selection: null });
});

check('a full selection resolves the base URL and headers in order: defaults, profile headers, overrides', () => {
  const r = resolveProfile({ profile: PROFILE, defaultHeaders: HEADERS }, 'env=staging,brand=alpha,region=eu');
  assert.equal(r.baseUrl, 'https://alpha-eu.staging.example.test');
  assert.deepEqual(r.defaultHeaders, {
    Accept: 'application/vnd.shop+json', // profile header wins over the default
    'Content-Type': 'application/json',
    'X-Brand': 'alpha',
    'X-Region': 'eu',
    'Accept-Language': 'en-GB', // from the region=eu override
  });
  assert.deepEqual(r.selection, { env: 'staging', brand: 'alpha', region: 'eu' });
});

check('an override with a baseUrl replaces the base URL and later override headers win', () => {
  const r = resolveProfile({ profile: PROFILE, defaultHeaders: HEADERS }, 'env=dev,brand=beta,region=us');
  assert.equal(r.baseUrl, 'https://beta-us.dev-internal.example.test');
  assert.equal(r.defaultHeaders['X-Region'], 'dev-us');
  assert.equal('Accept-Language' in r.defaultHeaders, false);
});

check('a dimension with one value is chosen on its own', () => {
  const profile = { ...PROFILE, dimensions: { ...PROFILE.dimensions, env: ['staging'] } };
  const r = resolveProfile({ profile, defaultHeaders: HEADERS }, 'brand=alpha,region=us');
  assert.equal(r.baseUrl, 'https://alpha-us.staging.example.test');
});

check('a missing dimension lists every dimension and its values', () => {
  assert.throws(
    () => resolveProfile({ profile: PROFILE, defaultHeaders: HEADERS }, 'env=staging'),
    /select one value for "brand", "region" with --select env=<value>,brand=<value>,region=<value>[\s\S]*env: dev, staging[\s\S]*brand: alpha, beta[\s\S]*region: us, eu/,
  );
});

check('a value outside the profile is rejected', () => {
  assert.throws(() => resolveProfile({ profile: PROFILE, defaultHeaders: HEADERS }, 'env=prod,brand=alpha,region=us'), /env=prod is not one of the profile's values/);
});

check('an unknown dimension is rejected', () => {
  assert.throws(() => resolveProfile({ profile: PROFILE, defaultHeaders: HEADERS }, 'env=dev,brand=alpha,region=us,tenant=x'), /unknown dimension "tenant"/);
});

check('a placeholder that is not a dimension is rejected, never left in the URL', () => {
  const profile = { ...PROFILE, baseUrl: 'https://{brand}.{zone}.example.test' };
  assert.throws(() => resolveProfile({ profile, defaultHeaders: HEADERS }, 'env=dev,brand=alpha,region=us'), /profile\.baseUrl uses \{zone\}, which is not a profile dimension/);
});

check('loadConfig applies the selection and the resolved production host is refused by the safety guard', () => {
  const file = inputFile('profile', { profile: PROFILE, defaultHeaders: HEADERS, endpoints: ENDPOINTS });
  const config = loadConfig(file, 'env=staging,brand=alpha,region=eu');
  assert.equal(config.baseUrl, 'https://alpha-eu.staging.example.test');
  // "staging" is a non-production part, so this one runs in full mode.
  assert.equal(assessSafety(config).mode, 'full');
  // ".test" counts as a non-production part, so the production case uses another domain.
  const prod = loadConfig(inputFile('profile-prod', { profile: { ...PROFILE, baseUrl: 'https://{brand}-{region}.example-shop.net' }, defaultHeaders: HEADERS, endpoints: ENDPOINTS }), 'env=dev,brand=alpha,region=us');
  assert.equal(prod.baseUrl, 'https://alpha-us.example-shop.net');
  assert.equal(assessSafety(prod).mode, 'refused');
});

check('loadConfig without a selection fails with the dimension list', () => {
  const file = inputFile('profile-noselect', { profile: PROFILE, defaultHeaders: HEADERS, endpoints: ENDPOINTS });
  assert.throws(() => loadConfig(file, undefined), /select one value for "env", "brand", "region"/);
});

check('loadConfig needs baseUrl or profile', () => {
  const file = inputFile('neither', { defaultHeaders: HEADERS, endpoints: ENDPOINTS });
  assert.throws(() => loadConfig(file, undefined), /"baseUrl" is required when there is no profile/);
});

check('takeSelectFlag puts the value in AGENT_SELECT and returns the other arguments', () => {
  delete process.env.AGENT_SELECT;
  assert.deepEqual(takeSelectFlag(['input/x.json', '--select', 'env=dev,brand=alpha']), ['input/x.json']);
  assert.equal(process.env.AGENT_SELECT, 'env=dev,brand=alpha');
  assert.deepEqual(takeSelectFlag(['--select=env=staging', 'input/y.json']), ['input/y.json']);
  assert.equal(process.env.AGENT_SELECT, 'env=staging');
  assert.throws(() => takeSelectFlag(['--select']), /--select needs a value/);
  delete process.env.AGENT_SELECT;
});

check('the kit input files still load unchanged', () => {
  for (const f of ['input/local-shop.json', 'input/endpoints.json', 'input/demo-small.json', 'input/local-shop-nested.json']) {
    const c = loadConfig(f, undefined);
    assert.ok(c.baseUrl.startsWith('http'), f);
    assert.equal(c.selection, null, f);
  }
  const nested = loadConfig('input/local-shop-nested.json', undefined);
  const getReview = nested.endpoints.find((e) => e.id === 'get-review')!;
  assert.deepEqual(setupSteps(getReview).map((s) => `${s.endpointId}->${s.param}`), ['create-product->id', 'create-review->reviewId']);
  assert.deepEqual(configProblems(nested), []);
});

check('input/example-profile.json loads with a selection and refuses without one', () => {
  const c = loadConfig('input/example-profile.json', 'env=staging,brand=alpha,region=eu');
  assert.equal(c.baseUrl, 'https://alpha-eu.staging.example-shop.test');
  assert.deepEqual(c.selection, { env: 'staging', brand: 'alpha', region: 'eu' });
  assert.throws(() => loadConfig('input/example-profile.json', undefined), /select one value/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
