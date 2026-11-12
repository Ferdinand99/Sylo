// /pay (the tax, no paying yourself or bots) and /rob (every guard, and the maths of a success and
// a failure, with the random source injected).
import './helpers/tmpDb.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/index.js';
import { getAccount } from '../src/db/economy.js';
import { doDeposit, doPay, doRob, doWithdraw, refusalText, taxOn } from '../src/modules/economy.js';
import { credit } from '../src/modules/lib/economy.js';
import { MAX_BALANCE, normaliseEconomyConfig } from '../src/modules/lib/economyConfig.js';

let n = 0;
let G;
beforeEach(() => {
  G = `5200000000000${String(++n).padStart(5, '0')}`;
});
const ROBBER = '800000000000000001';
const VICTIM = '800000000000000002';
const cfg = (over = {}) => normaliseEconomyConfig(over);
const bal = async (u) => {
  const a = await getAccount(G, u);
  return a ? { cash: Number(a.cash), bank: Number(a.bank) } : null;
};
const fund = (u, amount, config = cfg()) => credit(G, u, amount, { kind: 'staff_add', config });
const rowsIn = (g, u) =>
  db
    .prepare(
      'SELECT kind, amount, counterparty_id FROM economy_transactions WHERE guild_id = ? AND user_id = ? ORDER BY id'
    )
    .all(g, u);
const rows = (u) => rowsIn(G, u);
const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;
// A random source that returns the given values in turn.
const seq = (...values) => {
  let i = 0;
  return () => values[i++ % values.length];
};

// --- pay -----------------------------------------------------------------------------------------------

test('the tax is the configured percentage of the amount, rounded down', () => {
  assert.equal(taxOn(100, 5), 5);
  assert.equal(taxOn(99, 5), 5, 'rounded up');
  assert.equal(taxOn(10, 5), 1, 'a taxed payment always pays at least 1');
  assert.equal(taxOn(1, 1), 1);
  assert.equal(taxOn(9, 10), 1);
  assert.equal(taxOn(1000, 0), 0);
  assert.equal(taxOn(1000, 50), 500);
});

test('/pay moves the amount to the recipient and charges the tax to the sender on top', async () => {
  const config = cfg({ payTaxPercent: 10 });
  await fund(ROBBER, 500);
  const out = await doPay({ guildId: G, fromId: ROBBER, toId: VICTIM, amount: 100, config });
  assert.equal(out.ok, true);
  assert.deepEqual([out.amount, out.tax], [100, 10]);
  assert.deepEqual(await bal(ROBBER), { cash: 390, bank: 0 });
  assert.deepEqual(await bal(VICTIM), { cash: 100, bank: 0 });
  assert.deepEqual(
    rows(ROBBER).map((r) => [r.kind, r.amount]),
    [
      ['staff_add', 500],
      ['pay_out', -100],
      ['tax', -10],
    ]
  );
});

test('/pay with no tax writes no tax row', async () => {
  await fund(ROBBER, 50);
  await doPay({ guildId: G, fromId: ROBBER, toId: VICTIM, amount: 20, config: cfg() });
  assert.deepEqual(
    rows(ROBBER).map((r) => r.kind),
    ['staff_add', 'pay_out']
  );
});

test('/pay refuses yourself, bots, a switched-off command, bad amounts and too little money', async () => {
  const config = cfg({ payTaxPercent: 10 });
  await fund(ROBBER, 100);
  const pay = (over) => doPay({ guildId: G, fromId: ROBBER, toId: VICTIM, amount: 10, config, ...over });
  assert.equal((await pay({ toId: ROBBER })).reason, 'self');
  assert.equal((await pay({ toIsBot: true })).reason, 'bot');
  assert.equal((await pay({ config: cfg({ payEnabled: false }) })).reason, 'pay_off');
  assert.equal((await pay({ amount: 0 })).reason, 'invalid_amount');
  assert.equal((await pay({ amount: -3 })).reason, 'invalid_amount');
  assert.equal((await pay({ amount: 1.5 })).reason, 'invalid_amount');
  const short = await pay({ amount: 95 }); // 95 + 10 tax (9.5 rounded up) = 105 > 100
  assert.equal(short.reason, 'insufficient');
  assert.equal(short.needed, 105);
  assert.deepEqual(await bal(ROBBER), { cash: 100, bank: 0 });
  assert.equal(await bal(VICTIM), null, 'a refused payment does not even open the recipient account');
});

test('/pay takes cash only, not the bank', async () => {
  await fund(ROBBER, 100);
  await doDeposit({ guildId: G, userId: ROBBER, amount: 'all', config: cfg() });
  assert.equal(
    (await doPay({ guildId: G, fromId: ROBBER, toId: VICTIM, amount: 10, config: cfg() })).reason,
    'insufficient'
  );
});

test('the bank switch: deposit and withdraw are refused while it is off', async () => {
  const config = cfg({ bankEnabled: false });
  assert.equal((await doDeposit({ guildId: G, userId: ROBBER, amount: 5, config })).reason, 'bank_off');
  assert.equal((await doWithdraw({ guildId: G, userId: ROBBER, amount: 5, config })).reason, 'bank_off');
  assert.equal(await bal(ROBBER), null);
});

// --- rob: the guards ---------------------------------------------------------------------------------------

const rob = (over = {}) =>
  doRob({
    guildId: G,
    robberId: ROBBER,
    victimId: VICTIM,
    victimJoinedAt: T0 - 48 * HOUR,
    config: cfg({ robEnabled: true }),
    now: T0,
    random: seq(0, 0),
    ...over,
  });
/** A robber who can pay the smallest fine, and a victim worth robbing, in server `g`. */
const funded = async (g, robber = ROBBER, victim = VICTIM, victimCash = 100_000, robberCash = 100) => {
  await credit(g, victim, victimCash, { kind: 'staff_add', config: cfg() });
  await credit(g, robber, robberCash, { kind: 'staff_add', config: cfg() });
};
const robIn = (g, over = {}) => rob({ guildId: g, ...over });

test('robbing is off by default', async () => {
  assert.equal(normaliseEconomyConfig({}).robEnabled, false);
  await fund(VICTIM, 1000);
  const out = await rob({ config: cfg() });
  assert.equal(out.reason, 'rob_off');
  assert.deepEqual(await bal(VICTIM), { cash: 1000, bank: 0 });
});

test('you cannot rob yourself or a bot', async () => {
  await fund(VICTIM, 1000);
  assert.equal((await rob({ victimId: ROBBER })).reason, 'self');
  assert.equal((await rob({ victimIsBot: true })).reason, 'bot');
});

test('a victim who joined less than 24 hours ago is safe', async () => {
  await funded(G, ROBBER, VICTIM, 1000, 1000);
  const fresh = await rob({ victimJoinedAt: T0 - 23 * HOUR });
  assert.deepEqual([fresh.ok, fresh.reason, fresh.retryAt], [false, 'new_member', T0 + HOUR]);
  assert.equal((await rob({ victimJoinedAt: T0 - 24 * HOUR })).ok, true, 'exactly 24 hours is enough');
});

test('when the join time cannot be read the rob is refused, not let through', async () => {
  await funded(G, ROBBER, VICTIM, 1000, 1000);
  for (const unknown of [null, undefined, 0, NaN, 'yesterday']) {
    const out = await rob({ victimJoinedAt: unknown });
    assert.deepEqual([out.ok, out.reason], [false, 'join_unknown'], String(unknown));
  }
  assert.deepEqual(await bal(VICTIM), { cash: 1000, bank: 0 });
  // with the protection switched off the join time does not matter
  const open = await rob({ victimJoinedAt: null, config: cfg({ robEnabled: true, robNewMemberHours: 0 }) });
  assert.equal(open.ok, true);
});

test('the robber must hold at least the smallest fine in cash to attempt a rob', async () => {
  await fund(VICTIM, 1000);
  const none = await rob();
  assert.deepEqual([none.ok, none.reason], [false, 'robber_poor']);
  await fund(ROBBER, 24);
  assert.equal((await rob()).reason, 'robber_poor', '24 is below the smallest fine of 25');
  // money in the bank does not count: it could not be taken for the fine
  await doDeposit({ guildId: G, userId: ROBBER, amount: 'all', config: cfg() });
  assert.equal((await rob()).reason, 'robber_poor');
  assert.deepEqual(await bal(ROBBER), { cash: 0, bank: 24 });
  await fund(ROBBER, 25);
  assert.equal((await rob()).ok, true, 'exactly the smallest fine is enough');
  assert.match(
    refusalText({ reason: 'robber_poor', needed: 25 }, cfg()),
    /You need at least .*25.* cash to attempt a rob/
  );
});

test('a robber with no cash cannot count on a free failure: the attempt is refused and nothing is written', async () => {
  await fund(VICTIM, 1000);
  assert.equal((await rob({ random: seq(0.99) })).reason, 'robber_poor');
  assert.equal(await bal(ROBBER), null, 'no account was opened either');
  assert.equal(rows(VICTIM).length, 1);
});

test('the victim must hold the minimum cash (bank money does not count)', async () => {
  await fund(ROBBER, 100);
  await fund(VICTIM, 99);
  assert.equal((await rob()).reason, 'victim_poor');
  await fund(VICTIM, 1);
  await doDeposit({ guildId: G, userId: VICTIM, amount: 'all', config: cfg() });
  assert.equal((await rob()).reason, 'victim_poor', '100 in the bank is not 100 in cash');
  assert.deepEqual(await bal(VICTIM), { cash: 0, bank: 100 });
});

test('the robber has a 4 hour cooldown, started by a success and by a failure', async () => {
  await funded(G);
  const first = await rob({ random: seq(0, 0) }); // success
  assert.equal(first.success, true);
  const early = await rob({ now: T0 + 4 * HOUR - 1, random: seq(0, 0) });
  assert.deepEqual([early.ok, early.reason, early.retryAt], [false, 'cooldown', T0 + 4 * HOUR]);

  // a failure starts it too
  const G2 = `${G}9`;
  await funded(G2);
  assert.equal((await robIn(G2, { now: T0, random: seq(0.99) })).success, false);
  assert.equal((await robIn(G2, { now: T0 + HOUR, random: seq(0) })).reason, 'cooldown');
  assert.equal((await robIn(G2, { now: T0 + 4 * HOUR, random: seq(0, 0) })).ok, true);
});

test('after a successful robbery the victim is protected for an hour; a failed one does not protect', async () => {
  const other = '800000000000000003';
  await funded(G);
  await fund(other, 100);
  assert.equal((await rob({ random: seq(0, 0) })).success, true);
  const again = await rob({ robberId: other, now: T0 + 59 * 60_000, random: seq(0, 0) });
  assert.deepEqual([again.ok, again.reason, again.retryAt], [false, 'victim_protected', T0 + HOUR]);
  assert.equal((await rob({ robberId: other, now: T0 + HOUR, random: seq(0, 0) })).success, true);

  // a failed attempt leaves no protection behind
  const G2 = `${G}8`;
  await funded(G2);
  await credit(G2, other, 100, { kind: 'staff_add', config: cfg() });
  assert.equal((await robIn(G2, { random: seq(0.99) })).success, false);
  assert.equal((await robIn(G2, { robberId: other, random: seq(0, 0) })).success, true);
});

// --- rob: the maths ----------------------------------------------------------------------------------------

test('a success steals a share of the victim cash between min and max percent', async () => {
  await fund(VICTIM, 1000);
  await fund(ROBBER, 50);
  // roll 0 -> success (0 * 100 < 40); the second draw picks the percentage: 0 -> 10%
  const low = await rob({ random: seq(0, 0) });
  assert.deepEqual([low.ok, low.success, low.amount], [true, true, 100]);
  assert.deepEqual(await bal(VICTIM), { cash: 900, bank: 0 });
  assert.deepEqual(await bal(ROBBER), { cash: 150, bank: 0 });
  assert.deepEqual(
    rows(VICTIM).map((r) => [r.kind, r.amount, r.counterparty_id]),
    [
      ['staff_add', 1000, null],
      ['rob_loss', -100, ROBBER],
    ]
  );
  assert.deepEqual(
    rows(ROBBER).map((r) => [r.kind, r.amount, r.counterparty_id]),
    [
      ['staff_add', 50, null],
      ['rob_win', 100, VICTIM],
    ]
  );
});

test('the highest roll still within the chance steals up to the maximum percent', async () => {
  await fund(VICTIM, 1000);
  await fund(ROBBER, 25);
  // 0.3999 * 100 = 39.99 < 40 -> success; 0.999999 -> 30%
  const high = await rob({ random: seq(0.3999, 0.999999) });
  assert.deepEqual([high.success, high.amount], [true, 300]);
});

test('a roll at or past the chance fails: the robber pays the fine to the victim', async () => {
  await fund(VICTIM, 1000);
  await fund(ROBBER, 1000);
  // 0.4 * 100 = 40, not < 40 -> failure. Fine: max(25, 10% of 1000 = 100) = 100
  const out = await rob({ random: seq(0.4) });
  assert.deepEqual([out.ok, out.success, out.amount], [true, false, 100]);
  assert.deepEqual(await bal(ROBBER), { cash: 900, bank: 0 });
  assert.deepEqual(await bal(VICTIM), { cash: 1100, bank: 0 });
  assert.deepEqual(rows(ROBBER).at(-1), { kind: 'rob_fine_out', amount: -100, counterparty_id: VICTIM });
  assert.deepEqual(rows(VICTIM).at(-1), { kind: 'rob_fine_in', amount: 100, counterparty_id: ROBBER });
});

test('the fine is at least 25 and is always paid from cash, never from the bank', async () => {
  await fund(VICTIM, 1000);
  await fund(ROBBER, 100); // 10% = 10 -> 25
  assert.equal((await rob({ random: seq(0.9) })).amount, 25);
  assert.deepEqual(await bal(ROBBER), { cash: 75, bank: 0 });

  // cash 30 with 500 in the bank: the fine is the smallest, 25, from cash; the bank is not touched
  const G2 = `${G}7`;
  await credit(G2, VICTIM, 1000, { kind: 'staff_add', config: cfg() });
  await credit(G2, ROBBER, 530, { kind: 'staff_add', config: cfg() });
  await doDeposit({ guildId: G2, userId: ROBBER, amount: 500, config: cfg() });
  const out = await robIn(G2, { random: seq(0.9) });
  assert.equal(out.amount, 25);
  const robber = await getAccount(G2, ROBBER);
  assert.deepEqual([Number(robber.cash), Number(robber.bank)], [5, 500]);
});

test('with a smallest fine of 0 the robber still needs 1 cash, so a failure costs something', async () => {
  const c = cfg({ robEnabled: true, robFineMin: 0, robFinePercent: 50 });
  await fund(VICTIM, 1000);
  assert.equal((await rob({ config: c, random: seq(0.9) })).reason, 'robber_poor');
  await fund(ROBBER, 1);
  const out = await rob({ config: c, random: seq(0.9) });
  assert.deepEqual([out.success, out.amount], [false, 1]);
});

test('only cash can be stolen, and the share is of the victim cash at that moment', async () => {
  await fund(ROBBER, 100);
  await fund(VICTIM, 1000);
  await doDeposit({ guildId: G, userId: VICTIM, amount: 800, config: cfg() }); // cash 200, bank 800
  const out = await rob({ random: seq(0, 0.999999) }); // 30% of 200
  assert.equal(out.amount, 60);
  assert.deepEqual(await bal(VICTIM), { cash: 140, bank: 800 });
});

test('every rob value is configurable within bounds, and the bounds hold', async () => {
  const c = normaliseEconomyConfig({
    robEnabled: true,
    robChancePercent: 100,
    robMinPercent: 50,
    robMaxPercent: 10,
    robFinePercent: 500,
    robFineMin: -4,
    robCooldownHours: 0,
    robVictimMinCash: -1,
    robNewMemberHours: 99999,
    robProtectionMinutes: 99999,
  });
  assert.equal(c.robChancePercent, 99);
  assert.equal(c.robMaxPercent, 50, 'max is never below min');
  assert.equal(c.robFinePercent, 100);
  assert.equal(c.robFineMin, 0);
  assert.equal(c.robCooldownHours, 1);
  assert.equal(c.robVictimMinCash, 0);
  assert.equal(c.robNewMemberHours, 720);
  assert.equal(c.robProtectionMinutes, 1440);

  // custom values are used
  const custom = cfg({
    robEnabled: true,
    robMinPercent: 20,
    robMaxPercent: 20,
    robVictimMinCash: 10,
    robCooldownHours: 1,
  });
  await fund(VICTIM, 50);
  await fund(ROBBER, 100);
  const out = await rob({ config: custom, random: seq(0, 0) });
  assert.equal(out.amount, 10, '20% of 50');
});

test('a robbery that would take the robber over the cap takes only what fits', async () => {
  await fund(VICTIM, 1000);
  await fund(ROBBER, MAX_BALANCE - 40);
  const out = await rob({ random: seq(0, 0.999999) }); // 30% = 300, room 40
  assert.equal(out.amount, 40);
  assert.deepEqual(await bal(VICTIM), { cash: 960, bank: 0 });
});

test('two robberies of the same victim at once: only one gets through', async () => {
  const other = '800000000000000003';
  await fund(VICTIM, 10_000);
  await fund(ROBBER, 100);
  await fund(other, 100);
  const results = await Promise.all([
    rob({ random: seq(0, 0) }),
    rob({ robberId: other, random: seq(0, 0) }),
  ]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.find((r) => !r.ok).reason, 'victim_protected');
});

test('refusal sentences are plain and mention when to try again', () => {
  const config = cfg();
  assert.match(refusalText({ reason: 'cooldown', retryAt: T0 }, config), /try again <t:1700000000:R>/);
  assert.match(refusalText({ reason: 'rob_off' }, config), /turned off/);
  assert.match(refusalText({ reason: 'insufficient', needed: 104 }, config), /104/);
  assert.match(refusalText({ reason: 'join_unknown' }, config), /can't verify how long they've been here/);
  assert.match(refusalText({ reason: 'something-new' }, config), /did not work/);
});
