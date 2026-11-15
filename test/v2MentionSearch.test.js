// The member search behind the @ suggestions of the message fields: cached members by name, no bots,
// a short list, and nothing for an empty query.
import { startWebApp } from './helpers/webApp.js';
import { v2Open } from './helpers/v2Open.js';
import { GID } from './helpers/fakeGuild.js';
import test from 'node:test';
import assert from 'node:assert/strict';

let app;
let api;
test.before(async () => {
  app = await startWebApp();
  api = v2Open(app, GID);
  const add = (id, name, bot = false) =>
    app.guild.members.cache.set(id, {
      id,
      displayName: name,
      user: { id, username: name.toLowerCase(), bot },
    });
  add('100000000000000021', 'Alice');
  add('100000000000000022', 'Alina');
  add('100000000000000023', 'Alibot', true);
  for (let i = 0; i < 12; i += 1) add(`1000000000000001${String(i).padStart(2, '0')}`, `Zed${i}`);
});
test.after(() => app.close());

const search = async (q) =>
  (await (await api.get(`/members/search?q=${encodeURIComponent(q)}`)).json()).members;

test('finds cached members by name and leaves bots out', async () => {
  const found = await search('ali');
  assert.deepEqual(found.map((m) => m.name).sort(), ['Alice', 'Alina']);
  assert.deepEqual(Object.keys(found[0]).sort(), ['id', 'name', 'username']);
});

test('needs two characters: one letter returns nothing', async () => {
  assert.deepEqual(await search('a'), []);
});

test('names by id: cached members only come back, an unknown id is left out', async () => {
  app.guild.members.fetch = async () => {
    throw new Error('Unknown Member');
  };
  const res = await api.get(
    '/members/names?ids=100000000000000021,100000000000000022,100000000000000099,junk'
  );
  assert.deepEqual((await res.json()).names, {
    '100000000000000021': 'Alice',
    '100000000000000022': 'Alina',
  });
  assert.deepEqual((await (await api.get('/members/names')).json()).names, {});
});

test('is case-insensitive, short and empty for an empty query', async () => {
  assert.equal((await search('ALICE')).length, 1);
  assert.equal((await search('zed')).length, 8);
  assert.deepEqual(await search(''), []);
  assert.deepEqual(await search('nobody-by-this-name'), []);
});
