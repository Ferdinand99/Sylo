// The role and channel order on Fluxer. Discord numbers text and voice channels separately, and Fluxer takes a channel
// order as moves applied one at a time, refusing any move that leaves a voice channel above a text channel in a
// category; the fake Fluxer (helpers/mirrorFakes.js) applies the moves the same way. A failed role order never lets
// a role get its powerful permissions, and "Copy again" tries a failed order again.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../src/db/mirror.js';
import { channelOrder, channelPositionUpdates } from '../src/mirror/plan.js';
import { ELEVATED_FLUXER_MASK } from '../src/mirror/permissions.js';
import { BIT, dChannel, fakeFluxer, fluxerChannelList } from './helpers/mirrorFakes.js';
import { drain, scenario } from './helpers/mirrorScenario.js';

const MANAGE_ROLES = 1n << 28n;
const mapped = async (s, kind, id) => (await db.getMapping(s.pair.id, kind, id)).targetId;
const bitsOf = (s, id) => BigInt(s.fluxer.guild.roles.get(id)._permissions ?? 0);

/** A category in which text and voice channels share position numbers, as Discord numbers them. */
function mixedChannels(k) {
  return [
    dChannel({ id: k.cat, name: 'Info', type: 4, rawPosition: 1 }),
    dChannel({ id: '761000000000000001', name: 'general', type: 0, parentId: k.cat, rawPosition: 0 }),
    dChannel({ id: '761000000000000002', name: 'Lounge', type: 2, parentId: k.cat, rawPosition: 0 }),
    dChannel({ id: '761000000000000003', name: 'memes', type: 0, parentId: k.cat, rawPosition: 1 }),
    dChannel({ id: '761000000000000004', name: 'Stage', type: 13, parentId: k.cat, rawPosition: 1 }),
    dChannel({ id: '761000000000000005', name: 'news', type: 5, parentId: k.cat, rawPosition: 2 }),
    dChannel({ id: k.cat2, name: 'More', type: 4, rawPosition: 0 }),
    dChannel({ id: '761000000000000006', name: 'Talk', type: 2, parentId: k.cat2, rawPosition: 0 }),
    dChannel({ id: '761000000000000007', name: 'help', type: 0, parentId: k.cat2, rawPosition: 3 }),
    dChannel({ id: k.chat, name: 'welcome', type: 0, rawPosition: 5 }),
  ];
}

const source = (channels) => ({ channels: channels.map((c) => ({ ...c, position: c.rawPosition })) });

test('the channel order is the one Discord shows: text-like before voice in a category, loose channels first', () => {
  const k = { cat: '1', cat2: '2', chat: '3' };
  const channels = mixedChannels(k);
  const layout = channelOrder(source(channels), new Set(channels.map((c) => c.id)));
  const name = (id) => channels.find((c) => c.id === id).name;
  assert.deepEqual(
    layout.map((x) => [name(x.id), x.position, x.voice ?? null]),
    [
      ['welcome', 0, null], // a channel without a category comes before the categories
      ['More', 1, null],
      ['Info', 2, null],
      // the text-like channels of every category, then the voice channels
      ['help', 0, false],
      ['general', 0, false],
      ['memes', 1, false],
      ['news', 2, false],
      ['Talk', 1, true],
      ['Lounge', 3, true],
      ['Stage', 4, true],
    ]
  );
});

test('positions count only the channels that exist on Fluxer; a voice channel goes after the text channels already there', () => {
  const layout = [
    { id: 'cat', parentId: null, position: 0 },
    { id: 't1', parentId: 'cat', position: 0, voice: false },
    { id: 't2', parentId: 'cat', position: 1, voice: false }, // could not be made on Fluxer
    { id: 't3', parentId: 'cat', position: 2, voice: false },
    { id: 'v1', parentId: 'cat', position: 3, voice: true },
    { id: 'orphan', parentId: 'gone', position: 0, voice: false }, // its category has no copy
  ];
  const ids = new Map([
    ['cat', 'C'],
    ['t1', 'T1'],
    ['t3', 'T3'],
    ['v1', 'V1'],
    ['orphan', 'O'],
  ]);
  const fluxer = [
    { id: 'C', type: 4, parentId: null },
    { id: 'T1', type: 0, parentId: 'C' },
    { id: 'T3', type: 0, parentId: 'C' },
    { id: 'V1', type: 2, parentId: 'C' },
    { id: 'MINE', type: 0, parentId: 'C' }, // made by someone on Fluxer
    { id: 'MYVOICE', type: 2, parentId: 'C' },
  ];
  assert.deepEqual(channelPositionUpdates(layout, ids, fluxer), [
    { id: 'C', position: 0, parentId: null },
    { id: 'T1', position: 0, parentId: 'C' },
    { id: 'T3', position: 1, parentId: 'C' },
    { id: 'V1', position: 3, parentId: 'C' },
  ]);
});

test("the fake Fluxer refuses a voice channel above a text channel, like Fluxer (the old order's failure)", () => {
  const f = fakeFluxer({
    existingChannels: [
      { id: '1', type: 4, parentId: null, position: 1 },
      { id: '2', type: 0, parentId: '1', position: 2 },
      { id: '3', type: 0, parentId: '1', position: 3 },
      { id: '4', type: 2, parentId: '1', position: 4 },
    ],
  });
  // Discord's raw positions sorted together put the voice channel (position 0) between the two text channels.
  return assert.rejects(
    f.target.setChannelPositions([
      { id: '2', position: 0, parentId: '1' },
      { id: '4', position: 1, parentId: '1' },
      { id: '3', position: 2, parentId: '1' },
    ]),
    (err) => err.statusCode === 400 && /Invalid form body/.test(err.message)
  );
});

test('a server whose categories mix text and voice channels is copied and ordered as on Discord', async () => {
  const s = await scenario({ withExpressions: false });
  s.discord.channels.cache.clear();
  for (const c of mixedChannels(s.k)) s.discord.channels.cache.set(c.id, c);
  await s.engine.startCopy(s.pair.id);
  const end = await drain(s);
  const report = await s.engine.report(end);
  assert.deepEqual(report.failed, [], 'no step failed');
  assert.equal(s.fluxer.ops('setChannelPositions').length, 1);
  const names = fluxerChannelList(s.fluxer.guild.channels).map((c) => c.name);
  assert.deepEqual(names, [
    'welcome',
    'More',
    'help',
    'Talk',
    'Info',
    'general',
    'memes',
    'news',
    'Lounge',
    'Stage',
  ]);
});

test('a failed role order leaves every copied role without its powerful permissions, says so, and Copy again retries it', async () => {
  const s = await scenario({ withExpressions: false });
  s.discord.roles.cache.get(s.k.member).permissions = { bitfield: MANAGE_ROLES | BIT.ViewChannel };
  s.discord.roles.cache.get(s.k.mod).permissions = { bitfield: BIT.Administrator | BIT.ViewChannel };
  // What the SDK threw on Fluxer's 204 in the first live run.
  s.fluxer.failOn('setRolePositions', new TypeError("Cannot read properties of undefined (reading 'map')"));
  await s.engine.startCopy(s.pair.id);
  let end = await drain(s);

  const roles = [await mapped(s, 'role', s.k.member), await mapped(s, 'role', s.k.mod)];
  for (const sourceId of [s.k.member, s.k.mod]) {
    const m = await db.getMapping(s.pair.id, 'role', sourceId);
    assert.equal(bitsOf(s, m.targetId) & ELEVATED_FLUXER_MASK, 0n, 'no powerful permission was granted');
    assert.equal(m.specHash, '', 'the role still waits for them');
  }
  assert.ok(!(await db.getMapping(s.pair.id, 'order', 'roles')), 'the order is not marked as set');
  let report = await s.engine.report(end);
  const failed = report.failed.find((i) => i.name === 'Role order');
  assert.ok(failed, 'the role order is reported as failed');
  assert.match(failed.detail, /^Fluxer did not take the role order: Cannot read properties/);
  assert.match(failed.detail, /stay without their powerful permissions until the order is set/);
  assert.match(failed.detail, /Copy again/);
  const granted = s.fluxer
    .ops('editRole')
    .filter((c) => roles.includes(c.id) && BigInt(c.spec.permissions) & ELEVATED_FLUXER_MASK);
  assert.equal(granted.length, 0, 'no grant was sent');

  // Copy again: the order step is planned again, runs, and only then are the permissions granted.
  const preview = await s.engine.previewPair(end);
  assert.equal(preview.steps.find((x) => x.key === 'order-roles:roles').op, 'create');
  await s.engine.startCopy(s.pair.id);
  end = await drain(s);
  report = await s.engine.report(end);
  assert.deepEqual(report.failed, []);
  assert.equal(s.fluxer.ops('setRolePositions').length, 1);
  assert.equal(bitsOf(s, roles[0]) & MANAGE_ROLES, MANAGE_ROLES);
  assert.equal(bitsOf(s, roles[1]) & (1n << 3n), 1n << 3n);
});

test('a role order Fluxer refuses with a 400 says what Fluxer said, and grants nothing', async () => {
  const s = await scenario({ withExpressions: false });
  s.discord.roles.cache.get(s.k.mod).permissions = { bitfield: BIT.Administrator };
  s.fluxer.failOn(
    'setRolePositions',
    Object.assign(new Error('Invalid form body.'), {
      statusCode: 400,
      errors: [{ path: 'id', message: 'Invalid role ID', code: 'INVALID_ROLE_ID' }],
    })
  );
  await s.engine.startCopy(s.pair.id);
  const end = await drain(s);
  assert.equal(end.status, 'live', 'one refused step does not pause the mirror');
  const failed = (await s.engine.report(end)).failed.find((i) => i.name === 'Role order');
  assert.match(
    failed.detail,
    /^Fluxer did not take the role order: Invalid form body\. \(id: Invalid role ID\)\./
  );
  assert.equal(bitsOf(s, await mapped(s, 'role', s.k.mod)) & ELEVATED_FLUXER_MASK, 0n);
});

test('a failed channel order is reported plainly and Copy again tries it again', async () => {
  const s = await scenario({ withExpressions: false });
  s.fluxer.failOn('setChannelPositions', Object.assign(new Error('Invalid form body.'), { statusCode: 400 }));
  await s.engine.startCopy(s.pair.id);
  let end = await drain(s);
  const failed = (await s.engine.report(end)).failed.find((i) => i.name === 'Channel order');
  assert.match(failed.detail, /^Fluxer did not take the channel order: Invalid form body\. Copy again/);
  assert.equal(s.fluxer.ops('setChannelPositions').length, 0);

  await s.engine.startCopy(s.pair.id);
  end = await drain(s);
  assert.deepEqual((await s.engine.report(end)).failed, []);
  assert.equal(s.fluxer.ops('setChannelPositions').length, 1, 'the order went through the second time');
});

test('a rate limit on an order is waited out, not reported as a failure', async () => {
  const s = await scenario({ withExpressions: false });
  s.fluxer.failOn(
    'setChannelPositions',
    Object.assign(new Error('slow down'), { statusCode: 429, retryAfter: 2 })
  );
  await s.engine.startCopy(s.pair.id);
  const end = await drain(s);
  assert.deepEqual((await s.engine.report(end)).failed, []);
  assert.equal(s.fluxer.ops('setChannelPositions').length, 1);
});
