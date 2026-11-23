// Written by API Test Agent from the API definition (the input file), not by the model.
import type { APIResponse } from '@playwright/test';
import { BaseClient, segment, type CallOptions } from './base';

// One method per endpoint of the "booking" resource. A path or a default query value changes here, in one place.
export class BookingClient extends BaseClient {
  // list-bookings: GET /booking
  listBookings(options?: CallOptions): Promise<APIResponse> {
    return this.send('GET', '/booking', {}, undefined, options);
  }

  // create-booking: POST /booking
  createBooking(body?: unknown, options?: CallOptions): Promise<APIResponse> {
    return this.send('POST', '/booking', {}, body, options);
  }

  // get-booking: GET /booking/{id}
  getBooking(id: string | number, options?: CallOptions): Promise<APIResponse> {
    return this.send('GET', `/booking/${segment(id)}`, {}, undefined, options);
  }

  // update-booking: PUT /booking/{id}
  updateBooking(id: string | number, body?: unknown, options?: CallOptions): Promise<APIResponse> {
    return this.send('PUT', `/booking/${segment(id)}`, {}, body, options);
  }

  // delete-booking: DELETE /booking/{id}
  deleteBooking(id: string | number, options?: CallOptions): Promise<APIResponse> {
    return this.send('DELETE', `/booking/${segment(id)}`, {}, undefined, options);
  }
}
