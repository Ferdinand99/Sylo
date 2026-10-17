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
