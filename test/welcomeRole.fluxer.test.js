// Welcome on a role, on Fluxer. The SDK adds a role to the cached member in place, before the gateway's
// member update arrives, and builds the update's "old member" after that: a role Sylo gives itself
// (Verification, Applications, an autorole) would never look like a gain. The patched roles.add keeps
// the roles from before, and the update bridge puts them back on the old member. Checked against the
// real SDK classes.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as sdk from '@fluxerjs/core';
import { Collection } from '@fluxerjs/collection';
import { installFluxerCompat, restoreOldRoles } from '../src/platform/compat.js';
import { registerFluxerModuleEvents } from '../src/bot/fluxerModuleEvents.js';

installFluxerCompat(sdk, { Collection });

const RAW = '900000000000000061';
const KEY = `fluxer:${RAW}`;
const ADULT = '100000000000000803';
const OTHER = '100000000000000804';

/** A real role manager over a stand-in member whose REST puts are recorded. */
function memberWith(roleIds) {
  const puts = [];
  const member = {
    id: 'u1',
    client: { rest: { put: async (route) => puts.push(route) } },
    guild: { id: RAW, roles: new Map() },
  };
  member.roles = new sdk.GuildMemberRoleManager(member, roleIds);
  return { member, puts };
}

const PRIOR = Symbol.for('sylo.priorRoleIds');
const entriesOf = (member) => member.roles[PRIOR] ?? new Map();

/** What the SDK's gateway handler does: copy the member (after the in-place add), then patch it. */
function sdkUpdate(member) {
  const copy = {
    id: member.id,
    roles: new sdk.GuildMemberRoleManager({ ...member }, [...member.roles.roleIds]),
  };
  return { oldMember: copy, newMember: member };
}

test('roles.add keeps the roles from before, and restoreOldRoles hands them to the update once', async () => {
  const { member, puts } = memberWith([OTHER]);
  await member.roles.add(ADULT);
  assert.equal(puts.length, 1, 'the native add ran');
  assert.deepEqual(member.roles.roleIds, [OTHER, ADULT]);

  const { oldMember, newMember } = sdkUpdate(member);
  assert.deepEqual(oldMember.roles.roleIds, [OTHER, ADULT], 'the SDK copy already has the new role');
  restoreOldRoles(oldMember, newMember);
  assert.deepEqual(oldMember.roles.roleIds, [OTHER], 'the old member shows what was held before');
  assert.deepEqual(newMember.roles.roleIds, [OTHER, ADULT]);

  // used up: a later update is a plain copy
  const next = sdkUpdate(member);
  restoreOldRoles(next.oldMember, next.newMember);
  assert.deepEqual(next.oldMember.roles.roleIds, [OTHER, ADULT]);
});

test('several roles in one add keep the state from before the first', async () => {
  const { member } = memberWith([]);
  await member.roles.add([ADULT, OTHER]);
  assert.deepEqual(member.roles.roleIds, [ADULT, OTHER]);
  const { oldMember, newMember } = sdkUpdate(member);
  restoreOldRoles(oldMember, newMember);
  assert.deepEqual(oldMember.roles.roleIds, []);
});

test('restoreOldRoles does nothing for a member Sylo gave no role, or with nothing to patch', () => {
  const { member } = memberWith([ADULT]);
  const { oldMember, newMember } = sdkUpdate(member);
  restoreOldRoles(oldMember, newMember);
  assert.deepEqual(oldMember.roles.roleIds, [ADULT]);
  assert.doesNotThrow(() => restoreOldRoles(null, newMember));
  assert.doesNotThrow(() => restoreOldRoles(undefined, undefined));
  assert.doesNotThrow(() => restoreOldRoles({ id: 'x' }, { id: 'x', roles: {} }));
});

test('the member update the bridge dispatches shows a role Sylo gave as a gain', async () => {
  const calls = [];
  const client = new EventEmitter();
  client.user = { id: '555555555555555555' };
  client.guilds = { cache: new Map() };
  registerFluxerModuleEvents(client, {
    dispatch: async (event, key, payload) => calls.push({ event, key, payload }),
  });

  const { member } = memberWith([]);
  member.guild = { id: RAW };
  await member.roles.add(ADULT);
  const { oldMember, newMember } = sdkUpdate(member);
  client.emit('guildMemberUpdate', oldMember, newMember);
  await new Promise((r) => setImmediate(r));

  const update = calls.find((c) => c.event === 'guildMemberUpdate');
  assert.equal(update.key, KEY);
  assert.deepEqual(update.payload.old.roles.roleIds, []);
  assert.deepEqual(update.payload.new.roles.roleIds, [ADULT]);
});

test('an add that fails, or that adds nothing, leaves no entry', async () => {
  const { member } = memberWith([OTHER]);
  member.client.rest.put = async () => {
    throw new Error('Missing Permissions');
  };
  await assert.rejects(member.roles.add(ADULT), /Missing Permissions/);
  assert.deepEqual(member.roles.roleIds, [OTHER]);
  assert.equal(entriesOf(member).size, 0, 'a failed add clears its entry');

  const { member: holder } = memberWith([ADULT]);
  await holder.roles.add(ADULT); // already has it: the SDK does nothing
  assert.equal(entriesOf(holder).size, 0);
});

test('three roles added in a row: the update of each one shows its own role as a gain, whatever the order', async () => {
  const THIRD = '100000000000000805';
  const { member } = memberWith([]);
  await member.roles.add([ADULT, OTHER, THIRD]); // the SDK has all three in place when the updates arrive
  assert.equal(entriesOf(member).size, 3);

  // each update: a copy of the member as it is now (all three), and the payload of that one gateway event
  const update = (payloadIds) => {
    const oldMember = { id: 'u1', roles: new sdk.GuildMemberRoleManager({}, [...member.roles.roleIds]) };
    const newMember = { id: 'u1', roles: { roleIds: payloadIds, [PRIOR]: entriesOf(member) } };
    restoreOldRoles(oldMember, newMember);
    return oldMember.roles.roleIds;
  };
  assert.ok(!update([ADULT]).includes(ADULT), 'the first role is a gain');
  assert.ok(!update([ADULT, OTHER]).includes(OTHER), 'the second role is a gain');
  const last = update([ADULT, OTHER, THIRD]);
  assert.ok(!last.includes(THIRD), 'the trigger role, third in the row, is a gain');
  assert.deepEqual(last, [ADULT, OTHER]);
  assert.equal(entriesOf(member).size, 0, 'every entry was used once');
});

test('an add with no echo does not colour a later, unrelated update', async () => {
  const { member } = memberWith([OTHER]);
  await member.roles.add(ADULT);
  assert.equal(entriesOf(member).size, 1);
  const later = Date.now() + 31_000; // the gateway never confirmed it; a nickname change arrives much later
  const { oldMember, newMember } = sdkUpdate(member);
  restoreOldRoles(oldMember, newMember, later);
  assert.deepEqual(oldMember.roles.roleIds, [OTHER, ADULT], 'the old member is the plain copy: no gain');
  assert.equal(entriesOf(member).size, 0, 'the stale entry was dropped');
});

test('an update that does not hold the added role leaves its entry for the update that does', async () => {
  const { member } = memberWith([]);
  await member.roles.add(ADULT);
  const oldMember = { id: 'u1', roles: new sdk.GuildMemberRoleManager({}, [ADULT]) };
  restoreOldRoles(oldMember, { id: 'u1', roles: { roleIds: [OTHER], [PRIOR]: entriesOf(member) } });
  assert.deepEqual(oldMember.roles.roleIds, [ADULT], 'a nickname update before the echo changes nothing');
  assert.equal(entriesOf(member).size, 1);
});

test('an entry counts for ten seconds', async () => {
  for (const [wait, restored] of [
    [9_000, true],
    [11_000, false],
  ]) {
    const { member } = memberWith([OTHER]);
    await member.roles.add(ADULT);
    const { oldMember, newMember } = sdkUpdate(member);
    restoreOldRoles(oldMember, newMember, Date.now() + wait);
    assert.equal(!oldMember.roles.roleIds.includes(ADULT), restored, `${wait} ms after the add`);
  }
});
