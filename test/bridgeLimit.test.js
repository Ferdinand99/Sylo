// The ceiling of bridged channels per server (BRIDGE_MAX_LINKS): how it is read, that the Bridge page and the
// manual linking share it with the server mirror, and the platform spacing of the relay queue.
import './helpers/tmpDb.js';
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setGuildModule } from '../src/db/modules.js';
import { purgeGuild } from '../src/db/purge.js';
import { config } from '../src/config.js';
import {
  BRIDGE_MAX_LINKS_DEFAULT,
  BRIDGE_MAX_LINKS_MAX,
  BRIDGE_MAX_LINKS_MIN,
  parseBridgeMaxLinks,
} from '../src/lib/bridgeLimit.js';
import {
  BridgeError,
  acceptLink,
  bridgeOverview,
  dropBridgeCache,
  getMaxLinks,
  requestLink,
  useBridgeParts,
} from '../src/modules/bridge.js';
import { createRelayQueue, relayGapMs } from '../src/modules/lib/bridgeQueue.js';
import { D, F, installPlatforms, removePlatforms, useFakes } from './helpers/fakeBridge.js';

let p;
let fakes;

beforeEach(async () => {
  p = installPlatforms();
  useFakes();
  dropBridgeCache();
  for (const key of [D, F]) await purgeGuild(key);
  fakes = useFakes();
  await setGuildModule(D, 'bridge', { enabled: true });
  await setGuildModule(F, 'bridge', { enabled: true });
});
afterEach(() => {
  useBridgeParts();
  removePlatforms();
});

/** Use the fakes again with a ceiling of `n` links per server. */
const capAt = (n) => useBridgeParts({ transport: fakes.transport, queue: fakes.queue, maxLinks: n });

/** One link made through the real request and accept calls. */
async function link(name) {
  const dCh = p.channel(p.dGuild, { name: `d-${name}` });
  const fCh = p.channel(p.fGuild, { name: `f-${name}` });
  const made = await requestLink({ guildKey: D, channelId: dCh.id, actor: 'Alice' });
  return acceptLink({ guildKey: F, channelId: fCh.id, code: made.code, actor: 'Bob' });
}
const refuses = (promise, pattern) =>
  assert.rejects(promise, (err) => {
    assert.ok(err instanceof BridgeError);
    assert.equal(err.status, 409);
    assert.equal(err.code, 'limit');
    assert.match(err.message, pattern);
    return true;
  });

test('BRIDGE_MAX_LINKS: unset or blank is 100, a whole number from 1 to 500 is taken as it is', () => {
  assert.equal(BRIDGE_MAX_LINKS_DEFAULT, 100);
  assert.deepEqual([BRIDGE_MAX_LINKS_MIN, BRIDGE_MAX_LINKS_MAX], [1, 500]);
  for (const raw of [undefined, null, '', '   ']) {
    assert.deepEqual(parseBridgeMaxLinks(raw), { value: 100, error: null });
  }
  assert.equal(parseBridgeMaxLinks('1').value, 1);
  assert.equal(parseBridgeMaxLinks('500').value, 500);
  assert.equal(parseBridgeMaxLinks(' 250 ').value, 250);
});

test('BRIDGE_MAX_LINKS: anything outside 1 to 500, or not a whole number, is refused with a message', () => {
  for (const raw of ['0', '501', '1000', '-5', '1.5', 'abc', '1e2', '10 links', '0x10']) {
    const res = parseBridgeMaxLinks(raw);
    assert.equal(res.value, null, raw);
    assert.match(res.error, /BRIDGE_MAX_LINKS must be a whole number from 1 to 500/, raw);
  }
});

test('the configured ceiling is the default of 100 when the environment sets nothing', () => {
  assert.equal(config.bridgeMaxLinks, 100);
  assert.equal(getMaxLinks(), 100);
  capAt(3);
  assert.equal(getMaxLinks(), 3, 'tests can replace it');
  useBridgeParts();
  assert.equal(getMaxLinks(), 100, 'and it goes back');
});

test('a request is refused at the ceiling, and the refusal says how to raise it', async () => {
  capAt(2);
  await link('one');
  await link('two');
  const dCh = p.channel(p.dGuild, { name: 'd-three' });
  await refuses(
    requestLink({ guildKey: D, channelId: dCh.id, actor: 'Alice' }),
    /limit of 2 bridged channels.*BRIDGE_MAX_LINKS/s
  );
});

test('accepting is refused when the server that asked has filled its ceiling since', async () => {
  capAt(2);
  const dCh = p.channel(p.dGuild, { name: 'd-late' });
  const fCh = p.channel(p.fGuild, { name: 'f-late' });
  const made = await requestLink({ guildKey: D, channelId: dCh.id, actor: 'Alice' });
  // The Discord server fills its two links with another Fluxer server, so the Fluxer server that accepts is not full.
  const other = p.extra('95');
  const otherF = `fluxer:${other.fGuild.id}`;
  await setGuildModule(otherF, 'bridge', { enabled: true });
  for (const name of ['one', 'two']) {
    const req = await requestLink({ guildKey: D, channelId: p.channel(p.dGuild, { name }).id, actor: 'A' });
    await acceptLink({
      guildKey: otherF,
      channelId: p.channel(other.fGuild, { name }).id,
      code: req.code,
      actor: 'B',
    });
  }
  await refuses(
    acceptLink({ guildKey: F, channelId: fCh.id, code: made.code, actor: 'Bob' }),
    /server that made this request has reached its limit.*BRIDGE_MAX_LINKS/s
  );
});

test('the page gets the ceiling, and never a count above it for a server within it', async () => {
  capAt(3);
  await link('one');
  await link('two');
  const view = await bridgeOverview(D);
  assert.equal(view.limits.links, 3);
  assert.equal(view.links.length, 2);
  await link('three');
  const full = await bridgeOverview(D);
  assert.deepEqual([full.links.length, full.limits.links], [3, 3]);
});

test('the relay spaces a webhook by what its platform allows', () => {
  // Fluxer: 60 sends, 30 edits and 30 deletes per webhook per minute
  assert.ok(relayGapMs('fluxer', 'send') >= 1000);
  assert.ok(relayGapMs('fluxer', 'edit') >= 2000);
  assert.ok(relayGapMs('fluxer', 'delete') >= 2000);
  // Discord: about 5 sends per 2 seconds per webhook
  assert.ok(relayGapMs('discord', 'send') >= 400);
  assert.equal(relayGapMs('discord'), relayGapMs('discord', 'send'));
});

test('a queue made for the platforms waits the gap each call was queued with, and a plain one its own', async () => {
  const run = async (opts, gaps) => {
    const sleeps = [];
    const queue = createRelayQueue({
      minGapMs: 7,
      sleep: async (ms) => sleeps.push(ms),
      ...opts,
    });
    await Promise.all(gaps.map((gapMs) => queue.enqueue('hook', async () => 1, { gapMs })));
    return sleeps;
  };
  assert.deepEqual(await run({ platformGaps: true }, [1050, 1050, 2050]), [1050, 2050]);
  assert.deepEqual(await run({}, [1050, 1050, 2050]), [7, 7], 'the gap of the queue when it is not asked');
  assert.deepEqual(await run({ platformGaps: true }, [undefined, undefined]), [7]);
});
