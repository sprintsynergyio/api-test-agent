import { ctx, expect, recordStatus } from '../setup/ctx';

// The Pactum template the generator copies. Same four tagged tests as tests/template/update-booking.spec.ts,
// written against the local shop API (input/local-shop.json, update-product) so it runs anywhere.

const validBody = { name: 'Trail Runner Shoe V2', price: 99.5, category: 'shoes', inStock: false };

describe('update-product PUT /products/{id}', () => {
  it('[happy] update-product updates a product and returns the sent values', async () => {
    const id = await ctx.createResource('create-product');

    const response = await ctx.api.put(`/products/${id}`, validBody);

    recordStatus(response.status());
    expect(response.status()).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.name).toBe(validBody.name);
    expect(body.price).toBe(validBody.price);
    expect(body.category).toBe(validBody.category);
    expect(body.inStock).toBe(validBody.inStock);
  });

  it('[schema] update-product response has every required field with the correct type', async () => {
    const id = await ctx.createResource('create-product');

    const response = await ctx.api.put(`/products/${id}`, validBody);

    recordStatus(response.status());
    expect(response.status()).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(typeof body.id).toBe('number');
    expect(typeof body.name).toBe('string');
    expect(typeof body.price).toBe('number');
    expect(typeof body.category).toBe('string');
    expect(typeof body.inStock).toBe('boolean');
  });

  it('[invalid-input] update-product rejects a body with a wrong-typed price', async () => {
    const id = await ctx.createResource('create-product');

    const response = await ctx.api.put(`/products/${id}`, { name: 'Trail Runner Shoe V2', price: 'ninety nine' });

    recordStatus(response.status());
    expect(response.status()).toBeGreaterThanOrEqual(400);
    expect(response.status()).toBeLessThanOrEqual(499);
  });

  it('[auth] update-product rejects a request without auth', async () => {
    const id = await ctx.createResource('create-product');

    const response = await ctx.noAuthApi.put(`/products/${id}`, validBody);

    recordStatus(response.status());
    expect([401, 403]).toContain(response.status());
  });
});
