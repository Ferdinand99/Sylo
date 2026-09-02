import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseAutoresponder, matchesTrigger } from '../src/modules/autoresponder.js';

test('matchesTrigger: contains (default) is case-insensitive substring', () => {
  assert.ok(matchesTrigger('well GG everyone', 'gg', 'contains'));
  assert.ok(!matchesTrigger('good game', 'gg', 'contains'));
});

test('matchesTrigger: exact ignores surrounding whitespace only', () => {
  assert.ok(matchesTrigger('  ping  ', 'ping', 'exact'));
  assert.ok(!matchesTrigger('ping pong', 'ping', 'exact'));
});

test('matchesTrigger: startswith', () => {
  assert.ok(matchesTrigger('!help me', '!help', 'startswith'));
  assert.ok(!matchesTrigger('need !help', '!help', 'startswith'));
});

test('matchesTrigger: wholeword does not match inside another word', () => {
  assert.ok(matchesTrigger('that is a bug', 'bug', 'wholeword'));
  assert.ok(!matchesTrigger('debugger output', 'bug', 'wholeword'));
});

test('normaliseAutoresponder: drops empty rows, clamps cooldown, defaults match mode', () => {
  const c = normaliseAutoresponder({
    cooldownSeconds: 9999,
    responders: [
      { trigger: 'gg', response: 'Good game!' },
      { trigger: '', response: 'nope' }, // dropped
      { trigger: 'x', response: '   ' }, // dropped
      { trigger: 'hi', response: 'hello', match: 'bogus', embedColor: '#FF0000', embed: true },
    ],
  });
  assert.equal(c.cooldownSeconds, 300);
  assert.deepEqual(
    c.responders.map((r) => r.trigger),
    ['gg', 'hi']
  );
  assert.equal(c.responders[0].match, 'contains');
  assert.equal(c.responders[1].embedColor, 'FF0000');
  assert.equal(c.responders[1].embed, true);
});
