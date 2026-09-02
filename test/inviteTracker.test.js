import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseInviteTrackerConfig } from '../src/modules/inviteTracker.js';
import {
  getInviteCount,
  bumpRegular,
  bumpLeaves,
  setBonus,
  topInviters,
  inviterRank,
  inviterCount,
  recordJoin,
  getJoin,
  deleteJoin,
  setPersonalCode,
  personalCodeOwner,
  clearGuildInvites,
} from '../src/db/inviteTracker.js';

const G = '900000000000000001';

test('normaliseInviteTrackerConfig: validates channel id, clamps grace hours', () => {
  assert.deepEqual(normaliseInviteTrackerConfig({}), { joinLogChannelId: '', graceHours: 24 });
  assert.equal(normaliseInviteTrackerConfig({ joinLogChannelId: 'nope' }).joinLogChannelId, '');
  assert.equal(
    normaliseInviteTrackerConfig({ joinLogChannelId: '123456789012345678' }).joinLogChannelId,
    '123456789012345678'
  );
  assert.equal(normaliseInviteTrackerConfig({ graceHours: -5 }).graceHours, 0);
  assert.equal(normaliseInviteTrackerConfig({ graceHours: 9999 }).graceHours, 168);
  assert.equal(normaliseInviteTrackerConfig({ graceHours: '48' }).graceHours, 48);
});

test('net invites = regular - leaves + bonus', () => {
  clearGuildInvites(G);
  const u = '111111111111111111';
  bumpRegular(G, u, 5);
  bumpLeaves(G, u, 2);
  setBonus(G, u, 3);
  const c = getInviteCount(G, u);
  assert.equal(c.regular, 5);
  assert.equal(c.leaves, 2);
  assert.equal(c.bonus, 3);
  assert.equal(c.net, 6);
});

test('setBonus overwrites (does not accumulate)', () => {
  clearGuildInvites(G);
  const u = '222222222222222222';
  setBonus(G, u, 10);
  setBonus(G, u, 4);
  assert.equal(getInviteCount(G, u).bonus, 4);
});

test('topInviters: only positive net, ordered desc; rank + count', () => {
  clearGuildInvites(G);
  bumpRegular(G, 'aaaaaaaaaaaaaaaaaa'.replace(/a/g, '1'), 0); // no-op-ish
  bumpRegular(G, '111111111111111111', 8);
  bumpRegular(G, '222222222222222222', 3);
  bumpRegular(G, '333333333333333333', 1);
  bumpLeaves(G, '333333333333333333', 5); // net -4, excluded

  const top = topInviters(G, 10);
  assert.deepEqual(
    top.map((r) => r.user_id),
    ['111111111111111111', '222222222222222222']
  );
  assert.equal(inviterCount(G), 2);
  assert.equal(inviterRank(G, '222222222222222222'), 2);
  assert.equal(inviterRank(G, '111111111111111111'), 1);
});

test('join records: store, read, delete', () => {
  clearGuildInvites(G);
  const joiner = '444444444444444444';
  recordJoin(G, joiner, {
    inviterId: '111111111111111111',
    code: 'abcd',
    source: 'invite',
    joinedAt: 1000,
    counted: 1,
  });
  let j = getJoin(G, joiner);
  assert.equal(j.inviter_id, '111111111111111111');
  assert.equal(j.source, 'invite');
  assert.equal(j.counted, 1);

  // re-join overwrites
  recordJoin(G, joiner, { source: 'vanity', joinedAt: 2000, counted: 0 });
  j = getJoin(G, joiner);
  assert.equal(j.inviter_id, null);
  assert.equal(j.source, 'vanity');

  deleteJoin(G, joiner);
  assert.equal(getJoin(G, joiner), null);
});

test('personal invite code maps back to its owner', () => {
  clearGuildInvites(G);
  setPersonalCode(G, '111111111111111111', 'xYz123');
  assert.equal(personalCodeOwner(G, 'xYz123'), '111111111111111111');
  assert.equal(personalCodeOwner(G, 'unknown'), null);
  assert.equal(personalCodeOwner(G, null), null);
});

test('clearGuildInvites wipes everything for the guild', () => {
  bumpRegular(G, '111111111111111111', 2);
  recordJoin(G, '444444444444444444', { joinedAt: 1 });
  setPersonalCode(G, '111111111111111111', 'code');
  clearGuildInvites(G);
  assert.equal(getInviteCount(G, '111111111111111111').net, 0);
  assert.equal(getJoin(G, '444444444444444444'), null);
  assert.equal(personalCodeOwner(G, 'code'), null);
});
