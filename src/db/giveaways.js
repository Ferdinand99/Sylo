// Giveaways storage: a row per giveaway, a row per entrant. Ended giveaways are
// kept (so /giveaway reroll and the dashboard history work) until the guild is
// purged.
import { prepare, registerPostgresBootstrap } from './driver.js';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS giveaways (
    id               SERIAL PRIMARY KEY,
    guild_id         TEXT NOT NULL,
    channel_id       TEXT NOT NULL,
    message_id       TEXT,
    prize            TEXT NOT NULL,
    winners          INTEGER NOT NULL DEFAULT 1,
    host_id          TEXT NOT NULL,
    required_role_id TEXT,
    ends_at          BIGINT NOT NULL,
    ended            INTEGER NOT NULL DEFAULT 0,
    won_ids          TEXT NOT NULL DEFAULT '[]',
    created_at       BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_giveaways_guild ON giveaways (guild_id, ended, ends_at);
  CREATE TABLE IF NOT EXISTS giveaway_entries (
    giveaway_id INTEGER NOT NULL,
    user_id     TEXT NOT NULL,
    entered_at  BIGINT NOT NULL,
    PRIMARY KEY (giveaway_id, user_id)
  );
`);

const s = {
  create: prepare(
    `
    INSERT INTO giveaways (guild_id, channel_id, prize, winners, host_id, required_role_id, ends_at, created_at)
    VALUES (@guildId, @channelId, @prize, @winners, @hostId, @requiredRoleId, @endsAt, @createdAt)
  `,
    { returningId: true }
  ),
  setMessage: prepare('UPDATE giveaways SET message_id = ? WHERE id = ?'),
  get: prepare('SELECT * FROM giveaways WHERE id = ?'),
  getInGuild: prepare('SELECT * FROM giveaways WHERE id = ? AND guild_id = ?'),
  byMessage: prepare('SELECT * FROM giveaways WHERE message_id = ?'),
  active: prepare('SELECT * FROM giveaways WHERE guild_id = ? AND ended = 0 ORDER BY ends_at ASC'),
  recentEnded: prepare(
    'SELECT * FROM giveaways WHERE guild_id = ? AND ended = 1 ORDER BY ends_at DESC LIMIT ?'
  ),
  due: prepare('SELECT * FROM giveaways WHERE ended = 0 AND ends_at <= ?'),
  markEnded: prepare('UPDATE giveaways SET ended = 1, won_ids = ? WHERE id = ?'),
  setWinners: prepare('UPDATE giveaways SET won_ids = ? WHERE id = ?'),
  delGuild: prepare('DELETE FROM giveaways WHERE guild_id = ?'),

  // `INSERT OR IGNORE` (SQLite-only) rewritten to the standard `ON CONFLICT
  // DO NOTHING` — SQLite has supported this syntax since 3.24, so it's the
  // same statement on both drivers (same pattern as postedKeys.js).
  addEntry: prepare(
    'INSERT INTO giveaway_entries (giveaway_id, user_id, entered_at) VALUES (?, ?, ?) ON CONFLICT (giveaway_id, user_id) DO NOTHING'
  ),
  removeEntry: prepare('DELETE FROM giveaway_entries WHERE giveaway_id = ? AND user_id = ?'),
  hasEntry: prepare('SELECT 1 FROM giveaway_entries WHERE giveaway_id = ? AND user_id = ?'),
  countEntries: prepare('SELECT COUNT(*) AS n FROM giveaway_entries WHERE giveaway_id = ?'),
  entryIds: prepare('SELECT user_id FROM giveaway_entries WHERE giveaway_id = ?'),
  delGuildEntries: prepare(
    'DELETE FROM giveaway_entries WHERE giveaway_id IN (SELECT id FROM giveaways WHERE guild_id = ?)'
  ),
};

const hydrate = (row) => {
  if (!row) return null;
  let won;
  try {
    won = JSON.parse(row.won_ids);
  } catch {
    won = [];
  }
  return { ...row, ended: row.ended === 1, wonIds: Array.isArray(won) ? won : [] };
};

/** @returns {Promise<{ id: number }>} */
export async function createGiveaway(g) {
  const info = await s.create.run({
    guildId: g.guildId,
    channelId: g.channelId,
    prize: String(g.prize).slice(0, 250),
    winners: Math.max(1, Math.trunc(g.winners || 1)),
    hostId: g.hostId,
    requiredRoleId: g.requiredRoleId || null,
    endsAt: g.endsAt,
    createdAt: g.createdAt ?? Date.now(),
  });
  return { id: Number(info.lastInsertRowid) };
}

export const setGiveawayMessage = async (id, messageId) => s.setMessage.run(messageId, id);
export const getGiveaway = async (id) => hydrate(await s.get.get(id));
export const getGiveawayInGuild = async (id, guildId) => hydrate(await s.getInGuild.get(id, guildId));
export const getGiveawayByMessage = async (messageId) => hydrate(await s.byMessage.get(messageId));
export const activeGiveaways = async (guildId) => (await s.active.all(guildId)).map(hydrate);
export const endedGiveaways = async (guildId, limit = 10) =>
  (await s.recentEnded.all(guildId, limit)).map(hydrate);
export const dueGiveaways = async (now) => (await s.due.all(now)).map(hydrate);
export const markGiveawayEnded = async (id, wonIds) => s.markEnded.run(JSON.stringify(wonIds ?? []), id);
export const setGiveawayWinners = async (id, wonIds) => s.setWinners.run(JSON.stringify(wonIds ?? []), id);

export const addGiveawayEntry = async (id, userId) => s.addEntry.run(id, userId, Date.now());
export const removeGiveawayEntry = async (id, userId) => s.removeEntry.run(id, userId);
export const hasGiveawayEntry = async (id, userId) => Boolean(await s.hasEntry.get(id, userId));
export const giveawayEntryCount = async (id) => Number((await s.countEntries.get(id))?.n) || 0;
export const giveawayEntrantIds = async (id) => (await s.entryIds.all(id)).map((r) => r.user_id);

export async function clearGuildGiveaways(guildId) {
  await s.delGuildEntries.run(guildId);
  await s.delGuild.run(guildId);
}
