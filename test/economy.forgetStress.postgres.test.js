// /forget (and the shop's own erasure) running at the same moment as credits, payments, purchases,
// giveaway entries and cancels, and the sweeps (pending role grants, temporary roles, giveaway money,
// cooldown prune), many times over on a real Postgres connection: nothing may deadlock or fail.
// Lock order of every economy transaction (documented at the top of modules/lib/economy.js): the member
// accounts in user id order, then the ledger, then (inside the `after` hook) the giveaway row, the item
// row, the member's inventory, giveaway entries and prizes, and temporary-role records.
//
// It runs in a database of its own: the cooldown prune it includes is global (it would delete the records
// of other test files that share the CI database), and the test must not share rows or locks with them.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.DATABASE_URL;
const ROUNDS = Number(process.env.STRESS_ROUNDS) || 40;

test(
  '/forget in parallel with money, purchases, giveaway fees and the sweeps never deadlocks',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const postgres = (await import('postgres')).default;
    const admin = postgres(url);
    const dbName = `sylo_stress_${process.pid}_${Date.now()}`;
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    const own = new URL(url);
    own.pathname = `/${dbName}`;
    // the app reads DATABASE_URL when its config module loads, so this comes before every import of it
    process.env.DATABASE_URL = own.toString();
    const { closePostgres } = await import('../src/db/driver.js');
    const eco = await import('../src/modules/lib/economy.js');
    const shopDb = await import('../src/db/economyShop.js');
    const store = await import('../src/db/economy.js');
    const giveawayDb = await import('../src/db/giveaways.js');
    const modules = await import('../src/db/modules.js');
    const purge = await import('../src/db/purge.js');
    const shop = await import('../src/modules/lib/shop.js');
    const gw = await import('../src/modules/giveaways.js');
    const tempRoles = await import('../src/modules/tempRoles.js');
    const { normaliseEconomyConfig, normaliseItem } = await import('../src/modules/lib/economyConfig.js');
    const { buyNow, fakeMember, fakeRole, fakeShopGuild, dropFakeShop, ROLE_A, ROLE_B } =
      await import('./helpers/fakeShop.js');
    t.after(async () => {
      dropFakeShop();
      await closePostgres();
      await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.end({ timeout: 1 });
    });

    const config = normaliseEconomyConfig({});
    const G = `5950${Date.now()}`.slice(0, 19);
    const { guild } = fakeShopGuild(G, {
      roles: [fakeRole(ROLE_A, 'Temp'), fakeRole(ROLE_B, 'Perm')],
    });
    await modules.setGuildModule(G, 'giveaways', { enabled: true, config: {} });
    await modules.setGuildModule(G, 'economy', { enabled: true, config: {} });
    const mk = (over) => shopDb.createItem(G, normaliseItem({ name: 'Thing', price: 10, ...over }));
    const custom = await mk({ type: 'custom' });
    const temp = await mk({ type: 'temp_role', roleId: ROLE_A, durationHours: 24 });
    const perm = await mk({ type: 'role', roleId: ROLE_B });
    const gwId = (
      await giveawayDb.createGiveaway({
        guildId: G,
        channelId: '700000000000000201',
        prize: 'p',
        winners: 1,
        hostId: 'h',
        endsAt: Date.now() + 3_600_000,
        entryFee: 5,
        prizeAmount: 5,
      })
    ).id;

    const ids = ['8310000000000001', '8310000000000002', '8310000000000003'];
    const members = new Map();
    for (const id of ids) {
      const m = fakeMember(id);
      guild.members.cache.set(id, m);
      members.set(id, m);
    }
    const [A, B, C] = ids;

    const failures = [];
    for (let round = 0; round < ROUNDS; round++) {
      for (const id of ids) await eco.credit(G, id, 500, { kind: 'staff_add', config });
      const g = await giveawayDb.getGiveaway(gwId);
      const jobs = [
        purge.forgetUser(G, A),
        shop.endShopRolesForForget(guild, A),
        eco.credit(G, A, 3, { kind: 'daily', config }),
        eco.credit(G, A, 4, { kind: 'work', config }),
        eco.transfer(G, A, B, 2, { config }),
        eco.transfer(G, B, A, 2, { config }),
        eco.transfer(G, B, C, 1, { config }),
        buyNow({ guild, member: members.get(A), itemId: custom, config }),
        buyNow({ guild, member: members.get(A), itemId: temp, config }),
        buyNow({ guild, member: members.get(B), itemId: perm, config }),
        buyNow({ guild, member: members.get(C), itemId: temp, config }),
        gw.toggleEntryWithFee(g, A),
        gw.toggleEntryWithFee(g, B),
        gw.completeGiveawayMoney(),
        shop.recoverPending(Date.now() + 3_600_000),
        tempRoles.sweep(Date.now() + 3 * 86_400_000),
        store.pruneCooldowns(Date.now() + 8 * 86_400_000),
        purge.forgetUser(G, B),
      ];
      for (const r of await Promise.allSettled(jobs)) {
        if (r.status === 'rejected') {
          // the statement and the lock detail, so a deadlock can be read from the CI log
          const why = r.reason ?? {};
          failures.push(
            `round ${round}: ${why.code ?? ''} ${why.message} | ${String(why.query ?? '')
              .replace(/\s+/g, ' ')
              .slice(0, 160)} | ${String(why.detail ?? '').replace(/\s+/g, ' ')}`
          );
        }
      }
      // each round starts from nothing for these members
      await purge.forgetUser(G, A);
      await purge.forgetUser(G, B);
      await purge.forgetUser(G, C);
      for (const m of members.values()) m.roles.cache.clear();
    }
    assert.deepEqual(failures, [], 'no job failed, and none was a deadlock (40P01)');
    await purge.purgeGuild(G);
  }
);
