// A message the bot posted and keeps up to date (an embed message, the welcome message, a role
// message) is stored as a channel id plus a message id. When the person picks another channel, the
// bot has to post a fresh message there and delete the old one; editing the old id in the new
// channel fails with "Unknown Message". The stored pair changes only after the new post worked.
import './helpers/trustLoopbackProxy.js'; // each test is its own client for the per-client rate limits
import { startWebApp } from './helpers/webApp.js';
import { fakeGuild, ROLE } from './helpers/fakeGuild.js';
import { fakeChannel, missingAccess, serverError } from './helpers/fakeIntro.js';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import * as sdk from '@fluxerjs/core';
import { Collection } from '@fluxerjs/collection';
import { installFluxerCompat } from '../src/platform/compat.js';
import { runtime } from '../src/runtime.js';
import { dispatch } from '../src/modules/dispatch.js';
import { publishComposed } from '../src/modules/messageCreator.js';
import { getComponentAction, saveComponentActions } from '../src/db/componentReactions.js';
import { getComposed } from '../src/db/composedMessages.js';
import { getGuildModule } from '../src/db/modules.js';
import { publishWelcome, unpublishWelcome } from '../src/modules/welcomeChannel.js';

installFluxerCompat(sdk, { Collection });

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
  const fetch = async (messageId) => {
    if (ch.failFetch) throw ch.failFetch;
    const found = ch.store.get(messageId);
    if (!found) throw gone();
    // A message whose delete fails (the platform refuses it).
    return ch.failDelete ? { ...found, delete: async () => Promise.reject(ch.failDelete) } : found;
  };
  if (platform === 'fluxer') {
    // The real compat shim (platform/compat.js): messages.delete(id) fetches the message and deletes it.
    ch.messages = Object.assign(Object.create(sdk.MessageManager.prototype), { fetch });
  } else {
    ch.messages.fetch = fetch;
    ch.messages.delete = async (messageId) => (await fetch(messageId)).delete();
  }
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
  const ip = `10.7.${Math.floor(nextGuild / 250)}.${(nextGuild % 250) + 1}`;
  const api = {
    post: (path, body = {}) =>
      fetch(`${app.base}/api/v2/guilds/${key}${path}`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'x-forwarded-for': ip },
        body: JSON.stringify(body),
      }),
  };
  return { key, guild, chanA, chanB, api, platform };
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

// --- review round: what must not repost, order of the steps, races -----------------------------------

const slow = (ch, ms = 40) => {
  const send = ch.send;
  ch.send = async (p) => {
    await new Promise((r) => setTimeout(r, ms));
    return send(p);
  };
};

for (const platform of ['discord', 'fluxer']) {
  const where = `(${platform})`;
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

  test(`an edit that fails for a reason other than "gone" does not post a second message ${where}`, async () => {
    for (const fail of [serverError(), missingAccess()]) {
      const e = setup(platform);
      const rec = await publish(e);
      e.chanA.failFetch = fail;
      const res = await update(e, rec, {});
      assert.equal(res.status, 400, fail.message);
      assert.equal(e.chanA.log.sent.length, 1, `no repost after: ${fail.message}`);
      assert.deepEqual(ids(e.chanA), [rec.messageId]);
      const stored = await getComposed(e.key, rec.id);
      assert.equal(stored.message_id, rec.messageId);
    }
  });

  test(`welcome channel: a post deleted by hand is posted again in the same channel ${where}`, async () => {
    const e = setup(platform);
    const pub = (text) => e.api.post('/modules/welcome-channel/publish', { channelId: A, spec: spec(text) });
    const first = (await (await pub('w')).json()).config;
    e.chanA.store.clear();
    const res = await pub('w2');
    assert.equal(res.status, 200);
    const { config } = await res.json();
    assert.notEqual(config.messageId, first.messageId);
    assert.deepEqual(ids(e.chanA), [config.messageId]);

    // A 5xx on the edit is an error, not a second welcome message.
    e.chanA.failFetch = serverError();
    const bad = await pub('w3');
    assert.equal(bad.status, 400);
    assert.equal(e.chanA.log.sent.length, 2);
    assert.equal((await getGuildModule(e.key, 'welcome-channel')).config.messageId, config.messageId);
  });

  test(`welcome channel: publishing is limited per server like the other platform actions ${where}`, async () => {
    const e = setup(platform);
    let last;
    for (let i = 0; i < 11; i += 1) {
      last = await e.api.post('/modules/welcome-channel/publish', { channelId: A, spec: spec(`w${i}`) });
    }
    assert.equal(last.status, 429);
  });

  for (const style of ['buttons', 'reaction']) {
    const rr = (e, body) =>
      e.api.post('/modules/roles/rr', {
        style,
        channelId: A,
        pairs: [{ roleId: ROLE.member, emoji: style === 'reaction' ? '👍' : '', label: 'Member' }],
        ...body,
      });
    const withReact = (e) => {
      for (const ch of [e.chanA, e.chanB]) {
        const send = ch.send;
        ch.send = async (p) => Object.assign(await send(p), { react: async () => {} });
      }
    };

    test(`role message (${style}): a post deleted by hand is posted again; a failing lookup is not ${where}`, async () => {
      const e = setup(platform);
      withReact(e);
      const first = (await (await rr(e, {})).json()).reactionMessage;
      e.chanA.store.clear();
      const again = (await (await rr(e, { id: first.id })).json()).reactionMessage;
      assert.notEqual(again.messageId, first.messageId);
      assert.deepEqual(ids(e.chanA), [again.messageId]);

      e.chanA.failFetch = serverError();
      const body = await (await rr(e, { id: first.id, label: 'x' })).json();
      assert.ok(body.error, 'the failure is reported');
      assert.equal(e.chanA.log.sent.length, 2, 'no second panel');
      const [stored] = (await getGuildModule(e.key, 'roles')).config.reactionMessages;
      assert.equal(stored.messageId, again.messageId);
    });
  }

  test(`role message (reaction): a reaction counts on the new post after a move, not on the old one ${where}`, async () => {
    const e = setup(platform);
    for (const ch of [e.chanA, e.chanB]) {
      const send = ch.send;
      ch.send = async (p) => Object.assign(await send(p), { react: async () => {} });
    }
    e.guild.roles.cache.get(ROLE.member).editable = true;
    const added = [];
    e.guild.members.fetch = async (id) => ({
      id,
      roles: { cache: new Map(), add: async (r) => added.push([id, r.id]), remove: async () => {} },
    });
    const post = (body) =>
      e.api.post('/modules/roles/rr', {
        style: 'reaction',
        channelId: A,
        pairs: [{ roleId: ROLE.member, emoji: '👍' }],
        ...body,
      });
    const first = (await (await post({})).json()).reactionMessage;
    const moved = (await (await post({ id: first.id, channelId: B })).json()).reactionMessage;
    const react = (messageId) =>
      dispatch('reactionAdd', e.key, {
        reaction: { partial: false, message: { id: messageId }, emoji: { id: null, name: '👍' } },
        user: { id: '700000000000000042', bot: false },
      });

    await react(moved.messageId);
    assert.deepEqual(added, [['700000000000000042', ROLE.member]], 'the new post hands out the role');
    await react(first.messageId);
    assert.equal(added.length, 1, 'the old post is gone and does nothing');
  });

  // --- the order of the steps and races ---------------------------------------------------------

  test(`a new post is stored before the old one is deleted; a failed store removes the new post ${where}`, async () => {
    const e = setup(platform);
    const rec = await publish(e);
    const seen = [];
    const result = await publishComposed(
      e.guild,
      { channelId: A, messageId: rec.messageId },
      B,
      spec('order'),
      async (post) => {
        seen.push({ post, oldStillThere: ids(e.chanA).includes(rec.messageId) });
      }
    );
    assert.equal(seen.length, 1);
    assert.equal(seen[0].oldStillThere, true, 'persist runs while the old post still exists');
    assert.equal(seen[0].post.messageId, result.messageId);
    assert.deepEqual(ids(e.chanA), [], 'and the old post is deleted after it');

    // A store that fails: the new post is deleted again, and the old one is left alone.
    const second = setup(platform);
    const rec2 = await publish(second);
    await assert.rejects(
      publishComposed(second.guild, { channelId: A, messageId: rec2.messageId }, B, spec('x'), async () => {
        throw new Error('the database is down');
      }),
      /the database is down/
    );
    assert.deepEqual(ids(second.chanB), [], 'the new post is removed');
    assert.deepEqual(ids(second.chanA), [rec2.messageId], 'the old post stays');
  });

  test(`two publishes of the same message at once leave one post and one stored pair ${where}`, async () => {
    const e = setup(platform);
    slow(e.chanA);
    const draft = await e.api.post('/messages/new', {
      name: 'D',
      channelId: A,
      action: 'save',
      spec: spec('d'),
    });
    const rec = (await draft.json()).rec;
    const [x, y] = await Promise.all([update(e, rec, {}), update(e, rec, {})]);
    assert.deepEqual([x.status, y.status].sort(), [200, 409]);
    const loser = x.status === 409 ? x : y;
    assert.match((await loser.json()).error, /Someone else just published/);
    const stored = await getComposed(e.key, rec.id);
    assert.deepEqual(ids(e.chanA), [stored.message_id], 'the losing post was removed again');
  });

  test(`a draft save that runs while a post is moved does not undo the move ${where}`, async () => {
    const e = setup(platform);
    const rec = await publish(e);
    slow(e.chanB);
    const [pub, save] = await Promise.all([
      update(e, rec, { channelId: B }),
      update(e, rec, { channelId: B, action: 'save', spec: spec('draft') }),
    ]);
    assert.equal(pub.status, 200);
    assert.equal(save.status, 200);
    const stored = await getComposed(e.key, rec.id);
    assert.equal(stored.channel_id, B);
    assert.deepEqual(ids(e.chanB), [stored.message_id]);
    assert.deepEqual(ids(e.chanA), []);
  });

  const actions = (e, rec) =>
    saveComponentActions({
      guildId: e.key,
      channelId: A,
      messageId: rec.messageId,
      actions: [{ kind: 'button', customId: 'x', emoji: '✅' }],
    });
  test(`the stored button actions of the old post go with it on Fluxer only ${where}`, async () => {
    const e = setup(platform);
    const rec = await publish(e);
    await actions(e, rec);
    assert.ok(await getComponentAction(rec.messageId, '✅'));
    const res = await update(e, rec, { channelId: B });
    assert.equal(res.status, 200);
    const left = await getComponentAction(rec.messageId, '✅');
    assert.equal(left === null, platform === 'fluxer');
  });
}
