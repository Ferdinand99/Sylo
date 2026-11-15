// A reaction's users come from Discord 100 at a time. The tally read only the first page, so a
// bigger poll showed wrong results and a max-votes cap above 100 per option never closed it.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { reactors } from '../src/modules/polls.js';

function fakeReaction(total) {
  const ids = Array.from({ length: total }, (_, i) => String(100000000000000000n + BigInt(i)));
  return {
    users: {
      cache: new Map(),
      fetch: async ({ limit, after }) => {
        const start = after ? ids.indexOf(after) + 1 : 0;
        return new Map(ids.slice(start, start + limit).map((id) => [id, { id, bot: false }]));
      },
    },
  };
}

test('reactors reads every page', async () => {
  assert.equal((await reactors(fakeReaction(250))).size, 250);
});

test('reactors stops at its cap', async () => {
  assert.equal((await reactors(fakeReaction(250), 120)).size, 120);
});

test('reactors stops when the source ignores the cursor (a page adds nobody new)', async () => {
  let calls = 0;
  const same = new Map(Array.from({ length: 100 }, (_, i) => [String(i), { id: String(i), bot: false }]));
  const rx = {
    users: {
      cache: new Map(),
      fetch: async () => {
        calls += 1;
        return same;
      },
    },
  };
  assert.equal((await reactors(rx)).size, 100);
  assert.ok(calls <= 2, `fetched ${calls} times`);
});

test('reactors never reads more than its page limit', async () => {
  let calls = 0;
  let n = 0;
  const rx = {
    users: {
      cache: new Map(),
      fetch: async () => {
        calls += 1;
        // Always a full page of new users: only the hard page limit ends this.
        return new Map(
          Array.from({ length: 100 }, () => [String(100000000000000000n + BigInt(n++)), { bot: false }])
        );
      },
    },
  };
  await reactors(rx, 1_000_000);
  assert.ok(calls <= 60, `fetched ${calls} pages`);
});
