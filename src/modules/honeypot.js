// Honeypot: trap channels and trap messages that punish whoever posts in /
// reacts to them. Any real member interacting with one is an unambiguous
// automation signal (scrapers/raid bots that join, opt into every role, then
// DM the member list) — there is no grace period, only an Administrator/
// immune-role exemption.
//
// config shape (see normaliseHoneypotConfig for the canonical form):
//   {
//     exemptRoles: string[],
//     channels: [ { channelId, action, timeoutMinutes, deleteMessage } ],
//     messages: [ { channelId, messageId, bait, action, timeoutMinutes } ],
//   }
import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { on } from './dispatch.js';
import { getGuildModule, setGuildModule } from '../db/modules.js';
import { postModLog } from '../bot/lib/modlog.js';
import { notifyTarget, MOD_COLOR } from '../bot/lib/moderation.js';
import { addCase } from '../db/modCases.js';
import { log } from '../lib/log.js';

export const HONEYPOT_ACTIONS = ['kick', 'timeout', 'ban'];
const MAX_TIMEOUT_MS = 28 * 86_400_000; // Discord's own cap

const clampInt = (v, min, max, dflt) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
};
const idList = (v) => [...new Set((Array.isArray(v) ? v : [v]).filter((x) => /^\d{17,20}$/.test(x)))];
const isId = (v) => /^\d{17,20}$/.test(v ?? '');
const action = (v) => (HONEYPOT_ACTIONS.includes(v) ? v : 'kick');

export function normaliseHoneypotConfig(raw = {}) {
  return {
    exemptRoles: idList(raw.exemptRoles),
    channels: (Array.isArray(raw.channels) ? raw.channels : [])
      .map((c) => ({
        channelId: isId(c.channelId) ? c.channelId : '',
        action: action(c.action),
        timeoutMinutes: clampInt(c.timeoutMinutes, 1, 40320, 10),
        deleteMessage: c.deleteMessage !== false,
      }))
      .filter((c, i, arr) => c.channelId && arr.findIndex((x) => x.channelId === c.channelId) === i)
      .slice(0, 25),
    messages: (Array.isArray(raw.messages) ? raw.messages : [])
      .map((m) => ({
        channelId: isId(m.channelId) ? m.channelId : '',
        messageId: isId(m.messageId) ? m.messageId : '',
        bait: String(m.bait ?? '').slice(0, 500),
        action: action(m.action),
        timeoutMinutes: clampInt(m.timeoutMinutes, 1, 40320, 10),
      }))
      .filter((m, i, arr) => m.channelId && arr.findIndex((x) => x.channelId === m.channelId) === i)
      .slice(0, 25),
  };
}

function isExempt(member, cfg) {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return cfg.exemptRoles.some((r) => member.roles.cache.has(r));
}

/** Apply the configured punishment, log a case, and post to the mod-log. */
async function punish(guild, member, entry, reason) {
  let done = null;
  try {
    if (entry.action === 'timeout' && member.moderatable) {
      await member.timeout(Math.min(entry.timeoutMinutes * 60_000, MAX_TIMEOUT_MS), reason);
      done = `timed out for ${entry.timeoutMinutes}m`;
      await notifyTarget(member.user, { guildName: guild.name, action: 'timed out', reason });
    } else if (entry.action === 'kick' && member.kickable) {
      await notifyTarget(member.user, { guildName: guild.name, action: 'kicked', reason });
      await member.kick(reason);
      done = 'kicked';
    } else if (entry.action === 'ban' && guild.members.me?.permissions.has('BanMembers')) {
      await notifyTarget(member.user, { guildName: guild.name, action: 'banned', reason });
      await guild.bans.create(member.id, { reason });
      done = 'banned';
    }
  } catch (err) {
    log.error('module:honeypot', 'punish failed:', err.message);
    return;
  }
  if (!done) return;

  const { caseNumber } = await addCase({
    guildId: guild.id,
    userId: member.id,
    moderatorId: 'honeypot',
    action: entry.action,
    reason,
    detail: entry.action === 'timeout' ? `${entry.timeoutMinutes}m` : null,
  });

  const embed = new EmbedBuilder()
    .setColor(MOD_COLOR)
    .setTitle('Honeypot triggered')
    .setThumbnail(member.user.displayAvatarURL())
    .addFields(
      { name: 'Case', value: `#${caseNumber}` },
      { name: 'User', value: `${member.user.tag} (\`${member.id}\`)` },
      { name: 'Action', value: done },
      { name: 'Trigger', value: reason }
    )
    .setTimestamp(Date.now());
  await postModLog(guild, embed);
}

/**
 * (Re)posts each configured trap message, editing it in place when it
 * already exists — same "bot owns the message, admin only edits the text"
 * pattern verification.js's ensureVerifyMessage uses, generalized to a list
 * of rows keyed by channelId instead of a single row.
 */
export async function ensureHoneypotMessages(guild, config) {
  const rows = Array.isArray(config.messages) ? config.messages : [];
  if (!rows.length) return;
  const me = guild.members.me;
  let changed = false;

  for (const row of rows) {
    if (!row.channelId) continue;
    const channel =
      guild.channels.cache.get(row.channelId) ??
      (await guild.channels.fetch(row.channelId).catch(() => null));
    if (!channel?.isTextBased()) continue;
    if (!channel.permissionsFor(me)?.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) continue;

    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle('🍯')
      .setDescription(row.bait || '​');

    if (row.messageId) {
      const existing = await channel.messages.fetch(row.messageId).catch(() => null);
      if (existing) {
        await existing.edit({ embeds: [embed] }).catch(() => {});
        continue;
      }
    }
    const posted = await channel.send({ embeds: [embed] }).catch(() => null);
    if (posted) {
      row.messageId = posted.id;
      changed = true;
    }
  }

  if (changed) {
    const fresh = (await getGuildModule(guild.id, 'honeypot')).config;
    const byChannel = new Map(rows.map((r) => [r.channelId, r]));
    const merged = {
      ...fresh,
      messages: (fresh.messages ?? []).map((m) => byChannel.get(m.channelId) ?? m),
    };
    await setGuildModule(guild.id, 'honeypot', { config: merged });
  }
}

on('honeypot', 'messageCreate', async (message, config) => {
  if (message.partial || !message.guild) return;
  const cfg = normaliseHoneypotConfig(config);
  if (!cfg.channels.length) return;
  const entry = cfg.channels.find((c) => c.channelId === message.channelId);
  if (!entry) return;

  const member = message.member ?? (await message.guild.members.fetch(message.author.id).catch(() => null));
  if (!member || isExempt(member, cfg)) return;

  await punish(message.guild, member, entry, 'Honeypot: message posted in trap channel');
  if (entry.deleteMessage && message.deletable) await message.delete().catch(() => {});
});

on('honeypot', 'reactionAdd', async ({ reaction, user }, config) => {
  if (user.bot) return;
  const cfg = normaliseHoneypotConfig(config);
  if (!cfg.messages.length) return;
  const entry = cfg.messages.find((m) => m.messageId === reaction.message.id);
  if (!entry) return;

  const guild = reaction.message.guild;
  if (!guild) return;
  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member || isExempt(member, cfg)) return;

  await punish(guild, member, entry, 'Honeypot: reacted to trap message');
});
