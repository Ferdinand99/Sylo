import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { MessageFlags } from 'discord.js';
import { checkActable } from '../src/bot/lib/moderation.js';
import { execute as kick } from '../src/bot/commands/kick.js';
import { execute as ban } from '../src/bot/commands/ban.js';
import { execute as warn } from '../src/bot/commands/warn.js';
import { execute as modlog } from '../src/bot/commands/modlog.js';
import { execute as help } from '../src/bot/commands/help.js';
import { guardedListener } from '../src/bot/index.js';
import {
  isStaleInteractionError,
  redactedUrlPath,
  describeApiError,
  logUnhandledRejection,
} from '../src/lib/discordErrors.js';
import { runtime } from '../src/runtime.js';

/** Capture console.error for the duration of `fn` (sync or async). */
async function captureErr(fn) {
  const lines = [];
  const orig = console.error;
  console.error = (...a) => lines.push(a.join(' '));
  try {
    await fn();
  } finally {
    console.error = orig;
  }
  return lines;
}

/** A command interaction in a server the bot is not a member of: `guild` is null. */
function guildlessInteraction() {
  const replies = [];
  return {
    guild: null,
    guildId: '900000000000000001',
    member: { id: '1', roles: { highest: { comparePositionTo: () => 1 } } },
    user: { id: '1', tag: 'mod#0001' },
    options: {
      getMember: () => ({ id: '2', user: { id: '2', tag: 'target#0002' }, roles: { highest: {} } }),
      getUser: () => ({ id: '2', tag: 'target#0002' }),
      getString: () => null,
      getInteger: () => null,
      getSubcommand: () => 'add',
    },
    async reply(payload) {
      replies.push(payload);
    },
    _replies: replies,
  };
}

const staleError = (code = 10062) =>
  Object.assign(new Error('Unknown interaction'), { name: `DiscordAPIError[${code}]`, code });

// --- 1. moderation commands without a guild -----------------------------------------------

test('checkActable: no guild gives the friendly "not a member" message instead of throwing', () => {
  const msg = checkActable({ interaction: guildlessInteraction(), target: { id: '2' }, action: 'kick' });
  assert.match(msg, /not a member of this server, so I can't kick anyone here/);
});

test('checkActable: a guild without the bot member gives the same message', () => {
  const interaction = { ...guildlessInteraction(), guild: { members: { me: null }, ownerId: '9' } };
  const msg = checkActable({ interaction, target: { id: '2' }, action: 'ban' });
  assert.match(msg, /not a member of this server/);
});

test('/kick in a server the bot is not in replies with the friendly message', async () => {
  const interaction = guildlessInteraction();
  await kick(interaction);
  assert.equal(interaction._replies.length, 1);
  assert.match(interaction._replies[0].content, /not a member of this server/);
  assert.equal(interaction._replies[0].flags, MessageFlags.Ephemeral);
});

test('/ban, /warn and /modlog without a guild reply instead of dereferencing it', async () => {
  for (const [name, run] of [
    ['ban', ban],
    ['warn', warn],
    ['modlog', modlog],
  ]) {
    const interaction = guildlessInteraction();
    await run(interaction);
    assert.equal(interaction._replies.length, 1, `/${name} replied once`);
    assert.match(interaction._replies[0].content, /not a member of this server/, `/${name}`);
  }
});

// --- 2. stale interactions -----------------------------------------------------------------

test('isStaleInteractionError: only 10062 and 40060', () => {
  assert.equal(isStaleInteractionError(staleError(10062)), true);
  assert.equal(isStaleInteractionError(staleError(40060)), true);
  assert.equal(isStaleInteractionError(staleError(50013)), false);
  assert.equal(isStaleInteractionError(new TypeError('x is not a function')), false);
  assert.equal(isStaleInteractionError(null), false);
});

/** Run /help and return the collector the menu listens on. */
async function startHelp() {
  const collector = new EventEmitter();
  const interaction = {
    user: { id: 'u1' },
    client: { commands: new Map() },
    async reply() {},
    async fetchReply() {
      return { createMessageComponentCollector: () => collector };
    },
    async editReply() {},
  };
  await help(interaction);
  return collector;
}

/** Call every 'collect' listener and wait for it, as a real rejection would surface. */
async function collect(collector, i) {
  await Promise.all(collector.listeners('collect').map((fn) => fn(i)));
}

test('/help menu: an expired click (10062) is dropped, not an unhandled rejection', async () => {
  const collector = await startHelp();
  const before = runtime.errors.length;
  const lines = await captureErr(() =>
    collect(collector, {
      user: { id: 'u1' },
      values: ['overview'],
      update: async () => {
        throw staleError(10062);
      },
    })
  );
  assert.deepEqual(lines, []);
  assert.equal(runtime.errors.length, before);
});

test('/help menu: a failed reply to someone else (40060) is dropped too', async () => {
  const collector = await startHelp();
  const lines = await captureErr(() =>
    collect(collector, {
      user: { id: 'someone-else' },
      values: ['overview'],
      reply: async () => {
        throw staleError(40060);
      },
    })
  );
  assert.deepEqual(lines, []);
});

test('/help menu: any other error in the listener is still logged as an error', async () => {
  const collector = await startHelp();
  const before = runtime.errors.length;
  const lines = await captureErr(() =>
    collect(collector, {
      user: { id: 'u1' },
      values: ['overview'],
      update: async () => {
        throw new TypeError('x.y is not a function');
      },
    })
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0], /ERROR\s+bot\s+\/help menu failed: x\.y is not a function/);
  assert.equal(runtime.errors.length, before + 1);
});

test('guardedListener: stale interactions are dropped, other failures logged as errors', async () => {
  const stale = guardedListener('interactionCreate', async () => {
    throw staleError(10062);
  });
  assert.deepEqual(await captureErr(() => stale()), []);

  const bug = guardedListener('messageCreate', async () => {
    throw new TypeError('boom');
  });
  const lines = await captureErr(() => bug());
  assert.equal(lines.length, 1);
  assert.match(lines[0], /ERROR\s+bot\s+Event "messageCreate" handler failed: boom/);

  const ok = guardedListener('ready', async (a, b) => assert.deepEqual([a, b], [1, 2]));
  await ok(1, 2);
});

// --- the global handler's diagnostics ------------------------------------------------------

const TOKEN = 'aW50ZXJhY3Rpb24tdG9rZW4.SeCrEt-token_123';

test('redactedUrlPath: no query string, no interaction or webhook token', () => {
  assert.equal(
    redactedUrlPath(`https://discord.com/api/v10/interactions/111/${TOKEN}/callback?with_response=true`),
    '/api/v10/interactions/111/<token>/callback'
  );
  assert.equal(
    redactedUrlPath(`https://discord.com/api/v10/webhooks/222/${TOKEN}/messages/@original`),
    '/api/v10/webhooks/222/<token>/messages/@original'
  );
  assert.equal(
    redactedUrlPath('https://discord.com/api/v10/channels/333/messages?limit=5'),
    '/api/v10/channels/333/messages'
  );
  assert.equal(redactedUrlPath(undefined), '');
});

const apiError = () =>
  Object.assign(new Error('Unknown interaction'), {
    name: 'DiscordAPIError[10062]',
    code: 10062,
    status: 404,
    method: 'POST',
    url: `https://discord.com/api/v10/interactions/111/${TOKEN}/callback?x=1`,
  });

test('describeApiError: code, status, method and a token-free path', () => {
  const text = describeApiError(apiError());
  assert.match(text, /code=10062/);
  assert.match(text, /status=404/);
  assert.match(text, /POST \/api\/v10\/interactions\/111\/<token>\/callback/);
  assert.ok(!text.includes('SeCrEt'));
  assert.equal(describeApiError(new Error('plain')), '');
  assert.equal(describeApiError('a string'), '');
});

test('logUnhandledRejection: logs code, method and path without the token, and still an error', async () => {
  const before = runtime.errors.length;
  const lines = await captureErr(() => logUnhandledRejection(apiError()));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /ERROR\s+sylo\s+Unhandled promise rejection/);
  assert.match(lines[0], /code=10062/);
  assert.match(lines[0], /POST \/api\/v10\/interactions\/111\/<token>\/callback/);
  assert.match(lines[0], /\(at /, 'the top stack frames are in the line');
  assert.ok(!lines[0].includes('SeCrEt'), 'no token');
  assert.ok(!lines[0].includes('x=1'), 'no query string');
  assert.equal(runtime.errors.length, before + 1);
});

test('logUnhandledRejection: a TypeError in our own code is still an error, a string reason works', async () => {
  const before = runtime.errors.length;
  const lines = await captureErr(() => {
    logUnhandledRejection(new TypeError('x is not a function'));
    logUnhandledRejection('just a string');
  });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /ERROR\s+sylo\s+Unhandled promise rejection .*x is not a function/);
  assert.match(lines[1], /ERROR\s+sylo\s+Unhandled promise rejection just a string/);
  assert.equal(runtime.errors.length, before + 2);
});
