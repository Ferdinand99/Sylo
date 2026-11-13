// Collectibles on a real Postgres connection. The pictures are Sylo's first binary column, so the test that
// matters most is the round trip: bytes in equal bytes out, every byte value, a few hundred kilobytes. Also: the
// new table, its index and its storage setting, the columns on the item and inventory tables, an item that keeps
// its rarity, announce switch and picture, a purchase that carries the picture, the quota, a picture that goes
// in the transaction that drops its last reference, a collection query with grouping and paging, /forget and the
// purge, and the exact statement scripts/migrate-sqlite-to-postgres.js uses to copy a table (a row read from
// SQLite with a BLOB in it). The upgrade from 5.0 and 5.1 is in upgradeBoot.test.js.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'collectibles against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const shopDb = await import('../src/db/economyShop.js');
    const images = await import('../src/db/collectibleImages.js');
    const eco = await import('../src/modules/lib/economy.js');
    const store = await import('../src/db/economy.js');
    const shop = await import('../src/modules/lib/shop.js');
    const purge = await import('../src/db/purge.js');
    const { prepare } = await import('../src/db/driver.js');
    const { normaliseEconomyConfig, normaliseItem } = await import('../src/modules/lib/economyConfig.js');
    const { fakeMember, fakeShopGuild, dropFakeShop } = await import('./helpers/fakeShop.js');
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
    let size = 10;
    const stored = async () =>
      (await prepare('SELECT id FROM collectible_images WHERE guild_id = ? ORDER BY id').all(G)).map(
        (r) => r.id
      );
    const badge = async (over = {}) => {
      const id = await shopDb.createItem(
        G,
        normaliseItem({ name: 'Badge', price: 100, type: 'collectible', ...over })
      );
      const out = await images.attachImage(G, id, { mime: 'image/webp', data: randomBytes(++size * 7) });
      assert.equal(out.ok, true);
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

    await t.test('the table, its index and storage setting, and the new columns exist', async () => {
      const cols = await prepare(
        `SELECT table_name, column_name, data_type FROM information_schema.columns
         WHERE (table_name = 'collectible_images')
            OR (table_name IN ('economy_items', 'economy_inventory') AND column_name IN ('image_id', 'rarity', 'announce'))
         ORDER BY table_name, column_name`
      ).all();
      assert.deepEqual(
        cols.map((c) => `${c.table_name}.${c.column_name}:${c.data_type}`),
        [
          'collectible_images.bytes:integer',
          'collectible_images.created_at:bigint',
          'collectible_images.data:bytea',
          'collectible_images.guild_id:text',
          'collectible_images.id:text',
          'collectible_images.mime:text',
          'economy_inventory.image_id:text',
          'economy_inventory.rarity:text',
          'economy_items.announce:integer',
          'economy_items.image_id:text',
          'economy_items.rarity:text',
        ]
      );
      const idx = await prepare(
        `SELECT indexname FROM pg_indexes
         WHERE indexname IN ('idx_economy_items_image', 'idx_economy_inventory_image', 'idx_collectible_images_guild')
         ORDER BY indexname`
      ).all();
      assert.deepEqual(
        idx.map((r) => r.indexname),
        ['idx_collectible_images_guild', 'idx_economy_inventory_image', 'idx_economy_items_image']
      );
      const [storage] = await prepare(
        `SELECT attstorage FROM pg_attribute WHERE attrelid = 'collectible_images'::regclass AND attname = 'data'`
      ).all();
      assert.equal(storage.attstorage, 'e', 'out of line and not compressed');
    });

    await t.test('bytes in equal bytes out: every byte value, empty-looking and large pictures', async () => {
      const everyByte = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
      const samples = [
        everyByte,
        Buffer.from([0, 0, 0, 0]),
        Buffer.from([0xff, 0xd8, 0xff]),
        randomBytes(5000),
        randomBytes(300_000),
        Buffer.concat([everyByte, Buffer.alloc(70_000), everyByte]),
      ];
      for (const data of samples) {
        const id = await shopDb.createItem(
          G,
          normaliseItem({ name: 'Bytes', price: 1, type: 'collectible' })
        );
        const out = await images.attachImage(G, id, { mime: 'image/webp', data });
        assert.equal(out.ok, true);
        const read = await images.readImage(out.imageId);
        assert.ok(Buffer.isBuffer(read.data), 'a Buffer');
        assert.equal(read.data.length, data.length);
        assert.ok(read.data.equals(data), `${data.length} bytes come back unchanged`);
        assert.equal(read.bytes, data.length);
        assert.equal(read.mime, 'image/webp');
        // the bytea is as long as what was put in (no hex or escape encoding on the way)
        const [len] = await prepare(
          'SELECT octet_length(data) AS n FROM collectible_images WHERE id = ?'
        ).all(out.imageId);
        assert.equal(Number(len.n), data.length);
        await shopDb.deleteItem(G, id);
      }
      assert.deepEqual(await stored(), []);
    });

    await t.test('the statement of the SQLite to Postgres copy script carries a BLOB', async () => {
      const Database = (await import('better-sqlite3')).default;
      const postgres = (await import('postgres')).default;
      const sqlite = new Database(':memory:');
      sqlite.exec(
        `CREATE TABLE collectible_images_copy (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, mime TEXT NOT NULL,
           bytes INTEGER NOT NULL, data BLOB NOT NULL, created_at INTEGER NOT NULL)`
      );
      const blobs = [Buffer.from(Array.from({ length: 256 }, (_, i) => i)), randomBytes(100_000)];
      blobs.forEach((b, i) =>
        sqlite
          .prepare('INSERT INTO collectible_images_copy VALUES (?, ?, ?, ?, ?, ?)')
          .run(`${i}`.padStart(32, 'a'), G, 'image/webp', b.length, b, 1)
      );
      const rows = sqlite.prepare('SELECT * FROM collectible_images_copy ORDER BY rowid').all();
      const columns = ['id', 'guild_id', 'mime', 'bytes', 'data', 'created_at'];
      const sql = postgres(url);
      try {
        await sql`CREATE TABLE collectible_images_copy (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, mime TEXT NOT NULL,
          bytes INTEGER NOT NULL, data BYTEA NOT NULL, created_at BIGINT NOT NULL)`;
        // exactly what copyTable() in scripts/migrate-sqlite-to-postgres.js runs
        await sql`INSERT INTO ${sql('collectible_images_copy')} ${sql(rows, ...columns)}`;
        const back = await sql`SELECT * FROM collectible_images_copy ORDER BY id`;
        assert.equal(back.length, 2);
        back.forEach((r, i) =>
          assert.ok(Buffer.from(r.data).equals(blobs[i]), `row ${i} came back unchanged`)
        );
      } finally {
        await sql`DROP TABLE IF EXISTS collectible_images_copy`;
        await sql.end({ timeout: 1 });
        sqlite.close();
      }
    });

    await t.test(
      'an item keeps its rarity, announce switch and picture; the picture is replaced and deleted in one step',
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
        const replaced = await images.attachImage(G, id, { mime: 'image/webp', data: randomBytes(200) });
        assert.equal(replaced.ok, true);
        assert.equal(await images.readImage(got.imageId), null, 'the old picture is gone');
        assert.equal((await shopDb.getItem(G, id)).imageId, replaced.imageId);
        assert.equal(await images.detachImage(G, id), true);
        assert.equal(await images.readImage(replaced.imageId), null);
        assert.equal(await images.detachImage(G, id), false, 'nothing to take off');
      }
    );

    await t.test(
      'buying, the collection query, refund, and the pictures that stay while a copy holds them',
      async () => {
        const m = await member(1);
        const a = await badge({ name: 'A', price: 10, stock: 2 });
        const b = await badge({ name: 'B', price: 10, rarity: 'rare' });
        const first = await buy(m, a);
        assert.equal(first.ok, true);
        assert.equal((await buy(m, a)).ok, true);
        assert.equal((await buy(m, a)).reason, 'sold_out');
        const rareCopy = await buy(m, b);
        assert.equal(rareCopy.ok, true);
        assert.equal(await cash(m), 970);
        assert.equal(
          (await shopDb.getInventoryRow(G, rareCopy.row.id)).imageId,
          (await shopDb.getItem(G, b)).imageId,
          'the copy carries the picture'
        );
        const page = await shopDb.collectionPage(G, m.id, 1, 1);
        assert.deepEqual([page.kinds, page.copies, page.pages, page.entries.length], [2, 3, 2, 1]);
        assert.deepEqual([page.entries[0].name, page.entries[0].count], ['A', 2]);
        assert.equal((await shopDb.collectionPage(G, m.id, 2, 1)).entries[0].rarity, 'rare');
        const refunded = await shop.endRow({ guild, rowId: first.row.id, mode: 'refund', config });
        assert.equal(refunded.ok, true);
        assert.equal(await cash(m), 980);
        assert.equal((await shopDb.getItem(G, a)).sold, 1);

        // deleting an owned item keeps its picture, and the last copy to let go takes it
        const imageId = (await shopDb.getItem(G, b)).imageId;
        await shopDb.deleteItem(G, b);
        assert.notEqual(await images.readImage(imageId), null);
        const kept = (await shopDb.collectionPage(G, m.id)).entries.find((e) => e.name === 'B');
        assert.deepEqual([kept.removed, kept.imageId, kept.rarity], [true, imageId, 'rare']);
        await shop.endRow({ guild, rowId: rareCopy.row.id, mode: 'revoke', config });
        assert.equal(await images.readImage(imageId), null, 'deleted with the last reference');
        // erasing a member deletes what only they held
        await shopDb.deleteItem(G, a);
        assert.equal((await stored()).length, 1, 'the second copy of A still holds its picture');
        await shopDb.eraseInventory(G, m.id);
        assert.deepEqual(await stored(), []);
      }
    );

    await t.test(
      'a new picture after the old one was taken off reaches the copies and frees the old one',
      async () => {
        const m = await member(2);
        const id = await badge({ name: 'Detached', price: 5 });
        const copy = await buy(m, id);
        assert.equal(copy.ok, true);
        const old = (await shopDb.getItem(G, id)).imageId;
        await images.detachImage(G, id);
        assert.notEqual(await images.readImage(old), null, 'the copy still holds the old picture');
        const next = await images.attachImage(G, id, { mime: 'image/webp', data: randomBytes(321) });
        assert.equal(next.ok, true);
        assert.equal(await images.readImage(old), null, 'the old picture is freed');
        assert.equal((await shopDb.getInventoryRow(G, copy.row.id)).imageId, next.imageId);
        await shopDb.deleteItem(G, id);
        await shop.endRow({ guild, rowId: copy.row.id, mode: 'revoke', config });
        assert.equal(await images.readImage(next.imageId), null);
      }
    );

    // Concurrent staff actions on Postgres: one lock order (item, rows, picture) means no deadlock, and the
    // check-then-delete of a picture cannot be fooled by the other side's uncommitted change.
    await t.test('two refunds of the last two copies at once leave no picture behind', async () => {
      for (let round = 0; round < 6; round += 1) {
        const a = await member(40 + round * 2);
        const b = await member(41 + round * 2);
        const id = await badge({ name: `Last two ${round}`, price: 5 });
        const first = await buy(a, id);
        const second = await buy(b, id);
        assert.equal(first.ok && second.ok, true);
        await shopDb.deleteItem(G, id);
        assert.equal((await stored()).length, 1, 'both copies hold it');
        const ended = await Promise.all([
          shop.endRow({ guild, rowId: first.row.id, mode: 'refund', config }),
          shop.endRow({ guild, rowId: second.row.id, mode: 'revoke', config }),
        ]);
        assert.ok(ended.every((r) => r.ok));
        assert.deepEqual(await stored(), [], `round ${round}: no orphan`);
      }
    });

    await t.test('/forget and a refund at the same moment leave no picture behind', async () => {
      for (let round = 0; round < 4; round += 1) {
        const a = await member(60 + round * 2);
        const b = await member(61 + round * 2);
        const id = await badge({ name: `Forget ${round}`, price: 5 });
        const first = await buy(a, id);
        await buy(b, id);
        await shopDb.deleteItem(G, id);
        await Promise.all([
          shop.endRow({ guild, rowId: first.row.id, mode: 'refund', config }),
          shopDb.eraseInventory(G, b.id),
        ]);
        assert.deepEqual(await stored(), [], `round ${round}: no orphan`);
      }
    });

    await t.test(
      'deleting an item (or changing its kind) while a picture is uploaded leaves no orphan',
      async () => {
        for (let round = 0; round < 6; round += 1) {
          const id = await badge({ name: `Race ${round}`, price: 5 });
          const results = await Promise.all([
            shopDb.deleteItem(G, id),
            images.attachImage(G, id, { mime: 'image/webp', data: randomBytes(150 + round) }),
          ]);
          assert.equal(results[0], true);
          assert.deepEqual(await stored(), [], `delete round ${round}: no orphan`);

          const other = await badge({ name: `Kind ${round}`, price: 5 });
          await Promise.all([
            shopDb.updateItem(G, other, normaliseItem({ name: 'Kind', price: 5, type: 'custom' })),
            images.attachImage(G, other, { mime: 'image/webp', data: randomBytes(150 + round) }),
          ]);
          const after = await shopDb.getItem(G, other);
          const held = (await stored()).length;
          // the picture is either attached to a collectible that is still one, or there is none at all
          assert.equal(held, after.imageId ? 1 : 0, `kind round ${round}: the picture is the item's or gone`);
          await shopDb.deleteItem(G, other);
          assert.deepEqual(await stored(), []);
        }
      }
    );

    await t.test('a replaced picture or an edit racing a refund does not deadlock', async () => {
      for (let round = 0; round < 6; round += 1) {
        const m = await member(80 + round);
        const id = await badge({ name: `Mixed ${round}`, price: 5, rarity: 'rare' });
        const copy = await buy(m, id);
        const out = await Promise.all([
          images.attachImage(G, id, { mime: 'image/webp', data: randomBytes(200 + round) }),
          shop.endRow({ guild, rowId: copy.row.id, mode: 'refund', config }),
          shopDb.updateItem(
            G,
            id,
            normaliseItem({ name: 'Mixed', price: 5, type: 'collectible', rarity: 'epic' })
          ),
        ]);
        assert.equal(out[0].ok, true);
        assert.equal(out[1].ok, true);
        assert.equal(out[2], true);
        assert.equal((await images.readImage((await shopDb.getItem(G, id)).imageId)) !== null, true);
        assert.equal((await stored()).length, 1, 'only the item holds a picture now');
        await shopDb.deleteItem(G, id);
        assert.deepEqual(await stored(), []);
      }
    });

    await t.test('the quota is checked in the upload transaction', async () => {
      const ids = [];
      for (let i = 0; i < 3; i += 1) {
        ids.push(await shopDb.createItem(G, normaliseItem({ name: `Q${i}`, price: 1, type: 'collectible' })));
      }
      const big = Buffer.alloc(images.MAX_IMAGE_BYTES_PER_GUILD / 2 - 100);
      assert.equal((await images.attachImage(G, ids[0], { mime: 'image/webp', data: big })).ok, true);
      assert.equal((await images.attachImage(G, ids[1], { mime: 'image/webp', data: big })).ok, true);
      const over = await images.attachImage(G, ids[2], { mime: 'image/webp', data: Buffer.alloc(300) });
      assert.deepEqual([over.ok, over.reason], [false, 'quota']);
      // a replacement frees the picture it replaces
      assert.equal((await images.attachImage(G, ids[0], { mime: 'image/webp', data: big })).ok, true);
      assert.deepEqual(await images.imageUsage(G), { count: 2, bytes: big.length * 2 });
      for (const id of ids) await shopDb.deleteItem(G, id);
      assert.deepEqual(await stored(), []);
    });

    await t.test('the purge removes the pictures of the server', async () => {
      const id = await badge({ name: 'Purged' });
      const imageId = (await shopDb.getItem(G, id)).imageId;
      assert.notEqual(await images.readImage(imageId), null);
      await purge.purgeGuild(G);
      assert.equal(await images.readImage(imageId), null);
      assert.deepEqual(await shopDb.listItems(G), []);
    });
  }
);
