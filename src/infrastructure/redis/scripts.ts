import type { Redis } from 'ioredis';

/** A Lua script that runs atomically in Redis. `TResult` is what it returns, as ioredis decodes it. */
export interface LuaScript<TResult> {
  readonly name: string;
  /** How many of the arguments are keys. Keys are always passed in, never built inside the script. */
  readonly keys: number;
  readonly lua: string;
  /** Type-only: carries `TResult`. */
  readonly result?: TResult;
}

/** Declares a script once, at module level, next to the code that uses it. */
export function luaScript<TResult>(script: { name: string; keys: number; lua: string }): LuaScript<TResult> {
  if (!/^[a-z][a-zA-Z\d]*$/.test(script.name)) {
    throw new Error(`Script names are camelCase: "${script.name}"`);
  }
  return script;
}

/** A command added by `defineCommand`: keys first, then arguments. */
type DefinedCommand = (...input: (string | number)[]) => Promise<unknown>;

/** Scripts already defined on each client. */
const defined = new WeakMap<Redis, Map<string, string>>();

/**
 * Runs a script with `keys` and `args`. The first run on a client defines it with `defineCommand`, so later
 * runs send only its SHA (`EVALSHA`); ioredis resends the source if Redis has forgotten it.
 */
export async function runScript<TResult>(
  redis: Redis,
  script: LuaScript<TResult>,
  keys: readonly string[],
  args: readonly (string | number)[] = [],
): Promise<TResult> {
  if (keys.length !== script.keys) {
    throw new Error(`Script ${script.name} takes ${String(script.keys)} keys, got ${String(keys.length)}`);
  }
  const command = `lua${script.name[0]?.toUpperCase() ?? ''}${script.name.slice(1)}`;

  let scripts = defined.get(redis);
  if (scripts === undefined) {
    scripts = new Map();
    defined.set(redis, scripts);
  }
  const known = scripts.get(command);
  if (known === undefined) {
    redis.defineCommand(command, { numberOfKeys: script.keys, lua: script.lua });
    scripts.set(command, script.lua);
  } else if (known !== script.lua) {
    throw new Error(`Two different scripts are named ${script.name}`);
  }

  const run = (redis as unknown as Record<string, DefinedCommand | undefined>)[command];
  if (run === undefined) throw new Error(`Script ${script.name} was not defined`);
  return (await run.call(redis, ...keys, ...args)) as TResult;
}
