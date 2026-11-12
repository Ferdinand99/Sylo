// The money API (src/modules/lib/economy.js): credit, debit, transfer, deposit, withdraw,
// setBalance, reset. Balances never go negative, the cap holds, concurrent calls lose nothing, and
// every change writes exactly one ledger row that matches the balances.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/index.js';
import { recordAudit, listAudit } from '../src/db/audit.js';
import { eraseMember } from '../src/db/economy.js';
import { forgetUser } from '../src/db/purge.js';
import { prepare, transaction } from '../src/db/driver.js';
import { getAccount, listTransactions } from '../src/db/economy.js';
import {
  KINDS,
  credit,
  debit,
  deposit,
  registerKind,
  resetAccount,
  resetGuild,
  setBalance,
  transact,
  transfer,
  withdraw,
} from '../src/modules/lib/economy.js';
import { MAX_BALANCE, normaliseEconomyConfig } from '../src/modules/lib/economyConfig.js';

let n = 0;
const guild = () => `5000000000000${String(++n).padStart(5, '0')}`;
const A = '800000000000000001';
const B = '800000000000000002';
const config = normaliseEconomyConfig({});

const balances = async (g, u) => {
  const a = await getAccount(g, u);
  return { cash: Number(a.cash), bank: Number(a.bank) };
};
const ledger = (g, u) =>
  db.prepare('SELECT * FROM economy_transactions WHERE guild_id = ? AND user_id = ? ORDER BY id').all(g, u);

test('credit adds cash and writes one ledger row that matches', async () => {
  const g = guild();
  const out = await credit(g, A, 100, { kind: 'staff_add', actorId: B, reason: 'prize', config });
  assert.equal(out.ok, true);
  assert.equal(out.applied, 100);
  assert.deepEqual(await balances(g, A), { cash: 100, bank: 0 });
  const rows = ledger(g, A);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'staff_add');
  assert.equal(rows[0].amount, 100);
  assert.equal(rows[0].cash_after, 100);
  assert.equal(rows[0].bank_after, 0);
  assert.equal(rows[0].actor_id, B);
  assert.equal(rows[0].reason, 'prize');
});

test('debit takes cash, refuses more than the cash and leaves everything alone when it refuses', async () => {
  const g = guild();
  await credit(g, A, 50, { kind: 'daily', config });
  const out = await debit(g, A, 20, { kind: 'staff_remove', config });
  assert.equal(out.ok, true);
  assert.equal(out.applied, -20);
  assert.deepEqual(await balances(g, A), { cash: 30, bank: 0 });

  const refused = await debit(g, A, 31, { kind: 'staff_remove', config });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'insufficient');
  assert.deepEqual(await balances(g, A), { cash: 30, bank: 0 });
  assert.equal(ledger(g, A).length, 2, 'a refusal writes no ledger row');
});

test('debit from cash-then-bank takes cash first, then the bank, in one ledger row', async () => {
  const g = guild();
  await credit(g, A, 100, { kind: 'daily', config });
  await deposit(g, A, 70, { config }); // cash 30, bank 70
  const out = await debit(g, A, 50, { kind: 'staff_remove', from: 'cash-then-bank', config });
  assert.equal(out.ok, true);
  assert.deepEqual(await balances(g, A), { cash: 0, bank: 50 });
  const last = ledger(g, A).at(-1);
  assert.equal(last.amount, -50);
  assert.equal(last.cash_after, 0);
  assert.equal(last.bank_after, 50);
  const tooMuch = await debit(g, A, 51, { kind: 'staff_remove', from: 'cash-then-bank', config });
  assert.equal(tooMuch.reason, 'insufficient');
});

test('amounts must be whole numbers of at least 1', async () => {
  const g = guild();
  for (const bad of [0, -5, 1.5, NaN, '10', null, MAX_BALANCE + 1]) {
    assert.equal((await credit(g, A, bad, { kind: 'daily', config })).reason, 'invalid_amount', String(bad));
    assert.equal((await debit(g, A, bad, { kind: 'staff_remove', config })).reason, 'invalid_amount');
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM economy_accounts WHERE guild_id = ?').get(g).c, 0);
});

test('an unknown ledger kind is a programming error, not a silent write', async () => {
  const g = guild();
  await assert.rejects(credit(g, A, 5, { kind: 'bogus', config }), /unknown ledger kind/);
  assert.equal(ledger(g, A).length, 0);
  assert.equal(await getAccount(g, A), null, 'the rolled-back transaction left no account either');
  registerKind('shop_purchase');
  assert.ok(KINDS.has('shop_purchase'));
  assert.equal((await credit(g, A, 5, { kind: 'shop_purchase', config })).ok, true);
  assert.throws(() => registerKind('Bad Kind'), /bad ledger kind/);
});

test('the cap: a credit is cut to fit, and nothing is written when nothing fits', async () => {
  const g = guild();
  await credit(g, A, MAX_BALANCE - 10, { kind: 'daily', config });
  const cut = await credit(g, A, 100, { kind: 'daily', config });
  assert.equal(cut.ok, true);
  assert.equal(cut.applied, 10);
  assert.equal(cut.clamped, true);
  assert.deepEqual(await balances(g, A), { cash: MAX_BALANCE, bank: 0 });
  assert.equal(ledger(g, A).at(-1).amount, 10);

  const rows = ledger(g, A).length;
  const none = await credit(g, A, 5, { kind: 'daily', config });
  assert.equal(none.applied, 0);
  assert.equal(none.clamped, true);
  assert.equal(ledger(g, A).length, rows, 'no ledger row for a credit that changed nothing');
});

test('the cap counts cash and bank together', async () => {
  const g = guild();
  await credit(g, A, 600_000_000, { kind: 'daily', config });
  await deposit(g, A, 'all', { config });
  const out = await credit(g, A, 600_000_000, { kind: 'daily', config });
  assert.equal(out.applied, 400_000_000);
  assert.deepEqual(await balances(g, A), { cash: 400_000_000, bank: 600_000_000 });
});

test('transfer moves cash, with a tax on top, in three ledger rows that name each other', async () => {
  const g = guild();
  await credit(g, A, 200, { kind: 'daily', config });
  const out = await transfer(g, A, B, 100, { tax: 10, config });
  assert.equal(out.ok, true);
  assert.deepEqual(await balances(g, A), { cash: 90, bank: 0 });
  assert.deepEqual(await balances(g, B), { cash: 100, bank: 0 });
  const sender = ledger(g, A).slice(1);
  assert.deepEqual(
    sender.map((r) => [r.kind, r.amount, r.counterparty_id]),
    [
      ['pay_out', -100, B],
      ['tax', -10, B],
    ]
  );
  const recipient = ledger(g, B);
  assert.deepEqual(
    recipient.map((r) => [r.kind, r.amount, r.counterparty_id, r.cash_after]),
    [['pay_in', 100, A, 100]]
  );
});

test('transfer is refused: to yourself, without the money (amount plus tax), past the recipient cap', async () => {
  const g = guild();
  await credit(g, A, 100, { kind: 'daily', config });
  assert.equal((await transfer(g, A, A, 10, { config })).reason, 'self');
  const poor = await transfer(g, A, B, 100, { tax: 1, config });
  assert.equal(poor.reason, 'insufficient');
  assert.equal(poor.needed, 101);
  await credit(g, B, MAX_BALANCE - 5, { kind: 'daily', config });
  assert.equal((await transfer(g, A, B, 10, { config })).reason, 'recipient_cap');
  assert.deepEqual(await balances(g, A), { cash: 100, bank: 0 }, 'nothing moved');
  assert.equal(ledger(g, A).length, 1);
});

test('deposit and withdraw move money between cash and bank; total and ledger stay consistent', async () => {
  const g = guild();
  await credit(g, A, 100, { kind: 'daily', config });
  const d = await deposit(g, A, 60, { config });
  assert.equal(d.moved, 60);
  assert.deepEqual(await balances(g, A), { cash: 40, bank: 60 });
  const w = await withdraw(g, A, 'all', { config });
  assert.equal(w.moved, 60);
  assert.deepEqual(await balances(g, A), { cash: 100, bank: 0 });
  const [, dep, wd] = ledger(g, A);
  assert.deepEqual([dep.kind, dep.amount, dep.cash_after, dep.bank_after], ['deposit', 60, 40, 60]);
  assert.deepEqual([wd.kind, wd.amount, wd.cash_after, wd.bank_after], ['withdraw', 60, 100, 0]);

  assert.equal((await deposit(g, A, 101, { config })).reason, 'insufficient');
  assert.equal((await withdraw(g, A, 1, { config })).reason, 'insufficient');
  assert.equal((await withdraw(g, A, 'all', { config })).reason, 'nothing');
  assert.equal((await deposit(g, A, 0, { config })).reason, 'invalid_amount');
  assert.equal(ledger(g, A).length, 3);
});

test('setBalance sets cash exactly, leaves the bank, and refuses a total past the cap', async () => {
  const g = guild();
  await credit(g, A, 100, { kind: 'daily', config });
  await deposit(g, A, 30, { config });
  const out = await setBalance(g, A, 500, { actorId: B, reason: 'fix', config });
  assert.equal(out.ok, true);
  assert.deepEqual(await balances(g, A), { cash: 500, bank: 30 });
  const last = ledger(g, A).at(-1);
  assert.deepEqual([last.kind, last.amount, last.actor_id, last.reason], ['staff_set', 430, B, 'fix']);
  assert.equal((await setBalance(g, A, MAX_BALANCE, { config })).reason, 'cap');
  assert.equal((await setBalance(g, A, -1, { config })).reason, 'invalid_amount');
  assert.equal((await setBalance(g, A, 500, { config })).ok, true, 'setting the same value changes nothing');
  assert.equal(ledger(g, A).filter((r) => r.kind === 'staff_set').length, 1, 'and writes no row');
});

test('a new account gets the starting balance, written to the ledger as start', async () => {
  const g = guild();
  const cfg = normaliseEconomyConfig({ startingBalance: 250 });
  await credit(g, A, 10, { kind: 'daily', config: cfg });
  assert.deepEqual(await balances(g, A), { cash: 260, bank: 0 });
  const rows = ledger(g, A);
  assert.deepEqual(
    rows.map((r) => [r.kind, r.amount, r.cash_after]),
    [
      ['start', 250, 250],
      ['daily', 10, 260],
    ]
  );
  // a second call does not grant it again
  await credit(g, A, 1, { kind: 'daily', config: cfg });
  assert.equal(ledger(g, A).filter((r) => r.kind === 'start').length, 1);
});

test('every ledger row matches its balance change, over a mixed run', async () => {
  const g = guild();
  await credit(g, A, 1000, { kind: 'daily', config });
  await transfer(g, A, B, 250, { tax: 5, config });
  await deposit(g, A, 300, { config });
  await withdraw(g, A, 100, { config });
  await debit(g, B, 50, { kind: 'staff_remove', from: 'cash-then-bank', config });
  await setBalance(g, B, 7, { config });
  for (const user of [A, B]) {
    let cash = 0;
    let bank = 0;
    for (const r of ledger(g, user)) {
      const dTotal = r.cash_after + r.bank_after - (cash + bank);
      if (r.kind === 'deposit' || r.kind === 'withdraw') assert.equal(dTotal, 0);
      else assert.equal(r.amount, dTotal, `${r.kind}: amount is the change of cash + bank`);
      cash = r.cash_after;
      bank = r.bank_after;
    }
    assert.deepEqual(await balances(g, user), { cash, bank }, 'the last ledger row is the balance');
  }
});

test('50 parallel credits to one account lose nothing', async () => {
  const g = guild();
  const results = await Promise.all(
    Array.from({ length: 50 }, () => credit(g, A, 3, { kind: 'daily', config }))
  );
  assert.ok(results.every((r) => r.ok && r.applied === 3));
  assert.deepEqual(await balances(g, A), { cash: 150, bank: 0 });
  const rows = ledger(g, A);
  assert.equal(rows.length, 50);
  assert.equal(rows.at(-1).cash_after, 150);
  assert.equal(new Set(rows.map((r) => r.cash_after)).size, 50, 'each row saw a different running balance');
});

test('parallel debits never overdraw: exactly as many succeed as the money allows', async () => {
  const g = guild();
  await credit(g, A, 100, { kind: 'daily', config });
  const results = await Promise.all(
    Array.from({ length: 30 }, () => debit(g, A, 7, { kind: 'staff_remove', config }))
  );
  const ok = results.filter((r) => r.ok).length;
  assert.equal(ok, 14, '14 x 7 = 98 fits in 100, a 15th does not');
  assert.deepEqual(await balances(g, A), { cash: 2, bank: 0 });
  assert.equal(
    results.filter((r) => !r.ok).every((r) => r.reason === 'insufficient'),
    true
  );
});

test('crossing payments between two members in parallel keep the total and never deadlock', async () => {
  const g = guild();
  await credit(g, A, 500, { kind: 'daily', config });
  await credit(g, B, 500, { kind: 'daily', config });
  const jobs = [];
  for (let i = 0; i < 20; i++) {
    jobs.push(transfer(g, A, B, 5, { config }));
    jobs.push(transfer(g, B, A, 3, { config }));
  }
  const results = await Promise.all(jobs);
  assert.ok(results.every((r) => r.ok));
  const a = await balances(g, A);
  const b = await balances(g, B);
  assert.equal(a.cash + b.cash, 1000);
  assert.equal(a.cash, 500 - 100 + 60);
});

test('transact: a refusal changes nothing, and `after` runs in the same transaction (a throw rolls the money back)', async () => {
  const g = guild();
  await credit(g, A, 100, { kind: 'daily', config });
  const refused = await transact(g, [A], () => ({ refuse: { reason: 'nope' } }), { config });
  assert.deepEqual([refused.ok, refused.reason], [false, 'nope']);

  await assert.rejects(
    transact(g, [A], () => ({ changes: [{ userId: A, cash: -40, kind: 'staff_remove' }] }), {
      config,
      after: function* (tx) {
        yield tx.get('SELECT 1 AS one');
        throw new Error('inventory insert failed');
      },
    }),
    /inventory insert failed/
  );
  assert.deepEqual(await balances(g, A), { cash: 100, bank: 0 });
  assert.equal(ledger(g, A).length, 1);

  const out = await transact(
    g,
    [A],
    () => ({ changes: [{ userId: A, cash: -40, kind: 'staff_remove' }], result: 7 }),
    {
      config,
      after: function* (tx, outcome) {
        assert.equal(outcome.ledger.length, 1);
        yield tx.run('UPDATE economy_accounts SET daily_streak = 9 WHERE guild_id = ? AND user_id = ?', g, A);
      },
    }
  );
  assert.equal(out.result, 7);
  assert.equal(Number((await getAccount(g, A)).daily_streak), 9);
});

test('a plan may only stamp the cooldown columns', async () => {
  const g = guild();
  await assert.rejects(
    transact(g, [A], () => ({ stamps: { [A]: { cash: 99999 } } }), { config }),
    /bad stamp column/
  );
  assert.equal(await getAccount(g, A), null);
});

test('resetAccount: starting balance, empty bank, cleared streak, one reset row', async () => {
  const g = guild();
  const cfg = normaliseEconomyConfig({ startingBalance: 20 });
  await credit(g, A, 500, { kind: 'daily', config: cfg });
  await deposit(g, A, 100, { config: cfg });
  await transact(g, [A], () => ({ stamps: { [A]: { daily_streak: 5, last_work_at: 123 } } }), {
    config: cfg,
  });
  const out = await resetAccount(g, A, { actorId: B, reason: 'season over', config: cfg });
  assert.equal(out.ok, true);
  assert.deepEqual(await balances(g, A), { cash: 20, bank: 0 });
  const row = await getAccount(g, A);
  assert.equal(Number(row.daily_streak), 0);
  assert.equal(Number(row.last_work_at), 0);
  const last = ledger(g, A).at(-1);
  assert.deepEqual(
    [last.kind, last.amount, last.actor_id, last.reason],
    ['reset', 20 - 520, B, 'season over']
  );
});

test('resetGuild resets every account of one server only, with one reset row per account', async () => {
  const g = guild();
  const other = guild();
  await credit(g, A, 100, { kind: 'daily', config });
  await credit(g, B, 300, { kind: 'daily', config });
  await deposit(g, B, 50, { config });
  await credit(other, A, 999, { kind: 'daily', config });
  const out = await resetGuild(g, { actorId: B, config });
  assert.deepEqual(out, { ok: true, accounts: 2, total: 2 });
  assert.deepEqual(await balances(g, A), { cash: 0, bank: 0 });
  assert.deepEqual(await balances(g, B), { cash: 0, bank: 0 });
  assert.deepEqual(await balances(other, A), { cash: 999, bank: 0 }, 'another server is untouched');
  const rowsA = ledger(g, A);
  assert.deepEqual([rowsA.at(-1).kind, rowsA.at(-1).amount, rowsA.at(-1).actor_id], ['reset', -100, B]);
  assert.equal(ledger(g, B).at(-1).amount, -300);
  assert.equal(ledger(other, A).length, 1);
});

test('the leaderboard reads see exactly what the API wrote', async () => {
  const g = guild();
  await credit(g, A, 10, { kind: 'daily', config });
  assert.equal((await listTransactions(g, A, 10)).length, 1);
});

test('a refused or rolled-back money transaction never undoes an unrelated write made at the same time', async () => {
  // On SQLite the transaction runs start to end without returning to the event loop, so other
  // code's statements cannot land inside it (and then be rolled back with it).
  const g = guild();
  await credit(g, A, 10, { kind: 'daily', config });
  const chatter = async () => {
    for (let i = 0; i < 40; i++) {
      await recordAudit(g, { actor: 'x', action: 'noise', detail: String(i) });
    }
  };
  const refusals = async () => {
    for (let i = 0; i < 40; i++) {
      assert.equal((await debit(g, A, 999, { kind: 'staff_remove', config })).reason, 'insufficient');
      await transact(g, [A], () => ({ refuse: { reason: 'nope' } }), { config });
      await assert.rejects(
        transact(g, [A], () => ({ changes: [{ userId: A, cash: -1, kind: 'staff_remove' }] }), {
          config,
          after: function* (tx) {
            yield tx.get('SELECT 1 AS one');
            throw new Error('rolled back');
          },
        }),
        /rolled back/
      );
    }
  };
  await Promise.all([chatter(), refusals(), chatter()]);
  const audit = (await listAudit(g, 500)).filter((r) => r.action === 'noise');
  assert.equal(audit.length, 80, 'every audit row written meanwhile survived');
  assert.deepEqual(await balances(g, A), { cash: 10, bank: 0 });
  assert.equal(ledger(g, A).length, 1);
});

test('after /forget a new account keeps the cooldowns and gets no starting balance again', async () => {
  const g = guild();
  const cfg = normaliseEconomyConfig({ startingBalance: 100 });
  const now = Date.now();
  await credit(g, A, 5, { kind: 'daily', config: cfg });
  db.prepare(
    'UPDATE economy_accounts SET last_daily_at = ?, last_work_at = ?, last_rob_at = ? WHERE guild_id = ? AND user_id = ?'
  ).run(now - 1000, now - 2000, now - 3000, g, A);
  await eraseMember(g, A, now);
  assert.equal(await getAccount(g, A), null);
  await credit(g, A, 7, { kind: 'daily', config: cfg, now: now + 5000 });
  const row = await getAccount(g, A);
  assert.equal(Number(row.cash), 7, 'no starting balance the second time');
  assert.deepEqual(
    [Number(row.last_daily_at), Number(row.last_work_at), Number(row.last_rob_at)],
    [now - 1000, now - 2000, now - 3000]
  );
  assert.equal(
    ledger(g, A).filter((r) => r.kind === 'start').length,
    0,
    'and no start row: the first account was erased with its rows'
  );
});

test('the tombstone runs out after 7 days: then a new account is a new member', async () => {
  const g = guild();
  const cfg = normaliseEconomyConfig({ startingBalance: 100 });
  const now = Date.now();
  await credit(g, A, 5, { kind: 'daily', config: cfg });
  await eraseMember(g, A, now);
  const later = now + 7 * 86_400_000 + 1;
  await credit(g, A, 1, { kind: 'daily', config: cfg, now: later });
  assert.equal(Number((await getAccount(g, A)).cash), 101, 'the starting balance again, cooldowns clear');
});

test('resetGuild handles more accounts than one chunk and writes a row for each that held money', async () => {
  const g = guild();
  const ids = Array.from({ length: 450 }, (_, i) => `8300000000000${String(i).padStart(5, '0')}`);
  for (const id of ids) await credit(g, id, 10, { kind: 'daily', config });
  await credit(g, '830000000000099999', 0 + 1, { kind: 'daily', config });
  await resetAccount(g, '830000000000099999', { config }); // already fresh: nothing to record
  const out = await resetGuild(g, { actorId: B, config });
  assert.deepEqual(out, { ok: true, accounts: 451, total: 451 });
  const cash = db.prepare('SELECT SUM(cash) AS c FROM economy_accounts WHERE guild_id = ?').get(g).c;
  assert.equal(cash, 0);
  const resets = db
    .prepare(
      "SELECT COUNT(*) AS c, SUM(amount) AS s FROM economy_transactions WHERE guild_id = ? AND kind = 'reset' AND actor_id = ?"
    )
    .get(g, B);
  assert.deepEqual([resets.c, resets.s], [450, -4500]);
});

// --- the transaction runner and the hook ---------------------------------------------------------------

test('transaction() accepts only a plain generator function, and says so at once', async () => {
  await assert.rejects(
    transaction(async () => 1),
    /generator function/
  );
  await assert.rejects(
    transaction(() => 1),
    /generator function/
  );
  await assert.rejects(
    transaction(async function* () {
      yield 1;
    }),
    /generator function/
  );
  await assert.rejects(transaction(undefined), /generator function/);
  assert.equal(
    await transaction(function* (tx) {
      yield tx.get('SELECT 42 AS answer');
      return 42;
    }),
    42,
    'a plain generator works'
  );
});

test('a body that yields a promise is refused on SQLite (it would be awaited on Postgres)', async () => {
  await assert.rejects(
    transaction(function* () {
      yield Promise.resolve(1);
    }),
    /yielded a promise/
  );
});

test('a prepare() statement made inside a transaction body throws instead of running outside it', async () => {
  const g = guild();
  const stray = prepare('SELECT COUNT(*) AS n FROM economy_accounts WHERE guild_id = ?');
  await assert.rejects(
    transaction(function* (tx) {
      yield tx.run(
        'INSERT INTO economy_cooldowns (guild_id, user_id, last_daily_at, last_work_at, last_rob_at, expires_at) VALUES (?, ?, 0, 0, 0, 1)',
        g,
        A
      );
      yield stray.get(g); // not through tx
    }),
    /prepare\(\) statement was run inside a transaction/
  );
  const left = db.prepare('SELECT COUNT(*) AS n FROM economy_cooldowns WHERE guild_id = ?').get(g).n;
  assert.equal(left, 0, 'and the body was rolled back');
  assert.equal((await stray.get(g)).n, 0, 'the same statement works outside a transaction');
});

test('transact() needs a generator function as its after hook, and refuses before it starts', async () => {
  const g = guild();
  for (const bad of [() => {}, async () => {}, async function* () {}, 'no']) {
    await assert.rejects(
      transact(g, [A], () => ({ changes: [{ userId: A, cash: 5, kind: 'daily' }] }), { config, after: bad }),
      /after.* must be a generator function/
    );
  }
  assert.equal(await getAccount(g, A), null, 'nothing was opened');
});

test('an after hook that runs a prepare() statement is refused and the money is rolled back', async () => {
  const g = guild();
  await credit(g, A, 10, { kind: 'daily', config });
  const stray = prepare('SELECT 1 AS one');
  await assert.rejects(
    transact(g, [A], () => ({ changes: [{ userId: A, cash: -3, kind: 'staff_remove' }] }), {
      config,
      after: function* () {
        yield stray.get();
      },
    }),
    /prepare\(\) statement was run inside a transaction/
  );
  assert.deepEqual(await balances(g, A), { cash: 10, bank: 0 });
});

// --- /forget and the reset -------------------------------------------------------------------------------

test('eraseMember reads, writes the tombstone and deletes in one transaction', async () => {
  const g = guild();
  const now = Date.now();
  await credit(g, A, 5, { kind: 'daily', config });
  db.prepare('UPDATE economy_accounts SET last_daily_at = ? WHERE guild_id = ? AND user_id = ?').run(
    now - 5,
    g,
    A
  );
  const out = await eraseMember(g, A, now);
  assert.equal(out.account, 1);
  const tomb = db.prepare('SELECT * FROM economy_cooldowns WHERE guild_id = ? AND user_id = ?').get(g, A);
  assert.equal(tomb.last_daily_at, now - 5);
  assert.equal(await getAccount(g, A), null);
});

test('a partial reset says how far it got, stops, and finishes when run again', async () => {
  const g = guild();
  const ids = Array.from({ length: 450 }, (_, i) => `8400000000000${String(i).padStart(5, '0')}`);
  for (const id of ids) await credit(g, id, 10, { kind: 'daily', config });
  const failing = await resetGuild(g, {
    actorId: B,
    config,
    beforeChunk: (i) => {
      if (i === 1) throw new Error('database went away');
    },
  });
  assert.deepEqual(failing, { ok: false, accounts: 200, total: 450, error: 'database went away' });
  const left = db
    .prepare('SELECT COUNT(*) AS n FROM economy_accounts WHERE guild_id = ? AND cash > 0')
    .get(g).n;
  assert.equal(left, 250, 'the first chunk is reset, the rest untouched');
  const again = await resetGuild(g, { actorId: B, config });
  assert.deepEqual(again, { ok: true, accounts: 450, total: 450 });
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM economy_accounts WHERE guild_id = ? AND cash > 0').get(g).n,
    0
  );
  const rows = db
    .prepare("SELECT COUNT(*) AS n FROM economy_transactions WHERE guild_id = ? AND kind = 'reset'")
    .get(g).n;
  assert.equal(rows, 450, 'one row per account that held money, none twice');
});

test('a member who runs /forget during a reset is not re-created by it', async () => {
  const g = guild();
  const ids = Array.from({ length: 450 }, (_, i) => `8500000000000${String(i).padStart(5, '0')}`);
  for (const id of ids) await credit(g, id, 10, { kind: 'daily', config });
  const late = ids[449]; // in the last chunk, not reset yet when chunk 1 starts
  const out = await resetGuild(g, {
    config,
    beforeChunk: async (i) => {
      if (i === 1) await forgetUser(g, late);
    },
  });
  assert.equal(out.ok, true);
  assert.equal(out.accounts, 449, 'the erased member was skipped');
  assert.equal(await getAccount(g, late), null, 'and no account was made for them again');
});

test('money calls for a server wait while its reset runs, and then go through', async () => {
  const g = guild();
  const ids = Array.from({ length: 250 }, (_, i) => `8600000000000${String(i).padStart(5, '0')}`);
  for (const id of ids) await credit(g, id, 10, { kind: 'daily', config });
  let release;
  const gate = new Promise((r) => (release = r));
  let inFlight = false;
  const reset = resetGuild(g, {
    config,
    beforeChunk: async (i) => {
      if (i === 1) await gate;
    },
  });
  await new Promise((r) => setTimeout(r, 20));
  const late = credit(g, ids[0], 5, { kind: 'daily', config }).then((r) => {
    inFlight = true;
    return r;
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(inFlight, false, 'the credit is held back while the reset is between chunks');
  release();
  const [done, credited] = await Promise.all([reset, late]);
  assert.equal(done.ok, true);
  assert.equal(credited.ok, true);
  assert.deepEqual(
    await balances(g, ids[0]),
    { cash: 5, bank: 0 },
    'it landed after the reset, not under it'
  );
  const other = `${g}9`;
  assert.equal(
    (await credit(other, A, 1, { kind: 'daily', config })).ok,
    true,
    'another server is never held'
  );
});
