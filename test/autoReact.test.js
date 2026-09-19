import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseAutoReact, ruleMatches } from '../src/modules/autoReact.js';

test('normaliseAutoReact: clamps cooldown, defaults mode/roleAction/chance', () => {
  const c = normaliseAutoReact({
    cooldownSeconds: 9999,
    rules: [{ targetUsers: ['111111111111111111'], emojis: ['🧟'], mode: 'bogus', roleAction: 'bogus' }],
  });
  assert.equal(c.cooldownSeconds, 300);
  assert.equal(c.rules[0].mode, 'always');
  assert.equal(c.rules[0].roleAction, 'add');
  assert.equal(c.rules[0].chance, 50);
});

test('normaliseAutoReact: validates logChannelId as a snowflake', () => {
  assert.equal(normaliseAutoReact({ logChannelId: '444444444444444444' }).logChannelId, '444444444444444444');
  assert.equal(normaliseAutoReact({ logChannelId: 'not-an-id' }).logChannelId, '');
  assert.equal(normaliseAutoReact({}).logChannelId, '');
});

test('normaliseAutoReact: drops rules with no targets or no emojis', () => {
  const c = normaliseAutoReact({
    rules: [
      { targetUsers: ['111111111111111111'], emojis: [] }, // dropped: no emoji
      { targetUsers: [], targetRoles: [], emojis: ['🧟'] }, // dropped: no target
      { targetUsers: ['111111111111111111'], emojis: ['🧟'] }, // kept
      { targetRoles: ['222222222222222222'], emojis: ['🔥'] }, // kept
    ],
  });
  assert.equal(c.rules.length, 2);
});

test('normaliseAutoReact: filters non-snowflake ids out of target lists', () => {
  const c = normaliseAutoReact({
    rules: [{ targetUsers: ['111111111111111111', 'not-an-id'], emojis: ['🧟'] }],
  });
  assert.deepEqual(c.rules[0].targetUsers, ['111111111111111111']);
});

test('normaliseAutoReact: emoji list extracts a custom emoji id from pasted markup', () => {
  const c = normaliseAutoReact({
    rules: [{ targetUsers: ['111111111111111111'], emojis: '<a:zombie:333333333333333333> 🧟' }],
  });
  assert.deepEqual(c.rules[0].emojis, ['333333333333333333', '🧟']);
});

test('normaliseAutoReact: caps rules at 25 and emoji per rule at 10', () => {
  const rules = Array.from({ length: 30 }, (_, i) => ({
    targetUsers: [`1000000000000000${String(i).padStart(2, '0')}`],
    emojis: ['🧟'],
  }));
  const c = normaliseAutoReact({ rules });
  assert.equal(c.rules.length, 25);

  const many = normaliseAutoReact({
    rules: [{ targetUsers: ['111111111111111111'], emojis: Array.from({ length: 20 }, (_, i) => `e${i}`) }],
  });
  assert.equal(many.rules[0].emojis.length, 10);
});

test('normaliseAutoReact: validates a rule channelId as a snowflake', () => {
  const c = normaliseAutoReact({
    rules: [
      { targetUsers: ['111111111111111111'], emojis: ['🧟'], channelId: '555555555555555555' },
      { targetUsers: ['111111111111111111'], emojis: ['🧟'], channelId: 'not-an-id' },
    ],
  });
  assert.equal(c.rules[0].channelId, '555555555555555555');
  assert.equal(c.rules[1].channelId, '');
});

test('ruleMatches: matches by target user id', () => {
  const rule = { targetUsers: ['111111111111111111'], targetRoles: [] };
  const message = { author: { id: '111111111111111111' }, member: { roles: { cache: new Map() } } };
  assert.ok(ruleMatches(rule, message));
});

test('ruleMatches: matches by target role', () => {
  const rule = { targetUsers: [], targetRoles: ['222222222222222222'] };
  const message = {
    author: { id: '999999999999999999' },
    member: { roles: { cache: new Map([['222222222222222222', {}]]) } },
  };
  assert.ok(ruleMatches(rule, message));
});

test('ruleMatches: no match when neither user nor role is targeted', () => {
  const rule = { targetUsers: ['111111111111111111'], targetRoles: ['222222222222222222'] };
  const message = {
    author: { id: '999999999999999999' },
    member: { roles: { cache: new Map() } },
  };
  assert.ok(!ruleMatches(rule, message));
});

test('ruleMatches: a channel-locked rule only matches in that channel', () => {
  const rule = { targetUsers: ['111111111111111111'], targetRoles: [], channelId: '555555555555555555' };
  const inChannel = {
    author: { id: '111111111111111111' },
    member: { roles: { cache: new Map() } },
    channelId: '555555555555555555',
  };
  const otherChannel = { ...inChannel, channelId: '666666666666666666' };
  assert.ok(ruleMatches(rule, inChannel));
  assert.ok(!ruleMatches(rule, otherChannel));
});

test('ruleMatches: an unset channelId matches in any channel', () => {
  const rule = { targetUsers: ['111111111111111111'], targetRoles: [], channelId: '' };
  const message = {
    author: { id: '111111111111111111' },
    member: { roles: { cache: new Map() } },
    channelId: '777777777777777777',
  };
  assert.ok(ruleMatches(rule, message));
});
