// Reaction roles & autoroles.
//
// config shape:
//   {
//     autoroles: ["<roleId>", ...],
//     reactionMessages: [
//       { channelId, messageId, mode: "toggle",
//         pairs: [{ key, display, roleId }] }
//     ]
//   }
// `key` is what identifies the reaction: a custom emoji id, or the unicode char.
import { EmbedBuilder } from 'discord.js';
import { on } from './dispatch.js';
import { runtime } from '../runtime.js';

// --- emoji parsing --------------------------------------------------------

const CUSTOM_RE = /^<a?:([a-zA-Z0-9_]+):(\d+)>$/;

/**
 * Turn a user-entered emoji into { key, display, react } or null.
 * react is what message.react() accepts.
 * @param {string} raw
 * @param {import('discord.js').Guild} guild
 */
export function parseEmoji(raw, guild) {
  const s = String(raw ?? '').trim();
  if (!s) return null;

  const m = s.match(CUSTOM_RE);
  if (m) {
    return { key: m[2], display: s, react: `${m[1]}:${m[2]}` };
  }
  // :shortcode: → resolve against the guild's custom emojis
  const short = s.match(/^:([a-zA-Z0-9_]+):$/);
  if (short) {
    const e = guild.emojis.cache.find((x) => x.name === short[1]);
    if (e) return { key: e.id, display: e.toString(), react: `${e.name}:${e.id}` };
    return null;
  }
  // Assume a unicode emoji (grapheme). Keep as-is.
  return { key: s, display: s, react: s };
}

// --- dashboard helper: build a reaction-role message ------------------

/**
 * Post a reaction-role message (as an embed) and add its reactions.
 * @returns {Promise<{ channelId, messageId, mode, pairs }>}
 */
export async function createReactionMessage(guild, { channelId, title, description, color, pairs }) {
  const channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId));
  if (!channel?.isTextBased()) throw new Error('Channel not found or not text-based.');

  const list = pairs.map((p) => `${p.display} — <@&${p.roleId}>`).join('\n');
  const embed = new EmbedBuilder()
    .setColor(Number.isInteger(color) ? color : 0x4aa3df)
    .setDescription([description, description && list ? '' : null, list].filter((x) => x != null).join('\n') || list);
  if (title) embed.setTitle(title);

  const message = await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  for (const p of pairs) {
    await message.react(p.react).catch((err) => {
      console.warn(`[roles] could not react with ${p.display}: ${err.message}`);
    });
  }
  return {
    channelId,
    messageId: message.id,
    mode: 'toggle',
    pairs: pairs.map((p) => ({ key: p.key, display: p.display, roleId: p.roleId })),
  };
}

// --- runtime handlers --------------------------------------------------

on('roles', 'guildMemberAdd', async (member, config) => {
  const ids = Array.isArray(config.autoroles) ? config.autoroles : [];
  if (!ids.length) return;
  const me = member.guild.members.me;
  const addable = ids.filter((id) => {
    const role = member.guild.roles.cache.get(id);
    return role && role.editable && me && me.roles.highest.comparePositionTo(role) > 0;
  });
  if (addable.length) await member.roles.add(addable, 'Autorole on join').catch(() => {});
});

async function resolveReaction(payload) {
  let { reaction, user } = payload;
  if (user.bot) return null;
  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch {
      return null;
    }
  }
  return { reaction, user };
}

function findPair(config, reaction) {
  const key = reaction.emoji.id || reaction.emoji.name;
  for (const rm of config.reactionMessages ?? []) {
    if (rm.messageId !== reaction.message.id) continue;
    const pair = rm.pairs.find((p) => p.key === key);
    if (pair) return { rm, pair };
  }
  return null;
}

on('roles', 'reactionAdd', async (payload, config, guildId) => {
  const r = await resolveReaction(payload);
  if (!r) return;
  const hit = findPair(config, r.reaction);
  if (!hit) return;
  const guild = runtime.client.guilds.cache.get(guildId);
  const member = await guild.members.fetch(r.user.id).catch(() => null);
  const role = guild.roles.cache.get(hit.pair.roleId);
  if (!member || !role) return;
  if (!role.editable) {
    console.warn(`[roles] cannot assign "${role.name}" in ${guild.name}: bot lacks Manage Roles or is ranked below it`);
    return;
  }
  await member.roles.add(role, 'Reaction role').catch((err) => console.warn(`[roles] add role failed: ${err.message}`));
});

on('roles', 'reactionRemove', async (payload, config, guildId) => {
  const r = await resolveReaction(payload);
  if (!r) return;
  const hit = findPair(config, r.reaction);
  if (!hit || hit.rm.mode !== 'toggle') return;
  const guild = runtime.client.guilds.cache.get(guildId);
  const member = await guild.members.fetch(r.user.id).catch(() => null);
  const role = guild.roles.cache.get(hit.pair.roleId);
  if (member && role && role.editable) {
    await member.roles.remove(role, 'Reaction role removed').catch(() => {});
  }
});
