// Bookkeeping for temporary "join to create" voice channels, including the
// runtime state the /voice-* commands manage (owner, lock, hide, bans, name).
import { db } from './index.js';

const stmts = {
  add: db.prepare(`
    INSERT INTO temp_voice_channels (channel_id, guild_id, hub_id, owner_id, name, text_channel_id, created_at)
    VALUES (@channelId, @guildId, @hubId, @ownerId, @name, @textChannelId, @createdAt)
    ON CONFLICT (channel_id) DO NOTHING
  `),
  remove: db.prepare('DELETE FROM temp_voice_channels WHERE channel_id = ?'),
  get: db.prepare('SELECT * FROM temp_voice_channels WHERE channel_id = ?'),
  byGuild: db.prepare('SELECT * FROM temp_voice_channels WHERE guild_id = ?'),
  byOwnerHub: db.prepare(
    'SELECT * FROM temp_voice_channels WHERE guild_id = ? AND hub_id = ? AND owner_id = ?'
  ),
  countHub: db.prepare('SELECT COUNT(*) AS n FROM temp_voice_channels WHERE hub_id = ?'),
  all: db.prepare('SELECT * FROM temp_voice_channels'),
  clearGuild: db.prepare('DELETE FROM temp_voice_channels WHERE guild_id = ?'),
  setOwner: db.prepare('UPDATE temp_voice_channels SET owner_id = ? WHERE channel_id = ?'),
  setName: db.prepare('UPDATE temp_voice_channels SET name = ? WHERE channel_id = ?'),
  setLocked: db.prepare('UPDATE temp_voice_channels SET locked = ? WHERE channel_id = ?'),
  setHidden: db.prepare('UPDATE temp_voice_channels SET hidden = ? WHERE channel_id = ?'),
  setBans: db.prepare('UPDATE temp_voice_channels SET bans = ? WHERE channel_id = ?'),
  setEmptySince: db.prepare('UPDATE temp_voice_channels SET empty_since = ? WHERE channel_id = ?'),
};

const hydrate = (row) => {
  if (!row) return null;
  let bans = [];
  try {
    bans = JSON.parse(row.bans || '[]');
  } catch {
    bans = [];
  }
  return { ...row, banList: Array.isArray(bans) ? bans : [] };
};

export function addTempChannel({ channelId, guildId, hubId, ownerId, name = '', textChannelId = null }) {
  stmts.add.run({ channelId, guildId, hubId, ownerId, name, textChannelId, createdAt: Date.now() });
}
export function removeTempChannel(channelId) {
  stmts.remove.run(channelId);
}
export function getTempChannel(channelId) {
  return hydrate(stmts.get.get(channelId));
}
export function isTempChannel(channelId) {
  return Boolean(stmts.get.get(channelId));
}
export function listGuildTempChannels(guildId) {
  return stmts.byGuild.all(guildId).map(hydrate);
}
export function findUserHubChannel(guildId, hubId, ownerId) {
  return hydrate(stmts.byOwnerHub.get(guildId, hubId, ownerId));
}
export function countHubChannels(hubId) {
  return stmts.countHub.get(hubId).n;
}
export function listAllTempChannels() {
  return stmts.all.all().map(hydrate);
}
export function clearGuildTempVoice(guildId) {
  stmts.clearGuild.run(guildId);
}

export function setTempOwner(channelId, ownerId) {
  stmts.setOwner.run(ownerId, channelId);
}
export function setTempName(channelId, name) {
  stmts.setName.run(String(name).slice(0, 100), channelId);
}
export function setTempLocked(channelId, locked) {
  stmts.setLocked.run(locked ? 1 : 0, channelId);
}
export function setTempHidden(channelId, hidden) {
  stmts.setHidden.run(hidden ? 1 : 0, channelId);
}
export function setTempBans(channelId, bans) {
  stmts.setBans.run(JSON.stringify([...new Set(bans)].slice(0, 200)), channelId);
}
export function setTempEmptySince(channelId, ts) {
  stmts.setEmptySince.run(ts ?? null, channelId);
}
