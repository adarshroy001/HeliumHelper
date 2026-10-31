import { describe, expect, it } from 'vitest';
import { cartsFilter, istDay, ordersFilter, usersFilter, waitlistFilter } from './audience-filters.js';

describe('audience filters', () => {
  it('turns India days into UTC instants', () => {
    expect(istDay('2026-10-31', false).toISOString()).toBe('2026-10-30T18:30:00.000Z');
    expect(istDay('2026-10-31', true).toISOString()).toBe('2026-10-31T18:29:59.999Z');
  });

  it('filters users by registration date', () => {
    expect(usersFilter({})).toEqual({});
    expect(usersFilter({ registeredFrom: '2026-01-01' })).toEqual({
      createdAt: { $gte: istDay('2026-01-01', false) },
    });
  });

  it("maps every order filter to HeliumAdmin's fields", () => {
    expect(
      ordersFilter({
        orderDateTo: '2026-10-31',
        status: ['delivered'],
        paymentStatus: ['paid'],
        paymentMethod: ['razorpay'],
        channel: ['d2c'],
        productModel: ['H1'],
        deliveryPartner: ['delhivery'],
        minOrderValue: 5000,
      }),
    ).toEqual({
      createdAt: { $lte: istDay('2026-10-31', true) },
      status: { $in: ['delivered'] },
      'payment.status': { $in: ['paid'] },
      'payment.method': { $in: ['razorpay'] },
      channel: { $in: ['d2c'] },
      'product.model': { $in: ['H1'] },
      deliveryPartner: { $in: ['delhivery'] },
      $or: [
        { sellingPrice: { $gte: 5000 } },
        { 'product.totalPrice': { $gte: 5000 } },
        { 'payment.amount': { $gte: 5000 } },
      ],
    });
  });

  it('takes only carts that did not convert unless asked, and escapes the product search', () => {
    expect(cartsFilter({})).toEqual({
      'customer.phone': { $exists: true, $nin: [null, ''] },
      status: { $ne: 'converted' },
    });
    const filter = cartsFilter({ includeRecovered: true, productTitle: 'H1 (Pro)' });
    expect(filter).not.toHaveProperty('status');
    expect((filter['cart.title'] as RegExp).test('helium h1 (pro) purifier')).toBe(true);
  });

  it('filters the waitlist by join date and source, with a phone', () => {
    expect(waitlistFilter({ source: ['instagram'] })).toEqual({
      phone: { $exists: true, $nin: [null, ''] },
      source: { $in: ['instagram'] },
    });
  });
});
