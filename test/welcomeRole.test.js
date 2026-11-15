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
import { getGuildModule, setGuildModule } from '../src/db/modules.js';
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
// `since` replaces the times the server stamped (they are Date.now() at the call otherwise).
const setup = (over = {}, since = null) => {
  const stored = normaliseWelcomeConfig(config(over), env.guild);
  if (since) stored.triggerSince = since;
  return store(stored);
};
// Switching the module on restarts the clock of its roles, so the module is switched on first and the
// config, with the times the test wants, is written after that.
async function store(stored) {
  await setGuildModule(GID, 'welcome', { enabled: true });
  await setGuildModule(GID, 'welcome', { config: stored });
}

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
  assert.deepEqual(clean.triggerSince, {});
  assert.deepEqual(welcomeTrigger({}), { trigger: 'join', roleIds: [], since: {} });
  assert.deepEqual(
    welcomeTrigger({ joinChannel: 'x' }),
    { trigger: 'join', roleIds: [], since: {} },
    'an old config'
  );
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

test('join mode: joining welcomes and records it, and a role gain does not welcome again', async () => {
  await setup({ trigger: 'join' });
  const m = member(U);
  await dispatch('guildMemberAdd', KEY, m);
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].content, `Welcome <@${U}>, you got  in Hedgerow HQ!`, '{role} is empty text');
  assert.equal(m.user.dms.length, 1);
  assert.equal(m.user.dms[0].content, `Hi ${m.user.username}, .`);
  assert.ok(await rows(), 'the welcome was claimed like a role welcome');
  await gain(m, ROLE.adult);
  assert.equal(posts().length, 1);
  await dispatch('guildMemberRemove', KEY, m);
  await dispatch('guildMemberAdd', KEY, member(U));
  assert.equal(posts().length, 2, 'a member who left and came back is welcomed again, as before');
});

test('join mode: a second join event of the same membership does not welcome twice', async () => {
  await setup({ trigger: 'join' });
  const m = member(U);
  await Promise.all([dispatch('guildMemberAdd', KEY, m), dispatch('guildMemberAdd', KEY, m)]);
  assert.equal(posts().length, 1);
});

test('join mode: nothing to send claims nothing', async () => {
  await setup({ trigger: 'join', joinEnabled: false, dmEnabled: false });
  await dispatch('guildMemberAdd', KEY, member(U));
  assert.equal(await rows(), null);
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
  assert.equal(
    await claimWelcome(KEY, U, { joinedAt: Date.now() - 1000 }),
    false,
    'a fresh row is left alone'
  );
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

// --- when the "before" cannot be trusted: the clock decides ----------------------------------------------

const SINCE = 1_700_000_100_000; // a role started counting at this moment
const joinedAfter = { joinedAt: SINCE + 60_000 };
const joinedBefore = { joinedAt: SINCE - 60_000 };

/** A member the module has no old roles for. `joined` is { joinedAt } as fakeMember takes it. */
function uncached(id, roleIds, joined) {
  const m = fakeMember(env.guild, id, { roleIds, ...joined });
  m.guild = env.guild;
  m.user.tag = `${m.user.username}#0`;
  m.send = async (payload) => m.user.send(payload);
  return m;
}
/** The three shapes of an update that has no usable "before". */
const untrusted = (m) => [
  { old: null, new: m }, // Fluxer sends no member it had not seen
  { old: m, new: m }, // ... which the bridge turns into the member itself
  { old: { ...copyOf(m), partial: true, roles: { cache: new Map() } }, new: m }, // a Discord partial
];

test('timestamps: the server stamps each role when it starts counting, and never takes the time from the client', () => {
  const T0 = 1_000;
  const a = ROLE.adult;
  const b = ROLE.gamer;
  assert.deepEqual(
    normaliseWelcomeConfig({ trigger: 'join', triggerRoleIds: [a] }, env.guild).triggerSince,
    {}
  );
  // switched on: every role is stamped
  let stored = normaliseWelcomeConfig({ trigger: 'role', triggerRoleIds: [a] }, env.guild, { now: T0 });
  assert.deepEqual(stored.triggerSince, { [a]: T0 });
  // already on: a kept role keeps its time, an added one is stamped now, a client-sent time is ignored
  stored = normaliseWelcomeConfig(
    { trigger: 'role', triggerRoleIds: [a, b], triggerSince: { [a]: 5, [b]: 5 } },
    env.guild,
    { prev: stored, now: T0 + 500 }
  );
  assert.deepEqual(stored.triggerSince, { [a]: T0, [b]: T0 + 500 });
  // a role that leaves the list loses its time
  stored = normaliseWelcomeConfig({ trigger: 'role', triggerRoleIds: [b] }, env.guild, {
    prev: stored,
    now: T0 + 900,
  });
  assert.deepEqual(stored.triggerSince, { [b]: T0 + 500 });
  // a role the guild does not accept gets no time either
  assert.deepEqual(
    normaliseWelcomeConfig({ trigger: 'role', triggerRoleIds: [ROLE.bot, a] }, env.guild, { now: T0 })
      .triggerSince,
    { [a]: T0 }
  );
  // back to join and on again: stamped anew, so what was held meanwhile does not count
  const off = normaliseWelcomeConfig({ trigger: 'join', triggerRoleIds: [b] }, env.guild, { prev: stored });
  assert.deepEqual(off.triggerSince, {});
  assert.deepEqual(
    normaliseWelcomeConfig({ trigger: 'role', triggerRoleIds: [b] }, env.guild, {
      prev: off,
      now: T0 + 2000,
    }).triggerSince,
    { [b]: T0 + 2000 }
  );
  assert.deepEqual(welcomeTrigger({ triggerSince: { [a]: 'x', junk: 1, [b]: 7 } }).since, { [b]: 7 });
});

test('no usable before: a member who joined after the role started counting is welcomed, once', async () => {
  for (const shape of [0, 1, 2]) {
    await purgeGuild(GID);
    env.channel.log.sent.length = 0;
    await setup({}, { [ROLE.adult]: SINCE });
    const m = uncached(U, [ROLE.adult], joinedAfter);
    await dispatch('guildMemberUpdate', KEY, untrusted(m)[shape]);
    assert.equal(posts().length, 1, `welcomed (shape ${shape})`);
    assert.match(posts()[0].content, /you got 18\+/);
    await dispatch('guildMemberUpdate', KEY, { old: null, new: m });
    assert.equal(posts().length, 1, 'once');
  }
});

test('no usable before: a member who joined before it started counting is not welcomed', async () => {
  await setup({}, { [ROLE.adult]: SINCE });
  const m = uncached(U, [ROLE.adult], joinedBefore);
  for (const update of untrusted(m)) await dispatch('guildMemberUpdate', KEY, update);
  assert.equal(posts().length, 0);
  assert.equal(await rows(), null);
});

test('no usable before: an unknown join time, or a role with no time, is skipped', async () => {
  await setup({}, { [ROLE.adult]: SINCE });
  const noTime = uncached(U, [ROLE.adult], {});
  noTime.joinedTimestamp = null;
  await dispatch('guildMemberUpdate', KEY, { old: null, new: noTime });
  assert.equal(posts().length, 0);
  assert.equal(await rows(), null);

  await setup({ triggerRoleIds: [ROLE.adult, ROLE.gamer] }, { [ROLE.gamer]: SINCE });
  await dispatch('guildMemberUpdate', KEY, { old: null, new: uncached(V, [ROLE.adult], joinedAfter) });
  assert.equal(posts().length, 0, 'the held role has no time');
});

test('no usable before, a Fluxer member: the join time is its joinedAt date', async () => {
  await setup({}, { [ROLE.adult]: SINCE });
  const m = uncached(U, [ROLE.adult], {});
  delete m.joinedTimestamp;
  m.joinedAt = new Date(SINCE + 1000);
  await dispatch('guildMemberUpdate', KEY, { old: null, new: m });
  assert.equal(posts().length, 1);
});

test('a usable before decides alone: a gain counts whatever the join time, and a holder is not a gain', async () => {
  await setup({}, { [ROLE.adult]: SINCE });
  const old = member(U); // joined long before the role started counting
  await gain(old, ROLE.adult);
  assert.equal(posts().length, 1, 'a real gain of a long-time member');
  const holder = member(V, [ROLE.adult]);
  await dispatch('guildMemberUpdate', KEY, { old: copyOf(holder), new: holder });
  assert.equal(posts().length, 1, 'an update with the role on both sides');
});

test('switching to role mode: holders from before are not welcomed, newcomers are, a role added later starts then', async () => {
  const T1 = 1_750_000_000_000;
  // the dashboard switches the mode on at T1
  const stored = normaliseWelcomeConfig(config({ triggerRoleIds: [ROLE.adult] }), env.guild, { now: T1 });
  await store(stored);
  const holder = uncached(U, [ROLE.adult], { joinedAt: T1 - 86_400_000 });
  const newcomer = uncached(V, [ROLE.adult], { joinedAt: T1 + 1000 });
  for (const m of [holder, newcomer]) await dispatch('guildMemberUpdate', KEY, { old: null, new: m });
  assert.equal(posts().length, 1, 'only the member who joined after the switch');
  assert.ok(await getWelcomeSent(KEY, V));
  assert.equal(await rows(), null);

  // a second role is added at T2: someone who joined between T1 and T2 and holds it is not welcomed
  const T2 = T1 + 86_400_000;
  const next = normaliseWelcomeConfig(config({ triggerRoleIds: [ROLE.adult, ROLE.gamer] }), env.guild, {
    prev: stored,
    now: T2,
  });
  assert.deepEqual(next.triggerSince, { [ROLE.adult]: T1, [ROLE.gamer]: T2 });
  await setGuildModule(GID, 'welcome', { enabled: true, config: next });
  const middle = uncached('700000000000000510', [ROLE.gamer], { joinedAt: T1 + 5000 });
  await dispatch('guildMemberUpdate', KEY, { old: null, new: middle });
  assert.equal(posts().length, 1, 'joined before the role was added');
  const late = uncached('700000000000000511', [ROLE.gamer], { joinedAt: T2 + 5000 });
  await dispatch('guildMemberUpdate', KEY, { old: null, new: late });
  assert.equal(posts().length, 2);
});

// --- a member welcomed on joining, and long-time members ---------------------------------------------------

test('a member welcomed in join mode is not welcomed again by a role after the switch', async () => {
  await setup({ trigger: 'join' });
  const m = member(U);
  await dispatch('guildMemberAdd', KEY, m);
  assert.equal(posts().length, 1);
  await setup({ trigger: 'role' });
  await gain(m, ROLE.adult);
  assert.equal(posts().length, 1, 'already welcomed');
  // a member who has no row (nothing was set up when they joined) still is welcomed
  const other = member(V);
  await gain(other, ROLE.adult);
  assert.equal(posts().length, 2);
});

test('a long-time member who has a welcome row is not welcomed when they lose and regain a trigger role', async () => {
  await setup();
  const m = member(U); // joined in 2023
  await gain(m, ROLE.adult);
  assert.equal(posts().length, 1);
  lose(m, ROLE.adult);
  await gain(m, ROLE.adult);
  assert.equal(posts().length, 1);
});

// --- a row left over from an earlier membership -----------------------------------------------------------

test('claimWelcome replaces a row older than the join time, minus a minute, and only that', async () => {
  const joined = 1_800_000_000_000;
  assert.equal(await claimWelcome(KEY, U, { now: joined - 86_400_000 }), true);
  assert.equal(
    await claimWelcome(KEY, U, { joinedAt: joined - 86_400_000 - 1000 }),
    false,
    'same membership'
  );
  assert.equal(
    await claimWelcome(KEY, U, { now: joined + 10, joinedAt: joined }),
    true,
    'left over: replaced'
  );
  assert.equal((await getWelcomeSent(KEY, U)).sent_at, joined + 10);
  assert.equal(await claimWelcome(KEY, U, { now: joined + 20, joinedAt: joined }), false, 'and fresh now');
  // within the minute of skew: still this membership
  assert.equal(await claimWelcome(KEY, V, { now: joined - 30_000 }), true);
  assert.equal(await claimWelcome(KEY, V, { joinedAt: joined }), false);
  // several claims at the same moment on a stale row: exactly one replaces it
  const stale = '700000000000000530';
  assert.equal(await claimWelcome(KEY, stale, { now: 1_000 }), true);
  const wins = await Promise.all(
    Array.from({ length: 8 }, () => claimWelcome(KEY, stale, { now: joined + 5, joinedAt: joined }))
  );
  assert.equal(wins.filter(Boolean).length, 1);
});

test('a rejoin after a leave nobody saw is welcomed again', async () => {
  await setup();
  // the leave was missed (module off, Sylo down): a row from long before the new membership is left
  assert.equal(await claimWelcome(KEY, U, { now: 1_000 }), true);
  const again = member(U);
  again.joinedTimestamp = Date.now() - 5_000; // rejoined five seconds ago
  await gain(again, ROLE.adult);
  assert.equal(posts().length, 1, 'the old row did not block it');
  assert.ok((await rows()).sent_at > 1_000);
});

// --- which roles count when it runs ------------------------------------------------------------------------

test('at run time only @everyone and managed roles are dropped: a role missing from the cache counts', async () => {
  const missing = '100000000000000990';
  await setGuildModule(GID, 'welcome', {
    enabled: true,
    config: {
      ...normaliseWelcomeConfig(config(), env.guild),
      triggerRoleIds: [ROLE.everyone, ROLE.bot, missing],
    },
  });
  const m = member(U);
  await gain(m, ROLE.bot);
  await gain(m, ROLE.everyone);
  assert.equal(posts().length, 0, 'managed and @everyone never start a welcome');
  const before = copyOf(m);
  m.roles.cache.set(missing, undefined);
  await dispatch('guildMemberUpdate', KEY, { old: before, new: m });
  assert.equal(posts().length, 1, 'a role the guild cache does not know yet still counts');
  assert.match(posts()[0].content, /you got {2}in/, 'its name is empty text');
});

// --- the log -----------------------------------------------------------------------------------------------

test('a skipped welcome is logged at debug level with ids, never with the message', async () => {
  const lines = [];
  const debug = log.debug;
  log.debug = (...args) => lines.push(args.join(' '));
  try {
    await setup({ joinMessage: 'SECRET-TEXT {user}', dmMessage: 'SECRET-DM' }, { [ROLE.adult]: SINCE });
    const noTime = uncached(U, [ROLE.adult], {});
    noTime.joinedTimestamp = null;
    await dispatch('guildMemberUpdate', KEY, { old: null, new: noTime });
    await dispatch('guildMemberUpdate', KEY, { old: null, new: uncached(V, [ROLE.adult], joinedBefore) });
    const done = member('700000000000000520');
    await gain(done, ROLE.adult);
    lose(done, ROLE.adult);
    await gain(done, ROLE.adult); // already welcomed
    const text = lines.join('\n');
    assert.ok(text.includes(U) && text.includes(KEY) && text.includes(ROLE.adult), 'unknown join time');
    assert.ok(text.includes(V) && /before/.test(text), 'joined before');
    assert.ok(text.includes('700000000000000520') && /already welcomed/.test(text), 'claim held');
    assert.ok(!text.includes('SECRET'), 'no message content');
  } finally {
    log.debug = debug;
  }
});

// --- switching the module itself back on --------------------------------------------------------------------

test('a role gained while Welcome was off does not welcome the member when it is switched on again', async () => {
  // set up long ago, then switched off: the gains while it was off were never seen
  await setGuildModule(GID, 'welcome', {
    enabled: false,
    config: {
      ...normaliseWelcomeConfig(config(), env.guild),
      triggerSince: { [ROLE.adult]: SINCE },
    },
  });
  const gainedWhileOff = uncached(U, [ROLE.adult], joinedAfter); // joined after the role started counting
  await dispatch('guildMemberUpdate', KEY, { old: null, new: gainedWhileOff });
  assert.equal(posts().length, 0, 'off: nothing runs');

  const before = Date.now();
  await setGuildModule(GID, 'welcome', { enabled: true });
  const { config: stored, enabled } = await getGuildModule(GID, 'welcome');
  assert.equal(enabled, true);
  assert.ok(stored.triggerSince[ROLE.adult] >= before, 'every listed role starts counting now');

  // an unrelated update (a nickname) of that member, Sylo's cache having been emptied since
  await dispatch('guildMemberUpdate', KEY, { old: null, new: gainedWhileOff });
  assert.equal(posts().length, 0, 'no late welcome');
  assert.equal(await rows(), null);

  // a member who joins after it was switched on, and gets the role, is welcomed as usual
  const later = uncached(V, [ROLE.adult], { joinedAt: Date.now() + 1000 });
  await dispatch('guildMemberUpdate', KEY, { old: null, new: later });
  assert.equal(posts().length, 1);
});

test('switching Welcome on restarts the clock only when it was off, and only in role mode', async () => {
  await setup({}, { [ROLE.adult]: SINCE });
  await setGuildModule(GID, 'welcome', { enabled: true }); // already on: nothing changes
  assert.equal((await getGuildModule(GID, 'welcome')).config.triggerSince[ROLE.adult], SINCE);
  await setGuildModule(GID, 'welcome', { enabled: false });
  await setGuildModule(GID, 'welcome', { config: { ...(await getGuildModule(GID, 'welcome')).config } });
  assert.equal((await getGuildModule(GID, 'welcome')).config.triggerSince[ROLE.adult], SINCE, 'still off');

  const joinConfig = normaliseWelcomeConfig(config({ trigger: 'join' }), env.guild);
  await setGuildModule(GID, 'welcome', { enabled: false, config: joinConfig });
  await setGuildModule(GID, 'welcome', { enabled: true });
  assert.deepEqual((await getGuildModule(GID, 'welcome')).config, joinConfig, 'join mode has no clock');

  // another module is not touched
  await setGuildModule(GID, 'sticky', {
    enabled: false,
    config: { trigger: 'role', triggerRoleIds: [ROLE.adult] },
  });
  await setGuildModule(GID, 'sticky', { enabled: true });
  assert.equal((await getGuildModule(GID, 'sticky')).config.triggerSince, undefined);
});

// --- join mode: a rejoin after a leave nobody saw -----------------------------------------------------------

test('join mode: a rejoin after a leave nobody saw is welcomed again', async () => {
  await setup({ trigger: 'join' });
  const first = member(U);
  first.joinedTimestamp = Date.now() - 3_600_000;
  await dispatch('guildMemberAdd', KEY, first);
  assert.equal(posts().length, 1);
  // the leave was never seen (module off, Sylo down): the row stays, an hour old
  await clearWelcomeSent(KEY, U);
  assert.equal(await claimWelcome(KEY, U, { now: Date.now() - 3_600_000 }), true);
  const again = member(U);
  again.joinedTimestamp = Date.now() - 5_000;
  await dispatch('guildMemberAdd', KEY, again);
  assert.equal(posts().length, 2, 'the old row did not block the new membership');
  await dispatch('guildMemberAdd', KEY, again);
  assert.equal(posts().length, 2, 'and the new one is on record');
});
