// The picture of a collectible through the dashboard and the public address: the upload (type sniffing,
// re-encoding, limits, the answers to hostile files), where the file is stored, what /c/<id>.png sends and
// refuses (headers, the plain 404, path traversal and links), replacing and removing a picture, what happens to
// the files when the item is deleted while members own it, and when the server's data is purged.
// Who may upload (authorisation, CSRF) is in collectibles.permissions.test.js.
import { startWebApp } from './helpers/webApp.js';
import { v2Open } from './helpers/v2Open.js';
import { GID } from './helpers/fakeGuild.js';
import { buyNow, fakeMember } from './helpers/fakeShop.js';
import { HTML, SVG, makePicture, pngClaiming, pngSize, upload } from './helpers/collectibleFixtures.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { db } from '../src/db/index.js';
import { getItem } from '../src/db/economyShop.js';
import { setGuildModule } from '../src/db/modules.js';
import { purgeGuild } from '../src/db/purge.js';
import { credit } from '../src/modules/lib/economy.js';
import { collectiblesRoot, pathOf } from '../src/lib/collectibleFiles.js';

let app;
let api;
const U = '700000000000000021';
const config = {};
const files = () =>
  existsSync(join(collectiblesRoot(), GID)) ? readdirSync(join(collectiblesRoot(), GID)) : [];

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
const idOf = (path) => /^\/c\/([0-9a-f]{32})\.png$/.exec(path)?.[1];
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

test('an upload is stored as a PNG of at most 512x512 under the server folder and served at /c/<id>.png', async () => {
  const id = await addItem();
  const before = (await getItem(GID, id)).updatedAt;
  const res = await put(
    id,
    upload(await makePicture(1000, 500, 'jpeg'), { name: 'big.jpg', type: 'image/jpeg' })
  );
  assert.equal(res.status, 200);
  const item = (await json(res)).items.find((i) => i.id === id);
  const imageId = idOf(item.imagePath);
  assert.ok(imageId, `a /c/<id>.png path, got ${item.imagePath}`);
  assert.deepEqual(files(), [`${imageId}.png`]);
  assert.equal(pathOf(GID, imageId), join(collectiblesRoot(), GID, `${imageId}.png`));
  assert.ok((await getItem(GID, id)).updatedAt > before, 'a new picture is a new version of the item');

  const served = await get(item.imagePath);
  assert.equal(served.status, 200);
  const body = Buffer.from(await served.arrayBuffer());
  assert.deepEqual(pngSize(body), { width: 512, height: 256 });
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.equal(served.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
  assert.match(served.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(served.headers.get('content-security-policy'), /sandbox/);
  assert.equal(served.headers.get('content-length'), String(body.length));
  assert.equal(served.headers.get('set-cookie'), null);
  // it needs no login and no CSRF: that is the point
  assert.equal((await fetch(`${app.base}${item.imagePath}`, { headers: { cookie: '' } })).status, 200);
  const head = await fetch(`${app.base}${item.imagePath}`, { method: 'HEAD' });
  assert.equal(head.status, 200);
});

test('hostile files are refused and leave nothing behind', async () => {
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
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }
  );
  assert.equal(notMultipart.status, 415);
  assert.deepEqual(files(), [], 'no file was written');
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
  assert.deepEqual(files(), []);
});

test('a new picture replaces the old one and the old file is deleted; removing it deletes the file too', async () => {
  const id = await addItem();
  const uploaded = async (n) =>
    idOf(
      (await json(await put(id, upload(await makePicture(n, n))))).items.find((i) => i.id === id).imagePath
    );
  const first = await uploaded(20);
  const second = await uploaded(30);
  assert.notEqual(first, second);
  assert.deepEqual(files(), [`${second}.png`], 'only the new file is left');
  assert.equal((await get(`/c/${first}.png`)).status, 404);
  assert.equal((await get(`/c/${second}.png`)).status, 200);

  const removed = await api.post(`/modules/economy/shop/items/${id}/image/delete`, {});
  assert.equal(removed.status, 200);
  assert.equal((await json(removed)).items.find((i) => i.id === id).imagePath, null);
  assert.deepEqual(files(), []);
  assert.equal((await get(`/c/${second}.png`)).status, 404);
});

test('two uploads at once leave exactly one file, the one the item has', async () => {
  const id = await addItem();
  const results = await Promise.all(
    [12, 24, 36, 48].map(async (n) => put(id, upload(await makePicture(n, n))))
  );
  for (const res of results) assert.equal(res.status, 200);
  const imageId = (await getItem(GID, id)).imageId;
  assert.deepEqual(files(), [`${imageId}.png`]);
});

test('/c answers an unknown id, a wrong shape and every attempt to leave the folder with the same plain 404', async () => {
  const id = await addItem();
  const imageId = idOf(
    (await json(await put(id, upload(await makePicture(16, 16))))).items.find((i) => i.id === id).imagePath
  );
  // a file outside the collectibles folder that a traversal would reach
  writeFileSync(join(collectiblesRoot(), '..', 'secret.png'), 'TOP-SECRET');
  const paths = [
    `/c/${'0'.repeat(32)}.png`,
    `/c/${imageId.toUpperCase()}.png`,
    `/c/${imageId}.PNG`,
    `/c/${imageId}`,
    `/c/${imageId}.png/extra`,
    `/c/${imageId}.png%00`,
    `/c/${imageId}.png%2f..%2f..%2fsecret.png`,
    `/c/..%2fsecret.png`,
    `/c/..%2f..%2fsecret.png`,
    `/c/%2e%2e%2fsecret.png`,
    `/c/%2e%2e/%2e%2e/secret.png`,
    `/c/..\\secret.png`,
    `/c/${GID}/${imageId}.png`,
    `/c/${GID}%2f${imageId}.png`,
    `/c/secret.png`,
    `/c/`,
    `/c/a`,
  ];
  for (const path of paths) {
    const res = await raw(path);
    assert.equal(res.status, 404, path);
    assert.match(res.headers['content-type'], /text\/plain/, path);
    assert.equal(res.text, 'Not found', path);
    assert.equal(res.headers['cache-control'], 'no-store', path);
    assert.doesNotMatch(res.text, /TOP-SECRET/, path);
  }
  // the real one still works
  assert.equal((await get(`/c/${imageId}.png`)).status, 200);
});

test('a picture is only served while something refers to it, and a link in the folder is never followed', async () => {
  // a file with a valid name that no item refers to
  const orphan = 'b'.repeat(32);
  mkdirSync(join(collectiblesRoot(), GID), { recursive: true });
  writeFileSync(pathOf(GID, orphan), 'not referenced');
  assert.equal((await get(`/c/${orphan}.png`)).status, 404);
  // a link whose name an item does refer to points outside: not served
  const linked = 'c'.repeat(32);
  const target = join(collectiblesRoot(), '..', 'target.txt');
  writeFileSync(target, 'OUTSIDE');
  try {
    symlinkSync(target, pathOf(GID, linked));
  } catch {
    return; // links need a privilege on this system: nothing to check
  }
  const id = await addItem();
  db.prepare('UPDATE economy_items SET image_id = ? WHERE guild_id = ? AND id = ?').run(linked, GID, id);
  const res = await get(`/c/${linked}.png`);
  assert.equal(res.status, 404);
  assert.doesNotMatch(await res.text(), /OUTSIDE/);
});

test('deleting an item keeps the file while members own it, then it goes with the last owner', async () => {
  const id = await addItem({ rarity: 'rare', stock: 5 });
  const path = (await json(await put(id, upload(await makePicture(40, 40))))).items.find(
    (i) => i.id === id
  ).imagePath;
  const imageId = idOf(path);
  await credit(GID, U, 500, { kind: 'staff_add', config });
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
  assert.deepEqual(files(), [`${imageId}.png`], 'the owner still has it');
  assert.equal((await get(path)).status, 200, 'and it is still served');
  const after = (await json(await api.get(`/modules/economy/members/${U}/inventory`))).inventory[0];
  assert.deepEqual(
    [after.itemRemoved, after.imagePath, after.rarity],
    [true, path, 'rare'],
    'item removed, picture kept'
  );

  const revoke = await api.post(`/modules/economy/members/${U}/inventory/${inv.id}/revoke`, {});
  assert.equal(revoke.status, 200);
  assert.deepEqual(files(), [], 'the last owner is gone, so is the file');
  assert.equal((await get(path)).status, 404);
});

test('deleting a collectible nobody owns deletes its file; a refund of the last copy of a deleted item does too', async () => {
  const lonely = await addItem();
  await put(lonely, upload(await makePicture(16, 16)));
  assert.equal(files().length, 1);
  await api.post(`/modules/economy/shop/items/${lonely}/delete`, {});
  assert.deepEqual(files(), []);

  const id = await addItem({ price: 50 });
  await put(id, upload(await makePicture(16, 16)));
  await credit(GID, U, 100, { kind: 'staff_add', config });
  await buyNow({ guild: app.guild, member: app.guild.members.cache.get(U), itemId: id, config });
  await api.post(`/modules/economy/shop/items/${id}/delete`, {});
  assert.equal(files().length, 1);
  const row = (await json(await api.get(`/modules/economy/members/${U}/inventory`))).inventory[0];
  assert.equal((await api.post(`/modules/economy/members/${U}/inventory/${row.id}/refund`, {})).status, 200);
  assert.deepEqual(files(), []);
});

test('the server purge removes the files of every collectible of the server', async () => {
  const a = await addItem({ name: 'A' });
  const b = await addItem({ name: 'B' });
  await put(a, upload(await makePicture(16, 16)));
  await put(b, upload(await makePicture(24, 24)));
  assert.equal(files().length, 2);
  await purgeGuild(GID);
  assert.equal(existsSync(join(collectiblesRoot(), GID)), false);
});
