// Auto-react: automatically react (and optionally add/remove a role) when a
// message comes from a chosen user or role. No message-content reading, so
// this module needs no privileged intents.
//
// config shape (see normaliseAutoReact):
//   { cooldownSeconds: number, logChannelId: string, rules: [ {
//     id, targetUsers: string[], targetRoles: string[],
//     emojis: string[],              // custom-emoji id or unicode character, starboard-style
//     mode: 'always'|'random', chance: number (1-100, only used in 'random'),
//     roleId: string, roleAction: 'add'|'remove',
//     channelId: string,             // '' = every channel, otherwise locked to just this one
//   } ] }
// First matching rule wins, same as autoresponder's responders.
import { EmbedBuilder } from 'discord.js';
import { on } from './dispatch.js';
import { sendToChannel } from './lib/send.js';

const LOG_COLOR = 0x5b7cfa;

export const AUTO_REACT_MODES = ['always', 'random'];
export const AUTO_REACT_ROLE_ACTIONS = ['add', 'remove'];

const clampInt = (v, min, max, dflt) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
};
const id = (v) => (/^\d{17,20}$/.test(v ?? '') ? v : '');
const idList = (v) =>
  [...new Set((Array.isArray(v) ? v : [v]).filter((x) => /^\d{17,20}$/.test(x)))].slice(0, 25);

// Same emoji-key convention as starboard.js: a custom emoji is stored as just
// its numeric id (extracted from pasted `<a:name:id>` markup), a unicode
// emoji is kept as-is.
function emojiList(v) {
  return [
    ...new Set(
      (Array.isArray(v) ? v : String(v ?? '').split(/[\s,]+/))
        .map((s) => String(s).trim())
        .map((s) => {
          const m = s.match(/^<a?:\w+:(\d+)>$/);
          return m ? m[1] : s;
        })
        .filter(Boolean)
    ),
  ].slice(0, 10);
}

export function normaliseAutoReact(raw = {}) {
  return {
    cooldownSeconds: clampInt(raw.cooldownSeconds, 0, 300, 5),
    logChannelId: id(raw.logChannelId),
    rules: (Array.isArray(raw.rules) ? raw.rules : [])
      .slice(0, 25)
      .map((r, i) => ({
        id: r.id ? String(r.id) : String(i),
        targetUsers: idList(r.targetUsers),
        targetRoles: idList(r.targetRoles),
        emojis: emojiList(r.emojis),
        mode: AUTO_REACT_MODES.includes(r.mode) ? r.mode : 'always',
        chance: clampInt(r.chance, 1, 100, 50),
        roleId: id(r.roleId),
        roleAction: AUTO_REACT_ROLE_ACTIONS.includes(r.roleAction) ? r.roleAction : 'add',
        channelId: id(r.channelId),
      }))
      .filter((r) => (r.targetUsers.length > 0 || r.targetRoles.length > 0) && r.emojis.length > 0),
  };
}

export function ruleMatches(rule, message) {
  if (rule.channelId && rule.channelId !== message.channelId) return false;
  if (rule.targetUsers.includes(message.author.id)) return true;
  return rule.targetRoles.some((roleId) => message.member.roles.cache.has(roleId));
}

// A stored key is either a custom emoji's numeric id (resolved against the
// guild's current emoji list) or a unicode character used as-is.
function reactToken(key, guild) {
  if (/^\d+$/.test(key)) {
    const e = guild.emojis.cache.get(key);
    return e ? `${e.name}:${e.id}` : null;
  }
  return key;
}

// Per-author cooldown (not per-channel like autoresponder) — the point is
// limiting how often one targeted *person* gets reacted to, regardless of
// which channel they post in.
const lastFire = new Map(); // `${guildId}:${userId}` -> ts

on('auto-react', 'messageCreate', async (message, rawConfig, guildId) => {
  if (message.author?.bot || !message.member) return;
  const config = normaliseAutoReact(rawConfig);
  if (config.rules.length === 0) return;

  const key = `${guildId}:${message.author.id}`;
  const now = Date.now();
  if (now - (lastFire.get(key) ?? 0) < config.cooldownSeconds * 1000) return;

  const rule = config.rules.find((r) => ruleMatches(r, message));
  if (!rule) return;
  if (rule.mode === 'random' && Math.random() * 100 >= rule.chance) return;

  const guild = message.guild;
  const me = guild.members.me;
  if (!message.channel.permissionsFor(me)?.has(['AddReactions', 'ViewChannel'])) return;

  lastFire.set(key, now);

  for (const emojiKey of rule.emojis) {
    const tok = reactToken(emojiKey, guild);
    if (tok) await message.react(tok).catch(() => {});
  }

  let roleChanged = false;
  if (rule.roleId) {
    const role = guild.roles.cache.get(rule.roleId);
    if (role?.editable) {
      const has = message.member.roles.cache.has(role.id);
      if (rule.roleAction === 'add' && !has) {
        roleChanged = await message.member.roles
          .add(role, `Auto-react rule ${rule.id}`)
          .then(() => true)
          .catch(() => false);
      } else if (rule.roleAction === 'remove' && has) {
        roleChanged = await message.member.roles
          .remove(role, `Auto-react rule ${rule.id}`)
          .then(() => true)
          .catch(() => false);
      }
    }
  }

  if (config.logChannelId) {
    const bits = [`reacted to ${message.author.tag} (\`${message.author.id}\`) in <#${message.channelId}>`];
    if (roleChanged) {
      bits.push(`${rule.roleAction === 'remove' ? 'removed' : 'added'} <@&${rule.roleId}>`);
    }
    await sendToChannel(guildId, config.logChannelId, {
      embeds: [
        new EmbedBuilder()
          .setColor(LOG_COLOR)
          .setDescription(`🎯 ${bits.join(' · ')}`)
          .setTimestamp(Date.now()),
      ],
    });
  }
});
