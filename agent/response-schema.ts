import { z } from 'zod';

// The success response an endpoint documents (from an OpenAPI spec), in a small JSON Schema subset:
// type, nullable, properties, required, items, enum. The OpenAPI importer writes it into the input file
// as endpoint.responseSchema; the agent then
//   - checks the probe response against it (summary.json endpoints[].responseSchemaIssues),
//   - shows it to the planner and generator, and
//   - has the gate require [schema] tests to assert every required field it names.
// Anything outside the subset (formats, patterns, oneOf, numbers ranges) is not checked.

export type SchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';
export type LiteSchema = {
  type?: SchemaType | SchemaType[];
  nullable?: boolean;
  properties?: Record<string, LiteSchema>;
  required?: string[];
  items?: LiteSchema;
  enum?: unknown[];
};

const TYPES = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'] as const;
export const LiteSchemaZ: z.ZodType<LiteSchema> = z.lazy(() =>
  z.object({
    type: z.union([z.enum(TYPES), z.array(z.enum(TYPES)).min(1)]).optional(),
    nullable: z.boolean().optional(),
    properties: z.record(z.string(), LiteSchemaZ).optional(),
    required: z.array(z.string()).optional(),
    items: LiteSchemaZ.optional(),
    enum: z.array(z.unknown()).optional(),
  }).strict(),
);
export const ResponseSchemaZ = z.object({ status: z.number().int().min(200).max(299), schema: LiteSchemaZ }).strict();
export type ResponseSchema = z.infer<typeof ResponseSchemaZ>;

const MAX_ISSUES = 20;
const MAX_ITEMS = 3; // probe bodies have arrays truncated to 3 items

function typeOf(value: unknown): SchemaType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value as SchemaType;
}

function typeMatches(expected: SchemaType, actual: SchemaType): boolean {
  return expected === actual || (expected === 'number' && actual === 'integer');
}

// Every place the value breaks the schema, as "<path>: <what>" lines, at most MAX_ISSUES.
export function responseSchemaIssues(schema: LiteSchema, value: unknown, path = 'body', out: string[] = [], depth = 0): string[] {
  if (out.length >= MAX_ISSUES || depth > 8) return out;
  const actual = typeOf(value);
  if (actual === 'null' && schema.nullable) return out;
  if (schema.type) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowed.some((t) => typeMatches(t, actual))) {
      out.push(`${path}: expected ${allowed.join(' or ')}, got ${actual}`);
      return out;
    }
  }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    out.push(`${path}: ${JSON.stringify(value).slice(0, 40)} is not one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ').slice(0, 80)}`);
  }
  if (actual === 'object') {
    const obj = value as Record<string, unknown>;
    for (const name of schema.required ?? []) if (!(name in obj)) out.push(`${path}.${name}: required field is missing`);
    for (const [name, sub] of Object.entries(schema.properties ?? {})) {
      if (name in obj) responseSchemaIssues(sub, obj[name], `${path}.${name}`, out, depth + 1);
    }
  }
  if (actual === 'array' && schema.items) {
    (value as unknown[]).slice(0, MAX_ITEMS).forEach((item, i) => responseSchemaIssues(schema.items!, item, `${path}[${i}]`, out, depth + 1));
  }
  return out.slice(0, MAX_ISSUES);
}

// The required top-level fields a [schema] test must assert: those of the object, or of each array item.
export function requiredResponseFields(schema: LiteSchema | undefined): string[] {
  if (!schema) return [];
  const target = schema.items && (schema.type === 'array' || (Array.isArray(schema.type) && schema.type.includes('array'))) ? schema.items : schema;
  return [...new Set(target.required ?? [])].filter((f) => /^[A-Za-z_$][\w$-]*$/.test(f));
}

// OpenAPI or Swagger schema -> LiteSchema. deref follows local $refs; allOf is merged, oneOf/anyOf take
// their first branch (documented as "not checked" above), unknown keywords are dropped.
export function liteSchemaFrom(node: unknown, deref: (n: unknown) => unknown, depth = 0): LiteSchema | undefined {
  const s = deref(node);
  if (!s || typeof s !== 'object' || Array.isArray(s) || depth > 8) return undefined;
  const o = s as Record<string, unknown>;
  if (Array.isArray(o.allOf)) {
    const parts = o.allOf.map((p) => liteSchemaFrom(p, deref, depth + 1)).filter((p): p is LiteSchema => Boolean(p));
    const merged: LiteSchema = {};
    for (const p of parts) {
      if (p.type && !merged.type) merged.type = p.type;
      if (p.properties) merged.properties = { ...(merged.properties ?? {}), ...p.properties };
      if (p.required) merged.required = [...new Set([...(merged.required ?? []), ...p.required])];
      if (p.items && !merged.items) merged.items = p.items;
      if (p.nullable) merged.nullable = true;
    }
    if (!merged.type && merged.properties) merged.type = 'object';
    return merged;
  }
  const choice = Array.isArray(o.oneOf) ? o.oneOf : Array.isArray(o.anyOf) ? o.anyOf : null;
  if (choice) return undefined; // several shapes: not checked
  const out: LiteSchema = {};
  const rawTypes = (Array.isArray(o.type) ? o.type : o.type !== undefined ? [o.type] : []).map(String);
  const types = rawTypes.filter((t): t is SchemaType => (TYPES as readonly string[]).includes(t));
  if (types.length === 1) out.type = types[0];
  else if (types.length > 1) out.type = types;
  else if (o.properties) out.type = 'object';
  else if (o.items) out.type = 'array';
  if (o.nullable === true || o['x-nullable'] === true) out.nullable = true;
  if (Array.isArray(o.enum) && o.enum.length) out.enum = o.enum;
  if (o.properties && typeof o.properties === 'object') {
    const props: Record<string, LiteSchema> = {};
    for (const [name, sub] of Object.entries(o.properties as Record<string, unknown>)) {
      const lite = liteSchemaFrom(sub, deref, depth + 1);
      props[name] = lite ?? {};
    }
    out.properties = props;
  }
  if (Array.isArray(o.required)) {
    // writeOnly fields (passwords) are not in the response
    const props = (o.properties ?? {}) as Record<string, unknown>;
    out.required = o.required.map(String).filter((name) => {
      const p = deref(props[name]) as Record<string, unknown> | undefined;
      return !(p && p.writeOnly === true);
    });
  }
  if (o.items) {
    const items = liteSchemaFrom(o.items, deref, depth + 1);
    if (items) out.items = items;
  }
  return out;
}
