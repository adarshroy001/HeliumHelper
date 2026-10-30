const PART = /^[a-z][a-z\d-]*$/;

/**
 * A Redis key in the project format, `domain:purpose:{id}` (ADR-0007), such as `messaging:claim:{c123}`.
 * The id in braces is the hash tag: every key built for one id lands in the same cluster slot, so a Lua script
 * can use several of them together, today and after a move to cluster mode.
 */
export function redisKey(domain: string, purpose: string, id: string): string {
  if (!PART.test(domain) || !PART.test(purpose)) {
    throw new Error(`Redis key parts must be lower-case words: "${domain}", "${purpose}"`);
  }
  if (id === '' || /[{}]/.test(id)) {
    throw new Error(`Redis key id must be non-empty, without braces: "${id}"`);
  }
  return `${domain}:${purpose}:{${id}}`;
}
