// Custom commands: per-guild commands that reply with text or an embed.
// They can be triggered two ways (both work when enabled):
//   - prefix in chat:  <prefix>name            (needs Message Content intent)
//   - slash command:   /name [text]            (config.slash — synced to Discord)
//
// config shape:
//   { prefix: "!", slash: false,
//     commands: [ { name, response, embed, embedTitle, embedColor } ] }
// Placeholders in `response` / `embedTitle`: {user} {username} {server} {channel} {args}
import { EmbedBuilder } from 'discord.js';
import { on } from './dispatch.js';

export const CC_PLACEHOLDERS = ['{user}', '{username}', '{server}', '{channel}', '{args}'];
const DEFAULT_PREFIX = '!';
const NAME_RE = /^[a-z0-9_-]{1,32}$/i;

/** Coerce stored/submitted config into the canonical shape. */
export function normaliseCustomCommands(raw = {}) {
  const prefix = String(raw.prefix ?? DEFAULT_PREFIX).trim().slice(0, 5) || DEFAULT_PREFIX;
  const seen = new Set();
  const commands = (Array.isArray(raw.commands) ? raw.commands : [])
    .map((c) => ({
      name: String(c.name ?? '').trim().toLowerCase(),
      response: String(c.response ?? '').slice(0, 2000),
      embed: Boolean(c.embed),
      embedTitle: String(c.embedTitle ?? '').slice(0, 256),
      embedColor: /^#?[0-9a-fA-F]{6}$/.test(c.embedColor ?? '') ? c.embedColor.replace('#', '') : '5b7cfa',
    }))
    .filter((c) => {
      if (!NAME_RE.test(c.name) || c.response.trim() === '' || seen.has(c.name)) return false;
      seen.add(c.name);
      return true;
    })
    .slice(0, 100);
  return { prefix, slash: Boolean(raw.slash), commands };
}

/** Whether a command's text references {args} (→ it needs a slash `text` option). */
export function usesArgs(cmd) {
  return `${cmd.response ?? ''} ${cmd.embedTitle ?? ''}`.includes('{args}');
}

function fill(template, ctx) {
  return String(template ?? '')
    .replaceAll('{user}', ctx.userId ? `<@${ctx.userId}>` : '')
    .replaceAll('{username}', ctx.username ?? '')
    .replaceAll('{server}', ctx.guildName ?? '')
    .replaceAll('{channel}', ctx.channelId ? `<#${ctx.channelId}>` : '')
    .replaceAll('{args}', ctx.args ?? '');
}

/**
 * Build the Discord message payload for a custom command.
 * @param {{ response: string, embed: boolean, embedTitle: string, embedColor: string }} cmd
 * @param {{ userId?: string, username?: string, guildName?: string, channelId?: string, args?: string }} ctx
 */
export function buildCustomReply(cmd, ctx) {
  const text = fill(cmd.response, ctx);
  const mentions = { users: ctx.userId ? [ctx.userId] : [], roles: [] };
  if (cmd.embed) {
    const embed = new EmbedBuilder()
      .setColor(parseInt(cmd.embedColor || '5b7cfa', 16))
      .setDescription(text || '​');
    const title = fill(cmd.embedTitle, ctx).trim();
    if (title) embed.setTitle(title);
    return { embeds: [embed], allowedMentions: mentions };
  }
  return { content: text.slice(0, 2000) || '​', allowedMentions: mentions };
}

on('custom-commands', 'messageCreate', async (message, config) => {
  const prefix = config.prefix || DEFAULT_PREFIX;
  const content = message.content ?? '';
  if (!content.startsWith(prefix) || content.length <= prefix.length) return;

  const [rawName, ...rest] = content.slice(prefix.length).split(/\s+/);
  const cmd = (config.commands ?? []).find((c) => c.name === rawName.toLowerCase());
  if (!cmd) return;

  const me = message.guild.members.me;
  if (!message.channel.permissionsFor(me)?.has(['SendMessages', 'ViewChannel'])) return;

  const payload = buildCustomReply(cmd, {
    userId: message.author.id,
    username: message.author.username,
    guildName: message.guild.name,
    channelId: message.channelId,
    args: rest.join(' '),
  });
  await message.channel.send(payload).catch(() => {});
});
