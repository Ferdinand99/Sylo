// The picture of a collectible through the dashboard and the public address: the upload (type sniffing,
// re-encoding, limits, the quota, the answers to hostile files), what is stored in the database, what
// /c/<id>.webp sends and refuses (headers, no cookie, the plain 404, an exact address), replacing, removing and
// the type change of a picture, and what happens to the pictures when the item is deleted while members own it,
// and when the server's data is purged. Who may upload (authorisation, CSRF) is in
// collectibles.permissions.test.js.
import { startWebApp } from './helpers/webApp.js';
import { v2Open } from './helpers/v2Open.js';
import { GID } from './helpers/fakeGuild.js';
import { buyNow, fakeMember } from './helpers/fakeShop.js';
import {
  HTML,
  SVG,
  makePicture,
  pngClaiming,
  storedPictures,
  upload,
} from './helpers/collectibleFixtures.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { db } from '../src/db/index.js';
import { getItem, listInventory } from '../src/db/economyShop.js';
import { MAX_IMAGES_PER_GUILD, MAX_IMAGE_BYTES_PER_GUILD, readImage } from '../src/db/collectibleImages.js';
import { setGuildModule } from '../src/db/modules.js';
import { purgeGuild } from '../src/db/purge.js';
import { credit } from '../src/modules/lib/economy.js';
import { imageDimensions } from '../src/lib/imageSize.js';

let app;
let api;
const U = '700000000000000021';
const config = {};

test.before(async () => {
  app = await startWebApp();
  api = v2Open(app, GID);
});
test.after(() => app.close());
beforeEach(async () => {
  await purgeGuild(GID);
  app.guild.members.cache.set(U, fakeMember(U));
  await setGuildModule(GID, 'economy', { enabled: true, config: {} });
});

const json = (res) => res.json();
const addItem = async (body = {}) =>
  (
    await json(
      await api.post('/modules/economy/shop/items', {
        name: 'Founder badge',
        price: 100,
        type: 'collectible',
        ...body,
      })
    )
  ).id;
const put = (id, form) =>
  fetch(`${app.base}/api/v2/guilds/${GID}/modules/economy/shop/items/${id}/image`, {
    method: 'POST',
    body: form,
  });
const view = async (id) =>
  (await json(await api.get('/modules/economy/shop/items'))).items.find((i) => i.id === id);
const idOf = (path) => /^\/c\/([0-9a-f]{32})\.webp$/.exec(path)?.[1];
const get = (path) => fetch(`${app.base}${path}`);
/** A GET with the path exactly as written: fetch() would fold "%2e%2e" segments before sending. */
const raw = (path) =>
  new Promise((resolve, reject) => {
    const { hostname, port } = new URL(app.base);
    http
      .get({ host: hostname, port, path }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() })
        );
      })
      .on('error', reject);
  });
const uploaded = async (id, n) =>
  idOf((await json(await put(id, upload(await makePicture(n, n))))).items.find((i) => i.id === id).imagePath);
const ids = async () => (await storedPictures(GID)).map((r) => r.id);
const addMoney = (amount = 500) => credit(GID, U, amount, { kind: 'staff_add', config });

test('a collectible keeps its rarity (one of the fixed tiers) and its announce switch; other kinds do not', async () => {
  const id = await addItem({ rarity: 'epic', announce: true });
  const item = await view(id);
  assert.deepEqual(
    [item.type, item.rarity, item.announce, item.imagePath],
    ['collectible', 'epic', true, null]
  );
  const list = await json(await api.get('/modules/economy/shop/items'));
  assert.deepEqual(
    list.rarities.map((r) => r.key),
    ['common', 'uncommon', 'rare', 'epic', 'legendary']
  );
  // a made-up tier is none; a custom item has neither rarity nor announce
  const odd = await view(await addItem({ rarity: 'mythic', announce: 'yes' }));
  assert.deepEqual([odd.rarity, odd.announce], [null, false]);
  const custom = await view(await addItem({ type: 'custom', rarity: 'rare', announce: true }));
  assert.deepEqual([custom.rarity, custom.announce], [null, false]);
  // editing changes them
  await api.post(`/modules/economy/shop/items/${id}`, {
    name: 'Founder badge',
    price: 100,
    type: 'collectible',
    rarity: 'common',
  });
  const edited = await view(id);
  assert.deepEqual([edited.rarity, edited.announce], ['common', false]);
});

test('an upload is stored in the database as a WebP of at most 512x512 and served at /c/<id>.webp', async () => {
  const id = await addItem();
  const before = (await getItem(GID, id)).updatedAt;
  const res = await put(
    id,
    upload(await makePicture(1000, 500, 'jpeg'), { name: 'big.jpg', type: 'image/jpeg' })
  );
  assert.equal(res.status, 200);
  const item = (await json(res)).items.find((i) => i.id === id);
  const imageId = idOf(item.imagePath);
  assert.ok(imageId, `a /c/<id>.webp path, got ${item.imagePath}`);
  const stored = await storedPictures(GID);
  assert.deepEqual(
    stored.map((r) => [r.id, r.mime]),
    [[imageId, 'image/webp']]
  );
  assert.ok((await getItem(GID, id)).updatedAt > before, 'a new picture is a new version of the item');

  const served = await get(item.imagePath);
  assert.equal(served.status, 200);
  const body = Buffer.from(await served.arrayBuffer());
  assert.deepEqual(imageDimensions(body), { width: 512, height: 256 });
  assert.equal(body.length, stored[0].bytes);
  assert.equal(served.headers.get('content-type'), 'image/webp');
  assert.equal(served.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
  assert.match(served.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(served.headers.get('content-security-policy'), /sandbox/);
  assert.equal(served.headers.get('content-length'), String(body.length));
  // it needs no login and no CSRF: that is the point
  assert.equal((await fetch(`${app.base}${item.imagePath}`, { headers: { cookie: '' } })).status, 200);
  const head = await fetch(`${app.base}${item.imagePath}`, { method: 'HEAD' });
  assert.equal(head.status, 200);
});

test('/c starts no session: an answer carries no cookie, a hit or a miss', async () => {
  const id = await addItem();
  const imageId = await uploaded(id, 24);
  for (const path of [`/c/${imageId}.webp`, `/c/${'0'.repeat(32)}.webp`, '/c/nonsense']) {
    const res = await raw(path);
    assert.equal(res.headers['set-cookie'], undefined, `${path} set a cookie`);
  }
});

test('hostile files are refused and store nothing', async () => {
  const id = await addItem();
  const png = await makePicture(32, 32);
  const cases = [
    ['an SVG named .png with an image content type', SVG, 'x.png', 'image/png', 400, /PNG, JPEG or WebP/],
    ['an SVG as image/svg+xml', SVG, 'x.svg', 'image/svg+xml', 400, /PNG, JPEG or WebP/],
    ['HTML disguised as a PNG', HTML, 'x.png', 'image/png', 400, /PNG, JPEG or WebP/],
    [
      'PNG bytes behind a text/html type',
      Buffer.concat([png.subarray(0, 8), HTML]),
      'x.html',
      'text/html',
      400,
      /valid image|too large/,
    ],
    [
      'a PNG header over HTML',
      Buffer.concat([png.subarray(0, 8), HTML]),
      'x.png',
      'image/png',
      400,
      /valid image|too large/,
    ],
    [
      'wrong magic bytes (a GIF as a PNG)',
      Buffer.from('GIF89a' + 'x'.repeat(60)),
      'x.png',
      'image/png',
      400,
      /PNG, JPEG or WebP/,
    ],
    [
      'a picture over 2 MB',
      Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)]),
      'x.png',
      'image/png',
      413,
      /larger than 2 MB/,
    ],
    [
      'a header that claims 30000x30000',
      pngClaiming(30000, 30000),
      'x.png',
      'image/png',
      400,
      /too large in pixels/,
    ],
    [
      'a header that claims 17 megapixels',
      pngClaiming(4200, 4048),
      'x.png',
      'image/png',
      400,
      /16 megapixels/,
    ],
    ['an empty file', Buffer.alloc(0), 'x.png', 'image/png', 400, /Choose an image|PNG, JPEG or WebP/],
  ];
  for (const [what, bytes, name, type, status, message] of cases) {
    const res = await put(id, upload(bytes, { name, type }));
    assert.equal(res.status, status, what);
    assert.match((await json(res)).error, message, what);
  }
  const noFile = await put(id, upload(png, { field: 'attachment' }));
  assert.equal(noFile.status, 400);
  const notMultipart = await fetch(
    `${app.base}/api/v2/guilds/${GID}/modules/economy/shop/items/${id}/image`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }
  );
  assert.equal(notMultipart.status, 415);
  assert.deepEqual(await ids(), [], 'nothing was stored');
  assert.equal((await getItem(GID, id)).imageId, null);
});

test('only a collectible has a picture, and only an item of this server', async () => {
  const custom = await addItem({ type: 'custom' });
  const png = await makePicture(16, 16);
  const res = await put(custom, upload(png));
  assert.equal(res.status, 400);
  assert.match((await json(res)).error, /Only a collectible/);
  assert.equal((await put(999999, upload(png))).status, 404);
  assert.equal((await put('abc', upload(png))).status, 404);
  assert.equal((await api.post(`/modules/economy/shop/items/${custom}/image/delete`, {})).status, 400);
  assert.deepEqual(await ids(), []);
});

test('a new picture replaces the old one (which is deleted); removing it deletes it too', async () => {
  const id = await addItem();
  const first = await uploaded(id, 20);
  const second = await uploaded(id, 30);
  assert.notEqual(first, second);
  assert.deepEqual(await ids(), [second], 'only the new picture is left');
  assert.equal((await get(`/c/${first}.webp`)).status, 404);
  assert.equal((await get(`/c/${second}.webp`)).status, 200);

  const removed = await api.post(`/modules/economy/shop/items/${id}/image/delete`, {});
  assert.equal(removed.status, 200);
  assert.equal((await json(removed)).items.find((i) => i.id === id).imagePath, null);
  assert.deepEqual(await ids(), []);
  assert.equal((await get(`/c/${second}.webp`)).status, 404);
});

test('two uploads at once leave exactly one picture, the one the item has', async () => {
  const id = await addItem();
  const results = await Promise.all(
    [12, 24, 36, 48].map(async (n) => put(id, upload(await makePicture(n, n))))
  );
  for (const res of results) assert.equal(res.status, 200);
  assert.deepEqual(await ids(), [(await getItem(GID, id)).imageId]);
});

test('/c answers an unknown id, a wrong shape and every other address with the same plain 404', async () => {
  const id = await addItem();
  const imageId = await uploaded(id, 16);
  const paths = [
    `/c/${'0'.repeat(32)}.webp`,
    `/c/${imageId.toUpperCase()}.webp`,
    `/c/${imageId}.WEBP`,
    `/c/${imageId}.png`,
    `/c/${imageId}`,
    `/c/${imageId}.webp/`,
    `/C/${imageId}.webp`,
    `/c/${imageId}.webp/extra`,
    `/c/${imageId}.webp%00`,
    `/c/${imageId}.webp%2f..%2f..%2fx.webp`,
    `/c/..%2fx.webp`,
    `/c/..%2f..%2fx.webp`,
    `/c/%2e%2e%2fx.webp`,
    `/c/%2e%2e/%2e%2e/x.webp`,
    `/c/..\\x.webp`,
    `/c/${GID}/${imageId}.webp`,
    `/c/${GID}%2f${imageId}.webp`,
    `/c/${imageId.slice(1)}.webp`,
    `/c/${imageId}0.webp`,
    `/c/'%20OR%201=1--.webp`,
    `/c/`,
    `/c/a`,
  ];
  for (const path of paths) {
    const res = await raw(path);
    assert.equal(res.status, 404, path);
    assert.match(res.headers['content-type'], /text\/plain/, path);
    assert.equal(res.text, 'Not found', path);
    assert.equal(res.headers['cache-control'], 'no-store', path);
  }
  // the real one still works
  assert.equal((await get(`/c/${imageId}.webp`)).status, 200);
});

test('the quota: at most 200 pictures or 25 MB per server, counting every stored picture', async () => {
  const items = [];
  for (let i = 0; i < 3; i += 1) items.push(await addItem({ name: `Item ${i}` }));
  // fill the server up to its limit of pictures with rows made directly (they are not worth 200 uploads)
  const ins = db.prepare(
    'INSERT INTO collectible_images (id, guild_id, mime, bytes, data, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (let i = 0; i < MAX_IMAGES_PER_GUILD - 1; i += 1) {
    ins.run(i.toString(16).padStart(32, '0'), GID, 'image/webp', 10, Buffer.alloc(10), 1);
  }
  assert.equal((await put(items[0], upload(await makePicture(20, 20)))).status, 200, 'the 200th fits');
  const full = await put(items[1], upload(await makePicture(21, 21)));
  assert.equal(full.status, 400);
  assert.match((await json(full)).error, /already stores 200 pictures.*most is 200 pictures and 25 MB/);
  assert.equal((await getItem(GID, items[1])).imageId, null);
  assert.equal((await storedPictures(GID)).length, 200);
  // a replacement frees the picture it replaces, so it fits when the server is full
  assert.equal((await put(items[0], upload(await makePicture(22, 22)))).status, 200);
  assert.equal((await storedPictures(GID)).length, 200);

  // by bytes: one row that takes nearly all of the 25 MB
  await purgeGuild(GID);
  await setGuildModule(GID, 'economy', { enabled: true, config: {} });
  const a = await addItem({ name: 'A' });
  const b = await addItem({ name: 'B' });
  ins.run('f'.repeat(32), GID, 'image/webp', MAX_IMAGE_BYTES_PER_GUILD - 10, Buffer.alloc(8), 1);
  const bytes = await put(a, upload(await makePicture(24, 24)));
  assert.equal(bytes.status, 400);
  assert.match((await json(bytes)).error, /25 MB/);
  assert.equal((await put(b, upload(await makePicture(24, 24)))).status, 400);
});

test('the quota is per server: another server is not counted', async () => {
  const id = await addItem();
  db.prepare(
    'INSERT INTO collectible_images (id, guild_id, mime, bytes, data, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('e'.repeat(32), '900000000000009999', 'image/webp', MAX_IMAGE_BYTES_PER_GUILD, Buffer.alloc(8), 1);
  assert.equal((await put(id, upload(await makePicture(16, 16)))).status, 200);
  db.prepare("DELETE FROM collectible_images WHERE guild_id = '900000000000009999'").run();
});

test('removing the picture of an item keeps it for the members who own the item', async () => {
  const id = await addItem({ rarity: 'rare', stock: 5 });
  const imageId = await uploaded(id, 40);
  await addMoney();
  const bought = await buyNow({
    guild: app.guild,
    member: app.guild.members.cache.get(U),
    itemId: id,
    config,
  });
  assert.equal(bought.ok, true);
  assert.equal((await listInventory(GID, U))[0].imageId, imageId, 'the copy carries the picture');

  await api.post(`/modules/economy/shop/items/${id}/image/delete`, {});
  assert.equal((await getItem(GID, id)).imageId, null);
  assert.deepEqual(await ids(), [imageId], 'the owner still holds it');
  assert.equal((await get(`/c/${imageId}.webp`)).status, 200);
  const inv = (await json(await api.get(`/modules/economy/members/${U}/inventory`))).inventory[0];
  assert.deepEqual([inv.imagePath, inv.rarity, inv.itemRemoved], [`/c/${imageId}.webp`, 'rare', false]);

  // a new picture reaches the owners, and the old one goes
  const next = await uploaded(id, 50);
  assert.deepEqual(await ids(), [next]);
  assert.equal((await listInventory(GID, U))[0].imageId, next);
});

test('a collectible that becomes another kind lets go of its picture', async () => {
  const id = await addItem();
  const imageId = await uploaded(id, 24);
  assert.deepEqual(await ids(), [imageId]);
  const changed = await api.post(`/modules/economy/shop/items/${id}`, {
    name: 'Now custom',
    price: 100,
    type: 'custom',
  });
  assert.equal(changed.status, 200);
  assert.equal((await getItem(GID, id)).imageId, null);
  assert.deepEqual(await ids(), [], 'nobody owns it, so it is deleted');
  assert.equal((await get(`/c/${imageId}.webp`)).status, 404);
  // with an owner, the owner keeps theirs
  const other = await addItem({ name: 'Other' });
  const kept = await uploaded(other, 28);
  await addMoney();
  await buyNow({ guild: app.guild, member: app.guild.members.cache.get(U), itemId: other, config });
  await api.post(`/modules/economy/shop/items/${other}`, { name: 'Other', price: 100, type: 'custom' });
  assert.deepEqual(await ids(), [kept]);
});

test('deleting an item keeps its picture while members own it, then it goes with the last owner', async () => {
  const id = await addItem({ rarity: 'rare', stock: 5 });
  const imageId = await uploaded(id, 40);
  const path = `/c/${imageId}.webp`;
  await addMoney();
  const bought = await buyNow({
    guild: app.guild,
    member: app.guild.members.cache.get(U),
    itemId: id,
    config,
  });
  assert.equal(bought.ok, true);
  const inv = (await json(await api.get(`/modules/economy/members/${U}/inventory`))).inventory[0];
  assert.deepEqual(
    [inv.itemType, inv.imagePath, inv.rarity, inv.itemRemoved],
    ['collectible', path, 'rare', false]
  );

  const deleted = await json(await api.post(`/modules/economy/shop/items/${id}/delete`, {}));
  assert.equal(deleted.held, 1);
  assert.deepEqual(await ids(), [imageId], 'the owner still has it');
  assert.equal((await get(path)).status, 200, 'and it is still served');
  const after = (await json(await api.get(`/modules/economy/members/${U}/inventory`))).inventory[0];
  assert.deepEqual(
    [after.itemRemoved, after.imagePath, after.rarity],
    [true, path, 'rare'],
    'item removed, picture kept'
  );

  const revoke = await api.post(`/modules/economy/members/${U}/inventory/${inv.id}/revoke`, {});
  assert.equal(revoke.status, 200);
  assert.deepEqual(await ids(), [], 'the last owner is gone, so is the picture');
  assert.equal((await get(path)).status, 404);
});

test('deleting a collectible nobody owns deletes its picture; a refund of the last copy of a deleted item does too', async () => {
  const lonely = await addItem();
  await uploaded(lonely, 16);
  assert.equal((await ids()).length, 1);
  await api.post(`/modules/economy/shop/items/${lonely}/delete`, {});
  assert.deepEqual(await ids(), []);

  const id = await addItem({ price: 50 });
  await uploaded(id, 16);
  await addMoney(100);
  await buyNow({ guild: app.guild, member: app.guild.members.cache.get(U), itemId: id, config });
  await api.post(`/modules/economy/shop/items/${id}/delete`, {});
  assert.equal((await ids()).length, 1);
  const row = (await json(await api.get(`/modules/economy/members/${U}/inventory`))).inventory[0];
  assert.equal((await api.post(`/modules/economy/members/${U}/inventory/${row.id}/refund`, {})).status, 200);
  assert.deepEqual(await ids(), []);
});

test('the server purge removes the pictures of the server', async () => {
  const a = await addItem({ name: 'A' });
  const b = await addItem({ name: 'B' });
  await uploaded(a, 16);
  await uploaded(b, 24);
  assert.equal((await ids()).length, 2);
  await purgeGuild(GID);
  assert.deepEqual(await ids(), []);
});

test('a picture is read by its id only, and an id of the wrong shape is never looked up', async () => {
  const id = await addItem();
  const imageId = await uploaded(id, 16);
  assert.equal((await readImage(imageId)).mime, 'image/webp');
  for (const bad of [null, undefined, 42, '', imageId.toUpperCase(), `${imageId}0`, `${imageId}' OR 1=1`]) {
    assert.equal(await readImage(bad), null);
  }
});
