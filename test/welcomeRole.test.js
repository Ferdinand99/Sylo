// The Welcome module's "when a member gets a role" trigger: the settings clamp, who is welcomed and
// when, the once-per-member claim, and what leaving and a failed send do to it.
import './helpers/tmpDb.js';
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { dispatch } from '../src/modules/dispatch.js';
import {
  LIMITS,
  WELCOME_PLACEHOLDERS,
  normaliseWelcomeConfig,
  validTriggerRoleIds,
  welcomeTrigger,
} from '../src/modules/welcome.js';
import { setGuildModule } from '../src/db/modules.js';
import { claimWelcome, clearWelcomeSent, getWelcomeSent } from '../src/db/welcomeSent.js';
import { describeUserData, exportUserData, forgetUser, purgeGuild } from '../src/db/purge.js';
import { log } from '../src/lib/log.js';
import { GID, INTRO_CH, ROLE, dropFakeClient, fakeIntroGuild, fakeMember } from './helpers/fakeIntro.js';

const U = '700000000000000501';
const V = '700000000000000502';
const KEY = GID;

let env;
beforeEach(async () => {
  await purgeGuild(GID);
  env = fakeIntroGuild();
  env.guild.memberCount = 7;
});
afterEach(() => dropFakeClient());

const config = (over = {}) => ({
  trigger: 'role',
  triggerRoleIds: [ROLE.adult],
  joinEnabled: true,
  joinChannel: INTRO_CH,
  joinMessage: 'Welcome {user}, you got {role} in {server}!',
  dmEnabled: true,
  dmMessage: 'Hi {user.name}, {role}.',
  ...over,
});
// What the dashboard stores: the settings go through the normaliser, which empties a switched-off message.
const setup = (over = {}) =>
  setGuildModule(GID, 'welcome', { enabled: true, config: normaliseWelcomeConfig(config(over), env.guild) });

/** A member of the fake server, shaped the way the module reads one. */
function member(id, roleIds = []) {
  const m = fakeMember(env.guild, id, { username: `user${id.slice(-4)}`, roleIds });
  m.guild = env.guild;
  m.user.tag = `${m.user.username}#0`;
  m.send = async (payload) => m.user.send(payload);
  return m;
}
const copyOf = (m) => ({ ...m, roles: { cache: new Map(m.roles.cache) } });

/** The member gets a role: the update event carries a copy from before and the member after. */
async function gain(m, roleId) {
  const before = copyOf(m);
  m.roles.cache.set(roleId, env.guild.roles.cache.get(roleId));
  await dispatch('guildMemberUpdate', KEY, { old: before, new: m });
}
const lose = (m, roleId) => m.roles.cache.delete(roleId);
const posts = () => env.channel.log.sent;
const rows = () => getWelcomeSent(KEY, U);

// --- the settings ----------------------------------------------------------------------------------------

test('defaults: a config without the setting welcomes on join, with no roles', () => {
  const clean = normaliseWelcomeConfig({});
  assert.equal(clean.trigger, 'join');
  assert.deepEqual(clean.triggerRoleIds, []);
  assert.deepEqual(welcomeTrigger({}), { trigger: 'join', roleIds: [] });
  assert.deepEqual(welcomeTrigger({ joinChannel: 'x' }), { trigger: 'join', roleIds: [] }, 'an old config');
  assert.equal(LIMITS.triggerRoleIds.maxItems, 10);
});

test('a bad trigger falls back to join, and only the exact word role switches it on', () => {
  for (const trigger of ['JOIN', 'Role', 'roles', ' role', '', 0, null, undefined, {}, ['role'], true]) {
    assert.equal(normaliseWelcomeConfig({ trigger }).trigger, 'join', JSON.stringify(trigger));
  }
  assert.equal(normaliseWelcomeConfig({ trigger: 'role' }).trigger, 'role');
  assert.equal(welcomeTrigger({ trigger: 'weird' }).trigger, 'join');
});

test('trigger roles: ids only, no duplicates, kept in order, at most 10', () => {
  const ids = Array.from({ length: 14 }, (_, i) => `1000000000000009${String(i).padStart(2, '0')}`);
  const clean = normaliseWelcomeConfig({
    triggerRoleIds: [ids[2], ids[2], 'abc', 5, null, ['nested'], { id: 'x' }, ...ids],
  });
  assert.deepEqual(clean.triggerRoleIds, [ids[2], ...ids.filter((id) => id !== ids[2])].slice(0, 10));
  assert.equal(clean.triggerRoleIds.length, 10);
  assert.deepEqual(normaliseWelcomeConfig({ triggerRoleIds: 'not a list' }).triggerRoleIds, []);
  assert.deepEqual(welcomeTrigger({ triggerRoleIds: ids }).roleIds, ids.slice(0, 10));
});

test('trigger roles must exist, must not be @everyone and must not be managed', () => {
  const ids = [ROLE.everyone, ROLE.bot, '100000000000000999', ROLE.adult, ROLE.adult, ROLE.mod];
  assert.deepEqual(validTriggerRoleIds(env.guild, ids), [ROLE.adult, ROLE.adult, ROLE.mod]);
  const clean = normaliseWelcomeConfig({ trigger: 'role', triggerRoleIds: ids }, env.guild);
  assert.deepEqual(clean.triggerRoleIds, [ROLE.adult, ROLE.mod]);
  // 12 real roles: the 10 that fit
  for (let i = 0; i < 12; i += 1) {
    const id = `1000000000000008${String(i).padStart(2, '0')}`;
    env.guild.roles.cache.set(id, { id, name: `R${i}`, position: i, managed: false });
  }
  const many = [...env.guild.roles.cache.keys()].filter((id) => id.startsWith('1000000000000008'));
  assert.equal(normaliseWelcomeConfig({ triggerRoleIds: many }, env.guild).triggerRoleIds.length, 10);
});

test('trigger: role with no valid role saves, and then nothing fires', async () => {
  const clean = normaliseWelcomeConfig(config({ triggerRoleIds: [ROLE.bot, ROLE.everyone] }), env.guild);
  assert.equal(clean.trigger, 'role');
  assert.deepEqual(clean.triggerRoleIds, []);
  await setGuildModule(GID, 'welcome', { enabled: true, config: clean });
  const m = member(U);
  await dispatch('guildMemberAdd', KEY, m);
  await gain(m, ROLE.adult);
  await gain(m, ROLE.bot);
  assert.equal(posts().length, 0);
  assert.equal(await rows(), null, 'nothing was used up');
});

test('{role} is one of the placeholders the dashboard offers', () => {
  assert.ok(WELCOME_PLACEHOLDERS.includes('{role}'));
});

// --- role mode -----------------------------------------------------------------------------------------

test('a role gain sends the join message and the DM once, with the role name', async () => {
  await setup();
  const m = member(U);
  await gain(m, ROLE.adult);
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].content, `Welcome <@${U}>, you got 18+ in Hedgerow HQ!`);
  assert.deepEqual(posts()[0].allowedMentions, { users: [U] });
  assert.equal(m.user.dms.length, 1);
  assert.equal(m.user.dms[0].content, `Hi ${m.user.username}, 18+.`);
  const row = await rows();
  assert.ok(row && row.sent_at > 0, 'the claim row exists');
});

test('the welcome can be an embed', async () => {
  await setup({ useEmbed: true });
  await gain(member(U), ROLE.adult);
  assert.equal(posts().length, 1);
  assert.match(posts()[0].embeds[0].data.description, /you got 18\+ in Hedgerow HQ/);
});

test('a second gain of the same role, or of another trigger role, sends nothing more', async () => {
  await setup({ triggerRoleIds: [ROLE.adult, ROLE.gamer] });
  const m = member(U);
  await gain(m, ROLE.adult);
  assert.equal(posts().length, 1);
  lose(m, ROLE.adult);
  await gain(m, ROLE.adult); // lost and got back
  await gain(m, ROLE.gamer); // another trigger role
  assert.equal(posts().length, 1);
  assert.equal(m.user.dms.length, 1);
});

test('the role that started it is the first picked role the member gained', async () => {
  await setup({ triggerRoleIds: [ROLE.gamer, ROLE.adult] });
  const m = member(U);
  const before = copyOf(m);
  m.roles.cache.set(ROLE.adult, env.guild.roles.cache.get(ROLE.adult));
  m.roles.cache.set(ROLE.gamer, env.guild.roles.cache.get(ROLE.gamer));
  await dispatch('guildMemberUpdate', KEY, { old: before, new: m });
  assert.equal(posts().length, 1);
  assert.match(posts()[0].content, /you got Gamer in/);
});

test('a role that is not a trigger role sends nothing, and the first update still counts later', async () => {
  await setup();
  const m = member(U);
  await gain(m, ROLE.norway);
  assert.equal(posts().length, 0);
  assert.equal(await rows(), null);
  await gain(m, ROLE.adult);
  assert.equal(posts().length, 1);
});

test('two gain events at the same moment send exactly once', async () => {
  await setup({ triggerRoleIds: [ROLE.adult, ROLE.gamer] });
  const m = member(U);
  const a = copyOf(m);
  const b = copyOf(m);
  m.roles.cache.set(ROLE.adult, env.guild.roles.cache.get(ROLE.adult));
  m.roles.cache.set(ROLE.gamer, env.guild.roles.cache.get(ROLE.gamer));
  await Promise.all([
    dispatch('guildMemberUpdate', KEY, { old: a, new: m }),
    dispatch('guildMemberUpdate', KEY, { old: b, new: m }),
    dispatch('guildMemberUpdate', KEY, { old: a, new: m }),
  ]);
  assert.equal(posts().length, 1);
  assert.equal(m.user.dms.length, 1);
});

test('a gain and a join at the same moment send exactly once', async () => {
  await setup();
  const m = member(U);
  const before = copyOf(m);
  m.roles.cache.set(ROLE.adult, env.guild.roles.cache.get(ROLE.adult));
  await Promise.all([
    dispatch('guildMemberAdd', KEY, m),
    dispatch('guildMemberUpdate', KEY, { old: before, new: m }),
  ]);
  assert.equal(posts().length, 1);
});

test('joining sends nothing in role mode, unless the member already has a trigger role', async () => {
  await setup();
  const plain = member(U);
  await dispatch('guildMemberAdd', KEY, plain);
  assert.equal(posts().length, 0);
  assert.equal(plain.user.dms.length, 0);
  assert.equal(await rows(), null);

  const holder = member(V, [ROLE.adult]);
  await dispatch('guildMemberAdd', KEY, holder);
  assert.equal(posts().length, 1);
  assert.match(posts()[0].content, /you got 18\+/);
  assert.equal(holder.user.dms.length, 1);
  assert.ok(await getWelcomeSent(KEY, V));
  await dispatch('guildMemberAdd', KEY, holder);
  assert.equal(posts().length, 1, 'once');
});

test('a join that finds the role, and a later gain of another one, welcome once', async () => {
  await setup({ triggerRoleIds: [ROLE.adult, ROLE.gamer] });
  const m = member(U, [ROLE.adult]);
  await dispatch('guildMemberAdd', KEY, m);
  await gain(m, ROLE.gamer);
  assert.equal(posts().length, 1);
});

test('switching to role mode does not welcome members who already have the role', async () => {
  await setup();
  const old = member(U, [ROLE.adult]);
  // an unrelated update (a nickname) of a member who has held the role since before the switch
  await dispatch('guildMemberUpdate', KEY, { old: copyOf(old), new: old });
  assert.equal(posts().length, 0);
  assert.equal(await rows(), null);
});

test('without a trustworthy before there is no gain to see', async () => {
  await setup();
  const m = member(U, [ROLE.adult]);
  await dispatch('guildMemberUpdate', KEY, { old: null, new: m });
  await dispatch('guildMemberUpdate', KEY, { old: undefined, new: m });
  await dispatch('guildMemberUpdate', KEY, { old: m, new: m }); // Fluxer sends the member itself
  await dispatch('guildMemberUpdate', KEY, {
    old: { ...copyOf(m), partial: true, roles: { cache: new Map() } },
    new: m,
  });
  await dispatch('guildMemberUpdate', KEY, { old: { id: U }, new: m });
  assert.equal(posts().length, 0);
  assert.equal(await rows(), null);
});

test('nothing configured to send: nothing is claimed', async () => {
  await setup({ joinEnabled: false, dmEnabled: false });
  await gain(member(U), ROLE.adult);
  assert.equal(await rows(), null);
  assert.equal(posts().length, 0);
});

test('a welcome with only the DM turned on is sent, and used up', async () => {
  await setup({ joinEnabled: false });
  const m = member(U);
  await gain(m, ROLE.adult);
  assert.equal(posts().length, 0);
  assert.equal(m.user.dms.length, 1);
  assert.ok(await rows());
});

// --- join mode stays as it was -------------------------------------------------------------------------

test('join mode: joining welcomes, a role gain does not, and no claim is written', async () => {
  await setup({ trigger: 'join' });
  const m = member(U);
  await dispatch('guildMemberAdd', KEY, m);
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].content, `Welcome <@${U}>, you got  in Hedgerow HQ!`, '{role} is empty text');
  assert.equal(m.user.dms.length, 1);
  assert.equal(m.user.dms[0].content, `Hi ${m.user.username}, .`);
  await gain(m, ROLE.adult);
  assert.equal(posts().length, 1);
  assert.equal(await rows(), null);
  await dispatch('guildMemberAdd', KEY, m);
  assert.equal(posts().length, 2, 'every join welcomes, as before');
});

test('a config saved before the setting existed welcomes on join', async () => {
  await setGuildModule(GID, 'welcome', {
    enabled: true,
    config: { joinChannel: INTRO_CH, joinMessage: 'Hi {user}', dmMessage: '' },
  });
  await dispatch('guildMemberAdd', KEY, member(U));
  assert.equal(posts().length, 1);
});

// --- leaving ---------------------------------------------------------------------------------------------

test('the leave message is sent in both modes, and leaving clears the claim so a rejoin can be welcomed', async () => {
  const leave = { leaveEnabled: true, leaveChannel: INTRO_CH, leaveMessage: '{user.name} left {server}.' };
  for (const trigger of ['role', 'join']) {
    await purgeGuild(GID);
    env.channel.log.sent.length = 0;
    await setup({ trigger, ...leave });
    const m = member(U);
    await dispatch('guildMemberRemove', KEY, m);
    assert.equal(posts().at(-1).content, `${m.user.username} left Hedgerow HQ.`, trigger);
  }

  await purgeGuild(GID);
  env.channel.log.sent.length = 0;
  await setup({ ...leave });
  const m = member(U);
  await gain(m, ROLE.adult);
  assert.equal(posts().length, 1);
  assert.ok(await rows());
  await dispatch('guildMemberRemove', KEY, m);
  assert.equal(posts().length, 2, 'the leave message');
  assert.equal(await rows(), null, 'the claim row went with the member');
  // they come back without the role, and get it again
  const again = member(U);
  await dispatch('guildMemberAdd', KEY, again);
  assert.equal(posts().length, 2, 'role mode: joining sends nothing');
  await gain(again, ROLE.adult);
  assert.equal(posts().length, 3, 'welcomed again');
  assert.ok(await rows());
});

test('leaving without a leave message still clears the claim', async () => {
  await setup();
  const m = member(U);
  await gain(m, ROLE.adult);
  assert.ok(await rows());
  await dispatch('guildMemberRemove', KEY, m);
  assert.equal(await rows(), null);
  assert.equal(posts().length, 1, 'no leave message was configured');
});

// --- the placeholder -------------------------------------------------------------------------------------

test('{role} is filled in one pass and cannot format or ping', async () => {
  env.guild.roles.cache.set('100000000000000901', {
    id: '100000000000000901',
    name: '{user} **loud** @everyone',
    position: 1,
    managed: false,
  });
  await setup({
    triggerRoleIds: ['100000000000000901'],
    joinMessage: '[{role}]',
    dmEnabled: false,
  });
  await gain(member(U), '100000000000000901');
  assert.equal(posts().length, 1);
  const text = posts()[0].content;
  assert.ok(text.includes('{user}'), 'a name that looks like a placeholder stays as typed');
  assert.ok(!text.includes(`<@${U}>`));
  assert.ok(text.includes('\\*\\*loud\\*\\*'), 'markdown is escaped');
  assert.ok(!text.includes('@everyone'), 'no ping');
  assert.deepEqual(posts()[0].allowedMentions, { users: [U] });
});

// --- failure ---------------------------------------------------------------------------------------------

test('a failed send keeps the claim: the welcome is not sent a second time, and the log has no text', async () => {
  await setup({ joinMessage: 'SECRET-TEXT {user}', dmMessage: 'SECRET-DM' });
  env.channel.send = async () => {
    throw Object.assign(new Error('Missing Access'), { status: 403, code: 50001 });
  };
  const lines = [];
  const warn = log.warn;
  const info = log.info;
  log.warn = (...args) => lines.push(args.join(' '));
  log.info = (...args) => lines.push(args.join(' '));
  try {
    const m = member(U);
    m.send = async () => {
      throw new Error('Cannot send messages to this user');
    };
    await gain(m, ROLE.adult);
    assert.ok(await rows(), 'the row stays');
    assert.ok(
      lines.some((l) => l.includes(U) && l.includes(INTRO_CH)),
      'the failure is logged with ids'
    );
    assert.ok(!lines.join('\n').includes('SECRET'), 'no message content in the log');

    // the channel works again: a second gain still does not send
    env.channel.send = async (payload) => env.channel.log.sent.push(payload) && { id: 'x' };
    lose(m, ROLE.adult);
    await gain(m, ROLE.adult);
    assert.equal(posts().length, 0);
  } finally {
    log.warn = warn;
    log.info = info;
  }
});

test('a channel Sylo may not post in is a failed send, and keeps the claim too', async () => {
  dropFakeClient();
  env = fakeIntroGuild({ canSend: false });
  await setup({ dmEnabled: false });
  await gain(member(U), ROLE.adult);
  assert.equal(posts().length, 0);
  assert.ok(await rows());
});

// --- the claim row ---------------------------------------------------------------------------------------

test('claimWelcome: the first caller wins, others lose, a clear lets it be taken again', async () => {
  assert.equal(await claimWelcome(KEY, U), true);
  assert.equal(await claimWelcome(KEY, U), false);
  assert.equal(await claimWelcome(KEY, V), true, 'per member');
  assert.equal(await claimWelcome('900000000000000999', U), true, 'per server');
  const wins = await Promise.all(Array.from({ length: 8 }, () => claimWelcome(KEY, '700000000000000503')));
  assert.equal(wins.filter(Boolean).length, 1);
  await clearWelcomeSent(KEY, U);
  assert.equal(await getWelcomeSent(KEY, U), null);
  assert.equal(await claimWelcome(KEY, U), true);
  await purgeGuild('900000000000000999');
});

test('/forget, the export and the guild purge cover the claim row', async () => {
  await setup();
  await gain(member(U), ROLE.adult);
  await gain(member(V), ROLE.adult);
  const summary = await describeUserData(KEY, U);
  const item = summary.items.find((i) => i.key === 'welcomeSent');
  assert.equal(item.count, 1);
  assert.equal(item.kept, false);
  const dump = await exportUserData(KEY, U);
  assert.equal(dump.data.welcomeSent.length, 1);
  assert.equal(dump.data.welcomeSent[0].user_id, U);

  const result = await forgetUser(KEY, U);
  assert.equal(result.welcomeSent, 1);
  assert.equal(await getWelcomeSent(KEY, U), null);
  assert.ok(await getWelcomeSent(KEY, V), 'another member is untouched');
  assert.equal((await describeUserData(KEY, U)).erasable, 0);

  await purgeGuild(KEY);
  assert.equal(await getWelcomeSent(KEY, V), null);
});

// --- Fluxer: keyed by the platform guild key -------------------------------------------------------------

test('on Fluxer the claim and the welcome are keyed by the fluxer guild key', async () => {
  const { runtime } = await import('../src/runtime.js');
  const RAW = '900000000000000777';
  const FKEY = `fluxer:${RAW}`;
  const sent = [];
  const channel = {
    id: INTRO_CH,
    name: 'welcome',
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async (payload) => sent.push(payload) && { id: 'm1' },
  };
  const roles = new Map([
    [RAW, { id: RAW, name: '@everyone', position: 0, managed: false }],
    [ROLE.adult, { id: ROLE.adult, name: 'Member', position: 1, managed: false }],
  ]);
  const guild = {
    id: RAW,
    name: 'Fluxer HQ',
    memberCount: 3,
    channels: { cache: new Map([[INTRO_CH, channel]]), fetch: async () => channel },
    roles: { cache: roles },
    members: { cache: new Map(), me: null },
  };
  runtime.clients.fluxer = { guilds: { cache: new Map([[RAW, guild]]) }, isReady: () => true };
  try {
    await setGuildModule(FKEY, 'welcome', {
      enabled: true,
      config: config({ dmEnabled: false, triggerRoleIds: [ROLE.adult] }),
    });
    // the Fluxer SDK lists a member's roles in roleIds
    const fluxerMember = (ids) => ({
      id: U,
      guild,
      user: { id: U, username: 'fl', tag: 'fl#0', send: async () => {} },
      roles: { roleIds: ids, cache: new Map(ids.filter((i) => roles.has(i)).map((i) => [i, roles.get(i)])) },
    });
    await dispatch('guildMemberUpdate', FKEY, { old: fluxerMember([]), new: fluxerMember([ROLE.adult]) });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].content, `Welcome <@${U}>, you got Member in Fluxer HQ!`);
    assert.ok(await getWelcomeSent(FKEY, U), 'keyed by fluxer:<id>');
    assert.equal(await getWelcomeSent(RAW, U), null, 'not by the raw id');
    await dispatch('guildMemberUpdate', FKEY, { old: fluxerMember([]), new: fluxerMember([ROLE.adult]) });
    assert.equal(sent.length, 1);
    await dispatch('guildMemberRemove', FKEY, fluxerMember([]));
    assert.equal(await getWelcomeSent(FKEY, U), null);
  } finally {
    runtime.clients.fluxer = null;
    await purgeGuild(FKEY);
  }
});
