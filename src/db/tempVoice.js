// Bookkeeping for temporary "join to create" voice channels.
import { db } from './index.js';

const stmts = {
  add: db.prepare(`
    INSERT INTO temp_voice_channels (channel_id, guild_id, hub_id, owner_id, created_at)
    VALUES (@channelId, @guildId, @hubId, @ownerId, @createdAt)
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
};

export function addTempChannel({ channelId, guildId, hubId, ownerId }) {
  stmts.add.run({ channelId, guildId, hubId, ownerId, createdAt: Date.now() });
}
export function removeTempChannel(channelId) {
  stmts.remove.run(channelId);
}
export function getTempChannel(channelId) {
  return stmts.get.get(channelId) ?? null;
}
export function isTempChannel(channelId) {
  return Boolean(stmts.get.get(channelId));
}
export function listGuildTempChannels(guildId) {
  return stmts.byGuild.all(guildId);
}
export function findUserHubChannel(guildId, hubId, ownerId) {
  return stmts.byOwnerHub.get(guildId, hubId, ownerId) ?? null;
}
export function countHubChannels(hubId) {
  return stmts.countHub.get(hubId).n;
}
export function listAllTempChannels() {
  return stmts.all.all();
}
export function clearGuildTempVoice(guildId) {
  stmts.clearGuild.run(guildId);
}
