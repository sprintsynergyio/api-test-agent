import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConfigSchema, configProblems, loadConfig } from './config';
import { buildClientLayer, clientImport, clientLayerFiles, clientUse, dataImport, dataSource, literal, resourceOf, writeClientLayer } from './client-layer';
import { fakeSpec } from './fake-model';
import { nodeBin } from './node-bin';
import { validateSpec, type ValidateOptions } from './validate';

// npm run test:client-layer: the clients layout (input "layout": "clients"). Offline, no model.
//   1. the layer the agent writes from an input: names, grouping, escaping, and that it is the same every time
//   2. the hand-written example in tests/template-clients/ stays in step with the generator
//   3. the static gate: a test must send its request through the client class, and every rule about
//      ctx.api, ctx.noAuthApi and ctx.as('<role>') still applies

let failed = 0;
let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`ok    ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}\n      ${String((err as Error)?.message ?? err).split('\n').join('\n      ')}`);
  }
}

type E = { id: string; method: string; path: string; requiresAuth?: boolean; body?: unknown; query?: unknown; headers?: unknown; setup?: unknown };
const config = (endpoints: E[], extra: Record<string, unknown> = {}) =>
  ConfigSchema.parse({ baseUrl: 'http://localhost:4000', defaultHeaders: {}, endpoints: endpoints.map((e) => ({ requiresAuth: false, ...e })), ...extra });

// The compiler must accept what the generator writes, whatever the input held. The files are checked
// together (a client imports its base) in a folder inside the repo, so @playwright/test resolves.
const CHECK_DIR = '.tscheck-client-layer';
function compileErrors(files: { path: string; content: string }[]): string {
  rmSync(CHECK_DIR, { recursive: true, force: true });
  try {
    for (const f of files) {
      mkdirSync(dirname(join(CHECK_DIR, f.path)), { recursive: true });
      writeFileSync(join(CHECK_DIR, f.path), f.content);
    }
    writeFileSync(join(CHECK_DIR, 'tsconfig.json'), JSON.stringify({ extends: '../tsconfig.json', include: [], files: files.map((f) => f.path) }));
    const res = spawnSync(...nodeBin('tsc', ['-p', join(CHECK_DIR, 'tsconfig.json')]), { encoding: 'utf8' });
    return res.status === 0 ? '' : `${res.stdout}${res.stderr}`.trim() || `tsc exited with ${res.status}`;
  } finally {
    rmSync(CHECK_DIR, { recursive: true, force: true });
  }
}

// ---- 1. the layer ----

await check('resourceOf: the last fixed path segment names the resource', () => {
  assert.equal(resourceOf('/products'), 'products');
  assert.equal(resourceOf('/products/{id}'), 'products');
  assert.equal(resourceOf('/api/v1/products/{id}'), 'products');
  assert.equal(resourceOf('/products/{id}/reviews'), 'reviews');
  assert.equal(resourceOf('/products/{id}/reviews/{reviewId}'), 'reviews');
  assert.equal(resourceOf('/order_items/{id}'), 'order-items');
  assert.equal(resourceOf('/{id}'), 'root');
  assert.equal(resourceOf('/'), 'root');
});

const shop = loadConfig('input/local-shop.json');
const shopLayer = buildClientLayer(shop);

await check('local shop: one class, one method per endpoint, a data function per sample body', () => {
  assert.deepEqual(shopLayer.classes.map((c) => c.className), ['ProductsClient']);
  const cls = shopLayer.classes[0];
  assert.deepEqual(cls.methods.map((m) => m.name), ['listProducts', 'createProduct', 'getProduct', 'updateProduct', 'deleteProduct']);
  assert.deepEqual(cls.methods.map((m) => m.bodyFactory), [null, 'createProductBody', null, 'updateProductBody', null]);
  assert.deepEqual(cls.methods.map((m) => m.takesBody), [false, true, false, true, false]);
  assert.deepEqual(clientLayerFiles(shopLayer).map((f) => f.path), ['clients/base.ts', 'clients/products.ts', 'data/products.ts']);
});

await check('nested resource: reviews get their own class, with both path arguments in order', () => {
  const layer = buildClientLayer(loadConfig('input/local-shop-nested.json'));
  assert.deepEqual(layer.classes.map((c) => c.className).sort(), ['ProductsClient', 'ReviewsClient']);
  const use = clientUse(layer, 'get-review');
  assert.equal(use.className, 'ReviewsClient');
  assert.equal(use.method, 'getReview');
  assert.deepEqual(use.params, ['id', 'reviewId']);
  assert.match(use.signature, /^getReview\(id: string \| number, reviewId: string \| number, options\?: CallOptions\): Promise<APIResponse>$/);
  assert.match(use.sources.client, /`\/products\/\$\{segment\(id\)\}\/reviews\/\$\{segment\(reviewId\)\}`/);
});

await check('the sample query and extra headers of an endpoint are sent by its method, and a test can override or drop one', async () => {
  const layer = buildClientLayer(loadConfig('input/local-shop-nested.json'));
  const src = clientUse(layer, 'list-products-filtered').sources.client;
  assert.match(src, /const defaults = \{\n\s+params: \{\n\s+category: 'tops',\n\s+limit: 5,\n\s+\},\n\s+headers: \{\n\s+'X-Request-Source': 'api-test-agent',/);
  assert.match(src, /return this\.send\('GET', '\/products', defaults, undefined, options\);/);
  const dir = mkdtempSync(join(tmpdir(), 'client-layer-run-'));
  try {
    writeClientLayer(layer, dir);
    const sent: Record<string, unknown>[] = [];
    const api = { fetch: (_path: string, options: Record<string, unknown>) => (sent.push(options), Promise.resolve({})) };
    const mod = (await import(pathToFileURL(join(dir, 'clients', 'products.ts')).href)) as { ProductsClient: new (a: unknown) => { listProductsFiltered: (o?: unknown) => Promise<unknown> } };
    const client = new mod.ProductsClient(api);
    await client.listProductsFiltered();
    await client.listProductsFiltered({ params: { limit: 'many', category: undefined }, headers: { 'X-Extra': '1' } });
    assert.deepEqual(sent[0], { method: 'GET', params: { category: 'tops', limit: 5 }, headers: { 'X-Request-Source': 'api-test-agent' } });
    assert.deepEqual(sent[1], { method: 'GET', params: { limit: 'many' }, headers: { 'X-Request-Source': 'api-test-agent', 'X-Extra': '1' } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await check('the same input always gives the same files', () => {
  assert.deepEqual(clientLayerFiles(buildClientLayer(shop)), clientLayerFiles(buildClientLayer(loadConfig('input/local-shop.json'))));
});

await check('every generated file is valid TypeScript for every input file in input/', () => {
  for (const file of ['input/endpoints.json', 'input/demo-small.json', 'input/local-shop.json', 'input/local-shop-nested.json', 'input/local-shop-login.json', 'input/local-shop-oauth.json']) {
    assert.equal(compileErrors(clientLayerFiles(buildClientLayer(loadConfig(file)))), '', file);
  }
});

await check('two endpoint ids that would become the same method are refused, never merged', () => {
  assert.throws(
    () => buildClientLayer(config([{ id: 'get-product', method: 'GET', path: '/products/{id}' }, { id: 'get_product', method: 'GET', path: '/products/{id}' }])),
    /"get-product" and "get_product" would both become ProductsClient\.getProduct\(\)/,
  );
});

await check('names that would break the class are changed: reserved words, digits, a resource called base', () => {
  const layer = buildClientLayer(
    config([
      { id: 'delete', method: 'DELETE', path: '/base/{class}' },
      { id: 'send', method: 'POST', path: '/base', body: { a: 1 } },
      { id: '2fa-status', method: 'GET', path: '/2fa' },
    ]),
  );
  const base = layer.classes.find((c) => c.resource === 'base')!;
  assert.equal(base.file, 'base-resource');
  assert.equal(base.className, 'BaseResourceClient');
  assert.deepEqual(base.methods.map((m) => m.name), ['deleteRequest', 'sendRequest']);
  assert.deepEqual(base.methods[0].params, [{ placeholder: 'class', arg: 'classParam' }]);
  const twoFa = layer.classes.find((c) => c.resource === '2fa')!;
  assert.equal(twoFa.className, 'Api2faClient');
  assert.equal(twoFa.methods[0].name, 'call2faStatus');
  const paths = clientLayerFiles(layer).map((f) => f.path);
  assert.equal(new Set(paths).size, paths.length, 'no two files share a path');
  assert.equal(compileErrors(clientLayerFiles(layer)), '');
});

await check('text from the input never becomes code: quotes, backticks, ${ and line breaks are escaped', async () => {
  const nasty = "it's `x` ${process.env.SECRET} \\ end\nnext";
  const layer = buildClientLayer(
    config([
      { id: 'create-note', method: 'POST', path: '/no`tes${1+1}/{id}/it\'s', body: { text: nasty, 'odd key': [nasty, { n: null }], nested: { ok: true } }, query: { q: nasty }, headers: { 'X-Note': "a'b" } },
      { id: 'list-notes', method: 'GET', path: "/it's" },
    ]),
  );
  assert.equal(compileErrors(clientLayerFiles(layer)), '');
  const cls = layer.classes.find((c) => c.methods.some((m) => m.endpointId === 'create-note'))!;
  // Run the files the generator wrote: the request must carry the input's text exactly as it was, and
  // the data file must give back exactly the body from the input.
  const dir = mkdtempSync(join(tmpdir(), 'client-layer-run-'));
  try {
    for (const f of clientLayerFiles(layer)) {
      mkdirSync(dirname(join(dir, f.path)), { recursive: true });
      writeFileSync(join(dir, f.path), f.content);
    }
    const data = (await import(pathToFileURL(join(dir, 'data', `${cls.file}.ts`)).href)) as { createNoteBody: () => unknown };
    assert.deepEqual(data.createNoteBody(), { text: nasty, 'odd key': [nasty, { n: null }], nested: { ok: true } });
    assert.notEqual(data.createNoteBody(), data.createNoteBody(), 'a new object on every call');
    const sent: { path: string; options: Record<string, unknown> }[] = [];
    const api = { fetch: (path: string, options: Record<string, unknown>) => (sent.push({ path, options }), Promise.resolve({})) };
    const clients = (await import(pathToFileURL(join(dir, 'clients', `${cls.file}.ts`)).href)) as Record<string, new (a: unknown) => Record<string, (...args: unknown[]) => Promise<unknown>>>;
    const client = new clients[cls.className](api);
    // The path's {1+1} is a placeholder like any other; everything around it is plain text.
    await client.createNote('a/b', 7, { x: 1 });
    await client.listNotes({ params: { page: 2 } });
    assert.deepEqual(sent[0], { path: "/no`tes$a%2Fb/7/it's", options: { method: 'POST', data: { x: 1 }, params: { q: nasty }, headers: { 'X-Note': "a'b" } } });
    assert.deepEqual(sent[1], { path: "/it's", options: { method: 'GET', params: { page: 2 } } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await check('literal: single quotes, plain keys, trailing commas', () => {
  assert.equal(literal({ a: 1, 'b-c': 'x', d: [true, null], e: {} }, ''), "{\n  a: 1,\n  'b-c': 'x',\n  d: [\n    true,\n    null,\n  ],\n  e: {},\n}");
});

await check('sample bodies in the data file are the redacted ones the model is shown, never client data', () => {
  const layer = buildClientLayer(config([{ id: 'create-user', method: 'POST', path: '/users', body: { email: 'jane.doe@client-company.com', phone: '+44 20 7946 0958', name: 'Jane' } }]));
  const data = dataSource(layer.classes[0])!;
  assert.ok(!data.includes('client-company.com') && !data.includes('7946'), data);
  assert.match(data, /email: 'redacted@example\.com'/);
});

await check('writeClientLayer replaces the two folders and writes nothing else', () => {
  const root = mkdtempSync(join(tmpdir(), 'client-layer-'));
  try {
    writeClientLayer(buildClientLayer(loadConfig('input/local-shop-nested.json')), root);
    assert.ok(existsSync(join(root, 'clients', 'reviews.ts')));
    const written = writeClientLayer(shopLayer, root);
    assert.deepEqual(written, ['clients/base.ts', 'clients/products.ts', 'data/products.ts']);
    assert.ok(!existsSync(join(root, 'clients', 'reviews.ts')), 'a class that left the input does not stay behind');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await check('config: layout accepts flat and clients, and clients is Playwright only for now', () => {
  assert.equal(config([{ id: 'a', method: 'GET', path: '/a' }], { layout: 'clients' }).layout, 'clients');
  assert.equal(ConfigSchema.safeParse({ baseUrl: 'http://localhost:4000', defaultHeaders: {}, layout: 'pages', endpoints: [{ id: 'a', method: 'GET', path: '/a', requiresAuth: false }] }).success, false);
  const problems = configProblems(config([{ id: 'a', method: 'GET', path: '/a' }], { layout: 'clients', framework: 'pactum' }));
  assert.ok(problems.some((p) => /clients layout is available for Playwright only/.test(p)), problems.join('\n'));
  assert.deepEqual(configProblems(config([{ id: 'a', method: 'GET', path: '/a' }], { layout: 'clients' })).filter((p) => /layout/.test(p)), []);
});

// ---- 2. the example the generator prompt shows ----

await check('tests/template-clients: its client and data files are exactly what the generator writes for input/endpoints.json', () => {
  for (const f of clientLayerFiles(buildClientLayer(loadConfig('input/endpoints.json')))) {
    if (f.path !== 'clients/base.ts' && !f.path.endsWith('/booking.ts')) continue;
    assert.equal(readFileSync(join('tests', 'template-clients', f.path), 'utf8'), f.content, `tests/template-clients/${f.path} is out of step: regenerate it with writeClientLayer`);
  }
  const template = readFileSync(join('tests', 'template-clients', 'update-booking.spec.ts'), 'utf8');
  assert.match(template, /new BookingClient\(ctx\.api\)\.updateBooking\(id, sent\)/);
  assert.match(template, /new BookingClient\(ctx\.noAuthApi\)\.updateBooking\(id, updateBookingBody\(\)\)/);
  assert.ok(!/ctx\.(?:api|noAuthApi)\.(?:get|post|put|patch|delete|fetch)\(/.test(template), 'the example never calls the request context itself');
});

// ---- 3. the static gate ----

// The gate typechecks a candidate against the real files, so the layer is written where a run puts it.
// A layer left there by an earlier run (its specs still import it) is put back afterwards.
const hadGenerated = existsSync('generated');
const keep = mkdtempSync(join(tmpdir(), 'client-layer-keep-'));
for (const d of ['clients', 'data']) if (existsSync(join('generated', d))) cpSync(join('generated', d), join(keep, d), { recursive: true });
const loginConfig = loadConfig('input/local-shop-login.json');
const loginLayer = buildClientLayer(loginConfig);
writeClientLayer(loginLayer, 'generated');

const use = clientUse(loginLayer, 'update-product');
const layerOpt = { className: use.className, clientModule: use.clientModule, method: use.method, knownClasses: use.knownClasses, allowedModules: use.allowedModules };
const TYPES = ['happy', 'schema', 'invalid-input', 'auth', 'authz'];
const opts = (planTypes: string[] = TYPES): ValidateOptions => ({ name: 'client-layer-test', planTypes, probeStatus: 200, clientLayer: layerOpt });

const IMPORTS = `import { test, expect } from '../tests/fixtures/ctx';\nimport { ProductsClient } from '${clientImport('products')}';\nimport { updateProductBody } from '${dataImport('products')}';`;
const RECORD = `function recordStatus(status: number) {\n  test.info().annotations.push({ type: 'actual-status', description: String(status) });\n}`;
const spec = (tests: string[], imports = IMPORTS) => `${imports}\n\n${RECORD}\n\ntest.describe('update-product PUT /products/{id}', () => {\n${tests.join('\n\n')}\n});\n`;

const HAPPY = `  test('[happy] update-product returns the sent values', async ({ ctx }) => {
    const id = await ctx.createResource('create-product');
    const sent = updateProductBody();
    const response = await new ProductsClient(ctx.api).updateProduct(id, sent);
    recordStatus(response.status());
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.name).toBe(sent.name);
  });`;
const SCHEMA = `  test('[schema] update-product returns typed fields', async ({ ctx }) => {
    const id = await ctx.createResource('create-product');
    const products = new ProductsClient(ctx.api);
    const response = await products.updateProduct(id, updateProductBody());
    recordStatus(response.status());
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(typeof body.name).toBe('string');
  });`;
const INVALID = `  test('[invalid-input] update-product rejects a text price', async ({ ctx }) => {
    const id = await ctx.createResource('create-product');
    const response = await new ProductsClient(ctx.api).updateProduct(id, { ...updateProductBody(), price: 'ten' });
    recordStatus(response.status());
    expect(response.status()).toBeGreaterThanOrEqual(400);
    expect(response.status()).toBeLessThanOrEqual(499);
  });`;
const AUTH = `  test('[auth] update-product rejects a request without auth', async ({ ctx }) => {
    const id = await ctx.createResource('create-product');
    const response = await new ProductsClient(ctx.noAuthApi).updateProduct(id, updateProductBody());
    recordStatus(response.status());
    expect([401, 403]).toContain(response.status());
  });`;
const AUTHZ = `  test('[authz] update-product rejects the viewer role', async ({ ctx }) => {
    const id = await ctx.createResource('create-product');
    const response = await new ProductsClient(ctx.as('viewer')).updateProduct(id, updateProductBody());
    recordStatus(response.status());
    expect([403, 404]).toContain(response.status());
  });`;
const ALL = [HAPPY, SCHEMA, INVALID, AUTH, AUTHZ];

function accepts(name: string, code: string, o: ValidateOptions = opts()) {
  return check(`gate accepts ${name}`, () => {
    const result = validateSpec(code, o);
    assert.deepEqual(result.reasons, []);
    assert.equal(result.ok, true);
  });
}
function rejects(name: string, code: string, reasonPart: string | RegExp, o: ValidateOptions = opts()) {
  return check(`gate rejects ${name}`, () => {
    const result = validateSpec(code, o);
    assert.equal(result.ok, false, 'expected the gate to reject');
    assert.ok(result.reasons.some((r) => (typeof reasonPart === 'string' ? r.includes(reasonPart) : reasonPart.test(r))), `expected a reason matching ${reasonPart}, got:\n${result.reasons.join('\n')}`);
  });
}
const swap = (test: string, from: string, to: string) => {
  assert.ok(test.includes(from), `test text has no "${from}"`);
  return test.replace(from, to);
};
const withTest = (index: number, replacement: string) => spec(ALL.map((t, i) => (i === index ? replacement : t)));

await accepts('a spec that sends every request through the client class (inline and through a variable)', spec(ALL));

await rejects('a test that calls ctx.api itself', withTest(0, swap(HAPPY, 'new ProductsClient(ctx.api).updateProduct(id, sent)', 'ctx.api.put(`/products/${id}`, { data: sent })')), 'calls the request context directly');
await rejects(
  'a test that sends through the client and then again directly',
  withTest(0, swap(HAPPY, '    recordStatus(response.status());', '    await ctx.api.fetch(`/products/${id}`, { method: "DELETE" });\n    recordStatus(response.status());')),
  'calls the request context directly',
);
await rejects('a test that destructures api and calls it', withTest(0, swap(HAPPY, 'async ({ ctx }) => {', 'async ({ ctx }) => {\n    const { api } = ctx;\n    await api.get("/products");')), 'calls the request context directly');
await rejects('a test that never calls the endpoint method', withTest(1, swap(SCHEMA, 'products.updateProduct(id, updateProductBody())', 'products.getProduct(id)')), 'does not send its request with new ProductsClient');
await rejects('a client class that is not one of the run', withTest(0, swap(HAPPY, 'new ProductsClient(ctx.api)', 'new OrdersClient(ctx.api)')), 'not one of this run');
await rejects('a spec that writes its own client class', spec(ALL).replace(RECORD, `${RECORD}\n\nclass ProductsClient {\n  constructor(private api: unknown) {}\n}`), 'declares a class');
await rejects('a spec without the client import', spec(ALL, IMPORTS.split('\n').filter((l) => !l.includes('ProductsClient')).join('\n')), "does not import ProductsClient from '../generated/clients/products'");
await rejects('an import from a module that is not the ctx file or the layer', spec(ALL, `${IMPORTS}\nimport { readFileSync } from 'node:fs';`), /imports "node:fs"/);
await rejects('an import from another folder dressed up as a client', spec(ALL, `${IMPORTS}\nimport { x } from '../generated/clients/../../agent/claude';`), /imports "\.\.\/generated\/clients\/\.\.\/\.\.\/agent\/claude"/);

// The rules about who sends the request read the constructor argument, exactly as in the flat layout.
await rejects('an [auth] test that gives the client ctx.api', withTest(3, swap(AUTH, 'new ProductsClient(ctx.noAuthApi)', 'new ProductsClient(ctx.api)')), 'ctx.api');
await rejects('an [authz] test that gives the client ctx.api', withTest(4, swap(AUTHZ, "new ProductsClient(ctx.as('viewer'))", 'new ProductsClient(ctx.api)')), /ctx\.as|ctx\.api/);
await rejects('an [authz] test that expects a 2xx', withTest(4, swap(AUTHZ, 'expect([403, 404]).toContain(response.status());', 'expect(response.status()).toBe(200);')), /403|404|authz/);
await rejects('an [invalid-input] test that expects a 500', withTest(2, swap(INVALID, 'expect(response.status()).toBeLessThanOrEqual(499);', 'expect(response.status()).toBe(500);')), /500/);
await rejects('a wrong argument for the method (typecheck against the real client file)', withTest(0, swap(HAPPY, '.updateProduct(id, sent)', '.updateProduct({ id }, sent)')), /TS\d+|not assignable/);
await rejects('fewer tests than the plan', spec([HAPPY, SCHEMA, INVALID, AUTH]), /authz|fewer/);

// Without the layer option the gate is the flat one: the client import is not allowed there.
await rejects('a client-style spec in the flat layout', spec(ALL), /imports "\.\.\/generated\/clients\/products"/, { name: 'client-layer-test', planTypes: TYPES, probeStatus: 200 });

// ---- the fake model writes what the gate asks for (the offline pipeline tests rest on it) ----

await check('fake model: with a CLIENT LAYER block in the prompt it writes a client-style spec', () => {
  const prompt = [
    'ENDPOINT CONFIG:',
    JSON.stringify({ id: 'update-product', method: 'PUT', path: '/products/{id}', requiresAuth: true, body: { name: 'x', price: 1 } }, null, 2),
    '',
    'PROBE (redacted):',
    JSON.stringify({ status: 200, body: { id: 1, name: 'x' } }, null, 2),
    '',
    'PLAN:',
    JSON.stringify({ cases: [{ id: 'h', type: 'happy', title: '[happy] update-product works' }, { id: 'a', type: 'auth', title: '[auth] update-product needs auth' }, { id: 'authz-viewer', type: 'authz', title: '[authz] update-product rejects viewer' }] }, null, 2),
    '',
    'CLIENT LAYER:',
    JSON.stringify({ className: 'ProductsClient', clientModule: clientImport('products'), method: 'updateProduct', pathArguments: ['id'], takesBody: true, bodyFunction: 'updateProductBody', dataModule: dataImport('products') }, null, 2),
    '',
    "- This endpoint has setup. Each test that needs an existing resource gets one with `const id = await ctx.createResource('create-product');` (returns the id as a string) and passes it as the method's path argument.",
    '',
  ].join('\n');
  const code = fakeSpec(prompt, false);
  assert.match(code, /new ProductsClient\(ctx\.api\)\.updateProduct\(id, updateProductBody\(\)\)/);
  assert.match(code, /new ProductsClient\(ctx\.noAuthApi\)\.updateProduct\(id, updateProductBody\(\)\)/);
  assert.match(code, /new ProductsClient\(ctx\.as\('viewer'\)\)\.updateProduct\(id, updateProductBody\(\)\)/);
  const result = validateSpec(code, opts(['happy', 'auth', 'authz']));
  assert.deepEqual(result.reasons, []);
});

if (!hadGenerated) rmSync('generated', { recursive: true, force: true });
else {
  for (const d of ['clients', 'data']) {
    rmSync(join('generated', d), { recursive: true, force: true });
    if (existsSync(join(keep, d))) cpSync(join(keep, d), join('generated', d), { recursive: true });
  }
}
rmSync(keep, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
