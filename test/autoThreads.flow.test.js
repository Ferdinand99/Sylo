// Auto threads end to end with fake platform objects: the thread a post gets (name, archive time,
// first message, slowmode), every reason to skip a post, the missing-permission path with its one
// warning per channel per hour, the two second rate limit, and Fluxer (no threads).
// mock.timers is experimental until Node 23.1 but works on the Node 22 this project requires.
/* eslint-disable n/no-unsupported-features/node-builtins */
import './helpers/tmpDb.js';
import test, { mock, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import { runtime } from '../src/runtime.js';
import { log } from '../src/lib/log.js';
import { setGuildModule } from '../src/db/modules.js';
import { dispatch } from '../src/modules/dispatch.js';
import {
  THREAD_EVERY_MS,
  WARN_EVERY_MS,
  handleAutoThreadMessage,
  resetAutoThreads,
} from '../src/modules/autoThreads.js';

const BOT = '100000000000000999';
const USER = '100000000000000011';
const ROLE = '100000000000000700';
const START = Date.UTC(2026, 9, 29, 12, 0, 0);

let seq = 0;
let w;

/** A guild with one text channel `ch` (own id per call) and a message factory. */
function world({ platform = 'discord', granted = ['CreatePublicThreads', 'SendMessagesInThreads'] } = {}) {
  seq += 1;
  const rawId = String(900000000000000300n + BigInt(seq));
  const GID = platform === 'fluxer' ? `fluxer:${rawId}` : rawId;
  const out = { threads: [], sent: [], slowmode: [] };
  const permitted = new Set(granted);

  const makeChannel = (n, type = ChannelType.GuildText) => {
    const id = String(100000000000010000n + BigInt(seq * 100 + n));
    return {
      id,
      name: `posts-${n}`,
      type,
      isThread: () => false,
      permissionsFor: () => ({ has: (list) => [].concat(list).every((p) => permitted.has(p)) }),
    };
  };
  const ch = makeChannel(1);
  const ch2 = makeChannel(2);
  const forum = makeChannel(3, ChannelType.GuildForum);
  const client = { isReady: () => true, user: { id: BOT } };
  const guild = { id: platform === 'fluxer' ? rawId : GID, client, members: { me: { id: BOT } } };
  runtime.clients.discord = platform === 'fluxer' ? null : client;
  runtime.clients.fluxer = platform === 'fluxer' ? client : null;

  let msgSeq = 0;
  const post = (over = {}) => {
    msgSeq += 1;
    const channel = over.channel ?? ch;
    const message = {
      id: `30000000000${String(seq).padStart(3, '0')}${String(msgSeq).padStart(4, '0')}`,
      channelId: channel.id,
      channel,
      guild,
      client,
      system: false,
      hasThread: false,
      content: 'Anyone up for a raid tonight?',
      createdTimestamp: Date.now(),
      webhookId: null,
      author: { id: USER, bot: false, username: 'alexander' },
      member: { displayName: 'Alex', permissions: { has: () => false }, roles: { cache: new Map() } },
      attachments: { size: 0 },
      startThread: async (opts) => {
        out.threads.push({ messageId: message.id, ...opts });
        const thread = {
          id: `thread-${message.id}`,
          send: async (p) => out.sent.push(p),
          setRateLimitPerUser: async (n) => out.slowmode.push(n),
        };
        return thread;
      },
      ...over,
    };
    return message;
  };
  return { GID, guild, ch, ch2, forum, post, out, client };
}

const enable = (config) => setGuildModule(w.GID, 'auto-threads', { enabled: true, config });
const send = (message) => dispatch('messageCreateAny', w.GID, message);
const rules = (...rs) => ({ rules: (rs.length ? rs : [{}]).map((r) => ({ channelId: w.ch.id, ...r })) });

let warn;
let debug;
beforeEach(() => {
  // Every throttle (one warning an hour, one thread per two seconds) reads Date.now(); the tests move it.
  mock.timers.enable({ apis: ['Date'], now: START });
  resetAutoThreads();
  warn = mock.method(log, 'warn', () => {});
  debug = mock.method(log, 'debug', () => {});
});
afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
  runtime.clients.discord = null;
  runtime.clients.fluxer = null;
});

const warnings = () => warn.mock.calls.filter((c) => c.arguments[0] === 'auto-threads');
const debugLines = () =>
  debug.mock.calls.filter((c) => c.arguments[0] === 'auto-threads').map((c) => c.arguments[1]);

test('a new post gets a thread with the rendered name, the archive time and a reason', async () => {
  w = world();
  await enable(rules({ nameTemplate: '{author} - {date} - {words}', archiveMinutes: 4320 }));
  const message = w.post({ createdTimestamp: START });
  await send(message);
  assert.equal(w.out.threads.length, 1);
  const [t] = w.out.threads;
  assert.equal(t.messageId, message.id);
  assert.equal(t.name, 'Alex - 2026-10-29 - Anyone up for a raid tonight?');
  assert.equal(t.autoArchiveDuration, 4320);
  assert.match(t.reason, /Auto threads/);
  assert.deepEqual(w.out.sent, [], 'no first message unless set');
  assert.deepEqual(w.out.slowmode, [], 'no slowmode unless set');
});

test('the name falls back to the author for a post without words, and is cut at 100', async () => {
  w = world();
  await enable(rules({ nameTemplate: '{words}' }));
  await send(w.post({ content: '', attachments: { size: 1 } }));
  assert.equal(w.out.threads[0].name, 'Alex');
  await enable(rules({ nameTemplate: 'x'.repeat(100) }));
  mock.timers.tick(THREAD_EVERY_MS);
  await send(w.post({ member: null, author: { id: USER, bot: false, username: 'z'.repeat(150) } }));
  assert.equal(w.out.threads[1].name.length, 100);
});

test('the first message mentions the author and nobody else; slowmode is set on the thread', async () => {
  w = world();
  await enable(rules({ firstMessage: 'Welcome {author}! Stay on topic. @everyone', slowmodeSeconds: 120 }));
  await send(w.post());
  assert.deepEqual(w.out.slowmode, [120]);
  assert.equal(w.out.sent.length, 1);
  assert.equal(w.out.sent[0].content, `Welcome <@${USER}>! Stay on topic. @everyone`);
  assert.deepEqual(w.out.sent[0].allowedMentions, { parse: [], users: [USER] });
});

test('a thread without Manage Threads (slowmode fails) or a failing first message still counts', async () => {
  w = world();
  await enable(rules({ firstMessage: 'hi', slowmodeSeconds: 10 }));
  const message = w.post();
  message.startThread = async (opts) => {
    w.out.threads.push({ messageId: message.id, ...opts });
    return {
      id: 't1',
      send: async () => {
        throw new Error('no send');
      },
      setRateLimitPerUser: async () => {
        throw new Error('Missing Permissions');
      },
    };
  };
  await send(message);
  assert.equal(w.out.threads.length, 1);
  assert.equal(warnings().length, 0, 'extras failing is only a debug line');
  assert.ok(debugLines().some((l) => /no slowmode/.test(l)));
  assert.ok(debugLines().some((l) => /no first message/.test(l)));
});

test('the module off, or a channel without a rule: nothing happens', async () => {
  w = world();
  await setGuildModule(w.GID, 'auto-threads', { enabled: false, config: rules() });
  await send(w.post());
  await enable(rules());
  await send(w.post({ channel: w.ch2 }));
  assert.equal(w.out.threads.length, 0);
});

test('skips: system messages, posts in threads, forums, posts that have a thread, DMs', async () => {
  w = world();
  await enable({
    rules: [w.ch, w.ch2, w.forum].map((c) => ({ channelId: c.id })),
  });
  await send(w.post({ system: true }));
  await send(w.post({ hasThread: true }));
  const inThread = { ...w.ch, isThread: () => true, type: ChannelType.PublicThread };
  await send(w.post({ channel: inThread }));
  await send(w.post({ channel: w.forum }));
  await send(w.post({ channel: { ...w.ch, type: ChannelType.GuildVoice } }));
  await handleAutoThreadMessage({ ...w.post(), guild: null }, rules(), w.GID);
  assert.equal(w.out.threads.length, 0);
  assert.equal(warnings().length, 0);
  // and the same channel works for a normal post
  await send(w.post());
  assert.equal(w.out.threads.length, 1);
});

test('announcement channels work too', async () => {
  w = world();
  const news = { ...w.ch, id: '100000000000070001', type: ChannelType.GuildAnnouncement };
  await enable({ rules: [{ channelId: news.id }] });
  await send(w.post({ channel: news }));
  assert.equal(w.out.threads.length, 1);
});

test("skips: Sylo's own posts, even with skipBots off", async () => {
  w = world();
  await enable(rules({ skipBots: false }));
  await send(w.post({ author: { id: BOT, bot: true, username: 'Sylo' } }));
  assert.equal(w.out.threads.length, 0);
});

test('skips: bots and webhooks while skipBots is on; taken when it is off', async () => {
  w = world();
  await enable(rules());
  await send(w.post({ author: { id: '5', bot: true, username: 'other' } }));
  await send(w.post({ webhookId: '77', author: { id: '77', bot: true, username: 'hook' } }));
  assert.equal(w.out.threads.length, 0);

  await enable(rules({ skipBots: false }));
  await send(w.post({ author: { id: '5', bot: true, username: 'other' } }));
  mock.timers.tick(THREAD_EVERY_MS);
  await send(w.post({ webhookId: '77', author: { id: '77', bot: true, username: 'hook' } }));
  assert.equal(w.out.threads.length, 2);
});

test('skips: staff by permission or staff role, only while skipStaff is on', async () => {
  w = world();
  const admin = {
    displayName: 'Boss',
    permissions: { has: (p) => p === 'Administrator' },
    roles: { cache: new Map() },
  };
  const manager = {
    displayName: 'Mod',
    permissions: { has: (p) => p === 'ManageGuild' },
    roles: { cache: new Map() },
  };
  const helper = {
    displayName: 'Help',
    permissions: { has: () => false },
    roles: { cache: new Map([[ROLE, {}]]) },
  };
  await enable(rules({ skipStaff: true, staffRoleIds: [ROLE] }));
  for (const member of [admin, manager, helper]) await send(w.post({ member }));
  assert.equal(w.out.threads.length, 0);
  await send(w.post());
  assert.equal(w.out.threads.length, 1, 'a normal member still gets one');

  await enable(rules({ skipStaff: false }));
  mock.timers.tick(THREAD_EVERY_MS);
  await send(w.post({ member: admin }));
  assert.equal(w.out.threads.length, 2, 'off: staff get threads too');
});

test('skips: posts without an attachment or a link when a rule asks for one', async () => {
  w = world();
  await enable(rules({ onlyWithAttachments: true }));
  await send(w.post());
  await send(w.post({ content: 'https://example.com' }));
  assert.equal(w.out.threads.length, 0);
  await send(w.post({ attachments: { size: 1 } }));
  assert.equal(w.out.threads.length, 1);

  await enable(rules({ onlyWithLinks: true }));
  mock.timers.tick(THREAD_EVERY_MS);
  await send(w.post());
  await send(w.post({ attachments: { size: 1 } }));
  assert.equal(w.out.threads.length, 1);
  await send(w.post({ content: 'look: https://example.com/a' }));
  assert.equal(w.out.threads.length, 2);
});

test('the first rule that takes the post decides the thread', async () => {
  w = world();
  await enable(
    rules(
      { id: 'pics', onlyWithAttachments: true, nameTemplate: 'Pic by {author}', archiveMinutes: 60 },
      { id: 'rest', nameTemplate: '{words}', archiveMinutes: 10080 }
    )
  );
  await send(w.post({ attachments: { size: 1 }, createdTimestamp: START }));
  mock.timers.tick(THREAD_EVERY_MS);
  await send(w.post({ content: 'plain words' }));
  assert.deepEqual(
    w.out.threads.map((t) => [t.name, t.autoArchiveDuration]),
    [
      ['Pic by Alex', 60],
      ['plain words', 10080],
    ]
  );
});

test('Fluxer has no threads: the module does nothing there', async () => {
  w = world({ platform: 'fluxer' });
  await enable(rules());
  await send(w.post());
  assert.equal(w.out.threads.length, 0);
  assert.equal(warnings().length, 0);
});

// --- missing permissions ---------------------------------------------------------------------------

test('missing Create Public Threads or Send Messages in Threads: no thread, one warning', async () => {
  for (const granted of [['SendMessagesInThreads'], ['CreatePublicThreads'], []]) {
    resetAutoThreads();
    warn.mock.resetCalls();
    w = world({ granted });
    await enable(rules());
    await send(w.post());
    assert.equal(w.out.threads.length, 0, granted.join());
    assert.equal(warnings().length, 1, granted.join());
    assert.match(String(warnings()[0].arguments[1]), /Create Public Threads and Send Messages in Threads/);
  }
});

test('the permission warning is logged once per channel per hour, not once per post', async () => {
  w = world({ granted: [] });
  await enable({ rules: [{ channelId: w.ch.id }, { channelId: w.ch2.id }] });

  for (let i = 0; i < 20; i += 1) await send(w.post());
  assert.equal(warnings().length, 1, 'twenty posts, one line');

  await send(w.post({ channel: w.ch2 }));
  assert.equal(warnings().length, 2, 'another channel has its own warning');
  await send(w.post({ channel: w.ch2 }));
  assert.equal(warnings().length, 2);

  mock.timers.tick(WARN_EVERY_MS - 1);
  await send(w.post());
  assert.equal(warnings().length, 2, 'just under an hour: still quiet');

  mock.timers.tick(1);
  await send(w.post());
  assert.equal(warnings().length, 3, 'after an hour it warns again');
  await send(w.post());
  assert.equal(warnings().length, 3);
  assert.equal(w.out.threads.length, 0, 'and no post ever got a thread');
});

test('once the permissions are granted threads start again', async () => {
  w = world({ granted: [] });
  await enable(rules());
  await send(w.post());
  assert.equal(w.out.threads.length, 0);
  // the same channel object now answers yes
  w.ch.permissionsFor = () => ({ has: () => true });
  await send(w.post());
  assert.equal(w.out.threads.length, 1);
});

// --- rate safety -----------------------------------------------------------------------------------

test('at most one thread per channel every 2 seconds; the rest are dropped quietly and counted', async () => {
  w = world();
  await enable({ rules: [{ channelId: w.ch.id }, { channelId: w.ch2.id }] });

  await send(w.post());
  await send(w.post());
  await send(w.post());
  assert.equal(w.out.threads.length, 1, 'one thread; two posts dropped');
  assert.equal(warnings().length, 0, 'dropping is not a warning');
  const lines = debugLines().filter((l) => /rate limit/.test(l));
  assert.equal(lines.length, 2);
  assert.match(lines[0], /dropped 1 post/);
  assert.match(lines[1], /dropped 2 post/);

  await send(w.post({ channel: w.ch2 }));
  assert.equal(w.out.threads.length, 2, 'another channel has its own clock');

  mock.timers.tick(THREAD_EVERY_MS - 1);
  await send(w.post());
  assert.equal(w.out.threads.length, 2, 'one millisecond short');
  mock.timers.tick(1);
  await send(w.post());
  assert.equal(w.out.threads.length, 3, 'after two seconds the next post gets a thread');
  assert.ok(
    debugLines().some((l) => /3 post\(s\) were dropped/.test(l)),
    'the drops are totalled'
  );
});

test('posts at the same moment: only one thread is started', async () => {
  w = world();
  await enable(rules());
  await Promise.all(Array.from({ length: 8 }, () => send(w.post())));
  assert.equal(w.out.threads.length, 1);
});

// --- Discord refusing -------------------------------------------------------------------------------

test('a post deleted before the thread (10008) is a debug line; other errors warn once per hour', async () => {
  w = world();
  await enable(rules());
  const failing = (code, text) => {
    const message = w.post();
    message.startThread = async () => {
      throw Object.assign(new Error(text), { code });
    };
    return message;
  };
  await send(failing(10008, 'Unknown Message'));
  mock.timers.tick(THREAD_EVERY_MS);
  await send(failing(160004, 'A thread has already been created for this message'));
  assert.equal(warnings().length, 0);

  mock.timers.tick(THREAD_EVERY_MS);
  await send(failing(50013, 'Missing Permissions'));
  mock.timers.tick(THREAD_EVERY_MS);
  await send(failing(50013, 'Missing Permissions'));
  assert.equal(warnings().length, 1, 'the same failure is not repeated within the hour');
  assert.match(String(warnings()[0].arguments[1]), /Missing Permissions/);
});
