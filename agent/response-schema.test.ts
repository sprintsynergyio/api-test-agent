import assert from 'node:assert/strict';
import { ConfigSchema } from './config';
import { liteSchemaFrom, requiredResponseFields, responseSchemaIssues, type LiteSchema } from './response-schema';

// npm run test:response-schema: the documented response schema (OpenAPI) and the check of a probe
// response against it. Offline.

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

const PRODUCT: LiteSchema = {
  type: 'object',
  properties: { id: { type: 'integer' }, name: { type: 'string' }, price: { type: 'number' }, tag: { type: 'string', nullable: true }, kind: { enum: ['a', 'b'] } },
  required: ['id', 'name', 'price'],
};

check('a matching object has no issues (integer counts as number, nullable allows null)', () => {
  assert.deepEqual(responseSchemaIssues(PRODUCT, { id: 1, name: 'x', price: 2, tag: null, kind: 'a', extra: true }), []);
});
check('wrong types, missing required fields and enum values are reported with their path', () => {
  const issues = responseSchemaIssues(PRODUCT, { id: '1', price: 'cheap', kind: 'z' });
  assert.ok(issues.includes('body.name: required field is missing'), issues.join('\n'));
  assert.ok(issues.includes('body.id: expected integer, got string'), issues.join('\n'));
  assert.ok(issues.includes('body.price: expected number, got string'), issues.join('\n'));
  assert.ok(issues.some((i) => i.startsWith('body.kind: "z" is not one of')), issues.join('\n'));
});
check('array items are checked (first 3, as the probe truncates arrays)', () => {
  const list: LiteSchema = { type: 'array', items: PRODUCT };
  assert.deepEqual(responseSchemaIssues(list, [{ id: 1, name: 'a', price: 1 }]), []);
  assert.deepEqual(responseSchemaIssues(list, [{ id: 1, name: 'a', price: 1 }, { id: 2, price: 1 }]), ['body[1].name: required field is missing']);
  assert.deepEqual(responseSchemaIssues(list, { id: 1 }), ['body: expected array, got object']);
});
check('at most 20 issues', () => {
  const wide: LiteSchema = { type: 'object', required: Array.from({ length: 50 }, (_, i) => `f${i}`) };
  assert.equal(responseSchemaIssues(wide, {}).length, 20);
});
check('requiredResponseFields: object fields, or the item fields of an array', () => {
  assert.deepEqual(requiredResponseFields(PRODUCT), ['id', 'name', 'price']);
  assert.deepEqual(requiredResponseFields({ type: 'array', items: PRODUCT }), ['id', 'name', 'price']);
  assert.deepEqual(requiredResponseFields(undefined), []);
});
check('liteSchemaFrom: follows $ref, merges allOf, drops writeOnly required fields, skips oneOf', () => {
  const doc = {
    components: {
      schemas: {
        Base: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
        User: { allOf: [{ $ref: '#/components/schemas/Base' }, { type: 'object', properties: { password: { type: 'string', writeOnly: true }, email: { type: 'string', format: 'email' } }, required: ['password', 'email'] }] },
      },
    },
  };
  const deref = (n: unknown) => {
    let cur = n as Record<string, unknown>;
    while (cur && typeof cur.$ref === 'string') cur = (cur.$ref as string).slice(2).split('/').reduce<any>((o, k) => o?.[k], doc);
    return cur;
  };
  const lite = liteSchemaFrom({ $ref: '#/components/schemas/User' }, deref)!;
  assert.equal(lite.type, 'object');
  assert.deepEqual(Object.keys(lite.properties!).sort(), ['email', 'id', 'password']);
  assert.deepEqual(lite.required, ['id', 'email']);
  assert.equal(liteSchemaFrom({ oneOf: [{ type: 'string' }, { type: 'integer' }] }, deref), undefined);
});
check('the input file accepts endpoint.responseSchema and rejects a non-2xx status or unknown keys', () => {
  const base = { baseUrl: 'http://localhost:4000', defaultHeaders: {}, endpoints: [{ id: 'a', method: 'GET', path: '/a', requiresAuth: false }] };
  const withSchema = (rs: unknown) => ({ ...base, endpoints: [{ ...base.endpoints[0], responseSchema: rs }] });
  assert.equal(ConfigSchema.safeParse(withSchema({ status: 200, schema: PRODUCT })).success, true);
  assert.equal(ConfigSchema.safeParse(withSchema({ status: 404, schema: PRODUCT })).success, false);
  assert.equal(ConfigSchema.safeParse(withSchema({ status: 200, schema: { type: 'object', pattern: 'x' } })).success, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
