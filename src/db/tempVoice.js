// Bookkeeping for temporary "join to create" voice channels, including the
// runtime state the /voice-* commands manage (owner, lock, hide, bans, name).
import { prepare, registerPostgresBootstrap } from './driver.js';

// Schema copied verbatim from this table's cumulative SQLite migrations in
// index.js (the CREATE TABLE plus every later ALTER TABLE). created_at and
// empty_since are millisecond timestamps, so BIGINT (SQLite's INTEGER is
// 64-bit; Postgres's plain INTEGER is only 32-bit).
//
// purge.js used to bootstrap this table itself (temp_voice_channels was one
// of GUILD_TABLES' entries with no owning file yet); that block moved here
// now that this file is converted — see docs/roadmap.md, Phase 22.
registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS temp_voice_channels (
    channel_id      TEXT PRIMARY KEY,
    guild_id        TEXT NOT NULL,
    hub_id          TEXT NOT NULL,
    owner_id        TEXT NOT NULL,
    created_at      BIGINT NOT NULL,
    name            TEXT NOT NULL DEFAULT '',
    locked          INTEGER NOT NULL DEFAULT 0,
    hidden          INTEGER NOT NULL DEFAULT 0,
    bans            TEXT NOT NULL DEFAULT '[]',
    text_channel_id TEXT,
    empty_since     BIGINT
  );
  CREATE INDEX IF NOT EXISTS idx_temp_voice_guild ON temp_voice_channels (guild_id);
`);

const stmts = {
  add: prepare(`
    INSERT INTO temp_voice_channels (channel_id, guild_id, hub_id, owner_id, name, text_channel_id, created_at)
    VALUES (@channelId, @guildId, @hubId, @ownerId, @name, @textChannelId, @createdAt)
    ON CONFLICT (channel_id) DO NOTHING
  `),
  remove: prepare('DELETE FROM temp_voice_channels WHERE channel_id = ?'),
  get: prepare('SELECT * FROM temp_voice_channels WHERE channel_id = ?'),
  byGuild: prepare('SELECT * FROM temp_voice_channels WHERE guild_id = ?'),
  byOwnerHub: prepare('SELECT * FROM temp_voice_channels WHERE guild_id = ? AND hub_id = ? AND owner_id = ?'),
  countHub: prepare('SELECT COUNT(*) AS n FROM temp_voice_channels WHERE hub_id = ?'),
  all: prepare('SELECT * FROM temp_voice_channels'),
  clearGuild: prepare('DELETE FROM temp_voice_channels WHERE guild_id = ?'),
  setOwner: prepare('UPDATE temp_voice_channels SET owner_id = ? WHERE channel_id = ?'),
  setName: prepare('UPDATE temp_voice_channels SET name = ? WHERE channel_id = ?'),
  setLocked: prepare('UPDATE temp_voice_channels SET locked = ? WHERE channel_id = ?'),
  setHidden: prepare('UPDATE temp_voice_channels SET hidden = ? WHERE channel_id = ?'),
  setBans: prepare('UPDATE temp_voice_channels SET bans = ? WHERE channel_id = ?'),
  setEmptySince: prepare('UPDATE temp_voice_channels SET empty_since = ? WHERE channel_id = ?'),
};

const hydrate = (row) => {
  if (!row) return null;
  let bans;
  try {
    bans = JSON.parse(row.bans || '[]');
  } catch {
    bans = [];
  }
  return { ...row, banList: Array.isArray(bans) ? bans : [] };
};

export async function addTempChannel({
  channelId,
  guildId,
  hubId,
  ownerId,
  name = '',
  textChannelId = null,
}) {
  await stmts.add.run({ channelId, guildId, hubId, ownerId, name, textChannelId, createdAt: Date.now() });
}
export async function removeTempChannel(channelId) {
  await stmts.remove.run(channelId);
}
export async function getTempChannel(channelId) {
  return hydrate(await stmts.get.get(channelId));
}
export async function isTempChannel(channelId) {
  return Boolean(await stmts.get.get(channelId));
}
export async function listGuildTempChannels(guildId) {
  return (await stmts.byGuild.all(guildId)).map(hydrate);
}
export async function findUserHubChannel(guildId, hubId, ownerId) {
  return hydrate(await stmts.byOwnerHub.get(guildId, hubId, ownerId));
}
export async function countHubChannels(hubId) {
  return Number((await stmts.countHub.get(hubId))?.n) || 0;
}
export async function listAllTempChannels() {
  return (await stmts.all.all()).map(hydrate);
}
export async function clearGuildTempVoice(guildId) {
  await stmts.clearGuild.run(guildId);
}

export async function setTempOwner(channelId, ownerId) {
  await stmts.setOwner.run(ownerId, channelId);
}
export async function setTempName(channelId, name) {
  await stmts.setName.run(String(name).slice(0, 100), channelId);
}
export async function setTempLocked(channelId, locked) {
  await stmts.setLocked.run(locked ? 1 : 0, channelId);
}
export async function setTempHidden(channelId, hidden) {
  await stmts.setHidden.run(hidden ? 1 : 0, channelId);
}
export async function setTempBans(channelId, bans) {
  await stmts.setBans.run(JSON.stringify([...new Set(bans)].slice(0, 200)), channelId);
}
export async function setTempEmptySince(channelId, ts) {
  await stmts.setEmptySince.run(ts ?? null, channelId);
}
