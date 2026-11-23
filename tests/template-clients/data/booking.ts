// Written by API Test Agent from the API definition (the input file), not by the model.

// Sample request bodies for the "booking" resource. Each function returns a new object, so a test
// can change or remove a field without affecting another test:
//   { ...createBookingBody(), someField: 'another value' }

// create-booking: the sample body for POST /booking.
export function createBookingBody() {
  return {
    firstname: 'Jim',
    lastname: 'Brown',
    totalprice: 111,
    depositpaid: true,
    bookingdates: {
      checkin: '2026-11-01',
      checkout: '2026-11-05',
    },
    additionalneeds: 'Breakfast',
  };
}
export type CreateBookingBody = ReturnType<typeof createBookingBody>;

// update-booking: the sample body for PUT /booking/{id}.
export function updateBookingBody() {
  return {
    firstname: 'Sara',
    lastname: 'Khan',
    totalprice: 250,
    depositpaid: false,
    bookingdates: {
      checkin: '2026-12-10',
      checkout: '2026-12-14',
    },
    additionalneeds: 'Late checkout',
  };
}
export type UpdateBookingBody = ReturnType<typeof updateBookingBody>;
