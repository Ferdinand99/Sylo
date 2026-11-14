// The Economy page of the new dashboard: settings, the member list (paged, sortable, searchable),
// one member's balances and ledger, the staff changes and the reset of the whole economy, through
// /api/v2 with the stored rows and the audit log asserted. Who may call these routes is in
// v2.permissions*.test.js (helpers/v2Guarded.js lists them).
import { startWebApp } from './helpers/webApp.js';
import { v2Open, auditRows } from './helpers/v2Open.js';
import { GID } from './helpers/fakeGuild.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/index.js';
import { getGuildModule, setGuildModule } from '../src/db/modules.js';
import { getAccount } from '../src/db/economy.js';
import { purgeGuild } from '../src/db/purge.js';
import { credit, deposit } from '../src/modules/lib/economy.js';
import { auditDetail } from '../src/web/routes/v2Economy.js';

let app;
let api;
const U = '700000000000000001';
const V = '700000000000000002';
const W = '700000000000000003';
const BOT = '700000000000000004';

const member = (id, name, bot = false) => ({
  id,
  displayName: name,
  user: { id, username: name.toLowerCase(), tag: `${name.toLowerCase()}#0001`, bot },
});

test.before(async () => {
  app = await startWebApp();
  api = v2Open(app, GID);
  for (const m of [member(U, 'Alice'), member(V, 'Bob'), member(W, 'Carol'), member(BOT, 'Robo', true)]) {
    app.guild.members.cache.set(m.id, m);
  }
});
test.after(() => app.close());
beforeEach(() => purgeGuild(GID));

const json = (res) => res.json();
const enable = (config = {}) => setGuildModule(GID, 'economy', { enabled: true, config });
const cfg = {};
const give = (u, amount) => credit(GID, u, amount, { kind: 'staff_add', config: cfg });

test('the settings come back normalised with the channels, roles and the cap', async () => {
  const res = await api.get('/modules/economy/config');
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.config.currencyName, 'coins');
  assert.equal(body.config.currencyEmoji, '🪙');
  assert.equal(body.config.robEnabled, false, 'robbing is off by default');
  assert.equal(body.maxBalance, 1_000_000_000);
  assert.ok(body.channels.length > 0);
  assert.ok(Array.isArray(body.roles));
});

test('saving settings clamps every value, stores them and writes an audit row', async () => {
  const res = await api.post('/modules/economy/config', {
    currencyName: 'x'.repeat(50),
    currencyEmoji: '💰',
    messageMin: 0,
    messageMax: 99999,
    payTaxPercent: 80,
    robEnabled: true,
    robChancePercent: 100,
    startingBalance: -5,
    dailyBase: 'lots',
  });
  assert.equal(res.status, 200);
  const { config } = await json(res);
  assert.equal(config.currencyName.length, 20);
  assert.equal(config.messageMin, 1);
  assert.equal(config.messageMax, 1000);
  assert.equal(config.payTaxPercent, 50);
  assert.equal(config.robEnabled, true);
  assert.equal(config.robChancePercent, 99);
  assert.equal(config.startingBalance, 0);
  assert.equal(config.dailyBase, 100, 'an unreadable number falls back to the default');
  const stored = (await getGuildModule(GID, 'economy')).config;
  assert.equal(stored.robChancePercent, 99);
  assert.equal((await auditRows(GID, 'module:economy')).length, 1);
});

test('the member list is empty at first, then pages members with an account, richest first', async () => {
  await enable();
  const empty = await json(await api.get('/modules/economy/members'));
  assert.deepEqual([empty.rows.length, empty.total, empty.pages], [0, 0, 1]);

  await give(U, 100);
  await give(V, 300);
  await give(W, 200);
  await deposit(GID, W, 150, { config: cfg });
  const list = await json(await api.get('/modules/economy/members'));
  assert.deepEqual(
    list.rows.map((r) => [r.member.name, r.total, r.cash, r.bank]),
    [
      ['Bob', 300, 300, 0],
      ['Carol', 200, 50, 150],
      ['Alice', 100, 100, 0],
    ]
  );
  assert.equal(list.rows[0].member.inServer, true);
  assert.deepEqual([list.sort, list.dir, list.page, list.pages, list.total], ['total', 'desc', 1, 1, 3]);
});

test('the member list sorts by cash or bank, ascending or descending', async () => {
  await enable();
  await give(U, 100);
  await give(V, 300);
  await give(W, 200);
  await deposit(GID, W, 150, { config: cfg });
  const order = async (query) =>
    (await json(await api.get(`/modules/economy/members?${query}`))).rows.map((r) => r.member.name);
  assert.deepEqual(await order('sort=cash'), ['Bob', 'Alice', 'Carol']);
  assert.deepEqual(await order('sort=cash&dir=asc'), ['Carol', 'Alice', 'Bob']);
  assert.deepEqual(await order('sort=bank'), ['Carol', 'Alice', 'Bob'], 'equal banks keep a stable order');
  assert.deepEqual(await order('sort=total&dir=asc'), ['Alice', 'Carol', 'Bob']);
  assert.deepEqual(await order('sort=nonsense'), ['Bob', 'Carol', 'Alice'], 'an unknown sort is total');
});

test('the member list pages 25 at a time', async () => {
  await enable();
  for (let i = 1; i <= 30; i++) await give(`7100000000000${String(i).padStart(5, '0')}`, i);
  const p1 = await json(await api.get('/modules/economy/members?page=1'));
  const p2 = await json(await api.get('/modules/economy/members?page=2'));
  assert.deepEqual([p1.rows.length, p1.pages, p1.total, p1.rows[0].total], [25, 2, 30, 30]);
  assert.deepEqual([p2.rows.length, p2.page, p2.rows.at(-1).total], [5, 2, 1]);
  const past = await json(await api.get('/modules/economy/members?page=99'));
  assert.equal(past.page, 2);
  // members that are not in the server any more are listed with their id, and flagged
  assert.equal(p1.rows[0].member.inServer, false);
});

test('searching finds members by name or id, with zero balances for a member without an account', async () => {
  await enable();
  await give(U, 100);
  const byName = await json(await api.get('/modules/economy/members?q=ali'));
  assert.equal(byName.search, true);
  assert.deepEqual(
    byName.rows.map((r) => [r.member.name, r.total, r.hasAccount]),
    [['Alice', 100, true]]
  );
  const other = await json(await api.get('/modules/economy/members?q=carol'));
  assert.deepEqual(
    other.rows.map((r) => [r.member.name, r.total, r.hasAccount]),
    [['Carol', 0, false]]
  );
  const byId = await json(await api.get(`/modules/economy/members?q=${V}`));
  assert.equal(byId.rows[0].member.name, 'Bob');
  const none = await json(await api.get('/modules/economy/members?q=zzzz'));
  assert.deepEqual(none.rows, []);
  const bots = await json(await api.get('/modules/economy/members?q=robo'));
  assert.deepEqual(bots.rows, [], 'bots have no account to manage');
});

test('one member: balances and the newest ledger rows with the names on them', async () => {
  await enable();
  await give(U, 100);
  await credit(GID, U, 5, { kind: 'staff_add', actorId: V, reason: 'thanks', config: cfg });
  const res = await api.get(`/modules/economy/members/${U}`);
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.member.name, 'Alice');
  assert.deepEqual(body.account, { cash: 105, bank: 0, total: 105, dailyStreak: 0, hasAccount: true });
  assert.equal(body.transactionCount, 2);
  assert.deepEqual(
    [
      body.transactions[0].kind,
      body.transactions[0].amount,
      body.transactions[0].actor.name,
      body.transactions[0].reason,
    ],
    ['staff_add', 5, 'Bob', 'thanks']
  );
  assert.equal(body.transactions[0].cashAfter, 105);
  const nobody = await json(await api.get(`/modules/economy/members/${W}`));
  assert.deepEqual([nobody.account.hasAccount, nobody.transactions.length], [false, 0]);
  assert.equal((await api.get('/modules/economy/members/not-an-id')).status, 400);
});

test('the ledger shows at most the newest 50 rows and says how many there are', async () => {
  await enable();
  for (let i = 0; i < 55; i++) await give(U, 1);
  const body = await json(await api.get(`/modules/economy/members/${U}`));
  assert.equal(body.transactions.length, 50);
  assert.equal(body.transactionCount, 55);
  assert.equal(body.transactions[0].cashAfter, 55);
});

test('staff add, remove, set and reset a member from the page, each in the ledger, with an audit row', async () => {
  await enable();
  const adjust = (body) => api.post(`/modules/economy/members/${U}/adjust`, body);

  let res = await adjust({ action: 'add', amount: 500, reason: 'event prize' });
  assert.equal(res.status, 200);
  let body = await json(res);
  assert.deepEqual(
    [body.applied, body.account.cash, body.transactions[0].kind, body.transactions[0].reason],
    [500, 500, 'staff_add', 'event prize']
  );
  assert.match(body.summary, /500/);

  res = await adjust({ action: 'remove', amount: 100 });
  assert.equal((await json(res)).account.cash, 400);

  res = await adjust({ action: 'set', amount: 42, reason: 'correction' });
  body = await json(res);
  assert.deepEqual(
    [body.account.cash, body.transactions[0].kind, body.transactions[0].amount],
    [42, 'staff_set', -358]
  );

  await deposit(GID, U, 40, { config: cfg });
  res = await adjust({ action: 'reset-user', reason: 'new season' });
  body = await json(res);
  assert.deepEqual([body.account.cash, body.account.bank, body.transactions[0].kind], [0, 0, 'reset']);

  const kinds = db
    .prepare('SELECT kind FROM economy_transactions WHERE guild_id = ? ORDER BY id')
    .all(GID)
    .map((r) => r.kind);
  assert.deepEqual(kinds, ['staff_add', 'staff_remove', 'staff_set', 'deposit', 'reset']);
  assert.equal((await auditRows(GID, 'economy:adjust')).length, 4);
});

test('the audit line of a staff change names the member, not the snowflake', async () => {
  await enable();
  await api.post(`/modules/economy/members/${U}/adjust`, { action: 'add', amount: 330 });
  await api.post(`/modules/economy/members/${V}/adjust`, { action: 'reset-user' });
  const details = (await auditRows(GID, 'economy:adjust')).map((r) => r.detail).sort();
  assert.deepEqual(details, ['add 330 for Alice', 'reset-user for Bob']);
  for (const d of details) assert.doesNotMatch(d, /\d{17,20}/);
});

test('auditDetail: a name is trimmed and capped, and someone who is gone falls back to the id', () => {
  assert.equal(auditDetail('remove', 40, { displayName: '  Ann   Lee ' }, U), 'remove 40 for Ann Lee');
  assert.equal(auditDetail('set', 1, { user: { username: 'ann' } }, U), 'set 1 for ann');
  assert.equal(auditDetail('add', 5, null, U), `add 5 for ${U}`);
  assert.equal(auditDetail('reset-user', 0, null, U), `reset-user for ${U}`);
  assert.ok(auditDetail('add', 5, { displayName: 'x'.repeat(200) }, U).length < 90);
});

test('the page refuses what /eco would refuse', async () => {
  const adjust = (body, who = U) => api.post(`/modules/economy/members/${who}/adjust`, body);
  assert.equal((await adjust({ action: 'add', amount: 5 })).status, 400, 'the module is off');
  await enable();
  const refused = async (body, who) => {
    const res = await adjust(body, who);
    assert.equal(res.status, 400);
    return (await json(res)).error;
  };
  assert.match(await refused({ action: 'bogus', amount: 5 }), /what to do/);
  assert.match(await refused({ action: 'add', amount: 0 }), /whole number/);
  assert.match(await refused({ action: 'add', amount: -3 }), /whole number/);
  assert.match(await refused({ action: 'add', amount: 1.5 }), /whole number/);
  assert.match(await refused({ action: 'add', amount: 'ten' }), /whole number/);
  assert.match(await refused({ action: 'add', amount: 1_000_000_001 }), /whole number/);
  assert.match(await refused({ action: 'remove', amount: 5 }), /does not have that much/);
  assert.match(await refused({ action: 'add', amount: 5 }, BOT), /Bots/);
  assert.match(await refused({ action: 'add', amount: 5 }, 'nope'), /Pick a member/);
  assert.equal((await adjust({ action: 'set', amount: 0 })).status, 200, 'set may be 0');
  assert.equal(await getAccount(GID, BOT), null);
});

test('adjusting a member without an account opens one (with the starting balance)', async () => {
  await enable({ startingBalance: 25 });
  const res = await api.post(`/modules/economy/members/${W}/adjust`, { action: 'add', amount: 5 });
  assert.equal(res.status, 200);
  assert.equal((await json(res)).account.cash, 30);
});

test('a change posts to the staff log channel when one is set', async () => {
  const sent = [];
  const channel = app.guild.channels.cache.get('100000000000000002');
  const original = channel.send;
  channel.send = async (payload) => {
    sent.push(payload);
    return { id: 'm' };
  };
  try {
    await enable({ logChannelId: channel.id });
    await api.post(`/modules/economy/members/${U}/adjust`, { action: 'add', amount: 9, reason: 'because' });
    assert.equal(sent.length, 1);
    assert.match(sent[0].embeds[0].data.description, /^The dashboard added .*9/);
  } finally {
    channel.send = original;
  }
});

test('resetting the whole economy needs the typed word, then resets every account with one row each', async () => {
  await enable();
  await give(U, 100);
  await give(V, 200);
  assert.equal((await api.post('/modules/economy/reset', {})).status, 400);
  assert.equal((await api.post('/modules/economy/reset', { confirm: 'reset' })).status, 400);
  assert.equal(Number((await getAccount(GID, U)).cash), 100, 'nothing changed yet');

  const res = await api.post('/modules/economy/reset', { confirm: 'RESET' });
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { ok: true, accounts: 2 });
  assert.equal(Number((await getAccount(GID, U)).cash), 0);
  assert.equal(Number((await getAccount(GID, V)).cash), 0);
  const resets = db
    .prepare(
      "SELECT user_id, amount FROM economy_transactions WHERE guild_id = ? AND kind = 'reset' ORDER BY user_id"
    )
    .all(GID);
  assert.deepEqual(resets, [
    { user_id: U, amount: -100 },
    { user_id: V, amount: -200 },
  ]);
  assert.equal((await auditRows(GID, 'economy:reset')).length, 1);
});

test('staff can clean up after someone who left (they have an account) but never open one for a non-member', async () => {
  await enable();
  const GONE = '700000000000000077';
  const realFetch = app.guild.members.fetch;
  app.guild.members.fetch = async () => {
    throw new Error('Unknown Member');
  };
  try {
    const adjust = (body) => api.post(`/modules/economy/members/${GONE}/adjust`, body);
    const refused = await adjust({ action: 'add', amount: 5 });
    assert.equal(refused.status, 400);
    assert.match((await json(refused)).error, /not in this server and has no account/);
    assert.equal(await getAccount(GID, GONE), null, 'no account was opened');

    await give(GONE, 100); // they had an account before they left
    const res = await adjust({ action: 'remove', amount: 40, reason: 'cleaning up' });
    assert.equal(res.status, 200);
    assert.equal((await json(res)).account.cash, 60);
    assert.equal((await adjust({ action: 'reset-user' })).status, 200);
  } finally {
    app.guild.members.fetch = realFetch;
  }
});

test('with a log channel, staff changes count against the limit for actions that post (10 a minute)', async () => {
  const channel = app.guild.channels.cache.get('100000000000000002');
  const original = channel.send;
  channel.send = async () => ({ id: 'm' });
  try {
    await enable({ logChannelId: channel.id });
    const statuses = [];
    for (let i = 0; i < 12; i++) {
      statuses.push(
        (await api.post(`/modules/economy/members/${U}/adjust`, { action: 'add', amount: 1 })).status
      );
    }
    // (an earlier test in this file already used one of the ten)
    assert.equal(statuses[0], 200, 'the first go through: ' + statuses);
    assert.deepEqual(statuses.slice(-2), [429, 429], 'and the 11th and 12th do not: ' + statuses);
    assert.equal(
      (await api.post('/modules/economy/reset', { confirm: 'RESET' })).status,
      429,
      'the reset shares the count'
    );
  } finally {
    channel.send = original;
  }
});

test('the settings say whether the shortest-message rule can be applied on this host', async () => {
  const body = await json(await api.get('/modules/economy/config'));
  assert.equal(typeof body.messageLengthChecked, 'boolean');
});
