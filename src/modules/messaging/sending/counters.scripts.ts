import { luaScript } from '../../../infrastructure/redis/index.js';

/**
 * Applies one delivery's status to its campaign's live counters, once (design.md#ranks-and-counters). The rank of
 * every delivery is kept in a hash; a status counts only when it moves the delivery up. Reaching `read` also
 * counts `delivered` when Meta skipped it. `failed` counts while below `delivered`; `skipped` only from pending. `resolved` counts each delivery once, when it
 * first gets any result: a campaign is done when `resolved` reaches its total.
 *
 * Final ranks: -1 failed with `accepted` not counted, -3 failed after it was, -2 skipped. A positive status on -1
 * (the sender's batch recorded `accepted` after a fast `failed` webhook) counts `accepted` once and moves it to -3.
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
if cur == -1 and RANK[status] ~= nil then
  -- Failed before its acceptance was recorded (a webhook beat the sender's batch): Meta did accept it.
  redis.call('HSET', KEYS[1], ARGV[1], -3)
  redis.call('HINCRBY', KEYS[2], 'accepted', 1)
  return {0, cur}
end
if cur < 0 then return {0, cur} end
if status == 'failed' then
  if cur >= 3 then return {0, cur} end
  redis.call('HSET', KEYS[1], ARGV[1], cur == 0 and -1 or -3)
  redis.call('HINCRBY', KEYS[2], 'failed', 1)
  if cur == 0 then redis.call('HINCRBY', KEYS[2], 'resolved', 1) end
  return {1, cur}
end
if status == 'skipped' then
  if cur ~= 0 then return {0, cur} end
  redis.call('HSET', KEYS[1], ARGV[1], -2)
  redis.call('HINCRBY', KEYS[2], 'skipped', 1)
  redis.call('HINCRBY', KEYS[2], 'resolved', 1)
  return {1, cur}
end
local new = RANK[status]
if new == nil or new <= cur then return {0, cur} end
redis.call('HSET', KEYS[1], ARGV[1], new)
if cur == 0 then redis.call('HINCRBY', KEYS[2], 'resolved', 1) end
for r = cur + 1, new do redis.call('HINCRBY', KEYS[2], NAME[r], 1) end
return {1, cur}
`,
});

/**
 * Counts a billable message once per delivery, whichever of its statuses brings the pricing and in whatever
 * order they arrive. KEYS: billed (deliveryId → category), counters. ARGV: deliveryId, category.
 * Returns 1 if counted now.
 */
export const countBillable = luaScript<number>({
  name: 'countBillable',
  keys: 2,
  lua: `
if redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[2]) == 0 then return 0 end
redis.call('HINCRBY', KEYS[2], 'billable:' .. ARGV[2], 1)
return 1
`,
});
