// Data handling: /forget (the account and the member's ledger rows go; where they are named on
// someone else's row, the name comes off), the member's data export, the guild purge, the ledger
// retention prune, and the migration's tables.
import './helpers/tmpDb.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/index.js';
import {
  LEDGER_RETENTION_DAYS,
  TOMBSTONE_DAYS,
  getAccount,
  listTransactions,
  pruneCooldowns,
  pruneTransactions,
} from '../src/db/economy.js';
import { GUILD_TABLES, describeUserData, exportUserData, forgetUser, purgeGuild } from '../src/db/purge.js';
import { credit, deposit, transfer } from '../src/modules/lib/economy.js';
import { claimDaily, staffAdjust } from '../src/modules/economy.js';
import { normaliseEconomyConfig } from '../src/modules/lib/economyConfig.js';

let n = 0;
let G;
const U = '800000000000000001';
const V = '800000000000000002';
const STAFF = '800000000000000100';
const config = normaliseEconomyConfig({});
beforeEach(() => {
  G = `5400000000000${String(++n).padStart(5, '0')}`;
});
const count = (table, extra = '', ...args) =>
  db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE guild_id = ? ${extra}`).get(G, ...args).c;

/** U pays V, staff add to U, V is robbed-looking: enough rows on both sides to see who is named where. */
async function seed() {
  await credit(G, U, 500, { kind: 'daily', config });
  await credit(G, V, 500, { kind: 'daily', config });
  await transfer(G, U, V, 100, { tax: 5, config });
  await deposit(G, U, 50, { config });
  await staffAdjust({
    guildId: G,
    actorId: STAFF,
    userId: U,
    action: 'add',
    amount: 7,
    reason: 'gift',
    config,
  });
  await staffAdjust({ guildId: G, actorId: U, userId: V, action: 'add', amount: 3, config });
}

test('the migration made both tables, and both are in GUILD_TABLES', () => {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((r) => r.name);
  assert.ok(tables.includes('economy_accounts'));
  assert.ok(tables.includes('economy_transactions'));
  assert.ok(GUILD_TABLES.includes('economy_accounts'));
  assert.ok(GUILD_TABLES.includes('economy_transactions'));
  const cols = (t) =>
    db
      .prepare(`PRAGMA table_info(${t})`)
      .all()
      .map((c) => c.name);
  assert.deepEqual(cols('economy_accounts'), [
    'guild_id',
    'user_id',
    'cash',
    'bank',
    'daily_streak',
    'last_daily_at',
    'last_work_at',
    'last_rob_at',
    'last_robbed_at',
    'last_message_earn_at',
    'created_at',
    'updated_at',
  ]);
  assert.deepEqual(cols('economy_transactions'), [
    'id',
    'guild_id',
    'user_id',
    'kind',
    'amount',
    'cash_after',
    'bank_after',
    'counterparty_id',
    'actor_id',
    'reason',
    'created_at',
  ]);
});

test('/forget deletes the account and the ledger rows of the member, and nobody else', async () => {
  await seed();
  const out = await forgetUser(G, U);
  assert.equal(out.economyAccounts, 1);
  assert.ok(out.economyTransactions >= 5);
  assert.equal(await getAccount(G, U), null);
  assert.equal(count('economy_transactions', 'AND user_id = ?', U), 0);
  assert.notEqual(await getAccount(G, V), null, 'the other member keeps their account');
  assert.ok(count('economy_transactions', 'AND user_id = ?', V) >= 3, 'and their ledger');
});

test('/forget takes the name off rows of other members: the other side of a payment, the staff actor', async () => {
  await seed();
  assert.ok(count('economy_transactions', 'AND counterparty_id = ?', U) >= 1);
  assert.ok(count('economy_transactions', 'AND actor_id = ?', U) >= 1);
  const out = await forgetUser(G, U);
  assert.ok(out.economyNames >= 2);
  assert.equal(count('economy_transactions', 'AND counterparty_id = ?', U), 0);
  assert.equal(count('economy_transactions', 'AND actor_id = ?', U), 0);
  // the rows themselves stay: V still sees a payment came in and money was added
  const vRows = await listTransactions(G, V, 20);
  assert.ok(vRows.some((r) => r.kind === 'pay_in' && r.counterparty_id === null));
  assert.ok(vRows.some((r) => r.kind === 'staff_add' && r.actor_id === null));
});

test('/forget of a member who never used the economy is a quiet zero', async () => {
  const out = await forgetUser(G, '800000000000000555');
  assert.deepEqual([out.economyAccounts, out.economyTransactions, out.economyNames], [0, 0, 0]);
});

test('the member data export and the count list the economy data', async () => {
  await seed();
  const dump = await exportUserData(G, U);
  assert.equal(dump.data.economyAccount.length, 1);
  assert.equal(Number(dump.data.economyAccount[0].cash), 500 - 100 - 5 - 50 + 7 - 0);
  assert.ok(dump.data.economyTransactions.length >= 5);
  const kinds = dump.data.economyTransactions.map((r) => r.kind);
  assert.ok(kinds.includes('pay_out') && kinds.includes('tax') && kinds.includes('deposit'));
  // where U is the other side or the actor: what and when, not who or how much
  assert.ok(dump.data.economyCounterparty.every((r) => Object.keys(r).sort().join() === 'created_at,kind'));
  assert.ok(dump.data.economyCounterparty.length >= 1);
  assert.deepEqual(Object.keys(dump.data.economyActions[0]).sort(), ['created_at', 'kind']);

  const described = await describeUserData(G, U);
  const item = (key) => described.items.find((i) => i.key === key);
  assert.equal(item('economyAccount').count, 1);
  assert.ok(item('economyTransactions').count >= 5);
  assert.equal(item('economyAccount').kept, false, 'an erasable record');
  assert.deepEqual(Object.keys(dump.data).sort(), described.items.map((i) => i.key).sort());
});

test('after /forget the export holds no economy data', async () => {
  await seed();
  await forgetUser(G, U);
  const dump = await exportUserData(G, U);
  for (const key of ['economyAccount', 'economyTransactions', 'economyCounterparty', 'economyActions']) {
    assert.deepEqual(dump.data[key], [], key);
  }
});

test('the guild purge removes every account and ledger row of the server only', async () => {
  const other = `${G}9`;
  await seed();
  await credit(other, U, 10, { kind: 'daily', config });
  await purgeGuild(G);
  assert.equal(count('economy_accounts'), 0);
  assert.equal(count('economy_transactions'), 0);
  assert.notEqual(await getAccount(other, U), null);
});

test('the ledger keeps 180 days: older rows are pruned, newer stay, balances are untouched', async () => {
  await seed();
  const now = Date.now();
  const day = 86_400_000;
  // age some rows: two past the window, one just inside it
  const ids = db
    .prepare('SELECT id FROM economy_transactions WHERE guild_id = ? AND user_id = ? ORDER BY id')
    .all(G, U);
  const age = db.prepare('UPDATE economy_transactions SET created_at = ? WHERE id = ?');
  age.run(now - (LEDGER_RETENTION_DAYS + 1) * day, ids[0].id);
  age.run(now - (LEDGER_RETENTION_DAYS + 30) * day, ids[1].id);
  age.run(now - (LEDGER_RETENTION_DAYS - 1) * day, ids[2].id);
  const before = count('economy_transactions');
  const removed = await pruneTransactions(now);
  assert.equal(removed, 2);
  assert.equal(count('economy_transactions'), before - 2);
  const left = new Set(
    db
      .prepare('SELECT id FROM economy_transactions WHERE guild_id = ?')
      .all(G)
      .map((r) => r.id)
  );
  assert.equal(left.has(ids[0].id) || left.has(ids[1].id), false);
  assert.equal(left.has(ids[2].id), true);
  const a = await getAccount(G, U);
  assert.equal(Number(a.cash) + Number(a.bank), 500 - 100 - 5 + 7, 'pruning rows never changes a balance');
  assert.equal(await pruneTransactions(now), 0, 'a second prune finds nothing');
});

test('/forget leaves a small cooldown tombstone, and a new account keeps the cooldowns and gets no second starting balance', async () => {
  const cfg = normaliseEconomyConfig({ startingBalance: 100 });
  const now = Date.now();
  await credit(G, U, 50, { kind: 'daily', config: cfg });
  db.prepare(
    'UPDATE economy_accounts SET last_daily_at = ?, last_work_at = ?, last_rob_at = ?, daily_streak = 4 WHERE guild_id = ? AND user_id = ?'
  ).run(now - 10, now - 20, now - 30, G, U);
  await forgetUser(G, U);
  const tomb = db.prepare('SELECT * FROM economy_cooldowns WHERE guild_id = ? AND user_id = ?').get(G, U);
  assert.deepEqual([tomb.last_daily_at, tomb.last_work_at, tomb.last_rob_at], [now - 10, now - 20, now - 30]);
  assert.ok(tomb.expires_at > now + (TOMBSTONE_DAYS * 86_400_000 - 60_000), 'lasts 7 days');
  assert.deepEqual(
    Object.keys(tomb).sort(),
    ['expires_at', 'guild_id', 'last_daily_at', 'last_rob_at', 'last_work_at', 'user_id'],
    'nothing else is kept: no balance, no streak'
  );
  assert.equal(await getAccount(G, U), null);
  assert.equal(count('economy_transactions', 'AND user_id = ?', U), 0);

  // the member comes back: no starting balance, the cooldowns are still running
  await credit(G, U, 1, { kind: 'daily', config: cfg, now: now + 1000 });
  const row = await getAccount(G, U);
  assert.equal(Number(row.cash), 1, 'no starting balance again');
  const daily = await claimDaily({ guildId: G, userId: U, config: cfg, now: now + 2000 });
  assert.deepEqual([daily.ok, daily.reason], [false, 'cooldown']);
  assert.equal(count('economy_transactions', "AND user_id = ? AND kind = 'start'", U), 0);
  assert.deepEqual(
    [Number(row.last_daily_at), Number(row.last_work_at), Number(row.last_rob_at)],
    [now - 10, now - 20, now - 30]
  );
});

test('forgetting twice in a row keeps one tombstone, and the export lists it as kept', async () => {
  await credit(G, U, 5, { kind: 'daily', config });
  await forgetUser(G, U);
  await credit(G, U, 5, { kind: 'daily', config });
  await forgetUser(G, U);
  assert.equal(count('economy_cooldowns', 'AND user_id = ?', U), 1);
  const dump = await exportUserData(G, U);
  assert.equal(dump.data.economyCooldowns.length, 1);
  const item = (await describeUserData(G, U)).items.find((i) => i.key === 'economyCooldowns');
  assert.deepEqual([item.count, item.kept], [1, true]);
  // a member who never had an account leaves no tombstone
  await forgetUser(G, '800000000000000555');
  assert.equal(count('economy_cooldowns', 'AND user_id = ?', '800000000000000555'), 0);
});

test('the daily prune deletes tombstones that have run out and keeps the others', async () => {
  const now = Date.now();
  await credit(G, U, 5, { kind: 'daily', config });
  await credit(G, V, 5, { kind: 'daily', config });
  await forgetUser(G, U);
  await forgetUser(G, V);
  db.prepare('UPDATE economy_cooldowns SET expires_at = ? WHERE guild_id = ? AND user_id = ?').run(
    now - 1,
    G,
    U
  );
  assert.equal(await pruneCooldowns(now), 1);
  assert.equal(count('economy_cooldowns', 'AND user_id = ?', U), 0);
  assert.equal(count('economy_cooldowns', 'AND user_id = ?', V), 1);
  assert.equal(await pruneCooldowns(now), 0);
  // and the guild purge removes the rest
  await purgeGuild(G);
  assert.equal(count('economy_cooldowns'), 0);
});

test('the cooldown tombstone has its own table in the schema and the guild purge list', () => {
  assert.ok(GUILD_TABLES.includes('economy_cooldowns'));
  const cols = db
    .prepare('PRAGMA table_info(economy_cooldowns)')
    .all()
    .map((c) => c.name);
  assert.deepEqual(cols, [
    'guild_id',
    'user_id',
    'last_daily_at',
    'last_work_at',
    'last_rob_at',
    'expires_at',
  ]);
  const index = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'economy_transactions'")
    .all()
    .map((r) => r.name);
  assert.ok(
    index.includes('idx_economy_transactions_created_at'),
    'the prune has an index on the time alone'
  );
});

test('retention is 180 days', () => {
  assert.equal(LEDGER_RETENTION_DAYS, 180);
});
