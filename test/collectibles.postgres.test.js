// Collectibles on a real Postgres connection: the new columns and their partial indexes exist, an item keeps
// its rarity, announce switch and picture, a purchase is one transaction, the collection query (grouping and
// paging) works on Postgres, a deleted item hands its picture to the rows that are still owned, the picture
// is found by its id, and /forget and the purge cover it. The upgrade from 5.0 and 5.1 is in upgradeBoot.test.js.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'collectibles against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const shopDb = await import('../src/db/economyShop.js');
    const eco = await import('../src/modules/lib/economy.js');
    const store = await import('../src/db/economy.js');
    const shop = await import('../src/modules/lib/shop.js');
    const purge = await import('../src/db/purge.js');
    const { prepare } = await import('../src/db/driver.js');
    const { normaliseEconomyConfig, normaliseItem } = await import('../src/modules/lib/economyConfig.js');
    const { fakeMember, fakeShopGuild, dropFakeShop } = await import('./helpers/fakeShop.js');
    const { saveImage, pathOf } = await import('../src/lib/collectibleFiles.js');
    t.after(async () => {
      dropFakeShop();
      await closePostgres();
    });

    const config = normaliseEconomyConfig({});
    const G = `5700${Date.now()}`.slice(0, 19);
    const { guild } = fakeShopGuild(G, {});
    const member = async (i, cash = 1000) => {
      const m = fakeMember(`84${String(Date.now()).slice(-6)}${String(i).padStart(4, '0')}`);
      guild.members.cache.set(m.id, m);
      if (cash) await eco.credit(G, m.id, cash, { kind: 'staff_add', config });
      return m;
    };
    const cash = async (m) => Number((await store.getAccount(G, m.id))?.cash ?? 0);
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const badge = async (over = {}) => {
      const id = await shopDb.createItem(
        G,
        normaliseItem({ name: 'Badge', price: 100, type: 'collectible', ...over })
      );
      await shopDb.setItemImage(G, id, await saveImage(G, png));
      return id;
    };
    const buy = async (m, id) => {
      const item = await shopDb.getItem(G, id);
      return shop.purchase({
        guild,
        member: m,
        itemId: id,
        expectedPrice: item.price,
        expectedVersion: item.updatedAt,
        config,
      });
    };

    await t.test('the new columns and their partial indexes exist', async () => {
      const cols = await prepare(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE table_name IN ('economy_items', 'economy_inventory') AND column_name IN ('image_id', 'rarity', 'announce')
         ORDER BY table_name, column_name`
      ).all();
      assert.deepEqual(
        cols.map((c) => `${c.table_name}.${c.column_name}`),
        [
          'economy_inventory.image_id',
          'economy_inventory.rarity',
          'economy_items.announce',
          'economy_items.image_id',
          'economy_items.rarity',
        ]
      );
      const idx = await prepare(
        `SELECT indexname FROM pg_indexes WHERE indexname IN ('idx_economy_items_image', 'idx_economy_inventory_image') ORDER BY indexname`
      ).all();
      assert.deepEqual(
        idx.map((r) => r.indexname),
        ['idx_economy_inventory_image', 'idx_economy_items_image']
      );
    });

    await t.test(
      'an item keeps its rarity, announce switch and picture; an edit keeps the picture',
      async () => {
        const id = await badge({ rarity: 'epic', announce: true, stock: 3 });
        const got = await shopDb.getItem(G, id);
        assert.deepEqual(
          [got.type, got.rarity, got.announce, typeof got.imageId],
          ['collectible', 'epic', true, 'string']
        );
        await shopDb.updateItem(
          G,
          id,
          normaliseItem({ name: 'Badge', price: 120, type: 'collectible', rarity: 'rare', stock: 3 })
        );
        const edited = await shopDb.getItem(G, id);
        assert.deepEqual(
          [edited.rarity, edited.announce, edited.imageId, edited.price],
          ['rare', false, got.imageId, 120]
        );
        assert.ok(edited.updatedAt > got.updatedAt);
        assert.equal(await shopDb.guildOfImage(got.imageId), G);
        assert.equal(await shopDb.guildOfImage('f'.repeat(32)), null);
      }
    );

    await t.test('buying, the collection query, refund and the files', async () => {
      const m = await member(1);
      const a = await badge({ name: 'A', price: 10, stock: 2 });
      const b = await badge({ name: 'B', price: 10, rarity: 'rare' });
      const first = await buy(m, a);
      assert.equal(first.ok, true);
      assert.equal((await buy(m, a)).ok, true);
      assert.equal((await buy(m, a)).reason, 'sold_out');
      assert.equal((await buy(m, b)).ok, true);
      assert.equal(await cash(m), 970);
      const page = await shopDb.collectionPage(G, m.id, 1, 1);
      assert.deepEqual([page.kinds, page.copies, page.pages, page.entries.length], [2, 3, 2, 1]);
      assert.deepEqual([page.entries[0].name, page.entries[0].count], ['A', 2]);
      assert.equal((await shopDb.collectionPage(G, m.id, 2, 1)).entries[0].rarity, 'rare');
      const refunded = await shop.endRow({ guild, rowId: first.row.id, mode: 'refund', config });
      assert.equal(refunded.ok, true);
      assert.equal(await cash(m), 980);
      assert.equal((await shopDb.getItem(G, a)).sold, 1);

      // deleting an owned item hands its picture to the rows and keeps the file
      const imageId = (await shopDb.getItem(G, b)).imageId;
      await shopDb.deleteItem(G, b);
      assert.ok(existsSync(pathOf(G, imageId)));
      const kept = (await shopDb.collectionPage(G, m.id)).entries.find((e) => e.name === 'B');
      assert.deepEqual([kept.removed, kept.imageId, kept.rarity], [true, imageId, 'rare']);
      assert.equal(await shopDb.guildOfImage(imageId), G);
      // the member is erased: the last copy, so the file goes
      await shopDb.eraseInventory(G, m.id);
      assert.equal(existsSync(pathOf(G, imageId)), false);
      assert.equal(await shopDb.guildOfImage(imageId), null);
    });

    await t.test('the purge removes the files of the server', async () => {
      const id = await badge({ name: 'Purged' });
      const imageId = (await shopDb.getItem(G, id)).imageId;
      assert.ok(existsSync(pathOf(G, imageId)));
      await purge.purgeGuild(G);
      assert.equal(existsSync(pathOf(G, imageId)), false);
      assert.deepEqual(await shopDb.listItems(G), []);
    });
  }
);
