// Custom commands: per-guild `/slash` commands built from an ordered list of
// actions (MEE6-style). Each command is registered with Discord via
// bot/lib/customCommandSync.js and executed by handleCustomSlash().
//
// config shape:
//   { commands: [ {
//       id, name, description,
//       actions: [
//         { type: 'reply',       private, messages: [ { content, embed } ] },
//         { type: 'send',        channelId, messages: [ { content, embed } ] },
//         { type: 'add-role',    roleId },
//         { type: 'remove-role', roleId },
//       ],
//       allowedRoles: [], allowedChannels: [], cooldownSeconds: 0
//   } ] }
//
// `messages` with more than one entry: the bot picks one at random.
// Placeholders in content / embed text: {user} {username} {server} {channel} {args}
import { EmbedBuilder } from 'discord.js';
import { buildEmbed } from './messageCreator.js';
import { normaliseEmbedSpec } from './welcomeChannel.js';

export const CC_PLACEHOLDERS = ['{user}', '{username}', '{server}', '{channel}', '{args}'];
export const CC_ACTION_TYPES = ['reply', 'send', 'add-role', 'remove-role'];
const NAME_RE = /^[a-z0-9_-]{1,32}$/;
const isId = (v) => /^\d{17,20}$/.test(v ?? '');

// --- normalisation ----------------------------------------------------------

const embedIsEmpty = (e) =>
  !e ||
  (!e.title &&
    !e.description &&
    !e.image &&
    !e.thumbnail &&
    !e.authorName &&
    !e.footerText &&
    (!Array.isArray(e.fields) || e.fields.length === 0));

/** One message block: text and/or an embed. Returns { content, embed|null }. */
function normMessage(m = {}) {
  const content = String(m.content ?? '').slice(0, 2000);
  const embed = m.embed && typeof m.embed === 'object' ? normaliseEmbedSpec(m.embed) : null;
  return { content, embed: embedIsEmpty(embed) ? null : embed };
}

const messageHasContent = (m) => m.content.trim() !== '' || m.embed;

function normAction(a = {}) {
  const type = CC_ACTION_TYPES.includes(a.type) ? a.type : 'reply';

  if (type === 'add-role' || type === 'remove-role') {
    return { type, roleId: isId(a.roleId) ? a.roleId : '' };
  }

  const raw =
    Array.isArray(a.messages) && a.messages.length ? a.messages : [{ content: a.content, embed: a.embed }];
  let messages = raw.map(normMessage).filter(messageHasContent).slice(0, 10);
  if (!messages.length) messages = [{ content: '', embed: null }];

  const out = { type, messages };
  if (type === 'reply') out.private = Boolean(a.private);
  if (type === 'send') out.channelId = isId(a.channelId) ? a.channelId : '';
  return out;
}

const actionHasEffect = (a) =>
  a.type === 'reply' || a.type === 'send' ? a.messages.some(messageHasContent) : isId(a.roleId);

/** Migrate a pre-actions command ({ response, embed, embedTitle, embedColor }). */
function migrateLegacy(c) {
  const message = c.embed
    ? {
        content: '',
        embed: {
          title: c.embedTitle || '',
          description: c.response || '',
          color: `#${String(c.embedColor || '5b7cfa').replace('#', '')}`,
        },
      }
    : { content: c.response || '', embed: null };
  return [{ type: 'reply', private: false, messages: [message] }];
}

/** Coerce stored/submitted config into the canonical shape. */
export function normaliseCustomCommands(raw = {}) {
  const seen = new Set();
  const commands = (Array.isArray(raw.commands) ? raw.commands : [])
    .map((c, i) => {
      const actionsIn = Array.isArray(c.actions) ? c.actions : migrateLegacy(c);
      return {
        id: c.id ? String(c.id) : String(i),
        name: String(c.name ?? '')
          .trim()
          .toLowerCase(),
        description: String(c.description ?? '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 100),
        actions: actionsIn.map(normAction).slice(0, 10),
        allowedRoles: [...new Set((Array.isArray(c.allowedRoles) ? c.allowedRoles : []).filter(isId))].slice(
          0,
          25
        ),
        allowedChannels: [
          ...new Set((Array.isArray(c.allowedChannels) ? c.allowedChannels : []).filter(isId)),
        ].slice(0, 25),
        cooldownSeconds: Math.max(0, Math.min(86_400, Math.floor(Number(c.cooldownSeconds) || 0))),
      };
    })
    .filter((c) => {
      if (!NAME_RE.test(c.name) || seen.has(c.name)) return false;
      if (!c.actions.some(actionHasEffect)) return false;
      seen.add(c.name);
      return true;
    })
    .slice(0, 200);
  return { commands };
}

// --- placeholders + payload ----------------------------------------------

function fill(template, ctx) {
  return String(template ?? '')
    .replaceAll('{user}', ctx.userId ? `<@${ctx.userId}>` : '')
    .replaceAll('{username}', ctx.username ?? '')
    .replaceAll('{server}', ctx.guildName ?? '')
    .replaceAll('{channel}', ctx.channelId ? `<#${ctx.channelId}>` : '')
    .replaceAll('{args}', ctx.args ?? '');
}

const REFERENCED = (m) => `${m.content ?? ''} ${JSON.stringify(m.embed ?? '')}`;

/** Whether any message in the command references {args} (→ needs a `text` option). */
export function usesArgs(cmd) {
  return (cmd.actions ?? []).some((a) => (a.messages ?? []).some((m) => REFERENCED(m).includes('{args}')));
}

/** Pick one message block from an action (random when it has several). */
export function pickMessage(messages) {
  const list = Array.isArray(messages) && messages.length ? messages : [{ content: '', embed: null }];
  return list[Math.floor(Math.random() * list.length)];
}

/**
 * Build a Discord message payload for one message block, filling placeholders.
 * @param {{ content: string, embed: object|null }} msg
 * @param {{ userId?, username?, guildName?, channelId?, args? }} ctx
 */
export function buildActionPayload(msg, ctx) {
  const mentions = { users: ctx.userId ? [ctx.userId] : [], roles: [] };
  const out = { allowedMentions: mentions };

  if (msg?.embed) {
    const eb = buildEmbed({
      ...msg.embed,
      title: fill(msg.embed.title, ctx),
      description: fill(msg.embed.description, ctx),
      authorName: fill(msg.embed.authorName, ctx),
      footerText: fill(msg.embed.footerText, ctx),
      fields: (msg.embed.fields ?? []).map((f) => ({
        name: fill(f.name, ctx),
        value: fill(f.value, ctx),
        inline: Boolean(f.inline),
      })),
    });
    if (eb) out.embeds = [eb];
  }

  const content = fill(msg?.content, ctx).slice(0, 2000);
  if (content) out.content = content;
  if (!out.content && !out.embeds) out.content = '​'; // zero-width: send() needs something
  return out;
}

// --- legacy helper still used by the Autoresponder module ----------------

/**
 * Build a text/embed reply from the old flat shape. Kept for autoresponder.js.
 * @param {{ response: string, embed: boolean, embedTitle: string, embedColor: string }} cmd
 */
export function buildCustomReply(cmd, ctx) {
  const text = fill(cmd.response, ctx);
  const mentions = { users: ctx.userId ? [ctx.userId] : [], roles: [] };
  if (cmd.embed) {
    const embed = new EmbedBuilder()
      .setColor(parseInt((cmd.embedColor || '5b7cfa').replace('#', ''), 16))
      .setDescription(text || '​');
    const title = fill(cmd.embedTitle, ctx).trim();
    if (title) embed.setTitle(title);
    return { embeds: [embed], allowedMentions: mentions };
  }
  return { content: text.slice(0, 2000) || '​', allowedMentions: mentions };
}
