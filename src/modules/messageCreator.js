// Message Creator: turn a dashboard "spec" into a Discord message and send or
// edit it as the bot. Supports content, embeds, link buttons, role buttons
// (toggle a role on click) and a role select menu.
import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} from 'discord.js';
import { getComposedByMessage } from '../db/composedMessages.js';

const BUTTON_STYLE = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
};

const hexToInt = (h) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(h ?? ''));
  return m ? parseInt(m[1], 16) : null;
};
const trimOr = (v, max, fallback = undefined) => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : fallback;
};
const isUrl = (v) => /^https?:\/\/\S+$/i.test(String(v ?? ''));

/** Build one embed from a spec object, or null if it would be empty. */
export function buildEmbed(e) {
  const eb = new EmbedBuilder();
  let hasContent = false;

  const title = trimOr(e.title, 256);
  if (title) (eb.setTitle(title), (hasContent = true));
  const desc = trimOr(e.description, 4096);
  if (desc) (eb.setDescription(desc), (hasContent = true));
  if (isUrl(e.url)) eb.setURL(e.url);

  const color = hexToInt(e.color);
  if (color != null) eb.setColor(color);

  if (trimOr(e.authorName, 256)) {
    eb.setAuthor({
      name: trimOr(e.authorName, 256),
      iconURL: isUrl(e.authorIcon) ? e.authorIcon : undefined,
      url: isUrl(e.authorUrl) ? e.authorUrl : undefined,
    });
    hasContent = true;
  }
  if (trimOr(e.footerText, 2048)) {
    eb.setFooter({ text: trimOr(e.footerText, 2048), iconURL: isUrl(e.footerIcon) ? e.footerIcon : undefined });
    hasContent = true;
  }
  if (isUrl(e.thumbnail)) (eb.setThumbnail(e.thumbnail), (hasContent = true));
  if (isUrl(e.image)) (eb.setImage(e.image), (hasContent = true));
  if (e.timestamp) eb.setTimestamp(Date.now());

  const fields = (Array.isArray(e.fields) ? e.fields : [])
    .map((f) => ({ name: trimOr(f.name, 256), value: trimOr(f.value, 1024), inline: Boolean(f.inline) }))
    .filter((f) => f.name && f.value)
    .slice(0, 25);
  if (fields.length) (eb.addFields(fields), (hasContent = true));

  return hasContent ? eb : null;
}

function buildComponents(spec) {
  const rows = [];
  for (const row of (Array.isArray(spec.rows) ? spec.rows : []).slice(0, 5)) {
    if (row.type === 'roleselect') {
      const opts = (Array.isArray(row.options) ? row.options : [])
        .map((o) => ({
          label: trimOr(o.label, 100),
          value: String(o.roleId),
          description: trimOr(o.description, 100),
          emoji: trimOr(o.emoji, 64),
        }))
        .filter((o) => o.label && /^\d{17,20}$/.test(o.value))
        .slice(0, 25);
      if (!opts.length) continue;
      const menu = new StringSelectMenuBuilder()
        .setCustomId('msgroles')
        .setPlaceholder(trimOr(row.placeholder, 150) ?? 'Select roles')
        .setMinValues(Math.max(0, Math.min(Number(row.min) || 0, opts.length)))
        .setMaxValues(Math.max(1, Math.min(Number(row.max) || opts.length, opts.length)))
        .addOptions(opts);
      rows.push(new ActionRowBuilder().addComponents(menu));
      continue;
    }
    // button row
    const buttons = [];
    for (const b of (Array.isArray(row.buttons) ? row.buttons : []).slice(0, 5)) {
      const label = trimOr(b.label, 80);
      const emoji = trimOr(b.emoji, 64);
      if (!label && !emoji) continue;
      const btn = new ButtonBuilder();
      if (label) btn.setLabel(label);
      if (emoji) btn.setEmoji(emoji);
      if (b.style === 'link') {
        if (!isUrl(b.url)) continue;
        btn.setStyle(ButtonStyle.Link).setURL(b.url);
      } else if (/^\d{17,20}$/.test(b.roleId ?? '')) {
        btn.setStyle(BUTTON_STYLE[b.style] ?? ButtonStyle.Secondary).setCustomId(`msgrole:${b.roleId}`);
      } else {
        continue;
      }
      buttons.push(btn);
    }
    if (buttons.length) rows.push(new ActionRowBuilder().addComponents(buttons));
  }
  return rows;
}

/**
 * @param {object} spec
 * @returns {{ payload: import('discord.js').MessageCreateOptions, empty: boolean }}
 */
export function buildPayload(spec) {
  const content = trimOr(spec.content, 2000);
  const embeds = (Array.isArray(spec.embeds) ? spec.embeds : []).slice(0, 10).map(buildEmbed).filter(Boolean);
  const components = buildComponents(spec);
  const empty = !content && embeds.length === 0 && components.length === 0;
  return {
    payload: { content: content ?? '', embeds, components, allowedMentions: { parse: ['users', 'roles'] } },
    empty,
  };
}

async function resolveChannel(guild, channelId) {
  const ch = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
  if (!ch?.isTextBased()) throw new Error('Channel not found or not text-based.');
  const me = guild.members.me;
  if (me && !ch.permissionsFor(me)?.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) {
    throw new Error('The bot lacks View Channel / Send Messages / Embed Links there.');
  }
  return ch;
}

export async function sendComposed(guild, channelId, spec) {
  const { payload, empty } = buildPayload(spec);
  if (empty) throw new Error('Nothing to send — add content, an embed, or a component.');
  const channel = await resolveChannel(guild, channelId);
  const message = await channel.send(payload);
  return message;
}

export async function editComposed(guild, channelId, messageId, spec) {
  const { payload, empty } = buildPayload(spec);
  if (empty) throw new Error('Nothing to send — add content, an embed, or a component.');
  const channel = await resolveChannel(guild, channelId);
  const message = await channel.messages.fetch(messageId);
  await message.edit({ content: payload.content, embeds: payload.embeds, components: payload.components });
  return message;
}

// --- interaction handlers: role buttons + role select --------------------

async function toggleRole(interaction, roleId) {
  const role = interaction.guild.roles.cache.get(roleId);
  if (!role) return interaction.reply({ content: 'That role no longer exists.', ephemeral: true });
  if (!role.editable) {
    return interaction.reply({ content: "I can't assign that role (missing Manage Roles or ranked below it).", ephemeral: true });
  }
  const has = interaction.member.roles.cache.has(roleId);
  await interaction.member.roles[has ? 'remove' : 'add'](role, 'Message Creator role button');
  return interaction.reply({ content: `${has ? 'Removed' : 'Added'} **${role.name}**.`, ephemeral: true });
}

async function applyRoleSelect(interaction, composedSpecForMessage) {
  const row = (composedSpecForMessage?.rows ?? []).find((r) => r.type === 'roleselect');
  const menuRoleIds = new Set((row?.options ?? []).map((o) => String(o.roleId)).filter((v) => /^\d{17,20}$/.test(v)));
  if (menuRoleIds.size === 0) return interaction.reply({ content: 'This menu is no longer configured.', ephemeral: true });

  const picked = new Set(interaction.values);
  const me = interaction.guild.members.me;
  const add = [];
  const remove = [];
  for (const id of menuRoleIds) {
    const role = interaction.guild.roles.cache.get(id);
    if (!role || !role.editable || me.roles.highest.comparePositionTo(role) <= 0) continue;
    if (picked.has(id) && !interaction.member.roles.cache.has(id)) add.push(id);
    if (!picked.has(id) && interaction.member.roles.cache.has(id)) remove.push(id);
  }
  if (add.length) await interaction.member.roles.add(add, 'Message Creator role menu');
  if (remove.length) await interaction.member.roles.remove(remove, 'Message Creator role menu');
  return interaction.reply({
    content: add.length || remove.length ? 'Roles updated.' : 'No changes.',
    ephemeral: true,
  });
}

/** @param {import('discord.js').Client} client */
export function registerMessageComponentHandlers(client) {
  client.on('interactionCreate', async (interaction) => {
    try {
      if (interaction.isButton() && interaction.customId.startsWith('msgrole:')) {
        await toggleRole(interaction, interaction.customId.slice('msgrole:'.length));
      } else if (interaction.isStringSelectMenu() && interaction.customId === 'msgroles') {
        const rec = getComposedByMessage(interaction.guildId, interaction.message.id);
        await applyRoleSelect(interaction, rec?.spec);
      }
    } catch (err) {
      console.error('[messageCreator] component handler failed:', err.message);
      if (interaction.isRepliable() && !interaction.replied) {
        interaction.reply({ content: 'Something went wrong.', ephemeral: true }).catch(() => {});
      }
    }
  });
}
