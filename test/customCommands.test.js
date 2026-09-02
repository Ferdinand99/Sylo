import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseCustomCommands,
  buildCustomReply,
  buildActionPayload,
  usesArgs,
  pickMessage,
} from '../src/modules/customCommands.js';

test('names lowercased, invalid names dropped, action-less commands dropped', () => {
  const { commands } = normaliseCustomCommands({
    commands: [
      { name: 'Rules', actions: [{ type: 'reply', messages: [{ content: 'Be nice' }] }] },
      { name: 'has space', actions: [{ type: 'reply', messages: [{ content: 'x' }] }] },
      { name: 'empty', actions: [{ type: 'reply', messages: [{ content: '   ' }] }] },
      { name: 'gg-wp_1', actions: [{ type: 'reply', messages: [{ content: 'nice' }] }] },
    ],
  });
  assert.deepEqual(
    commands.map((c) => c.name),
    ['rules', 'gg-wp_1']
  );
});

test('duplicate names keep the first', () => {
  const { commands } = normaliseCustomCommands({
    commands: [
      { name: 'dupe', actions: [{ type: 'reply', messages: [{ content: 'first' }] }] },
      { name: 'DUPE', actions: [{ type: 'reply', messages: [{ content: 'second' }] }] },
    ],
  });
  assert.equal(commands.length, 1);
  assert.equal(commands[0].actions[0].messages[0].content, 'first');
});

test('legacy commands migrate to a single reply action', () => {
  const { commands } = normaliseCustomCommands({
    commands: [
      { name: 'plain', response: 'hello {user}' },
      { name: 'fancy', response: 'body text', embed: true, embedTitle: 'Title', embedColor: '#ff0000' },
    ],
  });
  const [plain, fancy] = commands;
  assert.equal(plain.actions.length, 1);
  assert.equal(plain.actions[0].type, 'reply');
  assert.equal(plain.actions[0].messages[0].content, 'hello {user}');
  assert.equal(plain.actions[0].messages[0].embed, null);

  assert.equal(fancy.actions[0].messages[0].content, '');
  assert.equal(fancy.actions[0].messages[0].embed.title, 'Title');
  assert.equal(fancy.actions[0].messages[0].embed.description, 'body text');
  assert.equal(fancy.actions[0].messages[0].embed.color, '#ff0000');
});

test('normalisation: ids and roles/channels validated, cooldown clamped', () => {
  const { commands } = normaliseCustomCommands({
    commands: [
      {
        id: 7,
        name: 'roleplay',
        actions: [
          { type: 'add-role', roleId: '123456789012345678' },
          { type: 'remove-role', roleId: 'nope' },
          { type: 'send', channelId: '999999999999999999', messages: [{ content: 'posted' }] },
        ],
        allowedRoles: ['111111111111111111', 'bad', '111111111111111111'],
        allowedChannels: ['222222222222222222'],
        cooldownSeconds: 999999,
      },
    ],
  });
  const c = commands[0];
  assert.equal(c.id, '7');
  // remove-role with a bad id is kept as an action shell but has no effect;
  // the command still survives because other actions do.
  assert.equal(c.actions[0].roleId, '123456789012345678');
  assert.equal(c.actions[1].roleId, '');
  assert.equal(c.actions[2].channelId, '999999999999999999');
  assert.deepEqual(c.allowedRoles, ['111111111111111111']);
  assert.deepEqual(c.allowedChannels, ['222222222222222222']);
  assert.equal(c.cooldownSeconds, 86400);
});

test('a command whose only action is an invalid role is dropped', () => {
  const { commands } = normaliseCustomCommands({
    commands: [{ name: 'x', actions: [{ type: 'add-role', roleId: 'bad' }] }],
  });
  assert.equal(commands.length, 0);
});

test('usesArgs scans every message in every action', () => {
  assert.equal(
    usesArgs({ actions: [{ type: 'reply', messages: [{ content: 'hi' }, { content: 'yo {args}' }] }] }),
    true
  );
  assert.equal(
    usesArgs({ actions: [{ type: 'reply', messages: [{ content: 'hi', embed: { title: '{args}' } }] }] }),
    true
  );
  assert.equal(usesArgs({ actions: [{ type: 'reply', messages: [{ content: 'hi' }] }] }), false);
});

test('pickMessage always returns a message block', () => {
  assert.deepEqual(pickMessage([{ content: 'only', embed: null }]), { content: 'only', embed: null });
  const one = pickMessage([{ content: 'a' }, { content: 'b' }]);
  assert.ok(['a', 'b'].includes(one.content));
  assert.ok(pickMessage([]).content === '');
});

test('buildActionPayload: fills placeholders, locks mentions to the caller', () => {
  const p = buildActionPayload(
    { content: 'Hey {user}, you said {args} in {server}', embed: null },
    { userId: '42', username: 'bob', guildName: 'Guild', channelId: '9', args: 'stuff' }
  );
  assert.equal(p.content, 'Hey <@42>, you said stuff in Guild');
  assert.deepEqual(p.allowedMentions, { users: ['42'], roles: [] });
});

test('buildActionPayload: embed title/description filled', () => {
  const p = buildActionPayload(
    { content: '', embed: { color: '#ff0000', title: 'Rules for {server}', description: 'hi {user}' } },
    { userId: '1', guildName: 'X' }
  );
  assert.equal(p.embeds[0].data.title, 'Rules for X');
  assert.equal(p.embeds[0].data.description, 'hi <@1>');
  assert.equal(p.embeds[0].data.color, 0xff0000);
});

test('buildCustomReply still works for the autoresponder shape', () => {
  const p = buildCustomReply(
    { response: 'Hey {user}', embed: false, embedColor: '5b7cfa' },
    { userId: '42', username: 'bob' }
  );
  assert.equal(p.content, 'Hey <@42>');
  assert.deepEqual(p.allowedMentions, { users: ['42'], roles: [] });
});
