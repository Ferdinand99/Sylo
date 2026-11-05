import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveUserTags } from '../src/web/lib/discord.js';

function fakeClient({ cachedUsers = {}, restUsers = {} } = {}) {
  const fetched = [];
  return {
    fetched,
    users: {
      cache: new Map(Object.entries(cachedUsers).map(([id, tag]) => [id, { tag }])),
      fetch: async (id) => {
        fetched.push(id);
        if (!restUsers[id]) throw new Error('Unknown User');
        return { tag: restUsers[id] };
      },
    },
  };
}

test('resolveUserTags reads the guild member cache first, then the user cache, then REST', async () => {
  const client = fakeClient({ cachedUsers: { u2: 'two' }, restUsers: { u3: 'three' } });
  const guild = { members: { cache: new Map([['u1', { user: { tag: 'one' } }]]) } };
  const tags = await resolveUserTags(client, ['u1', 'u2', 'u3', 'u4'], { guild });
  assert.deepEqual([...tags.entries()].sort(), [
    ['u1', 'one'],
    ['u2', 'two'],
    ['u3', 'three'],
    ['u4', 'u4'],
  ]);
  assert.deepEqual(client.fetched.sort(), ['u3', 'u4']);
});

test('resolveUserTags stops fetching after maxFetch and leaves the rest as raw ids', async () => {
  const ids = Array.from({ length: 30 }, (_, i) => `id${i}`);
  const restUsers = Object.fromEntries(ids.map((id) => [id, `tag-${id}`]));
  const client = fakeClient({ restUsers });
  const tags = await resolveUserTags(client, ids, { maxFetch: 25 });
  assert.equal(client.fetched.length, 25);
  assert.equal([...tags].filter(([id, tag]) => tag === id).length, 5);
});

test('resolveUserTags without options fetches every uncached id', async () => {
  const client = fakeClient({ restUsers: { a: 'A', b: 'B' } });
  const tags = await resolveUserTags(client, ['a', 'b', 'a']);
  assert.equal(client.fetched.length, 2);
  assert.equal(tags.get('b'), 'B');
});
