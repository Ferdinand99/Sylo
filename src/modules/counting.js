// Counting mini-game: members count upward, one number per message, in a
// designated channel. A wrong number (or, unless allowed, the same person
// twice in a row) breaks the streak.
//
// config shape: { channelId, allowSameUser, resetOnFail, react }
// Running state (current/record/last counter) lives in the `counting` table.
import { on } from './dispatch.js';
import { getCounting, advanceCount, resetCount } from '../db/counting.js';

const OK = '✅';
const BAD = '❌';
const NUMBER_RE = /^\s*(\d{1,15})\s*$/;

on('counting', 'messageCreate', async (message, config, guildId) => {
  if (!config.channelId || message.channelId !== config.channelId) return;

  const match = NUMBER_RE.exec(message.content ?? '');
  if (!match) return; // not a counting attempt — leave chatter alone

  const value = Number(match[1]);
  const state = getCounting(guildId);
  const expected = state.current + 1;

  const sameUser = !config.allowSameUser && state.last_user_id === message.author.id;
  const wrongNumber = value !== expected;

  if (sameUser || wrongNumber) {
    return fail(message, config, guildId, {
      brokeAt: state.current,
      record: state.record,
      reason: sameUser ? 'you can\'t count twice in a row' : `the next number was **${expected}**`,
    });
  }

  advanceCount(guildId, { current: value, userId: message.author.id, messageId: message.id });

  if (config.react !== false) {
    await message.react(value > state.record ? '🎉' : OK).catch(() => {});
  }
});

async function fail(message, config, guildId, { brokeAt, record, reason }) {
  const canManage = message.channel
    .permissionsFor(message.guild.members.me)
    ?.has(['SendMessages', 'AddReactions']);

  if (config.resetOnFail === false) {
    // Reject the bad number, keep the streak.
    await message.react(BAD).catch(() => {});
    if (message.deletable) await message.delete().catch(() => {});
    return;
  }

  resetCount(guildId);
  await message.react(BAD).catch(() => {});
  if (canManage) {
    await message.channel
      .send({
        content:
          `${BAD} ${message.author} broke the count at **${brokeAt}** — ${reason}.\n` +
          `Starting over from **1**.` +
          (record ? ` Best streak so far: **${record}**.` : ''),
        allowedMentions: { users: [message.author.id] },
      })
      .catch(() => {});
  }
}
