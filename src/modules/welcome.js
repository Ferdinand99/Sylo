// Welcome & leave module. config shape:
//   { joinChannel, joinMessage, leaveChannel, leaveMessage, dmMessage, useEmbed }
// Placeholders: {user} {user.tag} {user.name} {user.id} {server} {memberCount}
import { EmbedBuilder } from 'discord.js';
import { on } from './dispatch.js';
import { sendToChannel } from './lib/send.js';
import { guildEmbedColor } from '../db/guildSettings.js';

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

function payloadFor(text, member, useEmbed) {
  if (!useEmbed) return { content: text, allowedMentions: { users: [member.id] } };
  return {
    embeds: [
      new EmbedBuilder()
        .setColor(guildEmbedColor(member.guild.id))
        .setDescription(text)
        .setThumbnail(member.user.displayAvatarURL())
        .setTimestamp(Date.now()),
    ],
  };
}

on('welcome', 'guildMemberAdd', async (member, config, guildId) => {
  if (config.joinChannel && config.joinMessage) {
    await sendToChannel(
      guildId,
      config.joinChannel,
      payloadFor(fill(config.joinMessage, member), member, config.useEmbed)
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
    payloadFor(fill(config.leaveMessage, member), member, config.useEmbed)
  );
});
