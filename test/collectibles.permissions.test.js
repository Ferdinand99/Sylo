// Who may upload or remove the picture of a collectible: nobody who does not manage the server, nobody signed
// out, nobody from another server, and nobody without the CSRF token. The multipart upload goes through the
// same guards as every other write; a refused upload stores no picture and changes no item. The upload limit is
// checked here too, in a file of its own because the limit counts every request of the file.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  D_GUILD,
  OTHER_D_GUILD,
  browser,
  profiles,
  setProfiles,
  signIn,
  startOAuthApp,
} from './helpers/oauthApp.js';
import { session } from './helpers/v2Guarded.js';
import { makePicture, storedPictures, upload } from './helpers/collectibleFixtures.js';

await startOAuthApp();

const { getItem, listItems } = await import('../src/db/economyShop.js');
const { listAudit } = await import('../src/db/audit.js');

const stored = async (g) => (await storedPictures(g)).map((r) => r.id);

/** A browser signed in as a user with the given rights, with the multipart upload and the CSRF token. */
async function uploader({ guilds, withToken = true } = {}) {
  setProfiles({});
  if (guilds) profiles.discord.guilds = guilds;
  const b = browser();
  await signIn(b, 'discord');
  const token = (await (await b.get('/api/v2/csrf')).json()).token;
  return {
    get: (path) => b.get(path),
    put: (guild, id, form, extra = {}) =>
      b.get(`/api/v2/guilds/${guild}/modules/economy/shop/items/${id}/image`, {
        method: 'POST',
        headers: { ...(withToken ? { 'x-csrf-token': token } : {}), ...extra },
        body: form,
      }),
    remove: (guild, id) =>
      b.get(`/api/v2/guilds/${guild}/modules/economy/shop/items/${id}/image/delete`, {
        method: 'POST',
        headers: withToken
          ? { 'x-csrf-token': token, 'content-type': 'application/json' }
          : { 'content-type': 'application/json' },
        body: '{}',
      }),
  };
}

let itemId;
let picture;
test('setup: a collectible in the main server', async () => {
  picture = await makePicture(24, 24);
  const admin = await session();
  const made = await admin.post(`/guilds/${D_GUILD}/modules/economy/shop/items`, {
    name: 'Badge',
    price: 10,
    type: 'collectible',
  });
  assert.equal(made.status, 200);
  itemId = (await made.json()).id;
  assert.ok(itemId);
});

const untouched = async (note) => {
  assert.deepEqual(await stored(D_GUILD), [], `${note}: no picture`);
  assert.deepEqual(await stored(OTHER_D_GUILD), [], `${note}: no picture in the other server`);
  assert.equal((await getItem(D_GUILD, itemId)).imageId, null, `${note}: the item has no picture`);
};

test('someone who does not manage the server cannot upload or remove a picture', async () => {
  const nobody = await uploader({
    guilds: [
      { id: D_GUILD, owner: false, permissions: '0' },
      { id: OTHER_D_GUILD, owner: false, permissions: '0' },
    ],
  });
  assert.equal((await nobody.put(D_GUILD, itemId, upload(picture))).status, 403);
  assert.equal((await nobody.remove(D_GUILD, itemId)).status, 403);
  await untouched('non-admin');
});

test('the admin of one server cannot touch the pictures of another server', async () => {
  const admin = await uploader(); // owner of D_GUILD only
  assert.equal((await admin.put(OTHER_D_GUILD, itemId, upload(picture))).status, 403);
  assert.equal((await admin.remove(OTHER_D_GUILD, itemId)).status, 403);
  await untouched('wrong server');
});

test('signed out, an upload is refused', async () => {
  const b = browser();
  const out = await b.get(`/api/v2/guilds/${D_GUILD}/modules/economy/shop/items/${itemId}/image`, {
    method: 'POST',
    body: upload(picture),
  });
  assert.ok([401, 403].includes(out.status), `got ${out.status}`);
  await untouched('signed out');
});

test('an admin without the CSRF token is refused, also for a multipart upload', async () => {
  const noToken = await uploader({ withToken: false });
  const put = await noToken.put(D_GUILD, itemId, upload(picture));
  assert.equal(put.status, 403);
  assert.match((await put.json()).error, /CSRF/);
  assert.equal((await noToken.remove(D_GUILD, itemId)).status, 403);
  await untouched('no csrf token');
  assert.deepEqual(
    (await listAudit(D_GUILD, 50)).filter((r) => /picture/.test(r.detail ?? '')),
    [],
    'nothing was audited'
  );
});

test('a cross-site upload is refused (the Origin must be this site), even with the token', async () => {
  const admin = await uploader();
  const res = await admin.put(D_GUILD, itemId, upload(picture), { origin: 'https://evil.example' });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /Cross-origin/);
  await untouched('cross-site');
});

test('an admin with the token can upload, and the audit log says so', async () => {
  const admin = await uploader();
  const res = await admin.put(D_GUILD, itemId, upload(picture));
  assert.equal(res.status, 200);
  const item = await getItem(D_GUILD, itemId);
  assert.ok(item.imageId);
  assert.deepEqual(await stored(D_GUILD), [item.imageId]);
  const audit = (await listAudit(D_GUILD, 50)).filter((r) => r.action === 'economy:shop');
  assert.ok(audit.some((r) => /changed the picture of item/.test(r.detail)));
  assert.equal((await listItems(D_GUILD)).length, 1);

  // /c starts no session and sets no cookie, for a signed-in browser, a browser with no cookies at all (the
  // case where a session would be started and its cookie sent), and for an address that is not a picture.
  const address = `/c/${item.imageId}.webp`;
  const fresh = browser();
  for (const [who, b] of [
    ['signed in', admin],
    ['with no cookies', fresh],
  ]) {
    for (const path of [address, `/c/${'0'.repeat(32)}.webp`, '/c/nonsense']) {
      const res = await b.get(path);
      assert.equal(res.headers.getSetCookie().length, 0, `${who}: ${path} set a cookie`);
      assert.ok([200, 404].includes(res.status), `${who}: ${path} -> ${res.status}`);
    }
  }
  assert.equal((await fresh.get(address)).status, 200, 'the picture needs no login');
  // the same browser, asking for a page of the site, does get its session cookie (the check above is not vacuous)
  const page = await fresh.get('/api/v2/csrf');
  assert.ok(page.headers.getSetCookie().length > 0, 'a request that starts a session sets a cookie');

  await admin.remove(D_GUILD, itemId);
  assert.deepEqual(await stored(D_GUILD), []);
});

test('uploads are rate limited: past 40 a minute the answer is 429', async () => {
  const admin = await uploader();
  const statuses = [];
  for (let i = 0; i < 45; i += 1) {
    // an upload with no file: refused cheaply, but it counts
    statuses.push((await admin.put(D_GUILD, itemId, upload(picture, { field: 'nope' }))).status);
  }
  assert.ok(statuses.includes(429), `statuses: ${[...new Set(statuses)]}`);
  assert.equal(statuses.at(-1), 429);
  assert.ok(
    statuses.slice(0, 5).every((s) => s === 400),
    'the first ones are answered normally'
  );
});
