import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  listComposed,
  getComposed,
  getComposedByMessage,
  createComposed,
  updateComposed,
  deleteComposed,
} from '../src/db/composedMessages.js';

const G = '900000000000000050';
const CH = '700000000000000501';

test('createComposed returns a real id; getComposed round-trips, spec is parsed', async () => {
  const rec = await createComposed(G, {
    name: 'Welcome',
    channelId: CH,
    messageId: null,
    spec: { content: 'hi', embeds: [] },
  });
  assert.ok(Number.isInteger(rec.id) && rec.id > 0);
  assert.equal(rec.name, 'Welcome');
  assert.equal(rec.channel_id, CH);
  assert.equal(rec.message_id, null);
  assert.deepEqual(rec.spec, { content: 'hi', embeds: [] });

  const fetched = await getComposed(G, rec.id);
  assert.deepEqual(fetched, rec);
  assert.equal(await getComposed(G, 999999), null);
});

test('getComposedByMessage looks up by the published message id', async () => {
  const rec = await createComposed(G, {
    name: 'Announce',
    channelId: CH,
    messageId: 'msg-1',
    spec: { content: 'x', embeds: [] },
  });
  const byMsg = await getComposedByMessage(G, 'msg-1');
  assert.equal(byMsg.id, rec.id);
  assert.equal(await getComposedByMessage(G, 'nope'), null);
});

test('updateComposed rewrites fields in place, keeps the same id', async () => {
  const rec = await createComposed(G, {
    name: 'Old',
    channelId: CH,
    messageId: null,
    spec: { content: 'old', embeds: [] },
  });
  const updated = await updateComposed(G, rec.id, {
    name: 'New',
    channelId: '700000000000000502',
    messageId: 'posted-1',
    spec: { content: 'new', embeds: [] },
  });
  assert.equal(updated.id, rec.id);
  assert.equal(updated.name, 'New');
  assert.equal(updated.channel_id, '700000000000000502');
  assert.equal(updated.message_id, 'posted-1');
  assert.deepEqual(updated.spec, { content: 'new', embeds: [] });
});

test('listComposed orders newest-first and scopes to guild; deleteComposed removes a row', async () => {
  const mine = '900000000000000052';
  const other = '900000000000000051';
  await createComposed(other, { name: 'Other', channelId: CH, messageId: null, spec: {} });

  const a = await createComposed(mine, { name: 'A', channelId: CH, messageId: null, spec: {} });
  await new Promise((r) => setTimeout(r, 2));
  const b = await createComposed(mine, { name: 'B', channelId: CH, messageId: null, spec: {} });

  const list = await listComposed(mine, 50);
  assert.deepEqual(
    list.map((r) => r.id),
    [b.id, a.id]
  );
  assert.equal((await listComposed(other, 50)).length, 1);

  assert.equal(await deleteComposed(mine, a.id), true);
  assert.equal(await deleteComposed(mine, a.id), false); // already gone
  assert.equal(await getComposed(mine, a.id), null);
});
