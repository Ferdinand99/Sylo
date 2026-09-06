import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getCommandOverrides, getCommandOverride, setCommandOverride } from '../src/db/commandOverrides.js';

const G = '900000000000000070';

test('getCommandOverride is null with no override; setCommandOverride creates one', async () => {
  assert.equal(await getCommandOverride(G, 'ping'), null);
  await setCommandOverride(G, 'ping', { enabled: false, allowedChannels: ['1'], allowedRoles: ['2'] });
  const ov = await getCommandOverride(G, 'ping');
  assert.equal(ov.command, 'ping');
  assert.equal(ov.enabled, false);
  assert.deepEqual(ov.allowedChannels, ['1']);
  assert.deepEqual(ov.allowedRoles, ['2']);
});

test('setCommandOverride upserts, keeping unspecified fields from the current row', async () => {
  await setCommandOverride(G, 'rank', { enabled: true, allowedChannels: ['1'], allowedRoles: [] });
  await setCommandOverride(G, 'rank', { allowedRoles: ['9'] }); // partial patch
  const ov = await getCommandOverride(G, 'rank');
  assert.equal(ov.enabled, true); // kept
  assert.deepEqual(ov.allowedChannels, ['1']); // kept
  assert.deepEqual(ov.allowedRoles, ['9']); // updated
});

test('getCommandOverrides returns a Map keyed by command name, scoped to guild', async () => {
  const other = '900000000000000071';
  await setCommandOverride(other, 'stats', { enabled: false });
  await setCommandOverride(G, 'ping', { enabled: false });
  await setCommandOverride(G, 'rank', { enabled: true, allowedRoles: ['5'] });

  const map = await getCommandOverrides(G);
  assert.equal(map.size, 2);
  assert.equal(map.get('ping').enabled, false);
  assert.deepEqual(map.get('rank').allowedRoles, ['5']);
  assert.equal(map.has('stats'), false);

  const otherMap = await getCommandOverrides(other);
  assert.equal(otherMap.size, 1);
});
