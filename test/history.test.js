import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { addCase, setCaseActive } from '../src/db/modCases.js';
import { setCommandOverride } from '../src/db/commandOverrides.js';
import {
  execute,
  loadHistoryPage,
  historyEmbed,
  historyButtons,
  HISTORY_PAGE_SIZE,
} from '../src/bot/commands/history.js';

const user = {
  id: '910000000000000001',
  tag: 'Test',
  displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png',
};
const moderator = '910000000000000002';
async function seed(guildId, count) {
  for (let i = 0; i < count; i++)
    await addCase({
      guildId,
      userId: user.id,
      moderatorId: moderator,
      action: i % 2 ? 'ban' : 'warn',
      reason: `Powód ${i}`,
    });
}

test('history includes archived cases, newest first, and clamps to a populated final page', async () => {
  const guild = '910000000000000010';
  await seed(guild, 7);
  await setCaseActive(guild, 7, false);
  await addCase({ guildId: guild, userId: 'other-user', moderatorId: moderator, action: 'kick' });
  await seed('other-guild', 1);
  const first = await loadHistoryPage(guild, user.id);
  assert.equal(first.total, 7);
  assert.equal(first.rows[0].case_number, 7);
  assert.equal(first.rows[0].active, 0);
  const last = await loadHistoryPage(guild, user.id, 999);
  assert.equal(last.page, 2);
  assert.deepEqual(
    last.rows.map((r) => r.case_number),
    [2, 1]
  );
  const empty = await loadHistoryPage(guild, 'missing');
  assert.equal(empty.total, 0);
  assert.equal(empty.page, 1);
});

test('history embeds fit Discord limits even with maximum reasons and details', () => {
  const rows = Array.from({ length: HISTORY_PAGE_SIZE }, (_, i) => ({
    case_number: i + 1,
    action: 'timeout',
    detail: 'x'.repeat(200),
    reason: 'x'.repeat(1000),
    moderator_id: moderator,
    active: 0,
    created_at: Date.now(),
  }));
  const embed = historyEmbed(user, { rows, total: 5, page: 1, pages: 1 }).toJSON();
  assert.match(embed.fields[0].name, /archiwalny/);
  assert.match(embed.fields[0].value, /Moderator:/);
  const size =
    (embed.author?.name.length || 0) +
    (embed.description?.length || 0) +
    (embed.footer?.text.length || 0) +
    embed.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
  assert.ok(size <= 6000, size);
  assert.ok(embed.fields.every((f) => f.name.length <= 256 && f.value.length <= 1024));
  assert.ok(
    historyButtons({ page: 1, pages: 1 })[0]
      .toJSON()
      .components.every((b) => b.disabled)
  );
});

function command(guildId) {
  const payloads = [];
  const handlers = {};
  const collector = {
    ended: false,
    on: (event, fn) => {
      handlers[event] = fn;
    },
  };
  const message = { createMessageComponentCollector: () => collector };
  const interaction = {
    guild: { id: guildId },
    user: { id: moderator },
    options: { getUser: () => user, getInteger: () => null },
    deferReply: async (p) => {
      payloads.push(p);
    },
    editReply: async (p) => {
      payloads.push(p);
      return message;
    },
  };
  return { interaction, payloads, handlers, collector };
}
function click(guildId, actor = moderator, customId = 'history:next') {
  const replies = [];
  return {
    guildId,
    user: { id: actor },
    customId,
    channelId: 'channel',
    member: { roles: [] },
    inGuild: () => true,
    memberPermissions: { has: (p) => p === PermissionFlagsBits.ModerateMembers },
    reply: async (p) => {
      replies.push(p);
    },
    deferUpdate: async () => {},
    replies,
  };
}

test('history stays private, paginates, blocks another reader and rechecks disabled commands', async () => {
  const guild = '910000000000000020';
  await seed(guild, 6);
  const c = command(guild);
  await execute(c.interaction);
  assert.equal(c.payloads[0].flags, MessageFlags.Ephemeral);
  assert.deepEqual(c.payloads[1].allowedMentions, { parse: [] });
  const other = click(guild, 'another-user');
  await c.handlers.collect(other);
  assert.equal(other.replies[0].flags, MessageFlags.Ephemeral);
  assert.equal(c.payloads.length, 2);
  await c.handlers.collect(click(guild));
  assert.match(c.payloads.at(-1).embeds[0].toJSON().footer.text, /strona 2\/2/);
  await setCommandOverride(guild, 'history', { enabled: false });
  const denied = click(guild, moderator, 'history:previous');
  await c.handlers.collect(denied);
  assert.match(denied.replies[0].content, /Nie masz już dostępu/);
  assert.match(c.payloads.at(-1).embeds[0].toJSON().footer.text, /strona 2\/2/);
  c.handlers.end();
  assert.ok(
    c.payloads
      .at(-1)
      .components[0].toJSON()
      .components.every((b) => b.disabled)
  );
});

test('history empty record remains private and does not start a collector', async () => {
  const c = command('910000000000000030');
  await execute(c.interaction);
  assert.equal(c.payloads[0].flags, MessageFlags.Ephemeral);
  assert.match(c.payloads[1].embeds[0].toJSON().description, /Brak zapisanych kar/);
  assert.equal(c.handlers.collect, undefined);
});
