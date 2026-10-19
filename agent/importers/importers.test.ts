import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { ConfigSchema, configProblems, loadConfig } from '../config';
import { AUTH_NEEDED, AUTH_REMOVED, CREDENTIALS_DROPPED, type ImportResult } from './core';
import { importCurl } from './curl';
import { importHar } from './har';
import { importOpenApi } from './openapi';
import { importPostman } from './postman';
import { fromAnswer, importText, maskCredentials, type TextAnswer } from './text';

// npm run test:importers: checks each importer against the fixtures in test-fixtures/importers/.
// Plain node:assert, no test framework. The fixtures contain the fake credential below; it must
// never appear in any importer output.

const FIXTURES = 'test-fixtures/importers';
const SECRET = 'importer-secret-test-value';
const fixture = (name: string) => readFileSync(`${FIXTURES}/${name}`, 'utf8');
const localShop = loadConfig('input/local-shop.json');

let failed = 0;
let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`ok    ${name}`);
  } catch (err) {
    failed++;
    const message = String((err as Error)?.message ?? err).split(SECRET).join('<fake credential>');
    console.log(`FAIL  ${name}\n      ${message.split('\n').join('\n      ')}`);
  }
}

function assertNoSecret(label: string, text: string) {
  assert.ok(!text.includes(SECRET), `${label} contains the fake credential`);
  assert.ok(!/Bearer importer/i.test(text), `${label} contains part of the fake credential`);
}

// "<item without the (METHOD url) suffix>: <reason>" for each skipped entry.
function skippedLines(r: ImportResult): string[] {
  return r.skipped.map((s) => `${s.item.replace(/ \([A-Z]+ [^()]*\)$/, '')}: ${s.reason}`);
}

// One line per endpoint, so a whole import can be compared at a glance.
function lines(r: ImportResult): string[] {
  return r.input.endpoints.map(
    (e) => `${e.id} ${e.method} ${e.path} auth=${e.requiresAuth}${e.setup ? ` setup=${e.setup.endpointId}/${e.setup.idField}` : ''}${e.body ? ' body' : ''}`,
  );
}

function runCli(type: string, content: string) {
  const res = spawnSync('node_modules/.bin/tsx', ['agent/import.ts', type], { input: content, encoding: 'utf8' });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

// Same paths, methods, requiresAuth, bodies and setup as input/local-shop.json, and valid as an input file.
function assertLikeLocalShop(r: ImportResult) {
  assert.equal(r.input.baseUrl, 'http://localhost:4000');
  assert.deepEqual(r.input.defaultHeaders, { Accept: 'application/json', 'Content-Type': 'application/json' });
  assert.deepEqual(r.input.auth, { header: 'Authorization', valueEnv: 'CUSTOM_API_AUTH' });
  assert.deepEqual(
    r.input.endpoints.map((e) => e.id),
    ['get-products', 'post-products', 'get-products-id', 'put-products-id', 'delete-products-id'],
  );
  for (const want of localShop.endpoints) {
    const got = r.input.endpoints.find((e) => e.method === want.method && e.path === want.path);
    assert.ok(got, `no ${want.method} ${want.path}`);
    assert.equal(got.requiresAuth, want.requiresAuth, `${want.id}: requiresAuth`);
    assert.deepEqual(got.body, want.body, `${want.id}: body`);
    assert.deepEqual(got.setup, want.setup ? { endpointId: 'post-products', idField: 'id' } : undefined, `${want.id}: setup`);
  }
  assert.deepEqual(r.skipped, []);
  assert.ok(r.warnings.includes(AUTH_REMOVED), 'auth warning missing');
  assert.ok(
    r.warnings.some((w) => w.startsWith('Setup added: get-products-id, put-products-id, delete-products-id') && w.includes('idField')),
    'setup idField warning missing',
  );
  assert.equal(ConfigSchema.safeParse(r.input).success, true, 'not valid against the config schema');
  assert.deepEqual(configProblems(r.input), []);
  assertNoSecret('import result', JSON.stringify(r));
}

// CLAUDE.md rule 6: the output holds auth.header and auth.valueEnv only, never a header value, cookie
// or token, and a warning names every credential that was dropped.
function assertCredentialsDropped(r: ImportResult, names: string[]) {
  assertNoSecret('import result', JSON.stringify(r));
  assert.deepEqual(r.input.defaultHeaders, { Accept: 'application/json', 'Content-Type': 'application/json' });
  assert.deepEqual(Object.keys(r.input.auth ?? {}).sort(), ['header', 'valueEnv']);
  assert.equal(r.input.auth?.valueEnv, 'CUSTOM_API_AUTH');
  for (const e of r.input.endpoints) {
    for (const key of Object.keys(e)) assert.ok(['id', 'method', 'path', 'requiresAuth', 'body', 'setup'].includes(key), `${e.id}: unexpected field ${key}`);
  }
  assert.ok(r.warnings.includes(`${CREDENTIALS_DROPPED} ${names.join(', ')}.`), `no warning naming ${names.join(', ')}: ${r.warnings.join(' | ')}`);
}

async function main() {
  console.log('Auth stripping');
  await check('HAR, Postman and cURL: header values, cookies and tokens are dropped and named in a warning', () => {
    const har = {
      log: {
        entries: [
          {
            request: {
              method: 'GET',
              url: 'http://localhost:4000/orders',
              headers: [
                { name: 'Authorization', value: `Bearer ${SECRET}` },
                { name: 'Cookie', value: `session=${SECRET}` },
                { name: 'X-API-Key', value: SECRET },
              ],
              cookies: [{ name: 'session', value: SECRET }],
            },
            response: { status: 200, content: { mimeType: 'application/json', text: '[]' } },
          },
        ],
      },
    };
    const postman = {
      info: { name: 'Orders', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [
        {
          name: 'List orders',
          request: {
            method: 'GET',
            url: 'http://localhost:4000/orders',
            header: [
              { key: 'Authorization', value: `Bearer ${SECRET}` },
              { key: 'Cookie', value: `session=${SECRET}` },
              { key: 'X-API-Key', value: SECRET },
            ],
          },
        },
      ],
    };
    const curl = `curl http://localhost:4000/orders -H "Authorization: Bearer ${SECRET}" -H "Cookie: session=${SECRET}" -H "X-API-Key: ${SECRET}"`;
    const all = ['Authorization header', 'Cookie header', 'X-API-Key header'];
    const cases: [string, string, (content: string) => ImportResult, string[]][] = [
      ['har', JSON.stringify(har), importHar, all],
      ['postman', JSON.stringify(postman), importPostman, all],
      ['curl', curl, importCurl, all],
      ['har', fixture('local-shop.har'), importHar, ['Authorization header', 'Cookie header']],
      ['postman', fixture('local-shop.postman.json'), importPostman, ['Authorization header']],
      ['curl', fixture('local-shop.curl.txt'), importCurl, ['Authorization header']],
    ];
    for (const [type, content, importer, names] of cases) {
      assertCredentialsDropped(importer(content), names);
      const res = runCli(type, content);
      assert.equal(res.code, 0, `${type}: exit code ${res.code}: ${res.stderr}`);
      assertCredentialsDropped(JSON.parse(res.stdout) as ImportResult, names);
      assertNoSecret(`${type} stderr`, res.stderr);
    }
  });

  console.log('Postman');
  await check('local shop collection gives the 5 local-shop endpoints', () => {
    const r = importPostman(fixture('local-shop.postman.json'));
    assert.equal(r.input.name, 'local-shop-api');
    assertLikeLocalShop(r);
  });

  await check('edge cases: v2.0 format, duplicate ids, skipped items, credentials', () => {
    const r = importPostman(fixture('edge-cases.postman.json'));
    assert.deepEqual(lines(r), [
      'get-products GET /products auth=false',
      'get-products-2 GET /products?category=shoes auth=false',
      'get-products-3 GET /products?page=2 auth=true',
      'post-products POST /products auth=true body',
      'get-reviews-reviewid GET /reviews/{reviewId} auth=false',
      'delete-products-id DELETE /products/{id} auth=true setup=post-products/id',
      'put-products-id PUT /products/{id} auth=true setup=post-products/id body',
    ]);
    assert.deepEqual(r.input.auth, { header: 'X-API-Key', valueEnv: 'CUSTOM_API_AUTH' });
    assert.deepEqual(
      skippedLines(r),
      [
        'Health on another host: unresolved variable {{otherBase}} in URL',
        'Catalog / Admin / Upload image: non-JSON body (multipart form-data)',
        'Catalog / Admin / Create product (form): non-JSON body (form-urlencoded)',
        'Options: method OPTIONS is not supported (GET, POST, PUT, PATCH, DELETE only)',
        'Legacy XML update: non-JSON body (application/xml)',
        'Track event: origin https://analytics.example.com differs from the base URL http://localhost:4000',
      ],
    );
    const w = r.warnings.join('\n');
    assert.ok(r.warnings.includes(AUTH_REMOVED));
    assert.match(w, /get-reviews-reviewid needs setup: .*no POST \/reviews/);
    assert.match(w, /Setup added: delete-products-id, put-products-id .* post-products .*idField/);
    assert.match(w, /more than one name \(X-API-Key, query parameter api_key, Cookie\)\. Kept X-API-Key/);
    assert.match(w, /Headers not imported .*: X-Tenant-Id\./);
    assert.ok(!w.includes('X-Debug'), 'a disabled header was reported');
    assertNoSecret('import result', JSON.stringify(r));
  });

  await check('a credential value reused in a body is replaced and reported', () => {
    const collection = {
      info: { name: 'Reuse', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      variable: [{ key: 'token', value: SECRET }],
      item: [{ name: 'Note', request: { method: 'POST', url: 'http://localhost:4000/notes', header: [{ key: 'Authorization', value: `Bearer {{token}}` }], body: { mode: 'raw', raw: '{"text":"{{token}}"}', options: { raw: { language: 'json' } } } } }],
    };
    const r = importPostman(JSON.stringify(collection));
    assert.deepEqual(r.input.endpoints[0].body, { text: '<removed>' });
    assert.ok(r.warnings.some((x) => x.includes('also appeared in post-notes')));
    assertNoSecret('import result', JSON.stringify(r));
  });

  await check('not a collection, or not JSON: clear error without quoting the source', () => {
    assert.throws(() => importPostman('{"name": "x"}'), /Not a Postman collection/);
    assert.throws(() => importPostman(`{"info": {}, "item": [Bearer ${SECRET}]}`), (err: Error) => {
      assert.match(err.message, /^The Postman collection is not valid JSON \(line 1, column \d+\)\.$/);
      assertNoSecret('error', err.message);
      return true;
    });
  });

  console.log('cURL');
  await check('local shop commands give the 5 local-shop endpoints', () => {
    const r = importCurl(fixture('local-shop.curl.txt'));
    assert.equal(r.input.name, undefined);
    assertLikeLocalShop(r);
  });

  await check('edge cases: continuations, $\'...\', -G, -u, -b, skipped items', () => {
    const text = fixture('edge-cases.curl.txt');
    const r = importCurl(text);
    assert.deepEqual(lines(r), [
      'get-products GET /products auth=false',
      'get-products-2 GET /products?sort=price auth=false',
      'post-products POST /products auth=true body',
      'delete-products-id DELETE /products/{id} auth=true setup=post-products/id',
      'get-products-3 GET /products?q=trail%20shoe auth=true',
      'put-products-id PUT /products/{id} auth=true setup=post-products/id body',
    ]);
    assert.deepEqual(r.input.endpoints.find((e) => e.id === 'put-products-id')?.body, {
      name: "Rock's Shoe",
      price: 12.5,
      category: 'shoes',
      inStock: true,
    });
    const echoLine = text.split('\n').findIndex((l) => l.startsWith('echo')) + 1;
    assert.deepEqual(
      skippedLines(r),
      [
        `line ${echoLine}: not a curl command`,
        'curl #3 (line 8): unresolved variable $BASE_URL in URL',
        'curl #5 (line 14): non-JSON body (application/x-www-form-urlencoded)',
        'curl #4 (line 11): origin https://analytics.example.com differs from the base URL http://localhost:4000',
      ],
    );
    assert.deepEqual(r.input.auth, { header: 'Authorization', valueEnv: 'CUSTOM_API_AUTH' });
    const w = r.warnings.join('\n');
    assert.match(w, /more than one name \(Authorization, Cookie, query parameter access_token\)\. Kept Authorization/);
    assert.match(w, /Headers not imported .*: X-Request-Id\./);
    assert.match(w, /curl options ignored: --frobnicate\./);
    assertNoSecret('import result', JSON.stringify(r));
  });

  await check('user:password in the URL is a credential', () => {
    const r = importCurl(`curl http://admin:${SECRET}@localhost:4000/products`);
    assert.deepEqual(lines(r), ['get-products GET /products auth=true']);
    assert.equal(r.input.baseUrl, 'http://localhost:4000');
    assertNoSecret('import result', JSON.stringify(r));
  });

  console.log('OpenAPI / Swagger');
  await check('local shop OpenAPI YAML gives the 5 local-shop endpoints', () => {
    const r = importOpenApi(fixture('local-shop.openapi.yaml'));
    assert.equal(r.input.name, 'local-shop-api');
    assertLikeLocalShop(r);
  });

  await check('Swagger 2.0: host + basePath, query api key, body from schema, skipped operations', () => {
    const r = importOpenApi(fixture('edge-cases.swagger.json'));
    assert.equal(r.input.baseUrl, 'https://api.example.test');
    assert.deepEqual(lines(r), [
      'get-v2-pets GET /v2/pets?limit=1 auth=false',
      'post-v2-pets POST /v2/pets auth=true body',
      'get-v2-pets-petid GET /v2/pets/{petId} auth=true setup=post-v2-pets/id',
      'delete-v2-pets-petid DELETE /v2/pets/{petId} auth=true setup=post-v2-pets/id',
    ]);
    // Required, non-readOnly properties only, with simple typed values.
    assert.deepEqual(r.input.endpoints[1].body, { name: 'string', kind: 'dog', owner: { email: 'user@example.com' }, tags: ['string'] });
    assert.deepEqual(skippedLines(r), [
      'uploadPhoto: non-JSON body (multipart/form-data)',
      'putStoreConfig: non-JSON body (application/xml)',
      'healthCheck: method HEAD is not supported (GET, POST, PUT, PATCH, DELETE only)',
    ]);
    assert.deepEqual(r.input.auth, { header: 'api_key', valueEnv: 'CUSTOM_API_AUTH' });
    const w = r.warnings.join('\n');
    assert.ok(r.warnings.includes(AUTH_NEEDED), 'auth-needed warning missing');
    assert.ok(!r.warnings.includes(AUTH_REMOVED), 'nothing was removed, the spec has no values');
    assert.match(w, /Sample body built from the schema .* for: createPet\./);
    assert.match(w, /query parameter api_key, but the agent sends auth as a header/);
    assert.match(w, /Headers not imported .*: X-Request-Id\./);
  });

  await check('OpenAPI 3.1: relative server means empty baseUrl and a warning', () => {
    const r = importOpenApi(fixture('relative-server.openapi.json'));
    assert.equal(r.input.baseUrl, '');
    assert.deepEqual(lines(r), [
      'post-api-v1-orders POST /api/v1/orders auth=true body',
      'get-api-v1-orders GET /api/v1/orders auth=true',
      'patch-api-v1-orders-orderid PATCH /api/v1/orders/{orderId} auth=false setup=post-api-v1-orders/id',
      'post-api-v1-reports POST /api/v1/reports auth=false body',
    ]);
    assert.deepEqual(r.input.endpoints[0].body, { sku: 'string', quantity: 1 });
    assert.deepEqual(r.input.endpoints[3].body, {});
    const w = r.warnings.join('\n');
    assert.match(w, /servers\[0\]\.url is relative \(\/api\/v1\)\. Enter the base URL before running\./);
    assert.match(w, /External \$ref values are not followed: https:\/\/schemas\.example\.com\/order-patch\.json\./);
    assert.match(w, /no required fields, so the sample body is empty, for: createReport\./);
    // Valid apart from the empty base URL, which the user fills in.
    assert.equal(ConfigSchema.safeParse({ ...r.input, baseUrl: 'https://filled-in.example.com' }).success, true);
    assert.deepEqual(configProblems(r.input), []);
    assertNoSecret('import result', JSON.stringify(r));
  });

  await check('not OpenAPI, or broken YAML: clear error without quoting the source', () => {
    assert.throws(() => importOpenApi('title: just yaml\n'), /Not an OpenAPI 3\.x or Swagger 2\.0 document/);
    assert.throws(() => importOpenApi(`openapi: 3.0.0\ninfo: Send "Authorization: Bearer ${SECRET}" now\n`), (err: Error) => {
      assert.match(err.message, /^The OpenAPI document is not valid YAML \(line 2, column \d+, [A-Z_]+\)\.$/);
      assertNoSecret('error', err.message);
      return true;
    });
  });

  console.log('HAR');
  await check('mixed traffic: API calls grouped, the rest filtered and counted', () => {
    const r = importHar(fixture('local-shop.har'));
    assert.equal(r.input.baseUrl, 'http://localhost:4000');
    assert.deepEqual(lines(r), [
      'get-products GET /products auth=false',
      'post-session POST /session auth=false body',
      'post-products POST /products auth=true body',
      'get-products-id GET /products/{id} auth=false setup=post-products/id',
      'put-products-id PUT /products/{id} auth=true setup=post-products/id body',
      'get-products-id-reviews GET /products/{id}/reviews auth=false setup=post-products/id',
      'delete-products-id DELETE /products/{id} auth=true setup=post-products/id',
    ]);
    assert.deepEqual(r.input.endpoints[1].body, { email: 'qa@example.com', password: '<removed>' });
    assert.deepEqual(skippedLines(r), ['9 requests: filtered: not an API call', '1 request: non-JSON body (application/x-www-form-urlencoded)']);
    assert.deepEqual(r.input.auth, { header: 'Authorization', valueEnv: 'CUSTOM_API_AUTH' });
    const w = r.warnings.join('\n');
    assert.match(w, /Grouped 10 API requests into 8 endpoints\./);
    assert.match(w, /Query parameters not kept .*: GET \/products \(page\)\./);
    assert.match(w, /replaced with <removed>: POST \/session \(password\)/);
    assert.match(w, /Browsers send cookies with every request/);
    assertNoSecret('import result', JSON.stringify(r));
  });

  await check('not a HAR file: clear error', () => {
    assert.throws(() => importHar('{"entries": []}'), /Not a HAR file: expected log\.entries/);
    assert.throws(() => importHar('{"log": {"entries": []}}'), /No API calls found in the HAR file/);
  });

  console.log('Jira / Confluence text');
  await check('credentials are masked before the text goes to Claude', () => {
    const { text, removed } = maskCredentials(fixture('local-shop.jira.txt'));
    assertNoSecret('masked text', text);
    assert.deepEqual(removed, [SECRET]);
    assert.match(text, /"Authorization: Bearer <removed>"/);
    const more = maskCredentials(`X-API-Key: ${SECRET}\nGET /items?api_key=${SECRET}&page=2\n"password": "${SECRET}",`);
    assertNoSecret('masked text', more.text);
    assert.match(more.text, /^X-API-Key: <removed>$/m);
    assert.match(more.text, /\?api_key=<removed>&page=2/);
  });

  await check("Claude's answer is checked against the text: nothing invented gets through", () => {
    const text = 'Orders API. GET /orders lists orders. POST /orders creates one with sku and quantity; it needs a token.';
    const answer: TextAnswer = {
      name: 'Orders API',
      baseUrl: 'https://invented.example.com',
      defaultHeaders: { Accept: 'application/json', Authorization: 'Bearer abc123456789' },
      auth: { header: 'Authorization', valueEnv: 'CUSTOM_API_AUTH' },
      endpoints: [
        { id: 'list', method: 'GET', path: '/orders', requiresAuth: false },
        { id: 'create', method: 'POST', path: '/orders', requiresAuth: true, body: { sku: 'string', quantity: 1, color: 'red' } },
        { id: 'refund', method: 'POST', path: '/refunds/{id}', requiresAuth: true },
      ],
    };
    const r = fromAnswer(answer, text, []);
    assert.equal(r.input.baseUrl, '');
    assert.equal(r.input.name, 'orders-api');
    assert.deepEqual(lines(r), ['get-orders GET /orders auth=false', 'post-orders POST /orders auth=true body']);
    assert.deepEqual(r.input.endpoints[1].body, { sku: 'string', quantity: 1 });
    assert.deepEqual(skippedLines(r), ['POST /refunds/{id}: path not found in the text (paths are never invented)']);
    const w = r.warnings.join('\n');
    assert.match(w, /base URL in Claude's answer is not in the text, so it was dropped/);
    assert.match(w, /The text gives no base URL\. Enter the base URL before running\./);
    assert.match(w, /Body fields not named in the text were removed: POST \/orders \(color\)\./);
    assert.ok(r.warnings.includes(AUTH_NEEDED), 'auth-needed warning missing');
    assert.ok(!JSON.stringify(r).includes('abc123456789'), "a credential from Claude's defaultHeaders reached the output");
    assert.throws(() => fromAnswer({ ...answer, endpoints: [] }, text, []), /^Error: No endpoints found in the text$|No endpoints found in the text/);
  });

  await check('Jira ticket gives the 5 local-shop endpoints (live Claude call)', async () => {
    const r = await importText(fixture('local-shop.jira.txt'));
    assert.deepEqual(
      r.input.endpoints.map((e) => `${e.method} ${e.path}`),
      ['GET /products', 'POST /products', 'GET /products/{id}', 'PUT /products/{id}', 'DELETE /products/{id}'],
    );
    assert.equal(r.input.baseUrl, 'http://localhost:4000');
    assertNoSecret('import result', JSON.stringify(r));
    console.log(`      requiresAuth: ${r.input.endpoints.map((e) => `${e.id}=${e.requiresAuth}`).join(', ')}`);
  });

  await check('text without endpoints: exit 1 with "No endpoints found in the text" (live Claude call)', () => {
    const res = runCli('text', 'Retro notes, sprint 12. We talked about the release date and the on-call rota. No action items.');
    assert.equal(res.code, 1, `exit code ${res.code}, stdout: ${res.stdout.slice(0, 200)}`);
    assert.equal(res.stdout, '');
    assert.match(res.stderr, /import FAILED No endpoints found in the text/);
    assert.match(res.stderr, /\[claude\] import-text text .*\(import call 1\/2, not counted in the run budget\)/);
  });

  console.log('CLI (agent/import.ts)');
  await check('prints one JSON object with input, skipped and warnings', () => {
    for (const [type, file] of [
      ['postman', 'local-shop.postman.json'],
      ['curl', 'local-shop.curl.txt'],
      ['postman', 'edge-cases.postman.json'],
      ['curl', 'edge-cases.curl.txt'],
      ['openapi', 'local-shop.openapi.yaml'],
      ['openapi', 'edge-cases.swagger.json'],
      ['openapi', 'relative-server.openapi.json'],
      ['har', 'local-shop.har'],
    ]) {
      const res = runCli(type, fixture(file));
      assert.equal(res.code, 0, `${file}: exit code ${res.code}: ${res.stderr}`);
      const out = JSON.parse(res.stdout) as ImportResult;
      assert.deepEqual(Object.keys(out), ['input', 'skipped', 'warnings'], file);
      assertNoSecret(`${file} stdout`, res.stdout);
      assertNoSecret(`${file} stderr`, res.stderr);
    }
  });

  await check('zero endpoints: exit 1, reason on stderr, nothing on stdout', () => {
    const res = runCli('curl', `curl "$BASE_URL/products" -H "Authorization: Bearer ${SECRET}"`);
    assert.equal(res.code, 1);
    assert.equal(res.stdout, '');
    assert.match(res.stderr, /import FAILED No endpoints imported: 1 item skipped \(1 x unresolved variable \$BASE_URL in URL\)/);
    assertNoSecret('stderr', res.stderr);
  });

  await check('unknown type and empty stdin: exit 1 with usage or reason', () => {
    const unknown = runCli('soap', 'x');
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /type is one of: postman, openapi, curl, har, text/);
    const empty = runCli('postman', '  \n');
    assert.equal(empty.code, 1);
    assert.match(empty.stderr, /stdin is empty/);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`test:importers FAILED ${String((err as Error)?.message ?? err).split(SECRET).join('<fake credential>')}`);
  process.exit(1);
});
