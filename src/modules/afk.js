// AFK: members run /afk; Sylo replies to anyone who mentions them and clears
// the status when they next speak.
//
// config shape: { setNickname: bool, mentionReply: bool, ignoreChannels: [] }
import { on } from './dispatch.js';
import { getAfk, setAfk, clearAfk } from '../db/afk.js';

export { getAfk, setAfk, clearAfk };

const RETURN_NOTICE_MS = 8000;

on('afk', 'messageCreate', async (message, config, guildId) => {
  if (message.author?.bot || !message.member || !message.guild) return;
  if (Array.isArray(config.ignoreChannels) && config.ignoreChannels.includes(message.channelId)) return;

  // The author is coming back from AFK.
  const own = getAfk(guildId, message.author.id);
  if (own) {
    clearAfk(guildId, message.author.id);
    if (config.setNickname !== false && own.old_nick !== null && message.member.manageable) {
      message.member.setNickname(own.old_nick || null, 'Back from AFK').catch(() => {});
    }
    const notice = await message.reply({
      content: '👋 Welcome back — cleared your AFK.',
      allowedMentions: { repliedUser: false },
    }).catch(() => null);
    if (notice) setTimeout(() => notice.delete().catch(() => {}), RETURN_NOTICE_MS);
    return;
  }

  // Someone mentioned people who are AFK.
  if (config.mentionReply === false) return;
  const targets = [...message.mentions.users.keys()]
    .filter((uid) => uid !== message.author.id)
    .slice(0, 4);
  const lines = [];
  for (const uid of targets) {
    const afk = getAfk(guildId, uid);
    if (afk) lines.push(`<@${uid}> is AFK: ${afk.reason} · <t:${Math.floor(afk.since / 1000)}:R>`);
  }
  if (lines.length) {
    await message.reply({ content: lines.join('\n'), allowedMentions: { parse: [] } }).catch(() => {});
  }
});
