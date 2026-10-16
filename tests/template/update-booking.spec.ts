import { test, expect } from '../fixtures/ctx';

const validBody = {
  firstname: 'Sara',
  lastname: 'Khan',
  totalprice: 250,
  depositpaid: false,
  bookingdates: { checkin: '2026-12-10', checkout: '2026-12-14' },
  additionalneeds: 'Late checkout',
};

function recordStatus(status: number) {
  test.info().annotations.push({ type: 'actual-status', description: String(status) });
}

test.describe('update-booking PUT /booking/{id}', () => {
  test('[happy] update-booking updates a booking and returns the sent values', async ({ ctx }) => {
    const id = await ctx.createResource('create-booking');

    const response = await ctx.api.put(`/booking/${id}`, { data: validBody });

    recordStatus(response.status());
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.firstname).toBe(validBody.firstname);
    expect(body.lastname).toBe(validBody.lastname);
    expect(body.totalprice).toBe(validBody.totalprice);
    expect(body.depositpaid).toBe(validBody.depositpaid);
    expect(body.bookingdates.checkin).toBe(validBody.bookingdates.checkin);
    expect(body.bookingdates.checkout).toBe(validBody.bookingdates.checkout);
    expect(body.additionalneeds).toBe(validBody.additionalneeds);
  });

  test('[schema] update-booking response has every required field with the correct type', async ({ ctx }) => {
    const id = await ctx.createResource('create-booking');

    const response = await ctx.api.put(`/booking/${id}`, { data: validBody });

    recordStatus(response.status());
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(typeof body.firstname).toBe('string');
    expect(typeof body.lastname).toBe('string');
    expect(typeof body.totalprice).toBe('number');
    expect(typeof body.depositpaid).toBe('boolean');
    expect(typeof body.bookingdates).toBe('object');
    expect(body.bookingdates).not.toBeNull();
    expect(typeof body.bookingdates.checkin).toBe('string');
    expect(typeof body.bookingdates.checkout).toBe('string');
    expect(typeof body.additionalneeds).toBe('string');
  });

  test('[invalid-input] update-booking rejects a body with missing and wrong-typed fields', async ({ ctx }) => {
    const id = await ctx.createResource('create-booking');

    const response = await ctx.api.put(`/booking/${id}`, {
      data: { firstname: 'Sara', totalprice: 'two hundred fifty' },
    });

    recordStatus(response.status());
    expect(response.status()).toBeGreaterThanOrEqual(400);
    expect(response.status()).toBeLessThanOrEqual(499);
  });

  test('[auth] update-booking rejects a request without auth', async ({ ctx }) => {
    const id = await ctx.createResource('create-booking');

    const response = await ctx.noAuthApi.put(`/booking/${id}`, { data: validBody });

    recordStatus(response.status());
    expect([401, 403]).toContain(response.status());
  });
});
