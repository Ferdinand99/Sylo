// Decoding a welcome-card background allocates the whole bitmap inside the shared process, so only
// a few may run at once; the rest wait a little and then go without a card.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { _takeRenderPlace, _renderQueue } from '../src/bot/lib/welcomeCard.js';

test('at most two renders run at once, eight wait, the rest are refused', async () => {
  const held = [await _takeRenderPlace(), await _takeRenderPlace()];
  assert.ok(held.every((g) => typeof g === 'function'));
  assert.deepEqual(_renderQueue(), { running: 2, waiting: 0 });

  const waiting = Array.from({ length: 8 }, () => _takeRenderPlace(5000));
  assert.equal(_renderQueue().waiting, 8);
  assert.equal(await _takeRenderPlace(5000), null, 'the queue is full: refused at once');

  // Giving a place back hands it to the first waiter, and never lets more than two run.
  held[0]();
  held[0](); // a second give-back is ignored
  const first = await waiting[0];
  assert.equal(typeof first, 'function');
  assert.deepEqual(_renderQueue(), { running: 2, waiting: 7 });

  held[1]();
  first();
  for (const w of waiting.slice(1)) (await w)();
  assert.deepEqual(_renderQueue(), { running: 0, waiting: 0 });
});

test('a render that waits too long goes without a card', async () => {
  const a = await _takeRenderPlace();
  const b = await _takeRenderPlace();
  const keepAlive = setTimeout(() => {}, 1000); // the queue's own timer is unref'd
  assert.equal(await _takeRenderPlace(20), null);
  clearTimeout(keepAlive);
  assert.equal(_renderQueue().waiting, 0);
  a();
  b();
  assert.deepEqual(_renderQueue(), { running: 0, waiting: 0 });
});
