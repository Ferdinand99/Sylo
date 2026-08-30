// Temporary voice channels ("join to create"). A member joins a designated hub
// voice channel; Sylo spins up a fresh voice channel, moves them into it, and
// deletes it once everyone leaves.
//
// config shape:
//   {
//     hubs: [
//       {
//         hubChannelId: '',                 // the "join to create" trigger VC
//         categoryId: '',                   // where temp channels are made (blank = hub's category)
//         nameTemplate: "{user}'s channel", // {user} {username} {count}
//         userLimit: 0,                     // 0 = unlimited
//       }
//     ]
//   }
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { on } from './dispatch.js';
import { runtime } from '../runtime.js';
import {
  addTempChannel,
  removeTempChannel,
  isTempChannel,
  findUserHubChannel,
  countHubChannels,
  listAllTempChannels,
} from '../db/tempVoice.js';

const DEFAULT_NAME = "{user}'s channel";
const SWEEP_MS = 5 * 60 * 1000;
const CREATE_DEBOUNCE_MS = 3000;

const clampInt = (v, min, max, dflt) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
};
const id = (v) => (/^\d{17,20}$/.test(v ?? '') ? v : '');

export function normaliseTempVoiceConfig(raw = {}) {
  return {
    hubs: (Array.isArray(raw.hubs) ? raw.hubs : [])
      .map((h) => ({
        hubChannelId: id(h.hubChannelId),
        categoryId: id(h.categoryId),
        nameTemplate: String(h.nameTemplate ?? '').slice(0, 90).trim() || DEFAULT_NAME,
        userLimit: clampInt(h.userLimit, 0, 99, 0),
      }))
      .filter((h) => h.hubChannelId)
      .slice(0, 10),
  };
}

/** Render a channel name from a hub's template. */
export function renderName(template, { member, count }) {
  const name = String(template || DEFAULT_NAME)
    .replaceAll('{user}', member?.displayName ?? 'Player')
    .replaceAll('{username}', member?.user?.username ?? 'player')
    .replaceAll('{count}', String(count))
    .slice(0, 100)
    .trim();
  return name || 'Voice channel';
}

const lastCreate = new Map(); // `${guildId}:${userId}` -> ts

// --- create -----------------------------------------------------------------

async function handleJoin(guild, member, hub) {
  const key = `${guild.id}:${member.id}`;
  if (Date.now() - (lastCreate.get(key) ?? 0) < CREATE_DEBOUNCE_MS) return;
  lastCreate.set(key, Date.now());

  const me = guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageChannels) || !me.permissions.has(PermissionFlagsBits.MoveMembers)) {
    return;
  }

  // Reuse the member's existing channel from this hub if it's still around.
  const existing = findUserHubChannel(guild.id, hub.hubChannelId, member.id);
  if (existing) {
    const ch = guild.channels.cache.get(existing.channel_id);
    if (ch) {
      await member.voice.setChannel(ch).catch(() => {});
      return;
    }
    removeTempChannel(existing.channel_id);
  }

  const hubChannel = guild.channels.cache.get(hub.hubChannelId);
  const parent = hub.categoryId || hubChannel?.parentId || null;
  const name = renderName(hub.nameTemplate, { member, count: countHubChannels(hub.hubChannelId) + 1 });

  let channel;
  try {
    channel = await guild.channels.create({
      name,
      type: ChannelType.GuildVoice,
      parent: parent ?? undefined,
      userLimit: hub.userLimit || undefined,
      reason: `Temporary voice channel for ${member.user.tag}`,
      permissionOverwrites: [
        {
          id: member.id,
          allow: [
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.MoveMembers,
            PermissionFlagsBits.MuteMembers,
            PermissionFlagsBits.DeafenMembers,
          ],
        },
      ],
    });
  } catch (err) {
    console.error('[temp-voice] could not create channel:', err.message);
    return;
  }

  const moved = await member.voice.setChannel(channel).then(() => true).catch(() => false);
  if (!moved) {
    // They already left — bin the empty channel we just made.
    await channel.delete('Temp voice: member never joined').catch(() => {});
    return;
  }
  addTempChannel({ channelId: channel.id, guildId: guild.id, hubId: hub.hubChannelId, ownerId: member.id });
}

// --- cleanup --------------------------------------------------------------

async function maybeDelete(guild, channelId) {
  if (!channelId || !isTempChannel(channelId)) return;
  const channel = guild.channels.cache.get(channelId);
  if (!channel) {
    removeTempChannel(channelId);
    return;
  }
  if (channel.members.size > 0) return;
  await channel.delete('Temp voice: empty').catch(() => {});
  removeTempChannel(channelId);
}

// --- event -------------------------------------------------------------------

on('temp-voice', 'voiceStateUpdate', async ({ old: oldState, new: newState }, rawConfig) => {
  const guild = newState.guild ?? oldState.guild;
  if (!guild) return;
  const cfg = normaliseTempVoiceConfig(rawConfig);

  // Left / switched away from a temp channel → delete it if now empty.
  if (oldState.channelId && oldState.channelId !== newState.channelId) {
    await maybeDelete(guild, oldState.channelId);
  }

  // Joined a hub → make them a channel.
  if (newState.channelId && newState.channelId !== oldState.channelId) {
    const hub = cfg.hubs.find((h) => h.hubChannelId === newState.channelId);
    if (hub && newState.member) {
      await handleJoin(guild, newState.member, hub).catch((err) =>
        console.error('[temp-voice] join handler failed:', err.message)
      );
    }
  }
});

// --- sweep (startup + periodic) — catch channels emptied while Sylo was down --

async function sweep() {
  const client = runtime.client;
  if (!client?.isReady()) return;
  for (const row of listAllTempChannels()) {
    const guild = client.guilds.cache.get(row.guild_id);
    if (!guild) continue;
    const channel = guild.channels.cache.get(row.channel_id) ?? (await guild.channels.fetch(row.channel_id).catch(() => null));
    if (!channel) {
      removeTempChannel(row.channel_id);
      continue;
    }
    if (channel.members.size === 0) {
      await channel.delete('Temp voice: empty (startup sweep)').catch(() => {});
      removeTempChannel(row.channel_id);
    }
  }
}

setInterval(() => {
  sweep().catch((err) => console.error('[temp-voice] sweep failed:', err.message));
}, SWEEP_MS).unref();
setTimeout(() => sweep().catch(() => {}), 30_000).unref();
