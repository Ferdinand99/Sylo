// Welcome & leave module. config shape:
//   { joinChannel, joinMessage, leaveChannel, leaveMessage, dmMessage, useEmbed,
//     card, cardBackground }
// Placeholders: {user} {user.tag} {user.name} {user.id} {server} {memberCount}
import { EmbedBuilder, AttachmentBuilder } from 'discord.js';
import { on } from './dispatch.js';
import { sendToChannel } from './lib/send.js';
import { guildEmbedColor } from '../db/guildSettings.js';
import { renderWelcomeCard, welcomeCardAvailable } from '../bot/lib/welcomeCard.js';
import { log } from '../lib/log.js';

export const WELCOME_PLACEHOLDERS = [
  '{user}',
  '{user.tag}',
  '{user.name}',
  '{user.id}',
  '{server}',
  '{memberCount}',
];

function fill(template, member) {
  if (!template) return '';
  return template
    .replaceAll('{user.tag}', member.user.tag)
    .replaceAll('{user.name}', member.user.username)
    .replaceAll('{user.id}', member.id)
    .replaceAll('{user}', `<@${member.id}>`)
    .replaceAll('{server}', member.guild.name)
    .replaceAll('{memberCount}', String(member.guild.memberCount));
}

/** Build the welcome-card attachment for a joining member, or null. */
async function buildCard(member, config) {
  if (!config.card || !welcomeCardAvailable) return null;
  // No point rendering a card the bot can't attach — the message still goes out.
  const channel = member.guild.channels.cache.get(config.joinChannel);
  const me = member.guild.members.me;
  if (channel && me && !channel.permissionsFor(me)?.has('AttachFiles')) {
    log.warn('module:welcome', `missing Attach Files in #${channel.name} — welcome image skipped`);
    return null;
  }
  try {
    const png = await renderWelcomeCard({
      name: member.user.globalName || member.user.username,
      avatarUrl: member.user.displayAvatarURL({ extension: 'png', size: 256 }),
      memberCount: member.guild.memberCount,
      accent: guildEmbedColor(member.guild.id),
      backgroundUrl: config.cardBackground || undefined,
    });
    return png ? new AttachmentBuilder(png, { name: 'welcome.png' }) : null;
  } catch (err) {
    log.warn('module:welcome', 'welcome card render failed:', err.message);
    return null;
  }
}

function payloadFor(text, member, useEmbed, card) {
  const files = card ? [card] : [];
  if (!useEmbed) {
    return { content: text, files, allowedMentions: { users: [member.id] } };
  }
  const embed = new EmbedBuilder()
    .setColor(guildEmbedColor(member.guild.id))
    .setDescription(text)
    .setTimestamp(Date.now());
  // The card already shows the avatar — skip the thumbnail then.
  if (card) embed.setImage('attachment://welcome.png');
  else embed.setThumbnail(member.user.displayAvatarURL());
  return { embeds: [embed], files };
}

on('welcome', 'guildMemberAdd', async (member, config, guildId) => {
  if (config.joinChannel && config.joinMessage) {
    const card = await buildCard(member, config);
    await sendToChannel(
      guildId,
      config.joinChannel,
      payloadFor(fill(config.joinMessage, member), member, config.useEmbed, card)
    );
  }
  if (config.dmMessage) {
    await member.send({ content: fill(config.dmMessage, member) }).catch(() => {});
  }
});

on('welcome', 'guildMemberRemove', (member, config, guildId) => {
  if (!config.leaveChannel || !config.leaveMessage) return;
  return sendToChannel(
    guildId,
    config.leaveChannel,
    payloadFor(fill(config.leaveMessage, member), member, config.useEmbed, null)
  );
});
