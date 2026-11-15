// The starboard republishes a message for the board's readers. A message from a channel those readers
// cannot see (a private thread, a channel @everyone cannot view, an age-restricted channel on a board
// that is not) must not be copied there, on a reaction or in the catch-up rescan.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import { dispatch } from '../src/modules/dispatch.js';
import { rescanBoard, normaliseStarboard } from '../src/modules/starboard.js';
import { setGuildModule } from '../src/db/modules.js';

const G = '900000000000000031';
const BOARD = '100000000000000901';
const OPEN = '100000000000000902';
const STAFF = '100000000000000903';
const NSFW = '100000000000000904';
const THREAD = '100000000000000905';
const BOARD_NSFW = '100000000000000906';
const EVERYONE = { id: G, name: '@everyone' };

const channel = (id, { everyoneView = true, nsfw = false, ...extra } = {}) => ({
  id,
  nsfw,
  isTextBased: () => true,
  isThread: () => false,
  permissionsFor: (who) => ({ has: () => (who === EVERYONE ? everyoneView : true) }),
  ...extra,
});

function world() {
  const sent = [];
  const board = channel(BOARD, {
    send: async (p) => {
      sent.push(p);
      return { id: `post${sent.length}`, react: async () => {} };
    },
  });
  const channels = new Map(
    [
      board,
      channel(OPEN),
      channel(STAFF, { everyoneView: false }),
      channel(NSFW, { nsfw: true }),
      channel(BOARD_NSFW, {
        nsfw: true,
        send: async (p) => {
          sent.push(p);
          return { id: `post${sent.length}`, react: async () => {} };
        },
      }),
    ].map((c) => [c.id, c])
  );
  const guild = {
    id: G,
    channels: { cache: channels },
    roles: { everyone: EVERYONE },
    members: { me: {}, cache: new Map(), fetch: async () => null },
    emojis: { cache: new Map() },
  };
  return { guild, sent, channels };
}

const user = (id) => ({ id, bot: false });
function message(guild, ch, id = '700000000000000001') {
  const users = new Map([
    ['u1', user('u1')],
    ['u2', user('u2')],
    ['u3', user('u3')],
  ]);
  const m = {
    id,
    channelId: ch.id,
    channel: ch,
    guild,
    author: { id: 'author', bot: false, username: 'a', displayAvatarURL: () => 'https://x/a.png' },
    content: 'a secret thing',
    createdTimestamp: Date.now() - 60_000,
    url: `https://discord.com/channels/${G}/${ch.id}/${id}`,
    attachments: new Map(),
    embeds: [],
    reactions: { cache: new Map() },
  };
  const rx = {
    emoji: { id: null, name: '⭐' },
    message: m,
    partial: false,
    users: { fetch: async () => users, cache: users },
  };
  m.reactions.cache.set('⭐', rx);
  return { m, rx };
}

let boards = 0;
async function react(guild, ch, boardConfig = {}, { dest = BOARD } = {}) {
  // A new board id each time: a board posts at most once a minute.
  await setGuildModule(G, 'starboard', {
    enabled: true,
    config: { boards: [{ id: `b${(boards += 1)}`, channelId: dest, threshold: 3, ...boardConfig }] },
  });
  const { rx } = message(guild, ch);
  await dispatch('reactionAdd', G, { reaction: rx, user: user('u3') });
}

test('a message from a channel @everyone cannot view is not copied to the board', async () => {
  const { guild, sent, channels } = world();
  await react(guild, channels.get(STAFF));
  assert.equal(sent.length, 0);
});

test('a message from a channel everyone can read is copied (the rule does not break the normal case)', async () => {
  const { guild, sent, channels } = world();
  await react(guild, channels.get(OPEN));
  assert.equal(sent.length, 1);
});

test('a hidden channel an admin picked for the board ("only these channels") is still copied', async () => {
  const { guild, sent, channels } = world();
  await react(guild, channels.get(STAFF), { channelMode: 'deny', channelList: [STAFF] });
  assert.equal(sent.length, 1);
});

test('a private thread is never copied, even when it is the only channel picked', async () => {
  const { guild, sent, channels } = world();
  const parent = channels.get(OPEN);
  const thread = channel(THREAD, {
    isThread: () => true,
    type: ChannelType.PrivateThread,
    parent,
  });
  channels.set(THREAD, thread);
  await react(guild, thread, { channelMode: 'deny', channelList: [THREAD] });
  assert.equal(sent.length, 0);
});

test('a public thread follows its parent channel', async () => {
  const { guild, sent, channels } = world();
  const open = channel(THREAD, {
    isThread: () => true,
    type: ChannelType.PublicThread,
    parent: channels.get(OPEN),
  });
  await react(guild, open);
  assert.equal(sent.length, 1);
  const hiddenParent = channel('100000000000000907', {
    isThread: () => true,
    type: ChannelType.PublicThread,
    parent: channels.get(STAFF),
  });
  await react(guild, hiddenParent);
  assert.equal(sent.length, 1, 'a thread in a hidden channel is hidden too');
});

test('an age-restricted source is not copied to a board channel that is not, even when listed', async () => {
  const { guild, sent, channels } = world();
  await react(guild, channels.get(NSFW));
  assert.equal(sent.length, 0);
  await react(guild, channels.get(NSFW), { channelMode: 'deny', channelList: [NSFW] });
  assert.equal(sent.length, 0, 'an admin choice does not override the platform age gate');
});

test('an age-restricted source may go to a board channel that is age-restricted too', async () => {
  const { guild, sent, channels } = world();
  await react(guild, channels.get(NSFW), {}, { dest: BOARD_NSFW });
  assert.equal(sent.length, 1);
});

test('a source whose permissions cannot be read is not copied (fails closed)', async () => {
  const { guild, sent, channels } = world();
  const broken = channel('100000000000000908', {
    permissionsFor: () => {
      throw new Error('boom');
    },
  });
  channels.set(broken.id, broken);
  await react(guild, broken);
  assert.equal(sent.length, 0);
});

test('the catch-up rescan skips hidden sources too', async () => {
  const { guild, sent, channels } = world();
  const mk = (ch) => {
    const { m } = message(guild, ch, ch.id.slice(-6) + '000000000000');
    ch.messages = { fetch: async () => new Map([[m.id, m]]) };
  };
  for (const id of [OPEN, STAFF, NSFW]) mk(channels.get(id));
  const board = normaliseStarboard({ boards: [{ id: 'r', channelId: BOARD, threshold: 3 }] }).boards[0];
  const result = await rescanBoard(guild, board);
  assert.equal(result.posted, 1, 'only the open channel');
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, new RegExp(OPEN));
});
