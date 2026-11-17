// Brings a signed-in person's list of servers they run up to date with servers the bot has joined since
// they signed in. The list comes from the platform at sign-in and then follows the bot's own events;
// a new server is on nobody's list until this adds it. Rights are read through the bot (owner, cached
// member, one member fetch), never through the person's OAuth token, which Sylo does not keep.
import { allGuildKeys, guildByKey } from '../../platform/platformOf.js';
import { splitPlatformGuildId } from '../../lib/platformId.js';
import { setIdentityGuildAdmin } from '../../db/accounts.js';
import { guildJoinedAt, lastGuildJoin } from '../../bot/lib/guildJoins.js';
import { log } from '../../lib/log.js';

/** Most member lookups one refresh may make: each is one platform API call. */
const MAX_LOOKUPS = 25;

/** @type {Map<string, number>} "platform:userId" -> when the automatic check last ran for that identity */
const checkedAt = new Map();
/** @type {Map<string, Promise<number>>} */
const running = new Map();

const idKey = (identity) => `${identity.platform}:${identity.platformUserId}`;
const platformOfKey = (key) => splitPlatformGuildId(key)?.platform ?? 'discord';

/**
 * Add the servers this identity runs but has not listed. `check(key, userId)` is the live rights check
 * (serverRightsLive in auth.js: `{ right }` or null). Owners are found for free; anyone else costs a
 * lookup, made only for servers the bot joined after `since`, and at most MAX_LOOKUPS of them.
 * @returns {Promise<number>} how many servers were added
 */
export async function addJoinedGuilds(identity, check, { since = identity.guildsFetchedAt } = {}) {
  const listed = new Set(identity.guildIds);
  let lookups = 0;
  let added = 0;
  for (const key of allGuildKeys()) {
    if (listed.has(key) || platformOfKey(key) !== identity.platform) continue;
    const guild = guildByKey(key);
    if (!guild) continue;
    const owner = guild.ownerId === identity.platformUserId;
    if (!owner && (guildJoinedAt(key, guild) <= since || lookups >= MAX_LOOKUPS)) continue;
    if (!owner) lookups += 1;
    const live = await check(key, identity.platformUserId).catch(() => null);
    if (live?.right && (await setIdentityGuildAdmin(identity.platform, identity.platformUserId, key, true))) {
      added += 1;
    }
  }
  return added;
}

/**
 * The automatic refresh, run for the account on each request: an identity is looked at once after the
 * bot joins a server on its platform, and not again until the next join. Costs one map lookup per
 * identity otherwise.
 * @returns {Promise<boolean>} whether any list changed (the caller then reads the identities again)
 */
export async function refreshAfterJoins(account, check, now = Date.now()) {
  let changed = false;
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
    if ((await work) > 0) changed = true;
  }
  return changed;
}

/**
 * The "Refresh server list" action: every identity of this account, now, whatever the join times say.
 * Only the account's own identities are touched.
 * @returns {Promise<number>} servers added
 */
export async function refreshAccountGuilds(account, check, now = Date.now()) {
  let added = 0;
  for (const identity of account?.identities ?? []) {
    checkedAt.set(idKey(identity), now);
    added += await addJoinedGuilds(identity, check);
  }
  return added;
}

/** For tests. */
export function resetGuildListRefresh() {
  checkedAt.clear();
  running.clear();
}
