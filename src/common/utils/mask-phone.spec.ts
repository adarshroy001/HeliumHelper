import { describe, expect, it } from 'vitest';
import { maskPhone } from './mask-phone.js';

describe('maskPhone', () => {
  it.each([
    ['+919876543210', '+91******3210'],
    ['+91 98765 43210', '+91******3210'],
    ['+14155552671', '+1******2671'],
    ['9876543210', '******3210'],
    ['919876543210', '********3210'],
    ['98-7654-3210', '******3210'],
  ])('masks %s as %s', (input, expected) => {
    expect(maskPhone(input)).toBe(expected);
  });

  it.each([[''], [null], [undefined], ['12345'], ['+91 123']])('returns **** for %s', (input) => {
    expect(maskPhone(input)).toBe('****');
  });

  it('never returns more than the last 4 digits of the number', () => {
    const masked = maskPhone('+919876543210');
    expect(masked.replace(/\D/g, '')).toBe('913210');
  });
});
