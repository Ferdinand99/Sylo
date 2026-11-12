// Earning: chat messages (cooldown, minimum length, ignored channels and roles), voice (who counts,
// the 5-minute blocks), /daily (the streak: kept, broken, capped) and /work (the cooldown).
import './helpers/tmpDb.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/index.js';
import { getAccount } from '../src/db/economy.js';
import { setGuildModule } from '../src/db/modules.js';
import { dispatch } from '../src/modules/dispatch.js';
import {
  DAILY_STREAK_CAP,
  WORK_LINES,
  _internals,
  advanceVoiceSession,
  claimDaily,
  doWork,
  earnFromMessage,
  tickVoice,
  voiceEligible,
} from '../src/modules/economy.js';
import { DAILY_COOLDOWN_MS, normaliseEconomyConfig } from '../src/modules/lib/economyConfig.js';

let n = 0;
let G;
beforeEach(() => {
  G = `5100000000000${String(++n).padStart(5, '0')}`;
  _internals.messageCooldowns.clear();
  _internals.voiceSessions.clear();
});
const U = '800000000000000001';
const CH = '900000000000000001';
const ROLE = '900000000000000002';
const cfg = (over = {}) => normaliseEconomyConfig(over);
const cash = async (u = U) => Number((await getAccount(G, u))?.cash ?? 0);
const lastAt = 1_700_000_000_000;

// --- messages ----------------------------------------------------------------------------------------

test('a message pays a random amount between min and max (the random source is injected)', async () => {
  const config = cfg({ messageMin: 5, messageMax: 15 });
  const low = await earnFromMessage({
    guildId: G,
    userId: U,
    length: 10,
    channelId: CH,
    config,
    random: () => 0,
  });
  assert.deepEqual(low, { ok: true, amount: 5 });
  _internals.messageCooldowns.clear();
  const high = await earnFromMessage({
    guildId: G,
    userId: U,
    length: 10,
    channelId: CH,
    config,
    now: Date.now() + 120_000,
    random: () => 0.999999,
  });
  assert.deepEqual(high, { ok: true, amount: 15 });
  assert.equal(await cash(), 20);
});

test('message earning has a cooldown per member, and members do not share it', async () => {
  const config = cfg({ messageCooldownSeconds: 60 });
  const args = { guildId: G, channelId: CH, length: 10, config, random: () => 0 };
  const t0 = lastAt;
  assert.equal((await earnFromMessage({ ...args, userId: U, now: t0 })).ok, true);
  assert.deepEqual(await earnFromMessage({ ...args, userId: U, now: t0 + 30_000 }), {
    ok: false,
    reason: 'cooldown',
  });
  assert.equal((await earnFromMessage({ ...args, userId: '800000000000000002', now: t0 + 30_000 })).ok, true);
  assert.equal((await earnFromMessage({ ...args, userId: U, now: t0 + 60_000 })).ok, true);
  assert.equal(await cash(), 10);
});

test('the cooldown also holds in the database, so a restart does not reset it', async () => {
  const config = cfg({ messageCooldownSeconds: 60 });
  const args = { guildId: G, userId: U, channelId: CH, length: 10, config, random: () => 0 };
  assert.equal((await earnFromMessage({ ...args, now: lastAt })).ok, true);
  _internals.messageCooldowns.clear(); // as after a restart
  assert.deepEqual(await earnFromMessage({ ...args, now: lastAt + 10_000 }), {
    ok: false,
    reason: 'cooldown',
  });
  assert.equal(await cash(), 5);
});

test('a message shorter than the minimum length pays nothing and does not start the cooldown', async () => {
  const config = cfg({ messageMinLength: 3 });
  const args = { guildId: G, userId: U, channelId: CH, config, now: lastAt };
  assert.deepEqual(await earnFromMessage({ ...args, length: 2 }), { ok: false, reason: 'too_short' });
  assert.equal((await earnFromMessage({ ...args, length: 3 })).ok, true);
});

test('ignored channels and ignored roles pay nothing; the switch turns message earning off', async () => {
  const config = cfg({ ignoredChannels: [CH], ignoredRoles: [ROLE] });
  const args = { guildId: G, userId: U, length: 10, config, now: lastAt };
  assert.equal((await earnFromMessage({ ...args, channelId: CH })).reason, 'ignored_channel');
  assert.equal(
    (await earnFromMessage({ ...args, channelId: '900000000000000009', roleIds: [ROLE] })).reason,
    'ignored_role'
  );
  assert.equal(
    (await earnFromMessage({ ...args, channelId: '900000000000000009', roleIds: ['1'] })).ok,
    true
  );
  const off = cfg({ messageEnabled: false });
  assert.equal((await earnFromMessage({ ...args, config: off, channelId: CH })).reason, 'off');
});

test('the messageCreate handler pays through the module dispatch, and skips bots and DMs', async () => {
  await setGuildModule(G, 'economy', { enabled: true, config: { messageMin: 7, messageMax: 7 } });
  const message = (over = {}) => ({
    author: { id: U, bot: false },
    member: { roles: { cache: new Map() } },
    content: 'hello there',
    channelId: CH,
    ...over,
  });
  await dispatch('messageCreate', G, message({ author: { id: U, bot: true } }));
  await dispatch('messageCreate', G, message({ member: null }));
  assert.equal(await cash(), 0);
  await dispatch('messageCreate', G, message());
  assert.equal(await cash(), 7);
});

test('the module being off pays nothing', async () => {
  await dispatch('messageCreate', G, {
    author: { id: U, bot: false },
    member: { roles: { cache: new Map() } },
    content: 'hello there',
    channelId: CH,
  });
  assert.equal(await cash(), 0);
});

// --- voice -------------------------------------------------------------------------------------------

test('voice time adds up in 5-minute blocks and carries the remainder', () => {
  const s = { channelId: CH, at: 0, eligibleMs: 0 };
  assert.equal(advanceVoiceSession(s, 60_000, true), 0);
  assert.equal(advanceVoiceSession(s, 120_000, true), 0);
  assert.equal(advanceVoiceSession(s, 180_000, true), 0);
  assert.equal(advanceVoiceSession(s, 240_000, true), 0);
  assert.equal(advanceVoiceSession(s, 300_000, true), 1);
  assert.equal(s.eligibleMs, 0);
  assert.equal(advanceVoiceSession(s, 360_000, true), 0);
  assert.equal(s.eligibleMs, 60_000);
});

test('time when the member does not count is not paid, and a stalled tick adds at most two minutes', () => {
  const s = { channelId: CH, at: 0, eligibleMs: 0 };
  advanceVoiceSession(s, 60_000, false);
  assert.equal(s.eligibleMs, 0);
  advanceVoiceSession(s, 10 * 3_600_000, true);
  assert.equal(s.eligibleMs, 120_000);
});

const vs = (id, channelId, over = {}) => ({
  id,
  channelId,
  deaf: false,
  selfDeaf: false,
  member: { id, user: { bot: false } },
  ...over,
});
const voiceGuild = (states, afkChannelId = null) => ({
  id: G,
  afkChannelId,
  voiceStates: { cache: new Map(states.map((s) => [s.id, s])) },
});

test('voice earning rules: alone, self-deafened, server-deafened and the AFK channel do not count; bots are not company', () => {
  const a = vs('a', 'c1');
  const b = vs('b', 'c1');
  assert.equal(voiceEligible(voiceGuild([a, b]), a), true);
  assert.equal(voiceEligible(voiceGuild([a]), a), false, 'alone');
  const bot = vs('bot', 'c1', { member: { id: 'bot', user: { bot: true } } });
  assert.equal(voiceEligible(voiceGuild([a, bot]), a), false, 'a bot is not company');
  assert.equal(
    voiceEligible(voiceGuild([vs('a', 'c1', { selfDeaf: true }), b]), vs('a', 'c1', { selfDeaf: true })),
    false
  );
  assert.equal(
    voiceEligible(voiceGuild([vs('a', 'c1', { deaf: true }), b]), vs('a', 'c1', { deaf: true })),
    false
  );
  assert.equal(voiceEligible(voiceGuild([a, b], 'c1'), a), false, 'the AFK channel');
  assert.equal(voiceEligible(voiceGuild([vs('a', null), b]), vs('a', null)), false, 'not in a channel');
  assert.equal(
    voiceEligible(voiceGuild([a, vs('b', 'c2')]), a),
    false,
    'the other member is in another channel'
  );
});

test('a voice tick pays 10 per 5 eligible minutes to the members who count, and nobody else', async () => {
  await setGuildModule(G, 'economy', { enabled: true, config: { voiceEnabled: true, voiceAmount: 10 } });
  const states = [
    vs('a', 'c1'),
    vs('b', 'c1'),
    vs('c', 'c2', { selfDeaf: true }),
    vs('d', 'c2'),
    vs('e', 'c3'),
  ];
  const guild = voiceGuild(states);
  let t = lastAt;
  await tickVoice(t, { guilds: [guild] }); // opens the sessions
  let paid = 0;
  for (let i = 0; i < 5; i++) {
    t += 60_000;
    paid += await tickVoice(t, { guilds: [guild] });
  }
  assert.equal(paid, 3, 'a, b and d were paid once');
  assert.equal(await cash('a'), 10);
  assert.equal(await cash('b'), 10);
  assert.equal(await cash('c'), 0, 'self-deafened');
  assert.equal(await cash('d'), 10, 'c is deafened but still in the channel, so d is not alone');
  assert.equal(await cash('e'), 0, 'alone in the channel');
});

test('a voice tick does nothing while voice earning is off or the module is off', async () => {
  const guild = voiceGuild([vs('a', 'c1'), vs('b', 'c1')]);
  let t = lastAt;
  for (let i = 0; i < 7; i++) {
    t += 60_000;
    assert.equal(await tickVoice(t, { guilds: [guild] }), 0);
  }
  await setGuildModule(G, 'economy', { enabled: true, config: { voiceEnabled: false } });
  for (let i = 0; i < 7; i++) {
    t += 60_000;
    assert.equal(await tickVoice(t, { guilds: [guild] }), 0);
  }
  assert.equal(await cash('a'), 0);
});

// --- daily -------------------------------------------------------------------------------------------

const DAY = DAILY_COOLDOWN_MS;

test('the first /daily pays the base amount and starts a streak of 1', async () => {
  const config = cfg({ dailyBase: 100, dailyStreakBonus: 10 });
  const out = await claimDaily({ guildId: G, userId: U, config, now: lastAt });
  assert.deepEqual([out.ok, out.amount, out.streak, out.bonus], [true, 100, 1, 0]);
});

test('/daily can be claimed once per 24 hours', async () => {
  const config = cfg();
  await claimDaily({ guildId: G, userId: U, config, now: lastAt });
  const early = await claimDaily({ guildId: G, userId: U, config, now: lastAt + DAY - 1 });
  assert.deepEqual([early.ok, early.reason, early.retryAt], [false, 'cooldown', lastAt + DAY]);
  assert.equal((await claimDaily({ guildId: G, userId: U, config, now: lastAt + DAY })).ok, true);
});

test('the streak is kept within 48 hours, adds the bonus per extra day, and is capped at 7 days', async () => {
  const config = cfg({ dailyBase: 100, dailyStreakBonus: 10 });
  let t = lastAt;
  const paid = [];
  for (let i = 0; i < 9; i++) {
    const out = await claimDaily({ guildId: G, userId: U, config, now: t });
    paid.push([out.streak, out.amount]);
    t += DAY + 60_000; // a little over a day later each time
  }
  assert.deepEqual(paid, [
    [1, 100],
    [2, 110],
    [3, 120],
    [4, 130],
    [5, 140],
    [6, 150],
    [7, 160],
    [8, 160],
    [9, 160],
  ]);
  assert.equal(DAILY_STREAK_CAP, 7);
});

test('the streak breaks after 48 hours without claiming', async () => {
  const config = cfg({ dailyBase: 100, dailyStreakBonus: 10 });
  await claimDaily({ guildId: G, userId: U, config, now: lastAt });
  const kept = await claimDaily({ guildId: G, userId: U, config, now: lastAt + 2 * DAY });
  assert.equal(kept.streak, 2, 'exactly 48 hours later still counts');
  const broken = await claimDaily({ guildId: G, userId: U, config, now: lastAt + 2 * DAY + 2 * DAY + 1 });
  assert.deepEqual([broken.streak, broken.amount], [1, 100]);
});

test('two /daily at once pay once', async () => {
  const config = cfg();
  const results = await Promise.all(
    Array.from({ length: 5 }, () => claimDaily({ guildId: G, userId: U, config, now: lastAt }))
  );
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(await cash(), 100);
});

// --- work --------------------------------------------------------------------------------------------

test('/work pays between min and max with one of the built-in lines, then has a cooldown', async () => {
  const config = cfg({ workMin: 50, workMax: 150, workCooldownMinutes: 60 });
  const out = await doWork({ guildId: G, userId: U, config, now: lastAt, random: () => 0 });
  assert.equal(out.amount, 50);
  assert.equal(out.line, WORK_LINES[0]);
  assert.ok(out.line.includes('{amount}'));
  const early = await doWork({ guildId: G, userId: U, config, now: lastAt + 59 * 60_000, random: () => 0.5 });
  assert.deepEqual([early.ok, early.reason, early.retryAt], [false, 'cooldown', lastAt + 3_600_000]);
  const again = await doWork({
    guildId: G,
    userId: U,
    config,
    now: lastAt + 3_600_000,
    random: () => 0.999999,
  });
  assert.equal(again.amount, 150);
  assert.equal(await cash(), 200);
});

test('the work lines are all there and each has a place for the amount', () => {
  assert.ok(WORK_LINES.length >= 8);
  assert.ok(WORK_LINES.every((l) => l.includes('{amount}')));
  assert.ok(WORK_LINES.includes('You fixed a server rack and earned {amount}.'));
});

test('ledger rows of earning name their kind', async () => {
  const config = cfg();
  await claimDaily({ guildId: G, userId: U, config, now: lastAt });
  await doWork({ guildId: G, userId: U, config, now: lastAt, random: () => 0 });
  await earnFromMessage({
    guildId: G,
    userId: U,
    length: 10,
    channelId: CH,
    config,
    now: lastAt,
    random: () => 0,
  });
  const kinds = db
    .prepare('SELECT kind FROM economy_transactions WHERE guild_id = ? ORDER BY id')
    .all(G)
    .map((r) => r.kind);
  assert.deepEqual(kinds, ['daily', 'work', 'message']);
});
