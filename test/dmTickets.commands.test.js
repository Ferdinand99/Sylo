// A command sent in a DM is a command, not a ticket message.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { register } from '../src/bot/events/dmTickets.js';
import { log } from '../src/lib/log.js';

function dm(content) {
  const replies = [];
  const message = {
    guild: null,
    partial: false,
    content,
    author: { id: '111111111111111111', bot: false },
    attachments: new Map(),
    client: { guilds: { cache: new Map() }, user: { id: '555555555555555555' } },
    reply: async (text) => replies.push(text),
    react: async () => {},
  };
  return { message, replies };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

test('a DM that is a command is left to the command router', async () => {
  const client = new EventEmitter();
  register(client, { isCommand: (m) => m.content.startsWith('!') });
  const cmd = dm('!help');
  client.emit('messageCreate', cmd.message);
  const chat = dm('hello, I need help');
  client.emit('messageCreate', chat.message);
  await settle();
  assert.deepEqual(cmd.replies, [], 'no ticket handling for a command');
  assert.equal(chat.replies.length, 1, 'a normal DM is still handled (no server to open a ticket in)');
});

test('an isCommand that answers later is awaited: a command is left alone, other DMs are handled', async () => {
  const client = new EventEmitter();
  register(client, {
    isCommand: async (m) => {
      await new Promise((r) => setTimeout(r, 5));
      return m.content.startsWith('!');
    },
  });
  const cmd = dm('!help');
  client.emit('messageCreate', cmd.message);
  const chat = dm('hello, I need help');
  client.emit('messageCreate', chat.message);
  await settle();
  assert.deepEqual(cmd.replies, [], 'no ticket handling for a command');
  assert.equal(chat.replies.length, 1, 'a normal DM is still handled');
});

test('an isCommand that rejects is logged and leaves no unhandled rejection', async (t) => {
  const logged = t.mock.method(log, 'error', () => {});
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    const client = new EventEmitter();
    register(client, {
      isCommand: async () => {
        throw new Error('lookup failed');
      },
    });
    const chat = dm('hello');
    client.emit('messageCreate', chat.message);
    await settle();
    assert.equal(logged.mock.callCount(), 1);
    assert.match(String(logged.mock.calls[0].arguments[1]), /DM handler failed/);
    assert.deepEqual(chat.replies, []);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
