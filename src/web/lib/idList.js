// A list of platform ids from a form or JSON body: strings shaped like a snowflake only
// (`/^\d{17,20}$/.test(["123…"])` would let a nested array through), de-duplicated and capped
// so a request cannot store an unbounded list.

/** @returns {string[]} */
export function idList(value, max = 100) {
  const out = [];
  for (const v of [].concat(value ?? [])) {
    if (typeof v !== 'string' || !/^\d{17,20}$/.test(v) || out.includes(v)) continue;
    out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

/** Reaction-role messages per server, and roles per message (Discord's own button/select cap). */
export const MAX_REACTION_MESSAGES = 50;
export const MAX_REACTION_PAIRS = 25;
