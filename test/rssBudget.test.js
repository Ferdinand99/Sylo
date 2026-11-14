// The RSS poll spends at most 80 feed fetches a tick. It used to start at the first guild every
// tick, so guilds later in the list (all Fluxer guilds, which come after the Discord ones) were
// never polled once the earlier guilds held 80 feeds between them. Each tick now resumes where the
// previous one ran out of budget.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from '../src/runtime.js';
import { setGuildModule } from '../src/db/modules.js';
import { log } from '../src/lib/log.js';
import { _tick, _resetResumeAt } from '../src/modules/rss.js';

const CH = '123456789012345678';

function client(rawIds) {
  const c = { isReady: () => true, guilds: { cache: new Map() } };
  for (const id of rawIds) c.guilds.cache.set(id, { id, client: c });
  return c;
}

async function enable(key, host, count) {
  // Private addresses: the fetch is refused at once, which still costs one unit of the budget.
  const feeds = Array.from({ length: count }, (_, i) => ({
    url: `http://${host}.${i + 1}/feed.xml`,
    channelId: CH,
  }));
  await setGuildModule(key, 'rss', { enabled: true, config: { feeds } });
}

test('every guild is polled within a few ticks, Fluxer included', async () => {
  const discordIds = Array.from({ length: 7 }, (_, i) => `90000000000000${String(i + 1).padStart(4, '0')}`);
  const fluxerId = '910000000000000001';
  runtime.clients.discord = client(discordIds);
  runtime.clients.fluxer = client([fluxerId]);
  // 7 Discord guilds with 15 feeds each (105 > 80) and one Fluxer guild with 2.
  for (const [i, id] of discordIds.entries()) await enable(id, `10.${i + 1}.0`, 15);
  await enable(`fluxer:${fluxerId}`, '10.99.0', 2);
  _resetResumeAt();

  const polled = new Set();
  const original = log.error;
  log.error = (scope, msg) => {
    if (scope === 'rss') polled.add(String(msg).split(':')[0]);
  };
  try {
    await _tick();
    assert.ok(polled.size <= 80, `one tick polls at most 80 feeds (${polled.size})`);
    assert.ok(!polled.has('10.99.0.1'), 'the first tick cannot reach the Fluxer guild');
    await _tick();
    await _tick();
  } finally {
    log.error = original;
    runtime.clients.discord = null;
    runtime.clients.fluxer = null;
  }

  for (let g = 1; g <= 7; g += 1)
    for (let f = 1; f <= 15; f += 1) assert.ok(polled.has(`10.${g}.0.${f}`), `guild ${g} feed ${f}`);
  assert.ok(polled.has('10.99.0.1') && polled.has('10.99.0.2'), 'the Fluxer guild was polled');
});
