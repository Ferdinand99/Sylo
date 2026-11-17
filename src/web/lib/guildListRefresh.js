// Brings a signed-in person's list of servers they run up to date with servers the bot has joined since
// they signed in. The list comes from the platform at sign-in and then follows the bot's own events;
// a new server is on nobody's list until this adds it. Rights are read through the bot (owner, cached
// member, one member fetch), never through the person's OAuth token, which Sylo does not keep.
import { allGuildKeys, guildByKey } from '../../platform/platformOf.js';
import { splitPlatformGuildId } from '../../lib/platformId.js';
import { setIdentityGuildAdmin } from '../../db/accounts.js';
import { guildJoinedAt, lastGuildJoin } from '../../bot/lib/guildJoins.js';
import { log } from '../../lib/log.js';
import { refreshStaleMember } from '../middleware/access.js';

/** Most member lookups one refresh may make: each is one platform API call. */
const MAX_LOOKUPS = 25;
/** Most member lookups all refreshes together may make in a minute, however many accounts ask. */
const LOOKUPS_PER_MINUTE = 100;

let budget = { left: LOOKUPS_PER_MINUTE, resetAt: 0, size: LOOKUPS_PER_MINUTE };

/** Take one lookup from the instance-wide budget; false when this minute's lookups are used up. */
function takeLookup(now = Date.now()) {
  if (now >= budget.resetAt) budget = { ...budget, left: budget.size, resetAt: now + 60_000 };
  if (budget.left <= 0) return false;
  budget.left -= 1;
  return true;
}

/** @type {Map<string, number>} "platform:userId" -> when the automatic check last ran for that identity */
const checkedAt = new Map();
/** @type {Map<string, Promise<number>>} */
const running = new Map();

const idKey = (identity) => `${identity.platform}:${identity.platformUserId}`;
const platformOfKey = (key) => splitPlatformGuildId(key)?.platform ?? 'discord';

/**
 * Add the servers this identity runs but has not listed. `check(key, userId)` is the live rights check
 * (serverRightsLive in auth.js: `{ right }` or null). Owners are found for free; anyone else costs a
 * lookup, made only for servers the bot joined after `since`: the newest first, at most MAX_LOOKUPS of
 * them, and only while the instance-wide budget lasts.
 * @returns {Promise<number>} how many servers were added
 */
export async function addJoinedGuilds(identity, check, { since = identity.guildsFetchedAt } = {}) {
  const listed = new Set(identity.guildIds);
  const owned = [];
  const others = [];
  for (const key of allGuildKeys()) {
    if (listed.has(key) || platformOfKey(key) !== identity.platform) continue;
    const guild = guildByKey(key);
    if (!guild) continue;
    if (guild.ownerId === identity.platformUserId) owned.push(key);
    else {
      const joined = guildJoinedAt(key, guild);
      if (joined > since) others.push({ key, joined });
    }
  }
  // The newest joins first: the cap must never leave out the server that was just added.
  others.sort((a, b) => b.joined - a.joined);
  let added = 0;
  const add = async (key) => {
    if (await setIdentityGuildAdmin(identity.platform, identity.platformUserId, key, true)) added += 1;
  };
  for (const key of owned) {
    if ((await check(key, identity.platformUserId).catch(() => null))?.right) await add(key);
  }
  for (const { key } of others.slice(0, MAX_LOOKUPS)) {
    if (!takeLookup()) break;
    // Without the members intent a cached member can be out of date: look it up fresh, like every live access check.
    await refreshStaleMember(key, identity.platformUserId, { write: true }).catch(() => {});
    if ((await check(key, identity.platformUserId).catch(() => null))?.right) await add(key);
  }
  return added;
}

/**
 * The automatic refresh, run for the account on each request: an identity is looked at once after the
 * bot joins a server on its platform, and not again until the next join. Costs one map lookup per
 * identity otherwise.
 * @returns {Promise<{ changed: boolean, looked: Set<string> }>} whether any list changed (the caller then
 *   reads the identities again), and the identities that were looked at (the manual refresh skips them)
 */
export async function refreshAfterJoins(account, check, now = Date.now()) {
  let changed = false;
  const looked = new Set();
  for (const identity of account?.identities ?? []) {
    const key = idKey(identity);
    if (lastGuildJoin(identity.platform) <= (checkedAt.get(key) ?? 0)) continue;
    let work = running.get(key);
    if (!work) {
      // Only servers joined since the last look (or since sign-in): the earlier ones were checked already.
      const since = checkedAt.get(key) ?? identity.guildsFetchedAt;
      checkedAt.set(key, now);
      work = addJoinedGuilds(identity, check, { since })
        .catch((err) => {
          log.warn('auth', `could not refresh the server list of ${key}: ${err.message}`);
          return 0;
        })
        .finally(() => running.delete(key));
      running.set(key, work);
    }
    looked.add(key);
    if ((await work) > 0) changed = true;
  }
  return { changed, looked };
}

/**
 * The "Refresh server list" action: every identity of this account, now, whatever the join times say.
 * Only the account's own identities are touched. An identity the automatic check already looked at in this
 * same request (`account.guildListLooked`) is left alone: that look was as thorough.
 * @returns {Promise<number>} servers added
 */
export async function refreshAccountGuilds(account, check, now = Date.now()) {
  let added = 0;
  for (const identity of account?.identities ?? []) {
    const key = idKey(identity);
    if (account.guildListLooked?.has(key)) continue;
    const inFlight = running.get(key);
    if (inFlight) {
      added += await inFlight;
      continue;
    }
    checkedAt.set(key, now);
    added += await addJoinedGuilds(identity, check);
  }
  return added;
}

/** For tests: forget everything; `lookups` sets this minute's instance-wide lookup budget. */
export function resetGuildListRefresh({ lookups = LOOKUPS_PER_MINUTE } = {}) {
  checkedAt.clear();
  running.clear();
  budget = { left: lookups, resetAt: 0, size: lookups };
}
