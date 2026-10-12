// What a dashboard account is allowed to see and be, derived from the identities it
// holds (src/db/accounts.js). Pure functions over `{ id, identities }`, so the rules
// can be tested without a request.
import { config } from '../../config.js';

const PLATFORM_ORDER = ['discord', 'fluxer'];

/** Identities in the order the UI prefers them: Discord first, then Fluxer. */
function inOrder(account) {
  return [...(account?.identities ?? [])].sort(
    (a, b) => PLATFORM_ORDER.indexOf(a.platform) - PLATFORM_ORDER.indexOf(b.platform)
  );
}

/** The account's identity on a platform, or null. */
export function identityFor(account, platform) {
  return account?.identities?.find((i) => i.platform === platform) ?? null;
}

/**
 * The id other features key a person on (roadmap votes, dashboard preferences): their
 * Discord id when they have a Discord identity — so existing data keeps its key — else
 * "fluxer:<id>", which cannot collide with a Discord id.
 */
export function primaryUserId(account) {
  const primary = inOrder(account)[0];
  if (!primary) return null;
  return primary.platform === 'discord'
    ? primary.platformUserId
    : `${primary.platform}:${primary.platformUserId}`;
}

/** The name to show for the account. */
export function sessionUserLabel(account) {
  return inOrder(account)[0]?.username ?? null;
}

const OWNER_LISTS = () => ({ discord: config.ownerIds, fluxer: config.fluxerOwnerIds });

/** Is any identity the account holds on its platform's operator list? */
export function isOperator(account) {
  const lists = OWNER_LISTS();
  return (account?.identities ?? []).some((i) => lists[i.platform]?.includes(i.platformUserId));
}

/**
 * Guild keys the account administers: every identity's stored list, limited to guilds
 * the bot is actually in.
 * @param {{ identities: Array<{ guildIds: string[] }> } | null} account
 * @param {string[]} botKeys  keys of the guilds the bot is in (see allGuildKeys())
 */
export function adminKeysOf(account, botKeys) {
  const inBot = new Set(botKeys);
  const out = new Set();
  for (const identity of account?.identities ?? []) {
    for (const key of identity.guildIds) if (inBot.has(key)) out.add(key);
  }
  return out;
}

/** Identities whose stored guild list is older than `ttlMs` — due a refresh through their platform. */
export function staleIdentities(account, ttlMs, now = Date.now()) {
  return (account?.identities ?? []).filter((i) => now - i.guildsFetchedAt > ttlMs);
}
