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

test('an add that fails, or that adds nothing, keeps no state from before', async () => {
  const { member } = memberWith([OTHER]);
  member.client.rest.put = async () => {
    throw new Error('Missing Permissions');
  };
  await assert.rejects(member.roles.add(ADULT), /Missing Permissions/);
  assert.deepEqual(member.roles.roleIds, [OTHER]);
  const failed = sdkUpdate(member);
  restoreOldRoles(failed.oldMember, failed.newMember);
  assert.deepEqual(failed.oldMember.roles.roleIds, [OTHER], 'nothing to restore');

  const { member: holder } = memberWith([ADULT]);
  await holder.roles.add(ADULT); // already has it: the SDK does nothing
  const same = sdkUpdate(holder);
  holder.roles.ids = [ADULT, OTHER]; // a later change that came from the gateway only
  const copy = { ...same, oldMember: same.oldMember };
  restoreOldRoles(copy.oldMember, holder);
  assert.deepEqual(copy.oldMember.roles.roleIds, [ADULT], 'no stale state was kept');
});
