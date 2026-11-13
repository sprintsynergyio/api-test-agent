// Redaction of client data before it reaches Claude or the disk (rule 6 and the client data policy).
// No imports: the framework export copies this file as src/redact.ts, so it must stand alone.
// Everything here is pure: no process.env, no files, no network.
//
// Two kinds of rules:
// - Built-in rules, always on: values that look like personal or secret data (emails, phone numbers,
//   card numbers, IBANs, JWTs, API tokens, IP addresses, anything in a field or header named like a
//   credential). The replacement keeps the shape (<email>, <card>, ...) so the plan still knows the type.
// - Per input file: "redaction": { "fields": ["customer.name", "address.*", "*.ssn"], "mode": "strict" }.
//   fields are dot paths with * wildcards whose values become <redacted> in response bodies; strict mode
//   replaces every string in a response body with <string:len> and every number with <number>.
// Keys, status codes, booleans, nulls and array lengths are never changed, so Claude can still plan
// schema tests from the shape.
//
// Request bodies come from the user's own input file and become the bodies the generated tests send, so
// their built-in replacements are valid stand-ins (redacted@example.com, not <email>): a test that sends
// <email> would fail for the wrong reason.

export type RedactionMode = 'standard' | 'strict';
export type RedactionConfig = { fields?: string[]; mode?: RedactionMode };
export type RedactionCounter = { replaced: number };

// Where the value is going: a response or error text gets tags, a request body gets stand-ins.
export type RedactionContext = 'response' | 'request';

const CREDENTIAL_FIELD = /(?:^|[_.\-\s])(?:auth|authorization|token|secret|key|apikey|api_key|password|passwd|pwd|credential|credentials|session|cookie|set-cookie|csrf|otp|pin)(?:$|[_.\-\s])|(?:token|secret|key|password)$/i;
const CREDENTIAL_HEADER = /auth|cookie|token|key|secret|session|csrf/i;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Three base64url parts: a JWT, or any signed token in that shape.
const JWT = /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
// Bearer <token>, Basic <base64>, and well-known key prefixes (Anthropic, OpenAI, Stripe, GitHub, Slack).
const BEARER = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g;
const KEY_PREFIX = /\b(?:sk|pk|rk|ghp|gho|ghs|xox[abps]|AKIA)[-_][A-Za-z0-9_-]{12,}\b/g;
const IBAN = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g;
const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
// At least two colons and a hex letter, a 4-digit group or a "::", so clock times such as 22:41:25 stay.
const IPV6 = /\b(?=[0-9a-fA-F:]*(?:[a-fA-F]|[0-9a-fA-F]{4}|::))(?:[0-9a-fA-F]{1,4})?(?::[0-9a-fA-F]{0,4}){2,7}\b/g;
// A card number: 13 to 19 digits, optionally in groups of 4 with spaces or dashes, that pass the Luhn
// check (so most ids, timestamps and order numbers stay).
const CARD = /\b(?:\d[ -]?){12,18}\d\b/g;
// A phone number needs a + prefix or separators between its groups: a bare run of digits is an id.
const PHONE = /(?<![\w.:/-])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-])\d{2,4}[\s.-]?\d{3,5}(?![\w:/-])/g;

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function standIn(kind: string, context: RedactionContext): string {
  if (context === 'response') return `<${kind}>`;
  switch (kind) {
    case 'email':
      return 'redacted@example.com';
    case 'phone':
      return '+10000000000';
    case 'card':
      return '4111111111111111';
    case 'iban':
      return 'GB00REDACTED00000000000000';
    case 'ip':
      return '0.0.0.0';
    default:
      return `<${kind}>`;
  }
}

// Built-in rules on one string. Order matters: JWTs and prefixed keys first (they contain digits and
// dots an email or IP rule could otherwise cut in half), then emails, then numbers.
export function redactText(text: string, counter: RedactionCounter, context: RedactionContext = 'response'): string {
  if (!text) return text;
  let out = text;
  const swap = (re: RegExp, kind: string, keep?: (m: string) => boolean) => {
    out = out.replace(re, (m: string, ...rest: unknown[]) => {
      if (keep && !keep(m)) return m;
      counter.replaced++;
      if (kind === 'bearer') return `${rest[0] as string} <token>`;
      return standIn(kind, context);
    });
  };
  swap(BEARER, 'bearer');
  swap(KEY_PREFIX, 'token');
  swap(JWT, 'token');
  // The request stand-ins are kept, so redacting twice changes nothing.
  swap(EMAIL, 'email', (m) => m !== 'redacted@example.com');
  swap(IBAN, 'iban', (m) => m !== 'GB00REDACTED00000000000000');
  swap(IPV4, 'ip', (m) => m !== '0.0.0.0');
  swap(IPV6, 'ip', (m) => (m.match(/:/g) ?? []).length >= 2);
  swap(CARD, 'card', (m) => {
    const digits = m.replace(/[ -]/g, '');
    return digits.length >= 13 && digits.length <= 19 && luhn(digits) && digits !== '4111111111111111';
  });
  swap(PHONE, 'phone', (m) => {
    const digits = m.replace(/\D/g, '').length;
    return digits >= 8 && digits <= 15 && m.trim() !== '+10000000000' && !/^\d{4}[\s.-]\d{2}[\s.-]\d{2}$/.test(m.trim());
  });
  return out;
}

// Does a dot-path pattern ("customer.name", "address.*", "*.ssn", "items.*.price") match a value path?
// * matches exactly one path segment (array indexes are segments too).
export function fieldMatches(pattern: string, path: string[]): boolean {
  const parts = pattern.split('.');
  if (parts.length !== path.length) return false;
  return parts.every((p, i) => p === '*' || p === path[i]);
}

function isCredentialField(key: string): boolean {
  return CREDENTIAL_FIELD.test(key);
}

// Redacts a JSON value (parsed body). Keys, booleans and nulls are kept; strings get the built-in rules
// and the field rules; numbers are kept in standard mode and become <number> in strict mode.
export function redactValue(value: unknown, config: RedactionConfig | undefined, counter: RedactionCounter, context: RedactionContext = 'response', path: string[] = []): unknown {
  const fields = config?.fields ?? [];
  const strict = context === 'response' && config?.mode === 'strict';
  const key = path[path.length - 1];
  const listed = fields.some((f) => fieldMatches(f, path));

  if (Array.isArray(value)) return value.map((v, i) => redactValue(v, config, counter, context, [...path, String(i)]));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactValue(v, config, counter, context, [...path, k])]));
  }
  if (listed && value !== null && value !== undefined && typeof value !== 'boolean') {
    counter.replaced++;
    return '<redacted>';
  }
  if (typeof value === 'string') {
    if (key !== undefined && isCredentialField(key) && value !== '') {
      counter.replaced++;
      return '<token>';
    }
    if (strict) {
      counter.replaced++;
      return `<string:${value.length}>`;
    }
    return redactText(value, counter, context);
  }
  if (typeof value === 'number' && strict) {
    counter.replaced++;
    return '<number>';
  }
  return value;
}

// Header values: credential-looking names are replaced whole; the rest get the built-in rules.
export function redactHeaders(headers: Record<string, string> | null | undefined, counter: RedactionCounter): Record<string, string> | null | undefined {
  if (!headers) return headers;
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) => {
      if (CREDENTIAL_HEADER.test(k)) {
        counter.replaced++;
        return [k, '<redacted>'];
      }
      return [k, redactText(v, counter)];
    }),
  );
}

export function describeRedaction(config: RedactionConfig | undefined, counter: RedactionCounter): string {
  const mode = config?.mode === 'strict' ? 'strict' : 'standard';
  const fields = config?.fields?.length ? `, ${config.fields.length} listed field(s)` : '';
  return `redaction: ${mode}${fields}, ${counter.replaced} value(s) replaced`;
}
