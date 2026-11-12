import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import type { Config } from './config';
import { createClients, createResource, disposeClients } from './http';
import { assessSafety, classifyHost, endpointAllowed, ProductionRefused, ReadOnlyBlocked, refusalMessage, type HostClass } from './safety';

// npm run test:safety: the host rules, the safety modes, and the guard inside the shared HTTP layer.
// Plain node:assert, offline: the HTTP checks use a throwaway server on 127.0.0.1.

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

const HOSTS: [string, HostClass][] = [
  // local
  ['http://localhost:4000', 'local'],
  ['http://LOCALHOST', 'local'],
  ['http://127.0.0.1:8080/api', 'local'],
  ['http://[::1]:3000', 'local'],
  ['http://printer.local', 'local'],
  ['http://host.docker.internal:4000', 'local'],
  ['http://10.0.0.5', 'local'],
  ['http://10.255.255.255', 'local'],
  ['http://172.16.0.1', 'local'],
  ['http://172.31.255.254', 'local'],
  ['http://192.168.1.10', 'local'],
  // not private: production
  ['http://172.15.0.1', 'production'],
  ['http://172.32.0.1', 'production'],
  ['http://192.169.1.10', 'production'],
  ['http://11.0.0.1', 'production'],
  ['http://8.8.8.8', 'production'],
  ['http://127.0.0.2', 'production'],
  ['http://999.168.1.10', 'production'],
  // non-production: a whole part split on "." and "-"
  ['https://api-staging.example.com', 'non-production'],
  ['https://qa.shop.io', 'non-production'],
  ['https://dev.example.com', 'non-production'],
  ['https://api.test.example.com', 'non-production'],
  ['https://stage-api.example.com', 'non-production'],
  ['https://sandbox.payments.example.com', 'non-production'],
  ['https://uat.example.com', 'non-production'],
  ['https://preprod.example.com', 'non-production'],
  ['https://API-STAGING.EXAMPLE.COM', 'non-production'],
  // production: everything else, parts inside words do not count
  ['https://latest.example.com', 'production'],
  ['https://contest.io', 'production'],
  ['https://api.example.com', 'production'],
  ['https://restful-booker.herokuapp.com', 'production'],
  ['https://developer.example.com', 'production'],
  ['https://staging1.example.com', 'production'],
  ['https://qaserver.example.com', 'production'],
  ['https://my.localhost.example.com', 'production'],
  ['https://example.local.com', 'production'],
  ['not a url', 'production'],
  ['', 'production'],
];

const AUTH_VALUE = 'Bearer safety-test-token';
// createClients takes the auth environment: only the variables the auth section names.
const AUTH = { SAFETY_TEST_AUTH: AUTH_VALUE };

function config(baseUrl: string, flags: { allowProduction?: boolean; allowWrites?: boolean } = {}): Config {
  return {
    baseUrl,
    selection: null,
    defaultHeaders: { Accept: 'application/json', 'Content-Type': 'application/json' },
    auth: { type: 'header', header: 'Authorization', valueEnv: 'SAFETY_TEST_AUTH' },
    ...flags,
    endpoints: [
      { id: 'list-items', method: 'GET', path: '/items', requiresAuth: false },
      { id: 'create-item', method: 'POST', path: '/items', requiresAuth: true, body: { name: 'x' } },
      { id: 'get-item', method: 'GET', path: '/items/{id}', requiresAuth: false, setup: { endpointId: 'create-item', idField: 'id' } },
      { id: 'delete-item', method: 'DELETE', path: '/items/{id}', requiresAuth: true, setup: { endpointId: 'create-item', idField: 'id' } },
    ],
  };
}

async function main() {
  const ui = (await import(pathToFileURL('ui/host-class.mjs').href)) as {
    classifyHost(url: string): HostClass;
    refusalMessage(url: string): string;
    localRefusalMessage(url: string): string;
    safetyMode(url: string, cfg: { allowProduction?: boolean; allowWrites?: boolean }, opts?: { forceProduction?: boolean; hosted?: boolean }): { hostClass: HostClass; mode: string };
  };

  console.log('classifyHost');
  for (const [url, want] of HOSTS) {
    await check(`${JSON.stringify(url)} is ${want}`, () => {
      assert.equal(classifyHost(url), want, 'agent/safety.ts');
      assert.equal(ui.classifyHost(url), want, 'ui/host-class.mjs');
    });
  }

  console.log('Safety modes');
  await check('local and non-production hosts: full, whatever the flags', () => {
    for (const url of ['http://localhost:4000', 'https://api-staging.example.com']) {
      for (const flags of [{}, { allowProduction: true }, { allowProduction: true, allowWrites: true }, { allowWrites: true }]) {
        assert.equal(assessSafety({ baseUrl: url, ...flags }).mode, 'full', `${url} ${JSON.stringify(flags)}`);
      }
    }
  });
  await check('production host: refused, read-only, full', () => {
    const url = 'https://api.example.com';
    assert.deepEqual(assessSafety({ baseUrl: url }), { host: 'api.example.com', hostClass: 'production', mode: 'refused', allowProduction: false, allowWrites: false });
    assert.equal(assessSafety({ baseUrl: url, allowWrites: true }).mode, 'refused', 'allowWrites alone does not allow production');
    assert.equal(assessSafety({ baseUrl: url, allowProduction: true }).mode, 'read-only');
    assert.equal(assessSafety({ baseUrl: url, allowProduction: true, allowWrites: true }).mode, 'full');
  });
  await check('the refusal message names the host', () => {
    const want = 'REFUSED: api.example.com looks like a production host. Set allowProduction to run read-only tests.';
    assert.equal(refusalMessage(assessSafety({ baseUrl: 'https://api.example.com/v1' })), want);
    assert.equal(ui.refusalMessage('https://api.example.com/v1'), want);
  });
  await check('AGENT_FORCE_PRODUCTION only makes the guard stricter', () => {
    assert.equal(assessSafety({ baseUrl: 'http://localhost:4000' }, { forceProduction: true }).hostClass, 'production');
    assert.equal(assessSafety({ baseUrl: 'http://localhost:4000' }, { forceProduction: true }).mode, 'refused');
    assert.equal(assessSafety({ baseUrl: 'https://qa.shop.io' }, { forceProduction: true }).mode, 'refused');
    // false (or missing) never relaxes a production host
    assert.equal(assessSafety({ baseUrl: 'https://api.example.com' }, { forceProduction: false }).mode, 'refused');
    assert.equal(assessSafety({ baseUrl: 'https://api.example.com' }, {}).hostClass, 'production');
  });
  console.log('Hosted mode');
  await check('hosted: local and private hosts are refused, in the agent and the UI', () => {
    for (const url of ['http://localhost:4000', 'http://127.0.0.1:4000', 'http://10.8.0.1', 'http://192.168.1.10:8080', 'http://[::1]:3000', 'http://api.local']) {
      for (const flags of [{}, { allowProduction: true, allowWrites: true }]) {
        const s = assessSafety({ baseUrl: url, ...flags }, { hosted: true });
        assert.equal(s.hostClass, 'local', url);
        assert.equal(s.mode, 'refused', `${url} ${JSON.stringify(flags)}`);
        assert.equal(s.hosted, true);
        assert.equal(ui.safetyMode(url, flags, { hosted: true }).mode, 'refused', `ui ${url}`);
      }
    }
    const want = 'REFUSED: 10.8.0.1 is a local or private address; the hosted agent only tests public non-production hosts.';
    assert.equal(refusalMessage(assessSafety({ baseUrl: 'http://10.8.0.1/v1' }, { hosted: true })), want);
    assert.equal(ui.localRefusalMessage('http://10.8.0.1/v1'), want);
  });
  await check('hosted: non-production stays full, production stays refused or read-only, never full', () => {
    assert.equal(assessSafety({ baseUrl: 'https://api-staging.example.com', allowWrites: true }, { hosted: true }).mode, 'full');
    assert.equal(assessSafety({ baseUrl: 'https://api.example.com' }, { hosted: true }).mode, 'refused');
    assert.equal(assessSafety({ baseUrl: 'https://api.example.com', allowProduction: true }, { hosted: true }).mode, 'read-only');
    assert.equal(assessSafety({ baseUrl: 'https://api.example.com', allowProduction: true, allowWrites: true }, { hosted: true }).mode, 'read-only', 'allowWrites is ignored when hosted');
    assert.equal(ui.safetyMode('https://api.example.com', { allowProduction: true, allowWrites: true }, { hosted: true }).mode, 'read-only');
    assert.equal(ui.safetyMode('https://api.example.com', { allowProduction: true, allowWrites: true }).mode, 'full', 'not hosted: unchanged');
  });
  await check('HOSTED=1 in the environment applies without an option, and hosted: false cannot undo it', () => {
    const before = process.env.HOSTED;
    process.env.HOSTED = '1';
    try {
      assert.equal(assessSafety({ baseUrl: 'http://localhost:4000' }).mode, 'refused');
      assert.equal(assessSafety({ baseUrl: 'http://localhost:4000' }, { hosted: false }).mode, 'refused');
      assert.equal(assessSafety({ baseUrl: 'https://api.example.com', allowProduction: true, allowWrites: true }).mode, 'read-only');
    } finally {
      if (before === undefined) delete process.env.HOSTED;
      else process.env.HOSTED = before;
    }
    assert.equal(assessSafety({ baseUrl: 'http://localhost:4000' }).mode, 'full', 'without HOSTED the local demo is unchanged');
  });
  await check('hosted: the shared HTTP layer refuses a local host before any request', async () => {
    await assert.rejects(createClients(config('http://127.0.0.1:1'), AUTH, { hosted: true }), (err: Error) => {
      assert.ok(err instanceof ProductionRefused, err.message);
      assert.match(err.message, /local or private address/);
      return true;
    });
  });

  await check('read-only mode allows reads without setup only', () => {
    const s = assessSafety({ baseUrl: 'https://api.example.com', allowProduction: true });
    const eps = config('https://api.example.com').endpoints;
    assert.deepEqual(eps.map((e) => endpointAllowed(s, e)), [true, false, false, false]);
    assert.equal(endpointAllowed(s, { method: 'HEAD' }), true);
    assert.equal(endpointAllowed(s, { method: 'OPTIONS' }), true);
    assert.equal(endpointAllowed(s, { method: 'PATCH' }), false);
    const full = assessSafety({ baseUrl: 'http://localhost' });
    assert.deepEqual(eps.map((e) => endpointAllowed(full, e)), [true, true, true, true]);
    const refused = assessSafety({ baseUrl: 'https://api.example.com' });
    assert.deepEqual(eps.map((e) => endpointAllowed(refused, e)), [false, false, false, false]);
  });

  console.log('HTTP layer (agent/http.ts)');
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(req.method === 'POST' ? 201 : 200, { 'Content-Type': 'application/json' });
    res.end(req.method === 'POST' ? '{"id":7}' : '[]');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await check('refused: createClients throws ProductionRefused and no request reaches the server', async () => {
      seen.length = 0;
      await assert.rejects(createClients(config(base), AUTH, { forceProduction: true }), (err: Error) => {
        assert.ok(err instanceof ProductionRefused);
        assert.equal(err.message, 'REFUSED: 127.0.0.1 looks like a production host. Set allowProduction to run read-only tests.');
        return true;
      });
      await assert.rejects(createClients(config('https://api.example.com'), AUTH), ProductionRefused);
      assert.deepEqual(seen, []);
    });

    await check('read-only: GET and HEAD are sent and counted; POST, PUT, PATCH, DELETE and createResource throw ReadOnlyBlocked', async () => {
      seen.length = 0;
      const cfg = config(base, { allowProduction: true });
      const clients = await createClients(cfg, AUTH, { forceProduction: true });
      try {
        assert.equal(clients.safety.mode, 'read-only');
        assert.equal((await clients.noAuthApi.get('/items')).status(), 200);
        assert.equal((await clients.api.fetch('/items')).status(), 200);
        assert.equal((await clients.api.head('/items')).status(), 200);
        await assert.rejects(clients.api.post('/items', { data: { name: 'x' } }), (e: Error) => e instanceof ReadOnlyBlocked && /POST \/items/.test(e.message));
        await assert.rejects(clients.api.put('/items/1', { data: {} }), ReadOnlyBlocked);
        await assert.rejects(clients.api.patch('/items/1', { data: {} }), ReadOnlyBlocked);
        await assert.rejects(clients.noAuthApi.delete('/items/1'), ReadOnlyBlocked);
        await assert.rejects(clients.api.fetch('/items/1', { method: 'delete' }), (e: Error) => e instanceof ReadOnlyBlocked && /DELETE \/items\/1/.test(e.message));
        await assert.rejects(createResource(cfg, clients, 'create-item'), ReadOnlyBlocked);
        assert.equal(clients.counter.sent, 3);
        assert.deepEqual(seen, ['GET /items', 'GET /items', 'HEAD /items']);
      } finally {
        await disposeClients(clients);
      }
    });

    await check('production with allowWrites: writes are sent and counted', async () => {
      seen.length = 0;
      const cfg = config(base, { allowProduction: true, allowWrites: true });
      const clients = await createClients(cfg, AUTH, { forceProduction: true });
      try {
        assert.equal(clients.safety.mode, 'full');
        assert.equal(await createResource(cfg, clients, 'create-item'), '7');
        assert.equal((await clients.api.delete('/items/7')).status(), 200);
        assert.equal(clients.counter.sent, 2);
        assert.deepEqual(seen, ['POST /items', 'DELETE /items/7']);
      } finally {
        await disposeClients(clients);
      }
    });

    await check('login auth: refused host sends no login; read-only sends the login (not a data write) but blocks writes', async () => {
      seen.length = 0;
      const login: Config['auth'] = {
        type: 'login',
        request: { method: 'POST', path: '/login' },
        credentialsEnv: { user: 'SAFETY_TEST_USER', pass: 'SAFETY_TEST_PASS' },
        tokenPath: 'id',
        apply: { type: 'header', header: 'Authorization', prefix: 'Bearer ' },
      };
      const env = { SAFETY_TEST_USER: 'u', SAFETY_TEST_PASS: 'p' };
      await assert.rejects(createClients({ ...config(base), auth: login }, env, { forceProduction: true }), ProductionRefused);
      assert.deepEqual(seen, [], 'refused: not even the login request is sent');
      const clients = await createClients({ ...config(base, { allowProduction: true }), auth: login }, env, { forceProduction: true });
      try {
        assert.equal((await clients.api.get('/items')).status(), 200);
        await assert.rejects(clients.api.post('/items', { data: {} }), ReadOnlyBlocked);
        assert.deepEqual(seen, ['POST /login', 'GET /items'], 'the login (POST) went through the guard, the data write did not');
        assert.equal(clients.counter.sent, 2);
      } finally {
        await disposeClients(clients);
      }
    });

    await check('local host: full mode, every request counted', async () => {
      seen.length = 0;
      const clients = await createClients(config(base), AUTH);
      try {
        assert.equal(clients.safety.hostClass, 'local');
        assert.equal(clients.safety.mode, 'full');
        await clients.api.post('/items', { data: {} });
        await clients.api.get('/items');
        assert.equal(clients.counter.sent, 2);
        assert.equal(seen.length, 2);
      } finally {
        await disposeClients(clients);
      }
    });
  } finally {
    server.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`test:safety FAILED ${(err as Error)?.message ?? err}`);
  process.exit(1);
});
