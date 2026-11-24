import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { normalizeAuth } from './auth';
import { ConfigSchema, configProblems, type Config } from './config';
import { cleanupResources, createClients, createResource, disposeClients, runSetup } from './http';
import { buildInput, type RawRequest } from './importers/core';
import { getAt, requestBody, uniqueValue } from './model';
import { probeAll } from './probe';

// npm run test:setup-chains: setup for the shapes real APIs have (seen in a 25 endpoint import on
// 24 Nov 2026), offline:
// - a user made by a register endpoint, its id under "user.id" (dot path idField), the email new each time
// - a path id that is the id of another resource (/cart/items/{productId}): the add-to-cart call takes
//   the product id in its body (bodyFrom) and the setup reads it back
// - a resource created under another one and read or deleted at the top level (/reviews/{reviewId})
// The model helpers, the input checks, the importer's inference, and the whole chain against the real
// local shop API (started here on a free port): probe, setup, cleanup.

let failed = 0;
let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`ok    ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}\n      ${String((err as Error)?.stack ?? err).split('\n').slice(0, 6).join('\n      ')}`);
  }
}

const AUTH = { LOCAL_API_AUTH_VALUE: 'Bearer local-shop-demo-token' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const INPUT = JSON.parse(readFileSync('input/local-shop-setup.json', 'utf8')) as Config;
type Ep = Config['endpoints'][number];
const ep = (id: string, c: Config = INPUT): Ep => c.endpoints.find((e) => e.id === id)!;

function problemsOf(input: unknown): string[] {
  const parsed = ConfigSchema.safeParse(input);
  assert.ok(parsed.success, `schema: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`);
  return configProblems(parsed.data);
}
function withEndpoint(change: (endpoints: Ep[]) => void): Config {
  const copy = JSON.parse(JSON.stringify(INPUT)) as Config;
  change(copy.endpoints);
  return copy;
}

// ---------- Model helpers ----------

await check('uniqueValue: an email keeps its domain, digits keep their length, numbers their digit count, text gets a suffix', () => {
  assert.equal(uniqueValue('qa.user@example.com', 'k3x9a'), 'qa.user+k3x9a@example.com');
  const isbn = uniqueValue('9780441013593', 'k3x9a') as string;
  assert.match(isbn, /^9780441\d{6}$/);
  assert.notEqual(isbn, '9780441013593');
  assert.equal(String(uniqueValue(4711, 'k3x9a')).length, 4);
  assert.equal(typeof uniqueValue(4711, 'k3x9a'), 'number');
  assert.equal(uniqueValue('shoe-1', 'k3x9a'), 'shoe-1-k3x9a');
  assert.equal(uniqueValue(true, 'k3x9a'), true);
  assert.notEqual(uniqueValue('a@b.co', 'aaaaa'), uniqueValue('a@b.co', 'bbbbb'));
});

await check('requestBody: bodyFrom fills from setup values (a number stays a number), unique makes fields new, the sample is not changed', () => {
  const add = ep('add-cart-item');
  assert.deepEqual(requestBody(add, { productId: '42' }, 't0k3n'), { productId: 42, quantity: 2 });
  assert.deepEqual(add.body, { productId: 1, quantity: 2 });
  assert.throws(() => requestBody(add, {}, 't0k3n'), /body field "productId" of add-cart-item takes \{productId\} from setup, but no value was given/);
  const reg = requestBody(ep('register'), {}, 'abc12')!;
  assert.equal(reg.email, 'qa.user+abc12@example.com');
  assert.equal(reg.name, 'QA User');
  const nested = requestBody({ id: 'x', body: { user: { email: 'a@b.co', role: 'r' } }, unique: ['user.email'] }, {}, 'zz9')!;
  assert.deepEqual(nested, { user: { email: 'a+zz9@b.co', role: 'r' } });
  assert.equal(requestBody({ id: 'y' }, {}, 't'), undefined);
  assert.equal(getAt({ user: { id: 7 } }, 'user.id'), 7);
  assert.equal(getAt({ user: null }, 'user.id'), undefined);
});

// ---------- Input checks ----------

await check('input/local-shop-setup.json and its Pactum twin are valid', () => {
  assert.deepEqual(problemsOf(INPUT), []);
  assert.deepEqual(problemsOf(JSON.parse(readFileSync('input/local-shop-setup-pactum.json', 'utf8'))), []);
});

await check('input checks: bodyFrom and unique name real body fields, setup values have a use, a body-only setup names its param', () => {
  const p = (change: (e: Ep[]) => void) => problemsOf(withEndpoint(change)).join('\n');
  assert.match(p((e) => (ep('add-cart-item', { endpoints: e } as Config).bodyFrom = { itemId: 'productId' })), /bodyFrom" names body field "itemId", which is not in the sample body/);
  assert.match(p((e) => (ep('add-cart-item', { endpoints: e } as Config).bodyFrom = { productId: 'other' })), /bodyFrom.productId" takes \{other\}, but no setup step of this endpoint has param "other"/);
  assert.match(p((e) => delete ep('add-cart-item', { endpoints: e } as Config).setup), /bodyFrom" takes values from setup, but the endpoint has no setup/);
  assert.match(p((e) => ((ep('add-cart-item', { endpoints: e } as Config).setup as { param?: string }).param = undefined)), /setup.param" is required: \/cart\/items has no placeholder/);
  assert.match(p((e) => delete ep('add-cart-item', { endpoints: e } as Config).bodyFrom), /has setup but no \{id\} placeholder \(and no bodyFrom that uses a setup value\)/);
  assert.match(p((e) => (ep('register', { endpoints: e } as Config).unique = ['password2'])), /unique" names body field "password2", which is not in the sample body/);
  assert.match(p((e) => (ep('create-product', { endpoints: e } as Config).unique = ['inStock'])), /unique" names body field "inStock", which is not a string or number/);
  assert.match(p((e) => (ep('get-user', { endpoints: e } as Config).unique = ['email'])), /unique" needs a sample "body" to fill/);
  assert.match(p((e) => (ep('get-user', { endpoints: e } as Config).setup = [{ endpointId: 'register', idField: 'user.id', param: 'accountId' }])), /param" names \{accountId\}, which is not a placeholder of \/users\/\{userId\} \(\{userId\}\) nor a value bodyFrom uses/);
});

// ---------- Importer inference ----------

// The same API as the importers see it (a spec, a collection or a page): no setup, no ids.
const BASE = 'http://localhost:4000';
const raw = (method: string, path: string, opts: { body?: unknown; auth?: boolean } = {}): RawRequest => ({
  item: `${method} ${path}`,
  method,
  url: `${BASE}${path}`,
  ...(opts.body ? { body: { json: opts.body } } : {}),
  requiresAuth: opts.auth ?? true,
});
const SHOP: RawRequest[] = [
  raw('POST', '/auth/login', { body: { email: 'qa.user@example.com', password: 'x' }, auth: false }),
  raw('POST', '/products', { body: { name: 'Trail Runner Shoe', price: 89.99, category: 'shoes', inStock: true, sku: 'TR-100' } }),
  raw('DELETE', '/products/{id}'),
  raw('POST', '/auth/register', { body: { email: 'qa.user@example.com', password: 'demo-pass-123', name: 'QA User' }, auth: false }),
  raw('GET', '/users/{userId}'),
  raw('DELETE', '/users/{userId}'),
  raw('POST', '/cart/items', { body: { productId: 1, quantity: 2 } }),
  raw('PATCH', '/cart/items/{productId}', { body: { quantity: 3 } }),
  raw('DELETE', '/cart/items/{productId}'),
  raw('POST', '/products/{id}/reviews', { body: { rating: 5, text: 'Light and comfortable' } }),
  raw('GET', '/reviews/{reviewId}', { auth: false }),
  raw('DELETE', '/reviews/{reviewId}'),
];

const imported = buildInput(SHOP, { name: 'shop' });
const byPath = (method: string, path: string) => imported.input.endpoints.find((e) => e.method === method && e.path === path)!;

await check('importer: a user path gets setup from the register endpoint, deleted afterwards with the DELETE on that path', () => {
  const reg = byPath('POST', '/auth/register').id;
  const del = byPath('DELETE', '/users/{userId}').id;
  assert.deepEqual(byPath('GET', '/users/{userId}').setup, { endpointId: reg, idField: 'id', cleanup: { endpointId: del } });
  assert.deepEqual(byPath('DELETE', '/users/{userId}').setup, { endpointId: reg, idField: 'id', cleanup: { endpointId: del } });
  assert.ok(imported.warnings.some((w) => w.includes('there is no POST /users') && w.includes(`comes from a new account made with ${reg}`) && /"user\.id"/.test(w)), imported.warnings.join('\n'));
});

await check('importer: /cart/items/{productId} is a product id: add-to-cart creates the product first, takes its id in the body and is read back', () => {
  const add = byPath('POST', '/cart/items');
  const product = byPath('POST', '/products').id;
  assert.deepEqual(add.setup, { endpointId: product, idField: 'id', param: 'productId' });
  assert.deepEqual(add.bodyFrom, { productId: 'productId' });
  for (const m of ['PATCH', 'DELETE']) assert.deepEqual(byPath(m, '/cart/items/{productId}').setup, { endpointId: add.id, idField: 'productId' });
  assert.ok(imported.warnings.some((w) => w.includes('is the id of a product, not of the items itself')), imported.warnings.join('\n'));
});

await check('importer: /reviews/{reviewId} comes from the nested create (which makes its product first) and is deleted with the top-level DELETE', () => {
  const create = byPath('POST', '/products/{id}/reviews');
  const del = byPath('DELETE', '/reviews/{reviewId}').id;
  assert.deepEqual(create.setup, { endpointId: byPath('POST', '/products').id, idField: 'id' });
  for (const m of ['GET', 'DELETE']) assert.deepEqual(byPath(m, '/reviews/{reviewId}').setup, { endpointId: create.id, idField: 'id', cleanup: { endpointId: del } });
});

await check('importer: identifying fields of creates are unique (email, sku), never on login; the old shapes are unchanged', () => {
  assert.deepEqual(byPath('POST', '/auth/register').unique, ['email']);
  assert.deepEqual(byPath('POST', '/products').unique, ['sku']);
  assert.equal(byPath('POST', '/auth/login').unique, undefined);
  assert.equal(byPath('POST', '/cart/items').unique, undefined);
  assert.deepEqual(byPath('DELETE', '/products/{id}').setup, { endpointId: byPath('POST', '/products').id, idField: 'id' });
  assert.ok(!imported.warnings.some((w) => /needs setup for/.test(w)), `no endpoint left without setup:\n${imported.warnings.join('\n')}`);
  assert.deepEqual(configProblems(imported.input), []);
});

// ---------- Against the real local shop API ----------

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

const port = await freePort();
let out = '';
const child: ChildProcess = spawn(process.execPath, ['local-api/server.mjs'], { env: { ...process.env, PORT: String(port), LOG_REQUESTS: '1', FIXED: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
child.stdout!.on('data', (d) => (out += String(d)));
for (let i = 0; i < 50 && !out.includes('running on'); i++) await sleep(100);
const live = (c: Config = INPUT): Config => ({ ...c, baseUrl: `http://localhost:${port}`, selection: null, auth: normalizeAuth(c.auth) });
const authed = { headers: { Authorization: AUTH.LOCAL_API_AUTH_VALUE } };
const getJson = async (path: string) => (await fetch(`http://localhost:${port}${path}`, authed)).json() as Promise<unknown>;
const state = async () => ({ products: ((await getJson('/products')) as unknown[]).length, cart: ((await getJson('/cart')) as { count: number }).count });

try {
  await check('live: the chains run and cleanup deletes everything they made, newest first', async () => {
    const config = live();
    const clients = await createClients(config, AUTH);
    try {
      const user = await runSetup(config, clients, ep('get-user'));
      assert.match(user.userId, /^\d+$/);
      assert.equal(((await getJson(`/users/${user.userId}`)) as { email: string }).email.includes('+'), true, 'the registered email was made unique');
      const cartItem = await runSetup(config, clients, ep('update-cart-item'));
      assert.deepEqual(((await getJson('/cart')) as { items: { productId: number }[] }).items.map((i) => String(i.productId)), [cartItem.productId], 'the cart holds the product setup made');
      const review = await runSetup(config, clients, ep('get-review'));
      assert.equal(((await getJson(`/reviews/${review.reviewId}`)) as { id: number }).id, Number(review.reviewId));
      assert.deepEqual(await state(), { products: 5, cart: 1 });
      const totals = await cleanupResources(config, clients);
      assert.deepEqual({ ...totals, failures: totals.failures.length }, { created: 5, createdByTests: 0, deleted: 5, failed: 0, skippedNoDeleteEndpoint: 0, failures: 0 });
      assert.deepEqual(await state(), { products: 3, cart: 0 });
      assert.equal((await fetch(`http://localhost:${port}/users/${user.userId}`, authed)).status, 404, 'the user was deleted');
      // Newest first: the review before its product, the cart item before its product, the user last.
      const deletes = out.split('\n').filter((l) => /^DELETE /.test(l)).slice(-5).map((l) => l.replace(/\d+/g, 'N'));
      assert.deepEqual(deletes, ['DELETE /reviews/N', 'DELETE /products/N', 'DELETE /cart/items/N', 'DELETE /products/N', 'DELETE /users/N']);
    } finally {
      await disposeClients(clients);
    }
  });

  await check('live: registering twice through setup works (unique email), a fixed email is refused as a duplicate', async () => {
    const config = live();
    const clients = await createClients(config, AUTH);
    try {
      const a = await createResource(config, clients, 'register', 'user.id');
      const b = await createResource(config, clients, 'register', 'user.id');
      assert.notEqual(a, b);
      const fixed = live(withEndpoint((e) => delete ep('register', { endpoints: e } as Config).unique));
      await createResource(fixed, clients, 'register', 'user.id');
      await assert.rejects(createResource(fixed, clients, 'register', 'user.id'), /createResource\(register\) failed: status 409/);
      await cleanupResources(config, clients);
    } finally {
      await disposeClients(clients);
    }
  });

  await check('live: every endpoint of input/local-shop-setup.json probes usable, and the probe leaves the API as it found it', async () => {
    const run = await probeAll(live(), AUTH);
    const bad = [...run.results.values()].filter((r) => !r.usable).map((r) => `${r.endpointId}: ${r.status} ${r.error ?? ''}`);
    assert.deepEqual(bad, []);
    assert.equal(run.results.get('add-cart-item')!.status, 201);
    // The probe shows the body it sent (redacted like every probe): the product id setup made, not the sample's 1.
    assert.notEqual((run.results.get('add-cart-item')!.requestBody as { productId: number }).productId, 1);
    assert.equal(run.results.get('register')!.status, 201);
    assert.deepEqual({ failed: run.cleanup.failed, none: run.cleanup.skippedNoDeleteEndpoint, all: run.cleanup.created === run.cleanup.deleted }, { failed: 0, none: 0, all: true });
    assert.deepEqual(await state(), { products: 3, cart: 0 });
  });

  await check('live: the imported input, with only the idField fix its warning asks for, probes every endpoint usable', async () => {
    const fixed = JSON.parse(JSON.stringify(imported.input)) as Config;
    for (const e of fixed.endpoints) {
      const s = e.setup && !Array.isArray(e.setup) ? e.setup : null;
      if (s && s.endpointId === byPath('POST', '/auth/register').id) s.idField = 'user.id';
    }
    fixed.auth = { header: 'Authorization', valueEnv: 'LOCAL_API_AUTH_VALUE' } as Config['auth'];
    assert.deepEqual(configProblems(fixed), []);
    // Login with a made-up password is refused (401); every other endpoint must work.
    const run = await probeAll(live(fixed), AUTH);
    const bad = [...run.results.values()].filter((r) => !r.usable && r.path !== '/auth/login').map((r) => `${r.endpointId}: ${r.status} ${r.error ?? ''}`);
    assert.deepEqual(bad, []);
    assert.equal(run.cleanup.failed, 0);
    assert.deepEqual(await state(), { products: 3, cart: 0 });
  });
} finally {
  child.kill();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
