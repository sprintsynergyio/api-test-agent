// Written by API Test Agent from the API definition (the input file), not by the model.
import type { APIRequestContext, APIResponse } from '@playwright/test';

// Per-call options, merged over the endpoint's defaults.
export type CallOptions = {
  // Query parameters. A key set to undefined removes that default parameter from the request.
  params?: Record<string, string | number | boolean | undefined>;
  // Extra headers. The auth header never goes here: it comes from the request context.
  headers?: Record<string, string>;
};

type Defaults = { params?: Record<string, string | number | boolean>; headers?: Record<string, string> };

// Every client class extends this. `api` is the request context the test passes in: ctx.api (the
// default role), ctx.noAuthApi (no auth) or ctx.as('<role>'). The client never creates a context of its
// own, so every request keeps the safety guard, the evidence and the cleanup of the ctx fixture.
export class BaseClient {
  constructor(protected readonly api: APIRequestContext) {}

  protected send(method: string, path: string, defaults: Defaults, body: unknown, options: CallOptions = {}): Promise<APIResponse> {
    const params: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries({ ...defaults.params, ...options.params })) {
      if (value !== undefined) params[key] = value;
    }
    const headers = { ...defaults.headers, ...options.headers };
    return this.api.fetch(path, {
      method,
      ...(body !== undefined ? { data: body } : {}),
      ...(Object.keys(params).length ? { params } : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
    });
  }
}

// A path value as one URL segment.
export function segment(value: string | number): string {
  return encodeURIComponent(String(value));
}
