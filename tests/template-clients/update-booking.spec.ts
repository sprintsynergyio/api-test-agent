import { test, expect } from '../fixtures/ctx';
import { BookingClient } from './clients/booking';
import { updateBookingBody } from './data/booking';

function recordStatus(status: number) {
  test.info().annotations.push({ type: 'actual-status', description: String(status) });
}

test.describe('update-booking PUT /booking/{id}', () => {
  test('[happy] update-booking updates a booking and returns the sent values', async ({ ctx }) => {
    const id = await ctx.createResource('create-booking');
    const sent = updateBookingBody();

    const response = await new BookingClient(ctx.api).updateBooking(id, sent);

    recordStatus(response.status());
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.firstname).toBe(sent.firstname);
    expect(body.lastname).toBe(sent.lastname);
    expect(body.totalprice).toBe(sent.totalprice);
    expect(body.depositpaid).toBe(sent.depositpaid);
    expect(body.bookingdates.checkin).toBe(sent.bookingdates.checkin);
    expect(body.bookingdates.checkout).toBe(sent.bookingdates.checkout);
    expect(body.additionalneeds).toBe(sent.additionalneeds);
  });

  test('[schema] update-booking response has every required field with the correct type', async ({ ctx }) => {
    const id = await ctx.createResource('create-booking');

    const response = await new BookingClient(ctx.api).updateBooking(id, updateBookingBody());

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
    // Start from the sample body and change only what the case needs.
    const invalid: Record<string, unknown> = { ...updateBookingBody(), totalprice: 'two hundred fifty' };
    delete invalid.lastname;

    const response = await new BookingClient(ctx.api).updateBooking(id, invalid);

    recordStatus(response.status());
    expect(response.status()).toBeGreaterThanOrEqual(400);
    expect(response.status()).toBeLessThanOrEqual(499);
  });

  test('[auth] update-booking rejects a request without auth', async ({ ctx }) => {
    const id = await ctx.createResource('create-booking');

    const response = await new BookingClient(ctx.noAuthApi).updateBooking(id, updateBookingBody());

    recordStatus(response.status());
    expect([401, 403]).toContain(response.status());
  });
});
