// Proves the shop and the giveaway fee on a real Postgres connection: the bootstrap and migration 69
// create the tables and columns, a purchase is one transaction (debit, stock, inventory, ledger),
// 20 parallel buys of the last 5 items sell 5, a failed role grant refunds, refund and revoke work,
// the entry fee is charged and refunded once, and /forget and the purge cover the new tables.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'the economy shop against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const shopDb = await import('../src/db/economyShop.js');
    const giveawayDb = await import('../src/db/giveaways.js');
    const store = await import('../src/db/economy.js');
    const eco = await import('../src/modules/lib/economy.js');
    const shop = await import('../src/modules/lib/shop.js');
    const gw = await import('../src/modules/giveaways.js');
    const purge = await import('../src/db/purge.js');
    const modules = await import('../src/db/modules.js');
    const { normaliseEconomyConfig, normaliseItem } = await import('../src/modules/lib/economyConfig.js');
    const { buyNow, fakeMember, fakeRole, fakeShopGuild, dropFakeShop, ROLE_A } =
      await import('./helpers/fakeShop.js');
    t.after(async () => {
      dropFakeShop();
      await closePostgres();
    });

    const config = normaliseEconomyConfig({});
    const G = `5900${Date.now()}`.slice(0, 19);
    const { guild } = fakeShopGuild(G, { roles: [fakeRole(ROLE_A, 'Millionaire')] });
    const member = async (i, cash = 1000) => {
      const m = fakeMember(`83${String(Date.now()).slice(-6)}${String(i).padStart(4, '0')}`);
      guild.members.cache.set(m.id, m);
      if (cash) await eco.credit(G, m.id, cash, { kind: 'staff_add', config });
      return m;
    };
    const cash = async (m) => Number((await store.getAccount(G, m.id))?.cash ?? 0);
    const item = (over) =>
      shopDb.createItem(G, normaliseItem({ name: 'Thing', price: 100, type: 'custom', ...over }));
    const buy = (m, id) => buyNow({ guild, member: m, itemId: id, config });

    await t.test('items round-trip with numbers as numbers and the role list as an array', async () => {
      const id = await item({
        stock: 7,
        requiredRoles: ['700000000000000001'],
        perMemberLimit: 3,
        emoji: '🎁',
      });
      const got = await shopDb.getItem(G, id);
      assert.deepEqual(
        [
          typeof got.id,
          got.price,
          got.stock,
          got.sold,
          got.requiredRoles,
          got.perMemberLimit,
          got.enabled,
          got.sortOrder,
        ],
        ['number', 100, 7, 0, ['700000000000000001'], 3, true, 0]
      );
      await shopDb.updateItem(
        G,
        id,
        normaliseItem({ name: 'Renamed', price: 150, type: 'custom', stock: '' })
      );
      assert.deepEqual(
        [(await shopDb.getItem(G, id)).name, (await shopDb.getItem(G, id)).stock],
        ['Renamed', null]
      );
      const second = await item({ name: 'Second' });
      await shopDb.reorderItems(G, [second, id]);
      assert.deepEqual((await shopDb.listItems(G)).map((i) => i.id).slice(0, 2), [second, id]);
      await shopDb.setItemEnabled(G, second, false);
      assert.equal((await shopDb.getItem(G, second)).enabled, false);
    });

    await t.test('a purchase is one transaction: debit, stock, inventory row, ledger row', async () => {
      const m = await member(1);
      const id = await item({ stock: 3, price: 100 });
      const out = await buy(m, id);
      assert.equal(out.ok, true);
      assert.equal(await cash(m), 900);
      assert.equal((await shopDb.getItem(G, id)).sold, 1);
      const [row] = await shopDb.listInventory(G, m.id);
      assert.deepEqual(
        [row.itemName, row.status, row.pricePaid, typeof row.id],
        ['Thing', 'active', 100, 'number']
      );
      const ledger = await store.listTransactions(G, m.id, 5);
      assert.deepEqual([ledger[0].kind, ledger[0].amount], ['purchase', -100]);
    });

    await t.test('20 parallel buys of the last 5 items sell exactly 5', async () => {
      const id = await item({ stock: 5, price: 10 });
      const buyers = [];
      for (let i = 0; i < 20; i++) buyers.push(await member(100 + i, 10));
      const results = await Promise.all(buyers.map((m) => buy(m, id)));
      assert.equal(results.filter((r) => r.ok).length, 5);
      assert.ok(results.filter((r) => !r.ok).every((r) => r.reason === 'sold_out'));
      assert.equal((await shopDb.getItem(G, id)).sold, 5);
    });

    await t.test('a role that the platform refuses is refunded, with the stock put back', async () => {
      const m = await member(2);
      const id = await item({ type: 'temp_role', roleId: ROLE_A, durationHours: 24, price: 100, stock: 2 });
      m.failAdd = true;
      const out = await buy(m, id);
      assert.deepEqual([out.ok, out.reason, out.refunded], [false, 'grant_failed', true]);
      assert.equal(await cash(m), 1000);
      assert.equal((await shopDb.getItem(G, id)).sold, 0);
      const kinds = (await store.listTransactions(G, m.id, 5)).map((r) => r.kind);
      assert.deepEqual(kinds.slice(0, 2), ['refund', 'purchase']);
    });

    await t.test('refund, revoke and a free grant', async () => {
      const m = await member(3);
      const id = await item({ price: 200, stock: 4 });
      await buy(m, id);
      const [row] = await shopDb.listInventory(G, m.id);
      const refunded = await shop.endRow({ guild, rowId: row.id, mode: 'refund', config });
      assert.deepEqual([refunded.ok, refunded.refunded], [true, true]);
      assert.equal(await cash(m), 1000);
      assert.equal(
        (await shop.endRow({ guild, rowId: row.id, mode: 'refund', config })).reason,
        'not_active'
      );
      const granted = await shop.grantItem({ guild, member: m, itemId: id, by: 'staff', config });
      assert.equal(granted.ok, true);
      const [free] = await shopDb.listInventory(G, m.id);
      assert.deepEqual([free.source, free.pricePaid], ['grant', 0]);
      assert.equal((await shop.endRow({ guild, rowId: free.id, mode: 'revoke', config })).ok, true);
      assert.equal((await shopDb.getInventoryRow(G, free.id)).status, 'revoked');
      const ledger = (await store.listTransactions(G, m.id, 10)).map((r) => [r.kind, r.amount]);
      assert.deepEqual(ledger.slice(0, 2), [
        ['revoke', 0],
        ['grant', 0],
      ]);
    });

    await t.test('activity, stats and the stale-pending query run on Postgres', async () => {
      const act = await shopDb.listActivity(G, { limit: 3 });
      assert.ok(act.total >= 1 && act.rows.length <= 3);
      assert.ok((await shopDb.itemStats(G)).size >= 1);
      assert.deepEqual(await shopDb.stalePending(Date.now() - 1, 5), []);
      assert.equal(typeof (await shopDb.heldCount(G, 1)), 'number');
    });

    await t.test(
      'giveaway entry fee: charged, refunded on leave and on cancel, prize paid; columns exist after migration 69',
      async () => {
        await modules.setGuildModule(G, 'giveaways', { enabled: true, config: {} });
        await modules.setGuildModule(G, 'economy', { enabled: true, config: {} });
        const { id } = await giveawayDb.createGiveaway({
          guildId: G,
          channelId: '700000000000000201',
          prize: 'p',
          winners: 1,
          hostId: 'h',
          endsAt: Date.now() + 3_600_000,
          entryFee: 40,
          prizeAmount: 90,
        });
        const g = await giveawayDb.getGiveaway(id);
        assert.deepEqual([g.entry_fee, g.prize_amount, g.cancelled], [40, 90, false]);
        const a = await member(10);
        const b = await member(11);
        assert.deepEqual(await gw.toggleEntryWithFee(g, a.id), { ok: true, joined: true });
        assert.equal(await cash(a), 960);
        assert.deepEqual(await gw.toggleEntryWithFee(g, a.id), { ok: true, joined: false });
        assert.equal(await cash(a), 1000);
        await gw.toggleEntryWithFee(g, a.id);
        await gw.toggleEntryWithFee(g, b.id);
        const parallel = await Promise.all([gw.toggleEntryWithFee(g, b.id), gw.toggleEntryWithFee(g, b.id)]);
        assert.equal(parallel.length, 2);
        const cancelled = await gw.cancelGiveaway(id);
        assert.deepEqual([cancelled.ok, cancelled.failed], [true, 0]);
        assert.equal(await cash(a), 1000);
        assert.equal(await cash(b), 1000);
        assert.equal((await giveawayDb.getGiveaway(id)).cancelled, true);

        const { id: drawn } = await giveawayDb.createGiveaway({
          guildId: G,
          channelId: '700000000000000201',
          prize: 'p',
          winners: 1,
          hostId: 'h',
          endsAt: Date.now() + 3_600_000,
          prizeAmount: 90,
        });
        await giveawayDb.addGiveawayEntry(drawn, a.id);
        const out = await gw.endGiveaway(drawn);
        assert.deepEqual(out.winners, [a.id]);
        assert.equal(await cash(a), 1090);
      }
    );

    await t.test('the fix-round columns, tables and indexes exist', async () => {
      const { prepare } = await import('../src/db/driver.js');
      const cols = async (table) =>
        (
          await prepare('SELECT column_name FROM information_schema.columns WHERE table_name = ?').all(table)
        ).map((r) => r.column_name);
      assert.ok((await cols('economy_inventory')).includes('added_ms'));
      assert.ok((await cols('economy_inventory')).includes('lease_until'));
      assert.ok((await cols('giveaway_entries')).includes('refunded'));
      assert.ok((await cols('giveaways')).includes('prizes_paid'));
      assert.deepEqual((await cols('giveaway_prizes')).sort(), [
        'amount',
        'giveaway_id',
        'paid_at',
        'user_id',
      ]);
      const idx = (
        await prepare('SELECT indexname FROM pg_indexes WHERE tablename = ?').all('economy_inventory')
      ).map((r) => r.indexname);
      assert.ok(idx.includes('idx_economy_inventory_pending'));
    });

    await t.test(
      'a changed price is refused, and parallel buys of a permanent role charge once',
      async () => {
        const m = await member(30);
        const id = await item({ price: 100 });
        assert.equal(
          (
            await shop.purchase({
              guild,
              member: m,
              itemId: id,
              expectedPrice: 99,
              expectedVersion: 1,
              config,
            })
          ).reason,
          'price_changed'
        );
        assert.equal(await cash(m), 1000);
        const role = await item({ name: 'Legend', type: 'role', roleId: ROLE_A, price: 100 });
        const results = await Promise.all([buy(m, role), buy(m, role), buy(m, role), buy(m, role)]);
        assert.equal(results.filter((r) => r.ok).length, 1);
        assert.equal(await cash(m), 900, 'charged once');
        assert.equal((await shopDb.getItem(G, role)).sold, 1);
      }
    );

    await t.test(
      'a temporary role that expired is marked, and a refund takes off only its own time',
      async () => {
        const tm = await member(31);
        const tid = await item({
          type: 'temp_role',
          roleId: ROLE_A,
          durationHours: 24,
          price: 100,
          perMemberLimit: 1,
        });
        const bought = await buy(tm, tid);
        assert.equal(bought.ok, true);
        const row = (await shopDb.listInventory(G, tm.id))[0];
        assert.equal(row.addedMs, 86_400_000);
        assert.equal(await shopDb.expireShopTempRows(G, tm.id, ROLE_A), 1);
        assert.equal((await shopDb.getInventoryRow(G, row.id)).status, 'expired');
        assert.equal((await buy(tm, tid)).ok, true, 'an expired purchase does not count against the limit');
        assert.equal((await shopDb.stalePending(Date.now() + 1, 5)).length, 0);
      }
    );

    await t.test(
      'giveaway money: entries racing a cancel, a prize paid in parallel, and the sweep',
      async () => {
        await modules.setGuildModule(G, 'giveaways', { enabled: true, config: {} });
        await modules.setGuildModule(G, 'economy', { enabled: true, config: {} });
        const mk = (over) =>
          giveawayDb.createGiveaway({
            guildId: G,
            channelId: '700000000000000201',
            prize: 'p',
            winners: 12,
            hostId: 'h',
            endsAt: Date.now() + 3_600_000,
            ...over,
          });

        // twelve members enter while the giveaway is cancelled: every one that was charged is refunded
        const { id: cid } = await mk({ entryFee: 40 });
        const racers = [];
        for (let i = 0; i < 12; i++) racers.push(await member(200 + i));
        const g = await giveawayDb.getGiveaway(cid);
        await Promise.all([
          ...racers.map((m) => gw.toggleEntryWithFee(g, m.id)),
          gw.cancelGiveaway(cid),
          gw.cancelGiveaway(cid),
          gw.completeGiveawayMoney(),
        ]);
        await gw.cancelGiveaway(cid); // finish what the race left
        for (const m of racers)
          assert.equal(await cash(m), 1000, 'charged members were refunded, the others never paid');
        assert.deepEqual(await giveawayDb.unrefundedEntrantIds(cid), []);

        // twelve members enter while the draw runs: a charged member is in the draw, a winner pays
        const { id: did } = await mk({ entryFee: 40 });
        const runners = [];
        for (let i = 0; i < 12; i++) runners.push(await member(220 + i));
        const dg = await giveawayDb.getGiveaway(did);
        await Promise.all([...runners.map((m) => gw.toggleEntryWithFee(dg, m.id)), gw.endGiveaway(did)]);
        const drawn = await giveawayDb.getGiveaway(did);
        const entered = new Set(await giveawayDb.giveawayEntrantIds(did));
        for (const m of runners) {
          const paid = (await cash(m)) === 960;
          assert.equal(paid, entered.has(m.id), 'charged exactly when the entry exists');
        }
        for (const w of drawn.wonIds) assert.equal(entered.has(w), true, 'a winner was never refunded');

        // one prize, five payouts at the same moment: paid once
        const { id: pid } = await mk({ prizeAmount: 70 });
        const pg = await giveawayDb.getGiveaway(pid);
        const winner = await member(240);
        const outs = await Promise.all([1, 2, 3, 4, 5].map(() => gw.payPrize(pg, winner.id, config)));
        assert.equal(outs.filter((o) => o.ok).length, 1);
        assert.equal(await cash(winner), 1070);

        // a crash after the draw: the sweep pays
        const { id: sid } = await mk({ prizeAmount: 30, winners: 1 });
        const late = await member(241);
        await giveawayDb.markGiveawayEnded(sid, [late.id]);
        await gw.completeGiveawayMoney();
        await gw.completeGiveawayMoney();
        assert.equal(await cash(late), 1030);
        assert.equal((await giveawayDb.getGiveaway(sid)).prizesPaid, true);
      }
    );

    await t.test('/forget, export and the guild purge cover the new tables', async () => {
      const m = await member(20);
      const id = await item({ price: 10 });
      await buy(m, id);
      const gone = await purge.forgetUser(G, m.id);
      assert.equal(gone.economyInventory, 1);
      assert.equal((await shopDb.listInventory(G, m.id)).length, 0);
      const dump = await purge.exportUserData(G, m.id);
      assert.deepEqual(dump.data.economyInventory, []);
      await purge.purgeGuild(G);
      assert.equal(await shopDb.itemCount(G), 0);
    });
  }
);
