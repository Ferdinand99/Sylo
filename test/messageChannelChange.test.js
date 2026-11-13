// A message the bot posted and keeps up to date (an embed message, the welcome message, a role
// message) is stored as a channel id plus a message id. When the person picks another channel, the
// bot has to post a fresh message there and delete the old one; editing the old id in the new
// channel fails with "Unknown Message". The stored pair changes only after the new post worked.
import { startWebApp } from './helpers/webApp.js';
import { v2Open } from './helpers/v2Open.js';
import { fakeGuild, ROLE } from './helpers/fakeGuild.js';
import { fakeChannel, missingAccess, serverError } from './helpers/fakeIntro.js';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from '../src/runtime.js';
import { getComposed } from '../src/db/composedMessages.js';
import { getGuildModule } from '../src/db/modules.js';
import { publishWelcome, unpublishWelcome } from '../src/modules/welcomeChannel.js';

const A = '101000000000000901';
const B = '102000000000000902';

// What each platform throws for a message that is not there (see platform/messageErrors.js).
const goneOn = {
  discord: () => Object.assign(new Error('Unknown Message'), { status: 404, code: 10008 }),
  fluxer: () =>
    Object.assign(new Error('Could not fetch the message'), {
      cause: Object.assign(new Error('Unknown Message'), { statusCode: 404, code: 'UNKNOWN_MESSAGE' }),
    }),
};

/** A channel that keeps its messages, with the errors of `platform` and switches for failures. */
function channel(id, platform) {
  const ch = fakeChannel(id, `chan-${id.slice(-2)}`);
  const gone = goneOn[platform];
  const send = ch.send;
  ch.send = async (payload) => {
    if (ch.failSend) throw ch.failSend;
    const message = await send(payload);
    message.reactions = { cache: new Map(), removeAll: async () => {} };
    return message;
  };
  ch.messages.fetch = async (messageId) => {
    const found = ch.store.get(messageId);
    if (!found) throw gone();
    return found;
  };
  ch.messages.delete = async (messageId) => {
    if (ch.failDelete) throw ch.failDelete;
    const found = ch.store.get(messageId);
    if (!found) throw gone();
    await found.delete();
  };
  return ch;
}

let app;
let fluxerClient;
test.before(async () => {
  app = await startWebApp();
  fluxerClient = fakeGuild().client;
  runtime.clients.fluxer = fluxerClient;
});
test.after(() => {
  runtime.clients.fluxer = null;
  app.close();
});

let nextGuild = 0;

/**
 * A fresh server of `platform` with two channels that keep their messages, and the JSON API for it.
 * Every test gets its own server, so the stored rows and the publish rate limit (per server) do
 * not carry over.
 */
function setup(platform) {
  const { guild } = fakeGuild();
  guild.id = `90000000000001${String(++nextGuild).padStart(4, '0')}`;
  const client = platform === 'fluxer' ? fluxerClient : app.client;
  guild.client = client;
  client.guilds.cache.set(guild.id, guild);
  const key = platform === 'fluxer' ? `fluxer:${guild.id}` : guild.id;
  const chanA = channel(A, platform);
  const chanB = channel(B, platform);
  guild.channels.cache.set(A, chanA);
  guild.channels.cache.set(B, chanB);
  return { key, guild, chanA, chanB, api: v2Open(app, key), platform };
}

const spec = (content) => ({ content, embeds: [], rows: [] });
const ids = (ch) => [...ch.store.keys()];

for (const platform of ['discord', 'fluxer']) {
  const where = `(${platform})`;

  // --- embed messages -------------------------------------------------------------------------

  const publish = async (e, body = {}) => {
    const res = await e.api.post('/messages/new', {
      name: 'Rules',
      channelId: A,
      action: 'publish',
      spec: spec('v1'),
      ...body,
    });
    assert.equal(res.status, 200);
    return (await res.json()).rec;
  };
  const update = (e, rec, body) =>
    e.api.post(`/messages/${rec.id}`, {
      name: rec.name,
      channelId: rec.channelId,
      action: 'publish',
      spec: spec('v2'),
      ...body,
    });

  test(`composed: changing the channel of a published message posts fresh there and deletes the old one ${where}`, async () => {
    const e = setup(platform);
    const rec = await publish(e);
    const oldId = rec.messageId;
    assert.deepEqual(ids(e.chanA), [oldId]);

    const res = await update(e, rec, { channelId: B });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'sent');
    assert.equal(body.rec.channelId, B);
    assert.notEqual(body.rec.messageId, oldId);
    assert.deepEqual(ids(e.chanA), [], 'the old post is gone from the old channel');
    assert.deepEqual(ids(e.chanB), [body.rec.messageId]);

    const stored = await getComposed(e.key, rec.id);
    assert.equal(stored.channel_id, B);
    assert.equal(stored.message_id, body.rec.messageId);

    // The next update edits the new post in place (it used to fail for good).
    const again = await update(e, body.rec, { spec: spec('v3') });
    assert.equal(again.status, 200);
    assert.equal((await again.json()).status, 'updated');
    assert.equal(e.chanB.log.edits.length, 1);
  });

  test(`composed: a failing delete of the old post does not stop the move, and is logged ${where}`, async () => {
    for (const fail of [goneOn[platform](), missingAccess(), serverError()]) {
      const e = setup(platform);
      const rec = await publish(e);
      e.chanA.failDelete = fail;
      const logged = mock.method(console, 'error', () => {});
      try {
        const res = await update(e, rec, { channelId: B });
        assert.equal(res.status, 200, fail.message);
        const body = await res.json();
        assert.equal(body.rec.channelId, B);
        assert.equal(body.rec.messageId, ids(e.chanB)[0]);
        assert.ok(
          logged.mock.calls.some((c) => /could not delete/i.test(String(c.arguments[0]))),
          `the failed delete is logged (${fail.message})`
        );
      } finally {
        logged.mock.restore();
      }
    }
  });

  test(`composed: a failing new post changes nothing that is stored, and the old post stays ${where}`, async () => {
    const e = setup(platform);
    const rec = await publish(e);
    e.chanB.failSend = missingAccess();

    const res = await update(e, rec, { channelId: B });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /Missing Access/);
    assert.equal(body.rec.channelId, A);
    assert.equal(body.rec.messageId, rec.messageId);
    assert.deepEqual(ids(e.chanA), [rec.messageId], 'the old post is not deleted');
    assert.deepEqual(ids(e.chanB), []);
    const stored = await getComposed(e.key, rec.id);
    assert.equal(stored.channel_id, A);
    assert.equal(stored.message_id, rec.messageId);

    // Once the channel works again the same request succeeds: nothing is stuck.
    e.chanB.failSend = null;
    const retry = await update(e, rec, { channelId: B });
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).rec.channelId, B);
    assert.deepEqual(ids(e.chanA), []);
  });

  test(`composed: saving a draft keeps the posted message where it is until it is published again ${where}`, async () => {
    const e = setup(platform);
    const rec = await publish(e);
    const res = await update(e, rec, { channelId: B, action: 'save' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'saved');
    assert.equal(body.rec.channelId, A);
    assert.equal(body.rec.messageId, rec.messageId);
    assert.equal(body.rec.spec.content, 'v2', 'the text is saved');
    assert.deepEqual(ids(e.chanB), [], 'a draft is not posted');

    // Unpublish still finds the post.
    const off = await e.api.post(`/messages/${rec.id}/unpublish`);
    assert.equal(off.status, 200);
    assert.equal((await off.json()).rec.messageId, null);
    assert.deepEqual(ids(e.chanA), []);
  });

  test(`composed: a post that was deleted by hand is posted again in the same channel ${where}`, async () => {
    const e = setup(platform);
    const rec = await publish(e);
    e.chanA.store.clear();
    const res = await update(e, rec, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'sent');
    assert.equal(body.rec.channelId, A);
    assert.deepEqual(ids(e.chanA), [body.rec.messageId]);
  });

  test(`composed: a draft that was never posted just takes the new channel ${where}`, async () => {
    const e = setup(platform);
    const draft = await e.api.post('/messages/new', {
      name: 'D',
      channelId: A,
      action: 'save',
      spec: spec('x'),
    });
    const rec = (await draft.json()).rec;
    const res = await update(e, rec, { channelId: B, action: 'save' });
    assert.equal((await res.json()).rec.channelId, B);
    assert.deepEqual([...ids(e.chanA), ...ids(e.chanB)], []);
  });

  // --- welcome channel ------------------------------------------------------------------------

  const wc = (e, body) => e.api.post('/modules/welcome-channel/publish', { spec: spec('hello'), ...body });
  const wcCfg = async (e) => (await getGuildModule(e.key, 'welcome-channel')).config;

  test(`welcome channel: a new channel gets a fresh post and the old one is deleted ${where}`, async () => {
    const e = setup(platform);
    const first = await (await wc(e, { channelId: A })).json();
    const oldId = first.config.messageId;
    assert.deepEqual(ids(e.chanA), [oldId]);

    const res = await wc(e, { channelId: B });
    assert.equal(res.status, 200);
    const { config } = await res.json();
    assert.equal(config.channelId, B);
    assert.notEqual(config.messageId, oldId);
    assert.deepEqual(ids(e.chanA), []);
    assert.deepEqual(ids(e.chanB), [config.messageId]);
    assert.deepEqual(await wcCfg(e), config);

    const off = await e.api.post('/modules/welcome-channel/unpublish');
    assert.equal((await off.json()).config.messageId, '');
    assert.deepEqual(ids(e.chanB), []);
  });

  test(`welcome channel: a failing new post leaves the stored channel and message alone ${where}`, async () => {
    const e = setup(platform);
    const first = (await (await wc(e, { channelId: A })).json()).config;
    e.chanB.failSend = missingAccess();
    const res = await wc(e, { channelId: B, spec: spec('changed') });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /Missing Access/);
    const stored = await wcCfg(e);
    assert.equal(stored.channelId, A);
    assert.equal(stored.messageId, first.messageId);
    assert.equal(stored.spec.content, 'changed', 'the text is kept');
    assert.deepEqual(ids(e.chanA), [first.messageId]);
  });

  test(`welcome channel: saving a draft with another channel keeps the post reachable ${where}`, async () => {
    const e = setup(platform);
    const first = (await (await wc(e, { channelId: A })).json()).config;
    const res = await e.api.post('/modules/welcome-channel/config', { channelId: B, spec: spec('d') });
    const { config } = await res.json();
    assert.equal(config.channelId, A);
    assert.equal(config.messageId, first.messageId);
    const off = await e.api.post('/modules/welcome-channel/unpublish');
    assert.equal((await off.json()).config.messageId, '');
    assert.deepEqual(ids(e.chanA), [], 'the post is deleted in the channel it is in');
  });

  test(`welcome channel: publishWelcome and unpublishWelcome move and delete on the stored channel ${where}`, async () => {
    const e = setup(platform);
    const g = e.guild;
    const cfg = { channelId: A, messageId: '', spec: { content: 'x', embeds: [] } };
    const first = await publishWelcome(g, cfg);
    assert.equal(first.ok, true);
    assert.equal(first.channelId, A);
    const stored = { ...cfg, messageId: first.messageId };

    const moved = await publishWelcome(g, { ...stored, channelId: B }, stored);
    assert.equal(moved.ok, true);
    assert.equal(moved.channelId, B);
    assert.deepEqual(ids(e.chanA), []);
    assert.deepEqual(ids(e.chanB), [moved.messageId]);

    await unpublishWelcome(g, { ...stored, channelId: B, messageId: moved.messageId });
    assert.deepEqual(ids(e.chanB), []);
  });

  // --- role messages --------------------------------------------------------------------------

  for (const style of ['buttons', 'reaction']) {
    const rr = (e, body) =>
      e.api.post('/modules/roles/rr', {
        style,
        channelId: A,
        pairs: [{ roleId: ROLE.member, emoji: style === 'reaction' ? '👍' : '', label: 'Member' }],
        ...body,
      });
    const listed = async (e) => (await getGuildModule(e.key, 'roles')).config.reactionMessages;
    const withReact = (e) => {
      for (const ch of [e.chanA, e.chanB]) {
        const send = ch.send;
        ch.send = async (p) => Object.assign(await send(p), { react: async () => {} });
      }
    };

    test(`role message (${style}): a new channel gets a fresh post and the old one is deleted ${where}`, async () => {
      const e = setup(platform);
      withReact(e);
      const first = (await (await rr(e, {})).json()).reactionMessage;
      assert.ok(first.messageId, 'posted');
      assert.deepEqual(ids(e.chanA), [first.messageId]);

      const res = await rr(e, { id: first.id, channelId: B });
      const body = await res.json();
      assert.equal(body.error, null);
      assert.equal(body.reactionMessage.channelId, B);
      assert.notEqual(body.reactionMessage.messageId, first.messageId);
      assert.deepEqual(ids(e.chanA), []);
      assert.deepEqual(ids(e.chanB), [body.reactionMessage.messageId]);
      assert.equal((await listed(e))[0].channelId, B);
    });

    test(`role message (${style}): a failing new post keeps the stored channel and message ${where}`, async () => {
      const e = setup(platform);
      withReact(e);
      const first = (await (await rr(e, {})).json()).reactionMessage;
      e.chanB.failSend = missingAccess();
      const res = await rr(e, { id: first.id, channelId: B, label: 'x' });
      const body = await res.json();
      assert.match(body.error, /Missing Access/);
      const [stored] = await listed(e);
      assert.equal(stored.channelId, A);
      assert.equal(stored.messageId, first.messageId);
      assert.deepEqual(ids(e.chanA), [first.messageId]);
    });
  }
}
