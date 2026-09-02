// Reaction roles & autoroles.
//
// config shape:
//   {
//     autoroles: ["<roleId>", ...],
//     reactionMessages: [
//       {
//         id, channelId, messageId,
//         style: "reaction" | "buttons" | "select",   // how members pick a role
//         message: "",                 // plain text above the embed
//         embed: { ...embed spec },    // built with the WYSIWYG editor
//         exclusive: false,            // only one role from this set at a time
//         mode: "default" | "reverse", // reverse = the interaction removes the role
//         placeholder: "",             // select-menu placeholder (style: select)
//         pairs: [{ key, display, react, roleId, label?, btnStyle? }],
//       }
//     ]
//   }
// `key` identifies a reaction (custom emoji id or unicode char). For the button
// and select styles the emoji is optional; `label` / `btnStyle` drive the button.
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  StringSelectMenuBuilder,
} from 'discord.js';
import { on } from './dispatch.js';
import { runtime } from '../runtime.js';
import { getGuildModule } from '../db/modules.js';
import { buildEmbed, sendComposed, editComposed } from './messageCreator.js';
import { log } from '../lib/log.js';

const BTN_STYLE = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
};
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(+n) ? +n : lo));

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

// --- components (button / select styles) --------------------------------

/** An emoji value setEmoji() accepts: a custom-emoji id, or a unicode char. */
function emojiForPair(p) {
  if (!p || !p.key) return null;
  return /^\d+$/.test(String(p.key)) ? String(p.key) : p.display || p.key;
}

const validPairs = (rm) => (rm.pairs || []).filter((p) => /^\d{17,20}$/.test(p.roleId || ''));

/**
 * Build the button rows or select menu for a button/select-style message.
 * @returns {import('discord.js').ActionRowBuilder[]}
 */
export function buildRoleComponents(guild, rm) {
  const pairs = validPairs(rm);
  if (!pairs.length) return [];
  const nameOf = (id) => guild.roles.cache.get(id)?.name ?? 'role';

  if (rm.style === 'select') {
    const options = pairs.slice(0, 25).map((p) => {
      const opt = { label: (p.label || nameOf(p.roleId)).slice(0, 100) || 'role', value: p.roleId };
      const emoji = emojiForPair(p);
      if (emoji) opt.emoji = emoji;
      return opt;
    });
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`rrsel:${rm.id}`)
      .setPlaceholder((rm.placeholder || 'Pick your roles').slice(0, 150))
      .setMinValues(rm.exclusive ? 0 : clamp(rm.selMin, 0, options.length))
      .setMaxValues(rm.exclusive ? 1 : clamp(rm.selMax || options.length, 1, options.length))
      .addOptions(options);
    return [new ActionRowBuilder().addComponents(menu)];
  }

  const rows = [];
  for (let i = 0; i < pairs.length && rows.length < 5; i += 5) {
    const row = new ActionRowBuilder();
    for (const p of pairs.slice(i, i + 5)) {
      const btn = new ButtonBuilder()
        .setCustomId(`rr:${rm.id}:${p.roleId}`)
        .setStyle(BTN_STYLE[p.btnStyle] || ButtonStyle.Secondary)
        .setLabel((p.label || nameOf(p.roleId)).slice(0, 80) || 'role');
      const emoji = emojiForPair(p);
      if (emoji) {
        try {
          btn.setEmoji(emoji);
        } catch {
          /* ignore an emoji Discord won't accept */
        }
      }
      row.addComponents(btn);
    }
    rows.push(row);
  }
  return rows;
}

// --- dashboard helper: publish / re-publish a role message --------------

/** The embed spec for a role message — the configured embed, or an auto list. */
function roleMessageEmbedSpec(rm) {
  const e = rm.embed || {};
  const hasContent = e.title || e.description || e.image || (e.fields || []).length;
  if (hasContent) return e;
  const lines = validPairs(rm)
    .map((p) => `${p.display ? `${p.display} ` : ''}<@&${p.roleId}>`)
    .join('\n');
  return { ...e, description: lines };
}

/**
 * Send (or edit) a role message. For the "reaction" style it also reconciles the
 * message's reactions; for "buttons"/"select" it attaches the components.
 * @param {import('discord.js').Guild} guild
 * @param {object} rm  entry from config.reactionMessages (see shape above)
 * @returns {Promise<string>} the message id
 */
export async function publishReactionMessage(guild, rm) {
  const style = rm.style === 'buttons' || rm.style === 'select' ? rm.style : 'reaction';
  const embedSpec = roleMessageEmbedSpec(rm);

  if (style === 'reaction') {
    const spec = { content: rm.message || '', embeds: [embedSpec] };
    let message = null;
    if (rm.messageId) {
      message = await editComposed(guild, rm.channelId, rm.messageId, spec).catch(() => null);
    }
    if (!message) message = await sendComposed(guild, rm.channelId, spec);

    const wanted = new Set(rm.pairs.map((p) => p.key));
    try {
      for (const rx of message.reactions.cache.values()) {
        const k = rx.emoji.id || rx.emoji.name;
        if (!wanted.has(k)) await rx.remove().catch(() => {});
      }
    } catch {
      /* best-effort */
    }
    for (const p of rm.pairs) {
      if (p.react) {
        await message.react(p.react).catch((err) => log.warn('roles', `react ${p.display}: ${err.message}`));
      }
    }
    return message.id;
  }

  // button / select style — send the components directly (own customId namespace).
  const channel =
    guild.channels.cache.get(rm.channelId) || (await guild.channels.fetch(rm.channelId).catch(() => null));
  if (!channel?.isTextBased?.()) throw new Error('channel not found or not a text channel');
  const payload = {
    content: rm.message || '',
    embeds: [buildEmbed(embedSpec)].filter(Boolean),
    components: buildRoleComponents(guild, rm),
    allowedMentions: { parse: [] },
  };

  let message = rm.messageId ? await channel.messages.fetch(rm.messageId).catch(() => null) : null;
  if (message) {
    await message.edit(payload);
    await message.reactions.removeAll().catch(() => {}); // in case it used to be reaction-style
  } else {
    message = await channel.send(payload);
  }
  return message.id;
}

// --- component interaction handlers (button / select styles) -----------

/** Look up a still-configured, still-enabled role message by id. */
function roleMessageById(guildId, rmId) {
  const mod = getGuildModule(guildId, 'roles');
  if (!mod.enabled) return null;
  return (mod.config.reactionMessages || []).find((x) => String(x.id) === String(rmId)) || null;
}

const ephemeral = (interaction, content) => interaction.reply({ content, flags: MessageFlags.Ephemeral });

async function handleRoleButton(interaction, rmId, roleId) {
  const rm = roleMessageById(interaction.guildId, rmId);
  if (!rm || !(rm.pairs || []).some((p) => p.roleId === roleId)) {
    return ephemeral(interaction, 'This role menu is no longer configured.');
  }
  const role = interaction.guild.roles.cache.get(roleId);
  const member = interaction.member;
  if (!role || !role.editable) {
    return ephemeral(interaction, "I can't assign that role — I'm missing Manage Roles or ranked below it.");
  }
  const has = member.roles.cache.has(roleId);

  if (rm.mode === 'reverse') {
    await member.roles[has ? 'add' : 'remove'](role, 'Reaction role button (reverse)');
    return ephemeral(interaction, has ? `Restored **${role.name}**.` : `Removed **${role.name}**.`);
  }
  if (has) {
    await member.roles.remove(role, 'Reaction role button');
    return ephemeral(interaction, `Removed **${role.name}**.`);
  }
  await member.roles.add(role, 'Reaction role button');
  if (rm.exclusive) {
    const others = validPairs(rm)
      .filter((p) => p.roleId !== roleId && member.roles.cache.has(p.roleId))
      .map((p) => p.roleId);
    if (others.length) await member.roles.remove(others, 'Reaction role button (exclusive)').catch(() => {});
  }
  return ephemeral(interaction, `Added **${role.name}**.`);
}

async function handleRoleSelect(interaction, rmId) {
  const rm = roleMessageById(interaction.guildId, rmId);
  if (!rm) return ephemeral(interaction, 'This role menu is no longer configured.');
  const menuRoleIds = validPairs(rm).map((p) => p.roleId);
  const picked = new Set(interaction.values);
  const me = interaction.guild.members.me;
  const member = interaction.member;
  const add = [];
  const remove = [];
  for (const id of menuRoleIds) {
    const role = interaction.guild.roles.cache.get(id);
    if (!role || !role.editable || me.roles.highest.comparePositionTo(role) <= 0) continue;
    if (picked.has(id) && !member.roles.cache.has(id)) add.push(id);
    if (!picked.has(id) && member.roles.cache.has(id)) remove.push(id);
  }
  if (add.length) await member.roles.add(add, 'Reaction role menu');
  if (remove.length) await member.roles.remove(remove, 'Reaction role menu');
  return ephemeral(interaction, add.length || remove.length ? 'Roles updated.' : 'No changes.');
}

/** @param {import('discord.js').Client} client */
export function registerRoleComponentHandlers(client) {
  client.on('interactionCreate', async (interaction) => {
    try {
      if (interaction.isButton() && interaction.customId.startsWith('rr:')) {
        const [, rmId, roleId] = interaction.customId.split(':');
        await handleRoleButton(interaction, rmId, roleId);
      } else if (interaction.isStringSelectMenu() && interaction.customId.startsWith('rrsel:')) {
        await handleRoleSelect(interaction, interaction.customId.slice('rrsel:'.length));
      }
    } catch (err) {
      log.error('roles', 'component handler failed:', err.message);
      if (interaction.isRepliable() && !interaction.replied) {
        interaction
          .reply({ content: 'Something went wrong updating your roles.', flags: MessageFlags.Ephemeral })
          .catch(() => {});
      }
    }
  });
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
    log.warn(
      'roles',
      `cannot assign "${role.name}" in ${guild.name}: bot lacks Manage Roles or is ranked below it`
    );
    return;
  }

  if (hit.rm.mode === 'reverse') {
    await member.roles
      .remove(role, 'Reaction role (reverse)')
      .catch((e) => log.warn('roles', `remove failed: ${e.message}`));
    return;
  }

  await member.roles
    .add(role, 'Reaction role')
    .catch((err) => log.warn('roles', `add role failed: ${err.message}`));

  if (hit.rm.exclusive) {
    const others = hit.rm.pairs
      .filter((p) => p.roleId !== hit.pair.roleId && member.roles.cache.has(p.roleId))
      .map((p) => p.roleId);
    if (others.length) await member.roles.remove(others, 'Reaction role (exclusive)').catch(() => {});
    // drop the member's other reactions on this message so it reflects the switch
    for (const rx of r.reaction.message.reactions.cache.values()) {
      if ((rx.emoji.id || rx.emoji.name) !== (r.reaction.emoji.id || r.reaction.emoji.name)) {
        rx.users.remove(r.user.id).catch(() => {});
      }
    }
  }
});

on('roles', 'reactionRemove', async (payload, config, guildId) => {
  const r = await resolveReaction(payload);
  if (!r) return;
  const hit = findPair(config, r.reaction);
  if (!hit) return;
  const guild = runtime.client.guilds.cache.get(guildId);
  const member = await guild.members.fetch(r.user.id).catch(() => null);
  const role = guild.roles.cache.get(hit.pair.roleId);
  if (!member || !role || !role.editable) return;

  if (hit.rm.mode === 'reverse') {
    await member.roles.add(role, 'Reaction role (reverse, un-react)').catch(() => {});
  } else if (!hit.rm.exclusive) {
    await member.roles.remove(role, 'Reaction role removed').catch(() => {});
  }
});
