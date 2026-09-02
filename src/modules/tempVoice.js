// Temporary voice channels ("join to create"), MEE6-style "Hubs". A member joins
// a hub VC; Sylo spins up a personal voice channel (optionally with a paired
// text channel), moves them in, and cleans it up after everyone leaves — after
// an optional keep-alive delay. The /voice-* commands let the owner and
// moderators lock/hide/ban/rename/transfer it.
//
// config shape (per hub):
//   { id, hubChannelId, categoryId, nameTemplate, userLimit, bitrate,
//     keepAliveMinutes, ownershipLock, syncCategory, syncChannel,
//     roleMode: 'allow'|'deny', roleList: [], useRolesForAccess,
//     ignoredRoles: [], moderatorRoles: [],
//     ownerPerms: { manageChannels, managePermissions, prioritySpeaker, moveMembers },
//     textChannel: { enabled, restrictCommands, pinUsages, restrict } }
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { on } from './dispatch.js';
import { runtime } from '../runtime.js';
import { getGuildModule } from '../db/modules.js';
import { log } from '../lib/log.js';
import {
  addTempChannel,
  removeTempChannel,
  getTempChannel,
  isTempChannel,
  findUserHubChannel,
  countHubChannels,
  listAllTempChannels,
  setTempOwner,
  setTempName,
  setTempLocked,
  setTempHidden,
  setTempBans,
  setTempEmptySince,
} from '../db/tempVoice.js';

const DEFAULT_NAME = "#{index} - {username}'s Channel";
const SWEEP_MS = 60 * 1000;
const CREATE_DEBOUNCE_MS = 3000;
const P = PermissionFlagsBits;

const clampInt = (v, min, max, dflt) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
};
const id = (v) => (/^\d{17,20}$/.test(v ?? '') ? v : '');
const idList = (v) =>
  [...new Set((Array.isArray(v) ? v : []).filter((x) => /^\d{17,20}$/.test(x)))].slice(0, 25);
const bool = (v) => Boolean(v);

export const KEEPALIVE_OPTIONS = [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
export const USERLIMIT_MARKS = [0, 20, 40, 60, 80, 99];

export function normaliseTempVoiceConfig(raw = {}) {
  return {
    hubs: (Array.isArray(raw.hubs) ? raw.hubs : [])
      .map((h, i) => ({
        id: h.id ? String(h.id) : String(i),
        hubChannelId: id(h.hubChannelId),
        categoryId: id(h.categoryId),
        nameTemplate:
          String(h.nameTemplate ?? '')
            .slice(0, 95)
            .trim() || DEFAULT_NAME,
        userLimit: clampInt(h.userLimit, 0, 99, 0),
        bitrate: clampInt(h.bitrate, 0, 384, 0), // kbps, 0 = server default
        keepAliveMinutes: KEEPALIVE_OPTIONS.includes(Math.trunc(Number(h.keepAliveMinutes)))
          ? Math.trunc(Number(h.keepAliveMinutes))
          : 0,
        ownershipLock: bool(h.ownershipLock),
        syncCategory: bool(h.syncCategory),
        syncChannel: bool(h.syncChannel),
        roleMode: h.roleMode === 'deny' ? 'deny' : 'allow',
        roleList: idList(h.roleList),
        useRolesForAccess: bool(h.useRolesForAccess),
        ignoredRoles: idList(h.ignoredRoles),
        moderatorRoles: idList(h.moderatorRoles),
        ownerPerms: {
          manageChannels: h.ownerPerms?.manageChannels !== false,
          managePermissions: bool(h.ownerPerms?.managePermissions),
          prioritySpeaker: bool(h.ownerPerms?.prioritySpeaker),
          moveMembers: bool(h.ownerPerms?.moveMembers),
        },
        textChannel: {
          enabled: bool(h.textChannel?.enabled),
          restrictCommands: bool(h.textChannel?.restrictCommands),
          pinUsages: bool(h.textChannel?.pinUsages),
          restrict: bool(h.textChannel?.restrict),
        },
      }))
      .filter((h) => h.hubChannelId)
      .slice(0, 25),
  };
}

/** Render a channel name from a hub's template. */
export function renderName(template, { member, index }) {
  const name = String(template || DEFAULT_NAME)
    .replaceAll('{index}', String(index))
    .replaceAll('{count}', String(index))
    .replaceAll('{username}', member?.user?.username ?? 'player')
    .replaceAll('{user}', member?.displayName ?? member?.user?.username ?? 'Player')
    .slice(0, 100)
    .trim();
  return name || 'Voice channel';
}

// --- config lookup for the commands -----------------------------------

export function tempVoiceConfig(guildId) {
  return normaliseTempVoiceConfig(getGuildModule(guildId, 'temp-voice').config);
}
export function hubForChannel(guildId, hubId) {
  return tempVoiceConfig(guildId).hubs.find((h) => h.id === hubId || h.hubChannelId === hubId) ?? null;
}

// --- overwrites ------------------------------------------------------

function ownerAllowBits(hub) {
  const bits = [P.ViewChannel, P.Connect, P.Speak];
  if (hub.ownerPerms.manageChannels) bits.push(P.ManageChannels);
  if (hub.ownerPerms.managePermissions) bits.push(P.ManageRoles);
  if (hub.ownerPerms.prioritySpeaker) bits.push(P.PrioritySpeaker);
  if (hub.ownerPerms.moveMembers) bits.push(P.MoveMembers);
  return bits;
}

// Copy role/member overwrites from the parent, but drop the parent's @everyone
// entry — buildOverwrites emits the authoritative one. A "join to create" lobby
// often denies @everyone Speak, and copying that onto the spawned channel shows
// its own owner as server-muted.
export function syncedOverwrites(source, guild) {
  return [...source].filter((ow) => ow.id !== guild.id);
}

export function buildOverwrites(guild, hub, ownerId, { forText = false } = {}) {
  const view = forText ? P.ViewChannel : P.Connect;
  const overwrites = [];

  // @everyone: one entry. For a voice channel, always allow Speak/Stream so an
  // inherited category "no talking" rule can't leave members server-muted in
  // their own temp channel. Role gating adjusts the view/connect bit.
  const everyoneAllow = forText ? [] : [P.Speak, P.Stream];
  const everyoneDeny = [];
  if (hub.roleList.length && hub.roleMode === 'deny') everyoneDeny.push(view);
  if (everyoneAllow.length || everyoneDeny.length) {
    overwrites.push({ id: guild.id, allow: everyoneAllow, deny: everyoneDeny });
  }

  // Role allow/deny gate.
  if (hub.roleList.length) {
    if (hub.roleMode === 'deny') {
      for (const rid of hub.roleList) overwrites.push({ id: rid, allow: [view] });
    } else {
      for (const rid of hub.roleList) overwrites.push({ id: rid, deny: [view] });
    }
  }

  overwrites.push({ id: ownerId, allow: forText ? [P.ViewChannel, P.SendMessages] : ownerAllowBits(hub) });
  // Sylo keeps full control so /voice-* always works.
  if (guild.members.me) {
    overwrites.push({
      id: guild.members.me.id,
      allow: [P.ViewChannel, P.Connect, P.ManageChannels, P.MoveMembers, P.SendMessages],
    });
  }
  return overwrites;
}

// --- create -----------------------------------------------------------------

const lastCreate = new Map();

async function handleJoin(guild, member, hub) {
  const key = `${guild.id}:${member.id}`;
  if (Date.now() - (lastCreate.get(key) ?? 0) < CREATE_DEBOUNCE_MS) return;
  lastCreate.set(key, Date.now());

  const me = guild.members.me;
  if (!me?.permissions.has(P.ManageChannels) || !me.permissions.has(P.MoveMembers)) return;

  const prior = findUserHubChannel(guild.id, hub.hubChannelId, member.id);
  if (prior) {
    const ch = guild.channels.cache.get(prior.channel_id);
    if (ch) return void member.voice.setChannel(ch).catch(() => {});
    removeTempChannel(prior.channel_id);
  }

  const hubChannel = guild.channels.cache.get(hub.hubChannelId);
  const parent = hub.categoryId || hubChannel?.parentId || null;
  const parentCat = parent ? guild.channels.cache.get(parent) : null;
  const name = renderName(hub.nameTemplate, { member, index: countHubChannels(hub.hubChannelId) + 1 });

  let overwrites;
  if (hub.syncChannel && hubChannel?.permissionOverwrites) {
    overwrites = [
      ...syncedOverwrites(hubChannel.permissionOverwrites.cache.values(), guild),
      ...buildOverwrites(guild, hub, member.id),
    ];
  } else if (hub.syncCategory && parentCat?.permissionOverwrites) {
    overwrites = [
      ...syncedOverwrites(parentCat.permissionOverwrites.cache.values(), guild),
      ...buildOverwrites(guild, hub, member.id),
    ];
  } else {
    overwrites = buildOverwrites(guild, hub, member.id);
  }

  let channel;
  try {
    channel = await guild.channels.create({
      name,
      type: ChannelType.GuildVoice,
      parent: parent ?? undefined,
      userLimit: hub.userLimit || undefined,
      bitrate: hub.bitrate ? Math.min(hub.bitrate * 1000, guild.maximumBitrate) : undefined,
      reason: `Temp voice for ${member.user.tag}`,
      permissionOverwrites: overwrites,
    });
  } catch (err) {
    log.error('temp-voice', 'create failed:', err.message);
    return;
  }

  let textChannelId = null;
  if (hub.textChannel.enabled) {
    try {
      const t = await guild.channels.create({
        name,
        type: ChannelType.GuildText,
        parent: parent ?? undefined,
        reason: `Temp voice text for ${member.user.tag}`,
        permissionOverwrites: hub.textChannel.restrict
          ? [
              { id: guild.id, deny: [P.ViewChannel] },
              ...buildOverwrites(guild, hub, member.id, { forText: true }),
            ]
          : buildOverwrites(guild, hub, member.id, { forText: true }),
      });
      textChannelId = t.id;
      if (hub.textChannel.pinUsages) {
        await t
          .send({
            embeds: [
              {
                title: `Controls for ${name}`,
                description:
                  '`/voice-lock` `/voice-unlock` · `/voice-hide` `/voice-reveal`\n' +
                  '`/voice-limit` `/voice-rename` · `/voice-kick` `/voice-ban` `/voice-unban`\n' +
                  '`/voice-claim` `/voice-transfer` `/voice-owner`',
                color: 0x5b7cfa,
              },
            ],
          })
          .then((m) => m.pin().catch(() => {}))
          .catch(() => {});
      }
    } catch (err) {
      log.error('temp-voice', 'text channel create failed:', err.message);
    }
  }

  const moved = await member.voice
    .setChannel(channel)
    .then(() => true)
    .catch(() => false);
  if (!moved) {
    await channel.delete('Temp voice: member never joined').catch(() => {});
    if (textChannelId) await guild.channels.delete(textChannelId).catch(() => {});
    return;
  }
  addTempChannel({
    channelId: channel.id,
    guildId: guild.id,
    hubId: hub.hubChannelId,
    ownerId: member.id,
    name,
    textChannelId,
  });
}

// --- cleanup + ownership transfer -----------------------------------

async function onLeaveTemp(guild, channelId) {
  const row = getTempChannel(channelId);
  if (!row) return;
  const channel = guild.channels.cache.get(channelId);
  if (!channel) return void destroy(guild, row);

  if (channel.members.size > 0) {
    setTempEmptySince(channelId, null);
    // Owner left but others remain → transfer unless the hub locks ownership.
    const hub = hubForChannel(guild.id, row.hub_id);
    if (!channel.members.has(row.owner_id) && hub && !hub.ownershipLock) {
      const next = channel.members.first();
      if (next) {
        setTempOwner(channelId, next.id);
        await channel.permissionOverwrites
          .edit(next.id, Object.fromEntries(ownerAllowBits(hub).map((b) => [b, true])))
          .catch(() => {});
      }
    }
    return;
  }

  const hub = hubForChannel(guild.id, row.hub_id);
  const keep = hub?.keepAliveMinutes ?? 0;
  if (keep === 0) return void destroy(guild, row);
  if (keep < 0) return; // never auto-delete
  setTempEmptySince(channelId, Date.now());
}

async function destroy(guild, row) {
  const ch = guild.channels.cache.get(row.channel_id);
  if (ch) await ch.delete('Temp voice: empty').catch(() => {});
  if (row.text_channel_id) await guild.channels.delete(row.text_channel_id).catch(() => {});
  removeTempChannel(row.channel_id);
}

// --- events ---------------------------------------------------------------

on('temp-voice', 'voiceStateUpdate', async ({ old: oldState, new: newState }, rawConfig) => {
  const guild = newState.guild ?? oldState.guild;
  if (!guild) return;
  const cfg = normaliseTempVoiceConfig(rawConfig);

  if (oldState.channelId && oldState.channelId !== newState.channelId && isTempChannel(oldState.channelId)) {
    await onLeaveTemp(guild, oldState.channelId).catch((e) => log.error('temp-voice', 'leave:', e.message));
  }
  if (newState.channelId && newState.channelId !== oldState.channelId) {
    const hub = cfg.hubs.find((h) => h.hubChannelId === newState.channelId);
    if (hub && newState.member) {
      await handleJoin(guild, newState.member, hub).catch((e) => log.error('temp-voice', 'join:', e.message));
    }
  }
});

// --- keep-alive sweep --------------------------------------------------

async function sweep() {
  const client = runtime.client;
  if (!client?.isReady()) return;
  const now = Date.now();
  for (const row of listAllTempChannels()) {
    const guild = client.guilds.cache.get(row.guild_id);
    if (!guild) continue;
    const channel =
      guild.channels.cache.get(row.channel_id) ??
      (await guild.channels.fetch(row.channel_id).catch(() => null));
    if (!channel) {
      if (row.text_channel_id) await guild.channels.delete(row.text_channel_id).catch(() => {});
      removeTempChannel(row.channel_id);
      continue;
    }
    if (channel.members.size > 0) {
      if (row.empty_since) setTempEmptySince(row.channel_id, null);
      continue;
    }
    const hub = hubForChannel(guild.id, row.hub_id);
    const keep = hub?.keepAliveMinutes ?? 0;
    if (keep < 0) continue;
    const since = row.empty_since ?? row.created_at;
    if (now - since >= keep * 60_000) await destroy(guild, row);
  }
}

setInterval(() => sweep().catch((e) => log.error('temp-voice', 'sweep:', e.message)), SWEEP_MS).unref();
setTimeout(() => sweep().catch(() => {}), 30_000).unref();

// --- command helpers (used by bot/commands/voice-*.js) ---------------

export function setLock(channel, guild, locked) {
  setTempLocked(channel.id, locked);
  return channel.permissionOverwrites.edit(guild.id, { Connect: locked ? false : null }).catch(() => {});
}
export function setHidden(channel, guild, hidden) {
  setTempHidden(channel.id, hidden);
  return channel.permissionOverwrites.edit(guild.id, { ViewChannel: hidden ? false : null }).catch(() => {});
}
export async function banFromChannel(channel, row, userId) {
  const bans = [...new Set([...row.banList, userId])];
  setTempBans(channel.id, bans);
  await channel.permissionOverwrites.edit(userId, { Connect: false, ViewChannel: false }).catch(() => {});
  const m = channel.members.get(userId);
  if (m) await m.voice.disconnect('Voice-banned from temp channel').catch(() => {});
}
export async function unbanFromChannel(channel, row, userId) {
  setTempBans(
    channel.id,
    row.banList.filter((b) => b !== userId)
  );
  await channel.permissionOverwrites.delete(userId).catch(() => {});
}
export function renameTemp(channel, name) {
  setTempName(channel.id, name);
  return channel.setName(name.slice(0, 100)).catch(() => {});
}
export async function transferTemp(channel, guild, row, newOwnerId) {
  const hub = hubForChannel(guild.id, row.hub_id);
  if (row.owner_id) await channel.permissionOverwrites.delete(row.owner_id).catch(() => {});
  setTempOwner(channel.id, newOwnerId);
  if (hub) {
    await channel.permissionOverwrites
      .edit(newOwnerId, Object.fromEntries(ownerAllowBits(hub).map((b) => [b, true])))
      .catch(() => {});
  }
}
