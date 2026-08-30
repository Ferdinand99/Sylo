import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseCustomCommands, buildCustomReply, usesArgs } from '../src/modules/customCommands.js';

test('prefix: trimmed, capped at 5 chars, falls back to !', () => {
  assert.equal(normaliseCustomCommands({ prefix: '  ?? ' }).prefix, '??');
  assert.equal(normaliseCustomCommands({ prefix: '' }).prefix, '!');
  assert.equal(normaliseCustomCommands({ prefix: '>>>>>>>>' }).prefix, '>>>>>');
});

test('commands: names lowercased, invalid names dropped, empty responses dropped', () => {
  const { commands } = normaliseCustomCommands({
    commands: [
      { name: 'Rules', response: 'Be nice' },
      { name: 'has space', response: 'x' },
      { name: 'ok', response: '   ' },
      { name: 'gg-wp_1', response: 'nice' },
    ],
  });
  assert.deepEqual(
    commands.map((c) => c.name),
    ['rules', 'gg-wp_1']
  );
});

test('commands: duplicate names keep the first', () => {
  const { commands } = normaliseCustomCommands({
    commands: [
      { name: 'dupe', response: 'first' },
      { name: 'DUPE', response: 'second' },
    ],
  });
  assert.equal(commands.length, 1);
  assert.equal(commands[0].response, 'first');
});

test('embed colour: normalised to 6 hex chars without #, default when invalid', () => {
  const { commands } = normaliseCustomCommands({
    commands: [
      { name: 'a', response: 'x', embedColor: '#FF0000' },
      { name: 'b', response: 'x', embedColor: 'nope' },
    ],
  });
  assert.equal(commands[0].embedColor, 'FF0000');
  assert.equal(commands[1].embedColor, '5b7cfa');
});

test('slash flag defaults false and is coerced to boolean', () => {
  assert.equal(normaliseCustomCommands({}).slash, false);
  assert.equal(normaliseCustomCommands({ slash: 'on' }).slash, true);
});

test('usesArgs detects {args} in response or embed title', () => {
  assert.equal(usesArgs({ response: 'hi {args}', embedTitle: '' }), true);
  assert.equal(usesArgs({ response: 'hi', embedTitle: 'title {args}' }), true);
  assert.equal(usesArgs({ response: 'hi', embedTitle: 'title' }), false);
});

test('buildCustomReply: text fills placeholders and locks mentions to the caller', () => {
  const p = buildCustomReply(
    { response: 'Hey {user}, you said {args} in {server}', embed: false, embedColor: '5b7cfa' },
    { userId: '42', username: 'bob', guildName: 'Guild', channelId: '9', args: 'stuff' }
  );
  assert.equal(p.content, 'Hey <@42>, you said stuff in Guild');
  assert.deepEqual(p.allowedMentions, { users: ['42'], roles: [] });
});

test('buildCustomReply: embed uses title and colour', () => {
  const p = buildCustomReply(
    { response: 'body', embed: true, embedTitle: 'Rules for {server}', embedColor: 'ff0000' },
    { guildName: 'X' }
  );
  assert.equal(p.embeds[0].data.title, 'Rules for X');
  assert.equal(p.embeds[0].data.description, 'body');
  assert.equal(p.embeds[0].data.color, 0xff0000);
});
