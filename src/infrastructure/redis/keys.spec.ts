import { describe, expect, it } from 'vitest';
import { redisKey } from './keys.js';

describe('redisKey', () => {
  it('builds domain:purpose:{id}, with the id as the hash tag', () => {
    expect(redisKey('messaging', 'claim', 'c123')).toBe('messaging:claim:{c123}');
    expect(redisKey('rate-limit', 'internal', 'helium-admin:u1')).toBe(
      'rate-limit:internal:{helium-admin:u1}',
    );
  });

  it.each([
    ['Messaging', 'claim', 'c1'],
    ['messaging', 'a:b', 'c1'],
    ['messaging', 'claim', ''],
    ['messaging', 'claim', 'c{1}'],
  ])('rejects %s / %s / %s', (domain, purpose, id) => {
    expect(() => redisKey(domain, purpose, id)).toThrow();
  });
});
