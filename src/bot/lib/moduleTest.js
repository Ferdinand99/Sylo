// "Send test" from the dashboard: post one representative message for a module
// to its configured channel, so an admin can confirm the channel + permissions
// without waiting for a real trigger.
import { EmbedBuilder } from 'discord.js';
import { getGuildModule } from '../../db/modules.js';
import { guildEmbedColor } from '../../db/guildSettings.js';
import { sendToChannel } from '../../modules/lib/send.js';

/** Modules a test message makes sense for (they post to one configured channel). */
export const TESTABLE = new Set([
  'welcome',
  'birthdays',
  'logging',
  'twitch-alerts',
  'youtube-alerts',
  'starboard',
  'free-games',
]);

/**
 * @returns {Promise<{ ok: boolean, channelName?: string, reason?: 'no-channel'|'send-failed' }>}
 */
export async function sendModuleTest(guild, moduleId) {
  const cfg = getGuildModule(guild.id, moduleId).config || {};
  const color = guildEmbedColor(guild.id);
  let channelId;
  let embed;

  switch (moduleId) {
    case 'welcome':
      channelId = cfg.joinChannel;
      embed = new EmbedBuilder()
        .setColor(color)
        .setTitle('Welcome — test')
        .setDescription(`This is roughly what a join message looks like in **${guild.name}**.`);
      break;
    case 'birthdays':
      channelId = cfg.channel;
      embed = new EmbedBuilder()
        .setColor(0xf0b232)
        .setTitle('Birthdays — test')
        .setDescription('🎂 Happy birthday, birthday person! 🎉');
      break;
    case 'logging':
      channelId = cfg.channel;
      embed = new EmbedBuilder()
        .setColor(color)
        .setTitle('Server logging — test')
        .setDescription('Sample event: a member joined, changed their nickname, then a message was deleted.');
      break;
    case 'twitch-alerts':
      channelId = (cfg.alerts || [])[0]?.channelId;
      embed = new EmbedBuilder()
        .setColor(0x9146ff)
        .setTitle('SampleStreamer is live! — test')
        .setDescription('Playing **Just Chatting** · 1,234 viewers');
      break;
    case 'youtube-alerts':
      channelId = (cfg.alerts || [])[0]?.discordChannelId;
      embed = new EmbedBuilder()
        .setColor(0xff0000)
        .setTitle('New upload from Sample Channel — test')
        .setDescription('“A sample video title”');
      break;
    case 'starboard':
      channelId = (cfg.boards || [])[0]?.channelId;
      embed = new EmbedBuilder()
        .setColor(color)
        .setTitle('Starboard — test')
        .setDescription('⭐ 5 — a message that cleared the threshold would be reposted here.');
      break;
    case 'free-games':
      channelId = cfg.channelId;
      embed = new EmbedBuilder()
        .setColor(color)
        .setTitle('Free on the Epic Games Store — test')
        .setDescription('**Sample Game** — free to claim until next Thursday.');
      break;
    default:
      return { ok: false, reason: 'no-channel' };
  }

  if (!channelId) return { ok: false, reason: 'no-channel' };
  const sent = await sendToChannel(guild.id, channelId, {
    embeds: [embed],
    allowedMentions: { parse: [] },
  });
  if (!sent) return { ok: false, reason: 'send-failed' };
  const ch = guild.channels.cache.get(channelId);
  return { ok: true, channelName: ch?.name || channelId };
}
