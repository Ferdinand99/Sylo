// Giveaways storage: a row per giveaway, a row per entrant. Ended giveaways are
// kept (so /giveaway reroll and the dashboard history work) until the guild is
// purged.
import { db } from './index.js';

const s = {
  create: db.prepare(`
    INSERT INTO giveaways (guild_id, channel_id, prize, winners, host_id, required_role_id, ends_at, created_at)
    VALUES (@guildId, @channelId, @prize, @winners, @hostId, @requiredRoleId, @endsAt, @createdAt)
  `),
  setMessage: db.prepare('UPDATE giveaways SET message_id = ? WHERE id = ?'),
  get: db.prepare('SELECT * FROM giveaways WHERE id = ?'),
  getInGuild: db.prepare('SELECT * FROM giveaways WHERE id = ? AND guild_id = ?'),
  byMessage: db.prepare('SELECT * FROM giveaways WHERE message_id = ?'),
  active: db.prepare('SELECT * FROM giveaways WHERE guild_id = ? AND ended = 0 ORDER BY ends_at ASC'),
  recentEnded: db.prepare('SELECT * FROM giveaways WHERE guild_id = ? AND ended = 1 ORDER BY ends_at DESC LIMIT ?'),
  due: db.prepare('SELECT * FROM giveaways WHERE ended = 0 AND ends_at <= ?'),
  markEnded: db.prepare('UPDATE giveaways SET ended = 1, won_ids = ? WHERE id = ?'),
  setWinners: db.prepare('UPDATE giveaways SET won_ids = ? WHERE id = ?'),
  delGuild: db.prepare('DELETE FROM giveaways WHERE guild_id = ?'),

  addEntry: db.prepare('INSERT OR IGNORE INTO giveaway_entries (giveaway_id, user_id, entered_at) VALUES (?, ?, ?)'),
  removeEntry: db.prepare('DELETE FROM giveaway_entries WHERE giveaway_id = ? AND user_id = ?'),
  hasEntry: db.prepare('SELECT 1 FROM giveaway_entries WHERE giveaway_id = ? AND user_id = ?'),
  countEntries: db.prepare('SELECT COUNT(*) AS n FROM giveaway_entries WHERE giveaway_id = ?'),
  entryIds: db.prepare('SELECT user_id FROM giveaway_entries WHERE giveaway_id = ?'),
  delGuildEntries: db.prepare(
    'DELETE FROM giveaway_entries WHERE giveaway_id IN (SELECT id FROM giveaways WHERE guild_id = ?)'
  ),
};

const hydrate = (row) => {
  if (!row) return null;
  let won = [];
  try {
    won = JSON.parse(row.won_ids);
  } catch {
    won = [];
  }
  return { ...row, ended: row.ended === 1, wonIds: Array.isArray(won) ? won : [] };
};

/** @returns {{ id: number }} */
export function createGiveaway(g) {
  const info = s.create.run({
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

export const setGiveawayMessage = (id, messageId) => s.setMessage.run(messageId, id);
export const getGiveaway = (id) => hydrate(s.get.get(id));
export const getGiveawayInGuild = (id, guildId) => hydrate(s.getInGuild.get(id, guildId));
export const getGiveawayByMessage = (messageId) => hydrate(s.byMessage.get(messageId));
export const activeGiveaways = (guildId) => s.active.all(guildId).map(hydrate);
export const endedGiveaways = (guildId, limit = 10) => s.recentEnded.all(guildId, limit).map(hydrate);
export const dueGiveaways = (now) => s.due.all(now).map(hydrate);
export const markGiveawayEnded = (id, wonIds) => s.markEnded.run(JSON.stringify(wonIds ?? []), id);
export const setGiveawayWinners = (id, wonIds) => s.setWinners.run(JSON.stringify(wonIds ?? []), id);

export const addGiveawayEntry = (id, userId) => s.addEntry.run(id, userId, Date.now());
export const removeGiveawayEntry = (id, userId) => s.removeEntry.run(id, userId);
export const hasGiveawayEntry = (id, userId) => Boolean(s.hasEntry.get(id, userId));
export const giveawayEntryCount = (id) => s.countEntries.get(id)?.n ?? 0;
export const giveawayEntrantIds = (id) => s.entryIds.all(id).map((r) => r.user_id);

export function clearGuildGiveaways(guildId) {
  s.delGuildEntries.run(guildId);
  s.delGuild.run(guildId);
}
