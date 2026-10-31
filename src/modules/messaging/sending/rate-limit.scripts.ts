import { luaScript } from '../../../infrastructure/redis/index.js';

/**
 * Shared rate limit per phone number (design.md#rate-limits): a token bucket holding one second of the current
 * rate, refilled continuously. Campaign sends (priority 2) only take tokens while `reserve` of the bucket stays
 * free, for direct sends and auto-replies. While the number is paused (after a 130429) nothing is granted.
 *
 * KEYS: bucket, rate, pause. ARGV: want, priority, reserve fraction, now (ms), max rate.
 * Returns { granted, waitMs }: how long to wait before asking again when nothing was granted.
 */
export const takeTokens = luaScript<[number, number]>({
  name: 'takeTokens',
  keys: 3,
  lua: `
local pauseLeft = redis.call('PTTL', KEYS[3])
if pauseLeft > 0 then return {0, pauseLeft} end
local want, priority, reserve = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
local now, maxRate = tonumber(ARGV[4]), tonumber(ARGV[5])
local rate = tonumber(redis.call('HGET', KEYS[2], 'rate') or maxRate)
if rate > maxRate then rate = maxRate end
local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1]) or rate
local ts = tonumber(state[2]) or now
tokens = math.min(rate, tokens + math.max(0, now - ts) / 1000 * rate)
local floor = 0
if priority >= 2 then floor = rate * reserve end
local granted = math.max(0, math.min(want, math.floor(tokens - floor)))
tokens = tokens - granted
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', KEYS[1], 60000)
if granted > 0 then return {granted, 0} end
local missing = floor + 1 - tokens
return {0, math.max(5, math.ceil(missing / rate * 1000))}
`,
});

/**
 * Meta said the number is over its rate (130429), or is being upgraded (131057): slow down and pause.
 * KEYS: rate, pause. ARGV: factor, floor rate, pause (ms), now (ms), max rate. Returns the new rate.
 */
export const onRateLimited = luaScript<number>({
  name: 'onRateLimited',
  keys: 2,
  lua: `
local factor, floor, pauseMs = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
local now, maxRate = tonumber(ARGV[4]), tonumber(ARGV[5])
local rate = tonumber(redis.call('HGET', KEYS[1], 'rate') or maxRate)
rate = math.max(floor, math.min(maxRate, rate) * factor)
redis.call('HSET', KEYS[1], 'rate', tostring(rate), 'last429', tostring(now))
if pauseMs > 0 then redis.call('SET', KEYS[2], '1', 'PX', pauseMs) end
return math.floor(rate)
`,
});

/**
 * After a quiet spell without rate limits, raise the rate a step, up to the maximum.
 * KEYS: rate. ARGV: step, max rate, quiet (ms), now (ms). Returns the rate.
 */
export const maybeRaiseRate = luaScript<number>({
  name: 'maybeRaiseRate',
  keys: 1,
  lua: `
local step, maxRate, quiet, now = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4])
local state = redis.call('HMGET', KEYS[1], 'rate', 'last429', 'lastUp')
local rate = tonumber(state[1])
if rate == nil or rate >= maxRate then
  if rate ~= nil then redis.call('HSET', KEYS[1], 'rate', tostring(maxRate)) end
  return maxRate
end
local last429, lastUp = tonumber(state[2]) or 0, tonumber(state[3]) or 0
if now - last429 >= quiet and now - lastUp >= quiet then
  rate = math.min(maxRate, rate * step)
  redis.call('HSET', KEYS[1], 'rate', tostring(rate), 'lastUp', tostring(now))
end
return math.floor(rate)
`,
});
