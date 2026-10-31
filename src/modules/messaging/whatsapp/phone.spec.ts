import { describe, expect, it } from 'vitest';
import { normalizePhone, parsePhoneList, phoneLookupVariants } from './phone.js';

describe('normalizePhone', () => {
  it.each([
    ['9876543210', '919876543210'],
    ['09876543210', '919876543210'],
    ['919876543210', '919876543210'],
    ['+91 98765-43210', '919876543210'],
    ['0919876543210', '919876543210'],
    ['(+91) 6000 000 000', '916000000000'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizePhone(raw)).toBe(expected);
  });

  it.each([
    ['5876543210', 'a 10-digit number not starting 6–9'],
    ['98765432', 'too short'],
    ['449876543210', 'another country code'],
    ['', 'empty'],
    ['phone', 'no digits'],
  ])('rejects %s (%s)', (raw) => {
    expect(normalizePhone(raw)).toBeNull();
  });

  it('rejects null and undefined', () => {
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
  });
});

describe('phoneLookupVariants', () => {
  it('lists the stored forms of a number', () => {
    expect(phoneLookupVariants('919876543210')).toEqual([
      '919876543210',
      '9876543210',
      '+919876543210',
      '09876543210',
    ]);
  });
});

describe('parsePhoneList', () => {
  it('splits, normalizes and de-duplicates, skipping a header and keeping invalid tokens apart', () => {
    expect(parsePhoneList('phone\n9876543210, +91 9876543210;6000000000\nabc|12345')).toEqual({
      phones: ['919876543210', '916000000000'],
      invalid: ['+91', 'abc', '12345'],
    });
  });
});
