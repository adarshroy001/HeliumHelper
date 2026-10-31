import { luaScript } from '../../../infrastructure/redis/index.js';

/**
 * Applies one delivery's status to its campaign's live counters, once (design.md#ranks-and-counters). The rank of
 * every delivery is kept in a hash; a status counts only when it moves the delivery up. Reaching `read` also
 * counts `delivered` when Meta skipped it. `failed` counts while below `delivered`; `skipped` only from pending.
 *
 * KEYS: ranks, counters. ARGV: deliveryId, status. Returns { applied (0/1), previous rank }.
 */
export const transition = luaScript<[number, number]>({
  name: 'transition',
  keys: 2,
  lua: `
local RANK = { accepted = 1, sent = 2, delivered = 3, read = 4 }
local NAME = { 'accepted', 'sent', 'delivered', 'read' }
local cur = tonumber(redis.call('HGET', KEYS[1], ARGV[1]) or '0')
local status = ARGV[2]
if cur < 0 then return {0, cur} end
if status == 'failed' then
  if cur >= 3 then return {0, cur} end
  redis.call('HSET', KEYS[1], ARGV[1], -1)
  redis.call('HINCRBY', KEYS[2], 'failed', 1)
  return {1, cur}
end
if status == 'skipped' then
  if cur ~= 0 then return {0, cur} end
  redis.call('HSET', KEYS[1], ARGV[1], -2)
  redis.call('HINCRBY', KEYS[2], 'skipped', 1)
  return {1, cur}
end
local new = RANK[status]
if new == nil or new <= cur then return {0, cur} end
redis.call('HSET', KEYS[1], ARGV[1], new)
for r = cur + 1, new do redis.call('HINCRBY', KEYS[2], NAME[r], 1) end
return {1, cur}
`,
});
