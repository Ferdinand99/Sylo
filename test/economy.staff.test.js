// Staff changes (/eco and the dashboard): add, remove, set and reset a member, each through the
// money API with a reason and the actor in the ledger, a post in the log channel when one is set,
// and the reset of the whole economy. Also the leaderboard's order and a member's own rank.
import './helpers/tmpDb.js';
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/index.js';
import { getAccount } from '../src/db/economy.js';
import { runtime } from '../src/runtime.js';
import { balanceOf, leaderboardPage, memberPage, resetEconomy, staffAdjust } from '../src/modules/economy.js';
import { credit, deposit } from '../src/modules/lib/economy.js';
import { MAX_BALANCE, normaliseEconomyConfig } from '../src/modules/lib/economyConfig.js';

let n = 0;
let G;
let sent;
const LOG_CH = '900000000000000777';
const STAFF = '800000000000000100';
const U = '800000000000000001';
const V = '800000000000000002';
const W = '800000000000000003';

beforeEach(() => {
  G = `5300000000000${String(++n).padStart(5, '0')}`;
  sent = [];
  const channel = {
    id: LOG_CH,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async (payload) => {
      sent.push(payload);
      return { id: 'm1' };
    },
  };
  const guild = {
    id: G,
    name: 'Test',
    members: { me: null },
    channels: { cache: new Map([[LOG_CH, channel]]), fetch: async (id) => (id === LOG_CH ? channel : null) },
  };
  runtime.client = { guilds: { cache: new Map([[G, guild]]) } };
});
afterEach(() => {
  runtime.client = null;
});

const cfg = (over = {}) => normaliseEconomyConfig(over);
const ledger = (u) =>
  db.prepare('SELECT * FROM economy_transactions WHERE guild_id = ? AND user_id = ? ORDER BY id').all(G, u);
const adjust = (over) =>
  staffAdjust({ guildId: G, actorId: STAFF, userId: U, config: cfg(), reason: '', ...over });

test('staff add gives cash with the reason and the actor in the ledger', async () => {
  const out = await adjust({ action: 'add', amount: 250, reason: 'event prize' });
  assert.equal(out.ok, true);
  assert.equal(out.applied, 250);
  assert.equal(Number((await getAccount(G, U)).cash), 250);
  const [row] = ledger(U);
  assert.deepEqual(
    [row.kind, row.amount, row.actor_id, row.reason],
    ['staff_add', 250, STAFF, 'event prize']
  );
});

test('staff add is cut at the cap and says so', async () => {
  await credit(G, U, MAX_BALANCE - 5, { kind: 'staff_add', config: cfg() });
  const out = await adjust({ action: 'add', amount: 100 });
  assert.deepEqual([out.ok, out.applied, out.clamped], [true, 5, true]);
});

test('staff remove takes cash first, then the bank, and refuses more than the member has', async () => {
  await credit(G, U, 100, { kind: 'staff_add', config: cfg() });
  await deposit(G, U, 70, { config: cfg() }); // cash 30, bank 70
  const out = await adjust({ action: 'remove', amount: 50, reason: 'refund' });
  assert.deepEqual([out.ok, out.applied], [true, -50]);
  const a = await getAccount(G, U);
  assert.deepEqual([Number(a.cash), Number(a.bank)], [0, 50]);
  const last = ledger(U).at(-1);
  assert.deepEqual(
    [last.kind, last.amount, last.actor_id, last.reason],
    ['staff_remove', -50, STAFF, 'refund']
  );
  const tooMuch = await adjust({ action: 'remove', amount: 51 });
  assert.deepEqual([tooMuch.ok, tooMuch.reason], [false, 'member_poor']);
});

test('staff set puts the cash at an exact amount, including 0', async () => {
  await credit(G, U, 100, { kind: 'staff_add', config: cfg() });
  const out = await adjust({ action: 'set', amount: 9, reason: 'fix' });
  assert.deepEqual([out.ok, out.applied], [true, -91]);
  assert.equal(Number((await getAccount(G, U)).cash), 9);
  assert.equal((await adjust({ action: 'set', amount: 0 })).ok, true);
  assert.equal(Number((await getAccount(G, U)).cash), 0);
  assert.deepEqual(
    ledger(U).map((r) => [r.kind, r.amount]),
    [
      ['staff_add', 100],
      ['staff_set', -91],
      ['staff_set', -9],
    ]
  );
});

test('staff reset-user starts the member over and writes one reset row', async () => {
  const config = cfg({ startingBalance: 10 });
  await credit(G, U, 500, { kind: 'staff_add', config });
  await deposit(G, U, 200, { config });
  const out = await adjust({ action: 'reset-user', config, reason: 'new season' });
  assert.equal(out.ok, true);
  const a = await getAccount(G, U);
  assert.deepEqual([Number(a.cash), Number(a.bank)], [10, 0]);
  const last = ledger(U).at(-1);
  assert.deepEqual([last.kind, last.actor_id, last.reason], ['reset', STAFF, 'new season']);
  assert.equal(ledger(U).filter((r) => r.kind === 'reset').length, 1);
});

test('a bad action or amount is refused and changes nothing', async () => {
  assert.equal((await adjust({ action: 'delete', amount: 5 })).reason, 'invalid_action');
  assert.equal((await adjust({ action: 'add', amount: 0 })).reason, 'invalid_amount');
  assert.equal((await adjust({ action: 'add', amount: -5 })).reason, 'invalid_amount');
  assert.equal(await getAccount(G, U), null);
  assert.equal(sent.length, 0, 'nothing was logged either');
});

test('staff changes are posted to the log channel when one is set, and not otherwise', async () => {
  await adjust({ action: 'add', amount: 5, config: cfg() });
  assert.equal(sent.length, 0, 'no log channel set');

  const config = cfg({ logChannelId: LOG_CH });
  await adjust({ action: 'add', amount: 50, reason: 'prize', config });
  await adjust({ action: 'remove', amount: 10, config });
  await adjust({ action: 'set', amount: 3, config });
  await adjust({ action: 'reset-user', config });
  assert.equal(sent.length, 4);
  const text = sent.map((p) => `${p.embeds[0].data.description}`);
  assert.match(text[0], new RegExp(`<@${STAFF}> added .*50.* to <@${U}>`));
  assert.match(text[1], /removed .*10/);
  assert.match(text[2], /set the cash of .*3/);
  assert.match(text[3], /reset the account/);
  assert.equal(sent[0].embeds[0].data.fields[0].value, 'prize');
  assert.deepEqual(sent[0].allowedMentions, { parse: [] }, 'the log never pings');
});

test('a refused change is not logged, and a missing log channel never breaks the change', async () => {
  const config = cfg({ logChannelId: LOG_CH });
  await adjust({ action: 'remove', amount: 5, config });
  assert.equal(sent.length, 0);
  const gone = cfg({ logChannelId: '900000000000000999' });
  assert.equal((await adjust({ action: 'add', amount: 5, config: gone })).ok, true);
});

test('a change made from the dashboard in open mode has no actor, and says so in the log', async () => {
  const config = cfg({ logChannelId: LOG_CH });
  await staffAdjust({ guildId: G, actorId: null, userId: U, action: 'add', amount: 5, config });
  assert.equal(ledger(U)[0].actor_id, null);
  assert.match(sent[0].embeds[0].data.description, /^The dashboard added/);
});

test('resetEconomy resets every account of the server and logs it once', async () => {
  const config = cfg({ logChannelId: LOG_CH });
  await credit(G, U, 100, { kind: 'staff_add', config });
  await credit(G, V, 200, { kind: 'staff_add', config });
  const out = await resetEconomy({ guildId: G, actorId: STAFF, config });
  assert.deepEqual(out, { ok: true, accounts: 2 });
  assert.equal(Number((await getAccount(G, U)).cash), 0);
  assert.equal(Number((await getAccount(G, V)).cash), 0);
  assert.equal(ledger(U).at(-1).kind, 'reset');
  assert.equal(ledger(V).at(-1).amount, -200);
  assert.equal(sent.length, 1);
  assert.match(sent[0].embeds[0].data.description, /reset the economy: 2 account/);
});

// --- the leaderboard ---------------------------------------------------------------------------------------

test('the leaderboard orders by cash + bank, and ties are stable', async () => {
  const config = cfg();
  await credit(G, U, 100, { kind: 'staff_add', config });
  await credit(G, V, 300, { kind: 'staff_add', config });
  await credit(G, W, 200, { kind: 'staff_add', config });
  await deposit(G, U, 100, { config }); // U: 0 cash, 100 bank: total 100
  await credit(G, '800000000000000009', 200, { kind: 'staff_add', config }); // ties with W
  const board = await leaderboardPage(G, 1, 10);
  assert.deepEqual(
    board.rows.map((r) => [r.userId, r.total, r.rank]),
    [
      [V, 300, 1],
      [W, 200, 2],
      ['800000000000000009', 200, 3],
      [U, 100, 4],
    ]
  );
  assert.deepEqual([board.page, board.pages, board.total], [1, 1, 4]);
});

test('the leaderboard pages ten at a time and clamps the page', async () => {
  const config = cfg();
  for (let i = 1; i <= 25; i++)
    await credit(G, `8100000000000${String(i).padStart(5, '0')}`, i * 10, { kind: 'staff_add', config });
  const p1 = await leaderboardPage(G, 1, 10);
  const p3 = await leaderboardPage(G, 3, 10);
  assert.deepEqual([p1.rows.length, p1.pages, p1.rows[0].total, p1.rows[0].rank], [10, 3, 250, 1]);
  assert.deepEqual([p3.rows.length, p3.rows[0].rank, p3.rows.at(-1).total], [5, 21, 10]);
  assert.equal((await leaderboardPage(G, 99, 10)).page, 3, 'a page past the end shows the last');
  assert.equal((await leaderboardPage(G, -4, 10)).page, 1);
  assert.equal((await leaderboardPage(G, 'x', 10)).page, 1);
});

test('a member own rank counts the members richer than them; no account means no rank', async () => {
  const config = cfg();
  await credit(G, U, 50, { kind: 'staff_add', config });
  await credit(G, V, 500, { kind: 'staff_add', config });
  await credit(G, W, 500, { kind: 'staff_add', config });
  assert.equal((await balanceOf(G, V)).rank, 1);
  assert.equal((await balanceOf(G, W)).rank, 1, 'equal totals share a rank');
  assert.equal((await balanceOf(G, U)).rank, 3);
  const none = await balanceOf(G, '800000000000000055');
  assert.deepEqual([none.hasAccount, none.rank, none.total], [false, null, 0]);
  await deposit(G, V, 500, { config });
  const v = await balanceOf(G, V);
  assert.deepEqual([v.cash, v.bank, v.total], [0, 500, 500]);
});

test('the other server is its own economy', async () => {
  const config = cfg();
  const H = `${G}9`;
  await credit(G, U, 100, { kind: 'staff_add', config });
  await credit(H, U, 7, { kind: 'staff_add', config });
  assert.equal((await balanceOf(G, U)).total, 100);
  assert.equal((await balanceOf(H, U)).total, 7);
  assert.equal((await leaderboardPage(H, 1, 10)).total, 1);
});

test('the member page sorts by total, cash or bank in either direction', async () => {
  const config = cfg();
  await credit(G, U, 300, { kind: 'staff_add', config }); // cash 300
  await credit(G, V, 200, { kind: 'staff_add', config });
  await deposit(G, V, 200, { config }); // bank 200
  await credit(G, W, 100, { kind: 'staff_add', config });
  await deposit(G, W, 40, { config }); // cash 60 bank 40
  const order = async (opts) => (await memberPage(G, opts)).rows.map((r) => r.userId);
  assert.deepEqual(await order({ sort: 'total' }), [U, V, W]);
  assert.deepEqual(await order({ sort: 'total', dir: 'asc' }), [W, V, U]);
  assert.deepEqual(await order({ sort: 'cash' }), [U, W, V]);
  assert.deepEqual(await order({ sort: 'bank' }), [V, W, U]);
  assert.deepEqual(await order({ sort: 'bank', dir: 'asc' }), [U, W, V]);
  assert.deepEqual(
    await order({ sort: 'nonsense; DROP TABLE economy_accounts' }),
    [U, V, W],
    'unknown sorts fall back to total'
  );
  const paged = await memberPage(G, { sort: 'total', page: 2, perPage: 2 });
  assert.deepEqual([paged.page, paged.pages, paged.total, paged.rows.map((r) => r.userId)], [2, 2, 3, [W]]);
});
