// Proves the Economy tables and the money API on a real Postgres connection: the bootstrap creates
// the tables, BIGINT values come back as numbers, credit/debit/transfer/deposit/withdraw/reset run
// in one transaction each, 50 parallel credits lose nothing, and crossing payments do not deadlock.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'economy against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const store = await import('../src/db/economy.js');
    const eco = await import('../src/modules/lib/economy.js');
    const { MAX_BALANCE, normaliseEconomyConfig } = await import('../src/modules/lib/economyConfig.js');
    const purge = await import('../src/db/purge.js');
    t.after(async () => {
      await closePostgres();
    });

    const config = normaliseEconomyConfig({});
    const G = `pgtest-eco-${Date.now()}`;
    const H = `${G}-other`;
    const A = 'user-a';
    const B = 'user-b';
    const bal = async (g, u) => {
      const a = await store.getAccount(g, u);
      return { cash: a.cash, bank: a.bank };
    };

    await t.test('credit creates the account and one ledger row; numbers come back as numbers', async () => {
      const out = await eco.credit(G, A, 100, { kind: 'staff_add', actorId: B, reason: 'prize', config });
      assert.equal(out.ok, true);
      const row = await store.getAccount(G, A);
      assert.equal(typeof row.cash, 'number');
      assert.equal(typeof row.created_at, 'number');
      assert.deepEqual(await bal(G, A), { cash: 100, bank: 0 });
      const [tx] = await store.listTransactions(G, A, 10);
      assert.equal(typeof tx.id, 'number');
      assert.deepEqual(
        [tx.kind, tx.amount, tx.cash_after, tx.bank_after, tx.actor_id, tx.reason],
        ['staff_add', 100, 100, 0, B, 'prize']
      );
    });

    await t.test('debit, deposit, withdraw and setBalance', async () => {
      assert.equal((await eco.debit(G, A, 500, { kind: 'staff_remove', config })).reason, 'insufficient');
      await eco.deposit(G, A, 60, { config });
      assert.deepEqual(await bal(G, A), { cash: 40, bank: 60 });
      await eco.withdraw(G, A, 'all', { config });
      assert.deepEqual(await bal(G, A), { cash: 100, bank: 0 });
      await eco.setBalance(G, A, 5, { actorId: B, config });
      assert.deepEqual(await bal(G, A), { cash: 5, bank: 0 });
      const rows = await store.listTransactions(G, A, 20);
      assert.equal(rows.length, 4, 'credit, deposit, withdraw, set, and nothing for the refused debit');
      assert.equal(rows[0].kind, 'staff_set');
      assert.equal(rows[0].amount, -95);
    });

    await t.test('the cap cuts a credit and refuses a payment that does not fit', async () => {
      await eco.credit(G, B, MAX_BALANCE - 10, { kind: 'daily', config });
      const cut = await eco.credit(G, B, 100, { kind: 'daily', config });
      assert.equal(cut.applied, 10);
      assert.deepEqual(await bal(G, B), { cash: MAX_BALANCE, bank: 0 });
      assert.equal((await eco.transfer(G, A, B, 1, { config })).reason, 'recipient_cap');
      await eco.setBalance(G, B, 0, { config });
    });

    await t.test('transfer with a tax writes the three rows in one transaction', async () => {
      await eco.setBalance(G, A, 200, { config });
      const out = await eco.transfer(G, A, B, 100, { tax: 10, config });
      assert.equal(out.ok, true);
      assert.deepEqual(await bal(G, A), { cash: 90, bank: 0 });
      assert.deepEqual(await bal(G, B), { cash: 100, bank: 0 });
      const a = await store.listTransactions(G, A, 3);
      assert.deepEqual(a.map((r) => r.kind).slice(0, 2), ['tax', 'pay_out']);
      assert.equal((await store.listTransactions(G, B, 1))[0].counterparty_id, A);
    });

    await t.test('a failing `after` rolls the money back', async () => {
      const before = await bal(G, A);
      await assert.rejects(
        eco.transact(G, [A], () => ({ changes: [{ userId: A, cash: -1, kind: 'staff_remove' }] }), {
          config,
          after: async () => {
            throw new Error('boom');
          },
        }),
        /boom/
      );
      assert.deepEqual(await bal(G, A), before);
    });

    await t.test('50 parallel credits to one new account lose nothing', async () => {
      const C = 'user-c';
      const results = await Promise.all(
        Array.from({ length: 50 }, () => eco.credit(G, C, 3, { kind: 'daily', config }))
      );
      assert.ok(results.every((r) => r.ok && r.applied === 3));
      assert.deepEqual(await bal(G, C), { cash: 150, bank: 0 });
      const rows = await store.listTransactions(G, C, 100);
      assert.equal(rows.length, 50);
      assert.equal(new Set(rows.map((r) => r.cash_after)).size, 50);
    });

    await t.test('parallel debits never overdraw', async () => {
      const D = 'user-d';
      await eco.credit(G, D, 100, { kind: 'daily', config });
      const results = await Promise.all(
        Array.from({ length: 30 }, () => eco.debit(G, D, 7, { kind: 'staff_remove', config }))
      );
      assert.equal(results.filter((r) => r.ok).length, 14);
      assert.deepEqual(await bal(G, D), { cash: 2, bank: 0 });
    });

    await t.test('crossing payments in parallel keep the total and do not deadlock', async () => {
      const E = 'user-e';
      const F = 'user-f';
      await eco.credit(G, E, 500, { kind: 'daily', config });
      await eco.credit(G, F, 500, { kind: 'daily', config });
      const jobs = [];
      for (let i = 0; i < 20; i++) {
        jobs.push(eco.transfer(G, E, F, 5, { config }));
        jobs.push(eco.transfer(G, F, E, 3, { config }));
      }
      const results = await Promise.all(jobs);
      assert.ok(results.every((r) => r.ok));
      assert.deepEqual(await bal(G, E), { cash: 460, bank: 0 });
      assert.deepEqual(await bal(G, F), { cash: 540, bank: 0 });
    });

    await t.test('resetAccount and resetGuild', async () => {
      await eco.credit(H, A, 70, { kind: 'daily', config });
      await eco.credit(H, B, 30, { kind: 'daily', config });
      const one = await eco.resetAccount(H, A, { actorId: B, config });
      assert.equal(one.ok, true);
      assert.deepEqual(await bal(H, A), { cash: 0, bank: 0 });
      const all = await eco.resetGuild(H, { actorId: B, config });
      assert.equal(all.accounts, 2);
      assert.deepEqual(await bal(H, B), { cash: 0, bank: 0 });
      const reset = (await store.listTransactions(H, B, 5))[0];
      assert.deepEqual([reset.kind, reset.amount, reset.actor_id], ['reset', -30, B]);
    });

    await t.test('listing, rank, count, prune, forget and the guild purge run on Postgres', async () => {
      const page = await store.listAccounts(G, { sort: 'cash', dir: 'asc', limit: 3, offset: 0 });
      assert.ok(page.length >= 3);
      assert.ok(Number(page[0].cash) <= Number(page[1].cash));
      assert.equal(await store.accountCount(H), 2);
      assert.ok((await store.rankOfTotal(G, 0)) >= 1);
      assert.equal((await store.transactionCount(G, A)) > 0, true);

      assert.ok((await store.transactionCount(H, B)) > 0);
      assert.equal(await store.pruneTransactions(Date.now()), 0, 'rows from today are not old enough');

      const gone = await purge.forgetUser(G, A);
      assert.equal(gone.economyAccounts, 1);
      assert.ok(gone.economyTransactions >= 5);
      assert.equal(await store.getAccount(G, A), null);
      const exported = await purge.exportUserData(G, B);
      assert.ok(Array.isArray(exported.data.economyAccount));
      await purge.purgeGuild(G);
      await purge.purgeGuild(H);
      assert.equal(await store.accountCount(G), 0);
      assert.equal(await store.transactionCount(G, B), 0);
    });
  }
);
