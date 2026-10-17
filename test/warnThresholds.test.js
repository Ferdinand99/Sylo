// Warn thresholds punish with the bot's own permissions, so they must not become a way for a
// moderator to kick or ban people they could not act on themselves: admins and the owner are
// never auto-punished, and a ban only happens when the bot could ban the member anyway.
// /warn add itself checks the role hierarchy, like /ban does, and only warns server members.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyWarnThresholds } from '../src/modules/moderation.js';
import { setGuildModule } from '../src/db/modules.js';
import { execute as warn } from '../src/bot/commands/warn.js';
import { listWarnings } from '../src/db/modCases.js';

const GUILD_ID = '900000000000000310';
const OWNER = '900000000000000311';

const role = (position) => ({ position, comparePositionTo: (other) => position - other.position });

function fakeMember(id, { perms = [], bannable = true, top = 1 } = {}) {
  return {
    id,
    user: { id, tag: `user${id}`, bot: false, displayAvatarURL: () => null, send: async () => {} },
    permissions: { has: (p) => perms.includes(p) },
    roles: { highest: role(top), cache: new Map() },
    bannable,
    kickable: bannable,
    moderatable: bannable,
  };
}

function fakeGuild(members) {
  const bans = [];
  return {
    bans,
    guild: {
      id: GUILD_ID,
      name: 'Test',
      ownerId: OWNER,
      channels: { cache: new Map(), fetch: async () => null },
      members: {
        me: { id: 'bot', permissions: { has: () => true }, roles: { highest: role(50) } },
        fetch: async (id) => {
          const m = members.find((x) => x.id === id);
          if (!m) throw new Error('Unknown Member');
          return m;
        },
      },
      bans: { create: async (id) => bans.push(id) },
    },
  };
}

await setGuildModule(GUILD_ID, 'moderation', {
  enabled: true,
  config: { dmOnPunish: false, warnThresholds: [{ count: 1, action: 'ban' }] },
});

test('a member with Administrator is never auto-banned', async () => {
  const admin = fakeMember('900000000000000321', { perms: ['Administrator'] });
  const { guild, bans } = fakeGuild([admin]);
  await applyWarnThresholds(guild, admin.user, 3, 'mod');
  assert.deepEqual(bans, []);
});

test('a member with Manage Server is never auto-banned', async () => {
  const manager = fakeMember('900000000000000322', { perms: ['ManageGuild'] });
  const { guild, bans } = fakeGuild([manager]);
  await applyWarnThresholds(guild, manager.user, 3, 'mod');
  assert.deepEqual(bans, []);
});

test('a member the bot cannot ban is not banned', async () => {
  const high = fakeMember('900000000000000323', { bannable: false });
  const { guild, bans } = fakeGuild([high]);
  await applyWarnThresholds(guild, high.user, 3, 'mod');
  assert.deepEqual(bans, []);
});

test('an ordinary member is still banned at the threshold', async () => {
  const plain = fakeMember('900000000000000324');
  const { guild, bans } = fakeGuild([plain]);
  await applyWarnThresholds(guild, plain.user, 3, 'mod');
  assert.deepEqual(bans, [plain.id]);
});

/** A /warn add interaction from `moderator` against `target`. */
function warnInteraction(guild, moderator, target) {
  const replies = [];
  return {
    replies,
    interaction: {
      guild,
      member: moderator,
      user: moderator.user,
      options: {
        getSubcommand: () => 'add',
        getUser: () => target.user,
        getString: () => 'spam',
      },
      reply: async (p) => replies.push(p),
      deferReply: async () => {},
      editReply: async (p) => replies.push(p),
    },
  };
}

test('/warn add refuses a target whose top role is at or above the moderator', async () => {
  const mod = fakeMember('900000000000000331', { top: 5 });
  const boss = fakeMember('900000000000000332', { top: 9 });
  const { guild, bans } = fakeGuild([mod, boss]);
  const { interaction, replies } = warnInteraction(guild, mod, boss);
  await warn(interaction);
  assert.match(replies[0].content, /above or equal to yours/);
  assert.equal((await listWarnings(GUILD_ID, boss.id)).length, 0);
  assert.deepEqual(bans, []);
});

test('/warn add refuses someone who is not in the server', async () => {
  const mod = fakeMember('900000000000000333', { top: 5 });
  const stranger = fakeMember('900000000000000334');
  const { guild } = fakeGuild([mod]);
  const { interaction, replies } = warnInteraction(guild, mod, stranger);
  await warn(interaction);
  assert.match(replies[0].content, /not a member/);
  assert.equal((await listWarnings(GUILD_ID, stranger.id)).length, 0);
});

// Warnings from the dashboard can escalate too: the person warning must outrank the target.
test('warnRefusal: the dashboard actor must outrank the target', async () => {
  const { warnRefusal } = await import('../src/bot/lib/moderation.js');
  const g = { ownerId: OWNER };
  const mod = fakeMember('900000000000000341', { top: 5 });
  const boss = fakeMember('900000000000000342', { top: 9 });
  const owner = fakeMember(OWNER, { top: 1 });
  assert.match(warnRefusal(g, mod, boss), /above or equal/);
  assert.equal(warnRefusal(g, boss, mod), null);
  assert.equal(warnRefusal(g, owner, boss), null, 'the owner may warn anyone');
  assert.match(warnRefusal(g, boss, owner), /server owner/);
  assert.match(warnRefusal(g, null, mod), /not a member/);
});
