// The Bridge engine (src/modules/bridge.js): the consent flow, and everything a message meets on its way
// across: loops, pings, bots, the age rule, replies, edits and deletes, files, emoji, stickers, embeds,
// polls, join notices, the rate limit and what a failing link does. Platforms and webhooks are fakes
// (helpers/fakeBridge.js); the HTTP routes are in test/v2Bridge.test.js.
import './helpers/tmpDb.js';
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setGuildModule } from '../src/db/modules.js';
import { purgeGuild } from '../src/db/purge.js';
import { listAudit } from '../src/db/audit.js';
import * as store from '../src/db/bridge.js';
import { db } from '../src/db/index.js';
import { config } from '../src/config.js';
import { seal } from '../src/lib/seal.js';
import {
  BridgeError,
  FAIL_THRESHOLD,
  acceptLink,
  assertActorMayUse,
  failLink,
  bridgeIdle,
  bridgeProblems,
  cancelRequest,
  dropBridgeCache,
  handleBulkDelete,
  handleChannelDelete,
  handleDelete,
  handleJoin,
  handleMessage,
  handleUpdate,
  linkView,
  pauseLink,
  requestLink,
  resumeLink,
  setSideOptions,
  unlinkLink,
  useBridgeParts,
} from '../src/modules/bridge.js';
import { createRelayQueue } from '../src/modules/lib/bridgeQueue.js';
import { jumpUrl } from '../src/modules/quoteBoard.js';
import {
  D,
  F,
  ME_D,
  apiError,
  installPlatforms,
  message,
  removePlatforms,
  snowflake,
  useFakes,
} from './helpers/fakeBridge.js';

let p; // the platforms
let fakes; // transport, sleeps, downloads

beforeEach(async () => {
  p = installPlatforms();
  // Links left by the previous test are purged first (that talks to the webhook transport), then the
  // fakes start empty for this test.
  useFakes();
  dropBridgeCache();
  for (const key of [D, F]) await purgeGuild(key);
  fakes = useFakes();
  await setGuildModule(D, 'bridge', { enabled: true });
  await setGuildModule(F, 'bridge', { enabled: true });
});
afterEach(() => {
  useBridgeParts();
  removePlatforms();
});

/** A bridged pair of channels, made through the real request and accept calls. */
async function bridged({ nsfw = false, optionsD, optionsF } = {}) {
  const dCh = p.channel(p.dGuild, { name: 'discord-chat', nsfw });
  const fCh = p.channel(p.fGuild, { name: 'fluxer-chat', nsfw });
  const made = await requestLink({
    guildKey: D,
    channelId: dCh.id,
    options: optionsD,
    actor: 'Alice (dashboard)',
  });
  const link = await acceptLink({
    guildKey: F,
    channelId: fCh.id,
    code: made.code,
    options: optionsF,
    actor: 'Bob (dashboard)',
  });
  return { dCh, fCh, link, code: made.code };
}
const say = (channel) => channel.said.map((s) => s.content);
const fromD = (dCh, over = {}) => message({ channelId: dCh.id, client: p.discord, ...over });
const fromF = (fCh, over = {}) => message({ channelId: fCh.id, client: p.fluxer, ...over });
const relay = async (msg, key) => {
  await handleMessage(msg, {}, key);
  await bridgeIdle();
};
const refuses = async (promise, pattern, status) => {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof BridgeError, `a BridgeError, got ${err}`);
    assert.match(err.message, pattern);
    if (status) assert.equal(err.status, status);
    return true;
  });
};

// --- the consent flow ------------------------------------------------------------------------------------

test('a request gives a one-time code; accepting it in the other server links the two channels', async () => {
  const dCh = p.channel(p.dGuild, { name: 'discord-chat' });
  const fCh = p.channel(p.fGuild, { name: 'fluxer-chat' });
  const made = await requestLink({ guildKey: D, channelId: dCh.id, actor: 'Alice (dashboard)' });
  assert.match(made.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal((await store.pendingCodes(D)).length, 1);
  assert.equal(
    await store.linkForChannel(D, dCh.id),
    null,
    'nothing is linked until the other server accepts'
  );
  assert.equal(fakes.transport.hooks.length, 0, 'and no webhook exists yet');

  const link = await acceptLink({
    guildKey: F,
    channelId: fCh.id,
    code: made.code,
    actor: 'Bob (dashboard)',
  });
  assert.deepEqual(
    [link.guildA, link.channelA, link.guildB, link.channelB, link.status],
    [D, dCh.id, F, fCh.id, 'active']
  );
  assert.deepEqual([link.requestedBy, link.acceptedBy], ['Alice (dashboard)', 'Bob (dashboard)']);
  assert.deepEqual(
    fakes.transport.hooks.map((h) => [h.guildKey, h.channelId]),
    [
      [D, dCh.id],
      [F, fCh.id],
    ],
    'one webhook in each channel'
  );
  assert.ok(link.hookAId && link.hookAToken && link.hookBId && link.hookBToken);
  assert.equal((await store.pendingCodes(D)).length, 0, 'the request is used up');
  await refuses(
    acceptLink({ guildKey: F, channelId: p.channel(p.fGuild, {}).id, code: made.code, actor: 'Eve' }),
    /not valid, has expired or was already used/,
    404
  );

  // both channels show a visible notice, and both servers' audit logs record it
  assert.match(say(dCh)[0], /Bridge on.*#fluxer-chat.*Fluxer Home.*Fluxer.*Nobody is pinged/s);
  assert.match(say(fCh)[0], /Bridge on.*#discord-chat.*Discord Home.*Discord.*Nobody is pinged/s);
  assert.deepEqual(dCh.said[0].allowedMentions, { parse: [] }, 'the notice pings nobody either');
  assert.ok((await listAudit(D)).some((e) => e.action === 'bridge:link'));
  assert.ok((await listAudit(F)).some((e) => e.action === 'bridge:link'));
  assert.ok((await listAudit(D)).some((e) => e.action === 'bridge:request'));
});

test('a server cannot accept its own request, nor link two servers of the same platform', async () => {
  const dCh = p.channel(p.dGuild, {});
  const made = await requestLink({ guildKey: D, channelId: dCh.id, actor: 'Alice' });
  await refuses(
    acceptLink({ guildKey: D, channelId: p.channel(p.dGuild, {}).id, code: made.code, actor: 'Alice' }),
    /made in this server/,
    409
  );
  const { dGuild: d2 } = p.extra('91');
  const d2Key = d2.id;
  await setGuildModule(d2Key, 'bridge', { enabled: true });
  await refuses(
    acceptLink({ guildKey: d2Key, channelId: p.channel(d2, {}).id, code: made.code, actor: 'Eve' }),
    /Discord channel to a Fluxer channel/
  );
  assert.equal((await store.pendingCodes(D)).length, 1, 'neither attempt used the code up');
});

test('a wrong, malformed, expired or cancelled code is refused the same way', async () => {
  const fCh = p.channel(p.fGuild, {});
  const dCh = p.channel(p.dGuild, {});
  const accept = (code) => acceptLink({ guildKey: F, channelId: fCh.id, code, actor: 'Bob' });
  await refuses(accept('ABCD-EFGH-JKMN'), /not valid, has expired or was already used/, 404);
  await refuses(accept('hello'), /not valid, has expired or was already used/, 404);
  await refuses(accept(''), /not valid, has expired or was already used/, 404);
  const expired = await store.createCode({ guildId: D, channelId: dCh.id, ttlMs: -1000 });
  await refuses(accept(expired.code), /not valid, has expired or was already used/, 404);
  const made = await requestLink({ guildKey: D, channelId: dCh.id, actor: 'Alice' });
  const [pending] = await store.pendingCodes(D);
  await cancelRequest({ guildKey: D, id: pending.id, actor: 'Alice' });
  await refuses(accept(made.code), /not valid, has expired or was already used/, 404);
  await refuses(cancelRequest({ guildKey: D, id: pending.id, actor: 'Alice' }), /gone already/, 404);
  assert.equal(fakes.transport.hooks.length, 0, 'no wrong code made a webhook');
});

test("only the requesting server may cancel a request, and no server sees another's", async () => {
  const dCh = p.channel(p.dGuild, {});
  await requestLink({ guildKey: D, channelId: dCh.id, actor: 'Alice' });
  const [pending] = await store.pendingCodes(D);
  await refuses(cancelRequest({ guildKey: F, id: pending.id, actor: 'Eve' }), /gone already/, 404);
  assert.equal((await store.pendingCodes(D)).length, 1);
});

test('both servers need the module on, and Sylo needs the permissions in the channel', async () => {
  const dCh = p.channel(p.dGuild, {});
  const fCh = p.channel(p.fGuild, {});
  await setGuildModule(D, 'bridge', { enabled: false });
  await refuses(
    requestLink({ guildKey: D, channelId: dCh.id, actor: 'A' }),
    /Turn the Bridge module on/,
    409
  );
  await setGuildModule(D, 'bridge', { enabled: true });
  const made = await requestLink({ guildKey: D, channelId: dCh.id, actor: 'A' });

  await setGuildModule(F, 'bridge', { enabled: false });
  await refuses(
    acceptLink({ guildKey: F, channelId: fCh.id, code: made.code, actor: 'B' }),
    /Turn the Bridge module on/,
    409
  );
  await setGuildModule(F, 'bridge', { enabled: true });

  await setGuildModule(D, 'bridge', { enabled: false });
  await refuses(
    acceptLink({ guildKey: F, channelId: fCh.id, code: made.code, actor: 'B' }),
    /turned its Bridge module off/,
    409
  );
  await setGuildModule(D, 'bridge', { enabled: true });

  const locked = p.channel(p.fGuild, { name: 'locked', deny: ['ManageWebhooks'] });
  await refuses(
    acceptLink({ guildKey: F, channelId: locked.id, code: made.code, actor: 'B' }),
    /needs ManageWebhooks in #locked/
  );
  assert.equal(fakes.transport.hooks.length, 0);
  assert.ok(
    await acceptLink({ guildKey: F, channelId: fCh.id, code: made.code, actor: 'B' }),
    'the code still worked'
  );
});

test('only a normal text channel of the same server can be bridged', async () => {
  const fCh = p.channel(p.fGuild, {});
  await refuses(
    requestLink({ guildKey: D, channelId: fCh.id, actor: 'A' }),
    /normal text channel of this server/
  );
  await refuses(
    requestLink({ guildKey: D, channelId: snowflake(), actor: 'A' }),
    /normal text channel of this server/
  );
  const voice = p.channel(p.dGuild, { type: 2 });
  await refuses(
    requestLink({ guildKey: D, channelId: voice.id, actor: 'A' }),
    /normal text channel of this server/
  );
});

test('a channel can be in one link or one request only', async () => {
  const { dCh } = await bridged();
  await refuses(requestLink({ guildKey: D, channelId: dCh.id, actor: 'A' }), /already bridged/, 409);
  const other = p.channel(p.dGuild, {});
  await requestLink({ guildKey: D, channelId: other.id, actor: 'A' });
  await refuses(requestLink({ guildKey: D, channelId: other.id, actor: 'A' }), /request waiting/, 409);
  const fSecond = p.channel(p.fGuild, {});
  const made = await requestLink({ guildKey: D, channelId: p.channel(p.dGuild, {}).id, actor: 'A' });
  const fCh = [...p.fGuild.channels.cache.values()][0];
  await refuses(
    acceptLink({ guildKey: F, channelId: fCh.id, code: made.code, actor: 'B' }),
    /already bridged/,
    409
  );
  assert.ok(await acceptLink({ guildKey: F, channelId: fSecond.id, code: made.code, actor: 'B' }));
});

test('an age-restricted channel only links to an age-restricted one, in both directions', async () => {
  const mk = async (dNsfw, fNsfw) => {
    const dCh = p.channel(p.dGuild, { nsfw: dNsfw });
    const fCh = p.channel(p.fGuild, { nsfw: fNsfw });
    const made = await requestLink({ guildKey: D, channelId: dCh.id, actor: 'A' });
    return () => acceptLink({ guildKey: F, channelId: fCh.id, code: made.code, actor: 'B' });
  };
  await refuses(
    (await mk(true, false))(),
    /age-restricted channel can only be bridged with another age-restricted/
  );
  await refuses(
    (await mk(false, true))(),
    /age-restricted channel can only be bridged with another age-restricted/
  );
  assert.equal(fakes.transport.hooks.length, 0, 'refused before any webhook was made');
  assert.ok(await (await mk(true, true))(), 'two age-restricted channels link');
  assert.ok(await (await mk(false, false))(), 'two ordinary channels link');
});

test('a webhook that cannot be made refuses the link without using the code up', async () => {
  const dCh = p.channel(p.dGuild, {});
  const fCh = p.channel(p.fGuild, {});
  const made = await requestLink({ guildKey: D, channelId: dCh.id, actor: 'A' });
  fakes.transport.hookFailures.push(null, apiError(403));
  await refuses(
    acceptLink({ guildKey: F, channelId: fCh.id, code: made.code, actor: 'B' }),
    /could not make a webhook/,
    502
  );
  assert.equal(fakes.transport.deleted.length, 1, 'the webhook that was made is removed again');
  assert.equal((await store.pendingCodes(D)).length, 1);
  assert.ok(await acceptLink({ guildKey: F, channelId: fCh.id, code: made.code, actor: 'B' }));
});

test('two servers that accept the same code at once: one wins, the other leaves nothing behind', async () => {
  const dCh = p.channel(p.dGuild, {});
  const made = await requestLink({ guildKey: D, channelId: dCh.id, actor: 'A' });
  const f1 = p.channel(p.fGuild, {});
  const f2 = p.channel(p.fGuild, {});
  const results = await Promise.allSettled([
    acceptLink({ guildKey: F, channelId: f1.id, code: made.code, actor: 'B' }),
    acceptLink({ guildKey: F, channelId: f2.id, code: made.code, actor: 'C' }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await store.linksOfGuild(D)).length, 1);
  assert.equal(
    fakes.transport.hooks.length - fakes.transport.deleted.length,
    2,
    'only the winner keeps its two webhooks'
  );
});

// --- relaying a message ----------------------------------------------------------------------------------

test('a message is posted on the other side under the author name and platform, never with a ping', async () => {
  const { dCh, fCh, link } = await bridged();
  await relay(fromD(dCh, { content: 'Hello from Discord' }), D);
  assert.equal(fakes.transport.sends.length, 1);
  const sent = fakes.transport.sends[0];
  assert.equal(sent.guildKey, F, 'sent into the Fluxer server');
  assert.deepEqual(sent.hook, { id: link.hookBId, token: link.hookBToken, channelId: fCh.id });
  assert.equal(sent.payload.content, 'Hello from Discord');
  assert.equal(sent.payload.username, 'Alice [Discord]');

  await relay(fromF(fCh, { content: 'Hello back', member: { displayName: 'Bob' } }), F);
  const back = fakes.transport.sends[1];
  assert.equal(back.guildKey, D);
  assert.equal(back.hook.id, link.hookAId);
  assert.equal(back.payload.username, 'Bob [Fluxer]');
});

test('mentions are shown as names and @everyone and @here cannot ping: users, roles, channels, commands', async () => {
  const { dCh } = await bridged();
  const msg = fromD(dCh, {
    content:
      '@everyone @here <@111111111111111111> <@!111111111111111111> <@&222222222222222222> <#333333333333333333> </ban:444444444444444444> hi',
    mentions: {
      users: new Map([
        ['111111111111111111', { id: '111111111111111111', username: 'bob', displayName: 'Bobby' }],
      ]),
      members: new Map(),
      roles: new Map([['222222222222222222', { id: '222222222222222222', name: 'moderators' }]]),
    },
  });
  p.dGuild.channels.cache.set('333333333333333333', { id: '333333333333333333', name: 'rules' });
  await relay(msg, D);
  const text = fakes.transport.sends[0].payload.content;
  assert.ok(!/<[@#&]/.test(text), `no raw mention tokens left: ${text}`);
  assert.ok(!/@everyone|@here/.test(text), 'a plain @everyone or @here is broken by an invisible character');
  assert.match(text, /@.everyone @.here @.Bobby @.Bobby @.moderators #rules \/ban hi/);
});

test('custom emoji map to the same name on the other side, else become :name:; Unicode crosses as it is', async () => {
  const { dCh } = await bridged();
  p.fGuild.emojis.cache.set('555555555555555555', {
    id: '555555555555555555',
    name: 'Party',
    animated: true,
  });
  await relay(fromD(dCh, { content: 'hi 🎉 <:party:123456789012345678> <:nope:123456789012345679>' }), D);
  assert.equal(fakes.transport.sends[0].payload.content, 'hi 🎉 <a:Party:555555555555555555> :nope:');
});

test('a reply carries a short quote of the original and a link to its copy when it is mapped', async () => {
  const { dCh, fCh } = await bridged();
  const original = fromF(fCh, { content: 'Who wants pizza?', member: { displayName: 'Bob' } });
  await relay(original, F);
  const copyOnD = fakes.transport.sends[0].id;

  const reply = fromD(dCh, {
    content: 'Me!',
    reference: { messageId: copyOnD },
    referencedMessage: { content: 'Who wants pizza?', author: { username: 'Bob [Fluxer]' } },
  });
  await relay(reply, D);
  const content = fakes.transport.sends[1].payload.content;
  const url = jumpUrl(F, fCh.id, original.id);
  assert.equal(content, `> ↪ [**Bob**](<${url}>): Who wants pizza?\nMe!`);

  const unmapped = fromD(dCh, {
    content: 'Hm',
    reference: { messageId: snowflake() },
    referencedMessage: {
      content: 'old message',
      author: { username: 'carol' },
      member: { displayName: 'Carol' },
    },
  });
  await relay(unmapped, D);
  assert.equal(
    fakes.transport.sends[2].payload.content,
    '> ↪ **Carol**: old message\nHm',
    'quoted, with no link'
  );
});

test('a quote of a message with pings is neutralised too', async () => {
  const { dCh, fCh } = await bridged();
  const reply = fromF(fCh, {
    content: 'ok',
    messageReference: { messageId: snowflake() },
    referencedMessage: { content: '@everyone look', author: { username: 'x' } },
  });
  await relay(reply, F);
  assert.match(fakes.transport.sends[0].payload.content, /^> ↪ \*\*x\*\*: @.everyone look\nok$/);
  assert.equal(fakes.transport.sends[0].guildKey, D);
  assert.ok(dCh);
});

// --- loops, bots and what is not chat ------------------------------------------------------------------------

test('what a bridge webhook posted is never relayed again, so a copy cannot come back', async () => {
  const { dCh, fCh, link } = await bridged();
  await relay(fromD(dCh, { content: 'ping' }), D);
  assert.equal(fakes.transport.sends.length, 1);
  // The copy arrives in the Fluxer channel as a message from the webhook Sylo made there.
  const copy = fromF(fCh, {
    content: 'ping',
    webhookId: link.hookBId,
    author: { bot: true, username: 'Alice [Discord]' },
  });
  await relay(copy, F);
  // Even with bots switched on for that side, and even from the OTHER webhook of the link.
  await setSideOptions({ guildKey: F, id: link.id, options: { bots: true }, actor: 'B' });
  await relay(copy, F);
  await relay(fromD(dCh, { content: 'x', webhookId: link.hookAId, author: { bot: true } }), D);
  assert.equal(fakes.transport.sends.length, 1, 'nothing went back');
});

test("Sylo's own messages and messages from any Sylo bridge webhook are not relayed, even with bots on", async () => {
  const { dCh, link } = await bridged({ optionsD: { bots: true } });
  await relay(fromD(dCh, { content: 'welcome!', author: { id: ME_D, bot: true } }), D);
  // another link's webhook posting into this channel
  const otherD = p.channel(p.dGuild, {});
  const otherF = p.channel(p.fGuild, {});
  const made = await requestLink({ guildKey: D, channelId: otherD.id, actor: 'A' });
  const second = await acceptLink({ guildKey: F, channelId: otherF.id, code: made.code, actor: 'B' });
  await relay(fromD(dCh, { content: 'stray', webhookId: second.hookAId, author: { bot: true } }), D);
  assert.equal(fakes.transport.sends.length, 0);
  assert.ok(link);
});

test('bots are off by default and only cross when that side turns them on', async () => {
  const { dCh, link } = await bridged();
  const bot = () => fromD(dCh, { content: 'beep', member: null, author: { bot: true, username: 'RoleBot' } });
  const foreignHook = () =>
    fromD(dCh, {
      content: 'ci done',
      member: null,
      webhookId: snowflake(),
      author: { bot: true, username: 'CI' },
    });
  await relay(bot(), D);
  await relay(foreignHook(), D);
  assert.equal(fakes.transport.sends.length, 0, 'off by default');
  await setSideOptions({ guildKey: D, id: link.id, options: { bots: true }, actor: 'A' });
  await relay(bot(), D);
  await relay(foreignHook(), D);
  assert.equal(fakes.transport.sends.length, 1, 'a bot account crosses; a webhook message never does');
  assert.equal(fakes.transport.sends[0].payload.username, 'RoleBot [Discord]');
});

test("each side's options only change what that side sends", async () => {
  const { dCh, fCh, link } = await bridged({ optionsD: { bots: true } });
  await relay(fromD(dCh, { content: 'a', author: { bot: true } }), D);
  await relay(fromF(fCh, { content: 'b', author: { bot: true } }), F);
  assert.equal(fakes.transport.sends.length, 1, 'the Fluxer side never turned bots on');
  const view = linkView(await store.getLink(link.id), F);
  assert.deepEqual([view.options.bots, view.theirOptions.bots], [false, true]);
});

test('system messages, empty messages and threads are not relayed', async () => {
  const { dCh } = await bridged();
  await relay(fromD(dCh, { content: 'x joined', type: 7, system: true }), D);
  await relay(fromD(dCh, { content: '' }), D);
  await relay(message({ channelId: snowflake(), client: p.discord, content: 'in a thread' }), D);
  assert.equal(fakes.transport.sends.length, 0);
});

test('nothing is relayed while the other server has the module off, or the link is paused', async () => {
  const { dCh, link } = await bridged();
  await setGuildModule(F, 'bridge', { enabled: false });
  await relay(fromD(dCh, { content: 'one' }), D);
  await setGuildModule(F, 'bridge', { enabled: true });
  await pauseLink({ guildKey: F, id: link.id, actor: 'B' });
  await relay(fromD(dCh, { content: 'two' }), D);
  assert.equal(fakes.transport.sends.length, 0);
  await resumeLink({ guildKey: F, id: link.id, actor: 'B' });
  await relay(fromD(dCh, { content: 'three' }), D);
  assert.equal(fakes.transport.sends.length, 1);
});

test('the age rule is checked on every message: a channel that changes pauses the link', async () => {
  const { dCh, link } = await bridged({ nsfw: true });
  await relay(fromD(dCh, { content: 'fine' }), D);
  assert.equal(fakes.transport.sends.length, 1);
  dCh.nsfw = false; // the Discord channel is made ordinary
  await relay(fromD(dCh, { content: 'now what' }), D);
  assert.equal(fakes.transport.sends.length, 1, 'not relayed');
  const row = await store.getLink(link.id);
  assert.deepEqual([row.status, row.failReason], ['failed', 'age-restriction']);
  assert.ok(
    say(dCh).some((s) => /Bridge stopped/.test(s)),
    'and said so in the channel'
  );
});

// --- edits and deletes -------------------------------------------------------------------------------------

test('an edit is mirrored on the copy; an edit that changes nothing visible is not', async () => {
  const { dCh } = await bridged();
  const original = fromD(dCh, { content: 'first' });
  await relay(original, D);
  const copyId = fakes.transport.sends[0].id;

  await handleUpdate(
    { old: original, new: { ...original, content: 'second <@123456789012345678> @everyone' } },
    {},
    D
  );
  await bridgeIdle();
  assert.equal(fakes.transport.edits.length, 1);
  const edit = fakes.transport.edits[0];
  assert.equal(edit.messageId, copyId);
  assert.match(edit.payload.content, /^second @.user @.everyone$/);

  // a link preview appearing fires an update with the same text: nothing to do
  await handleUpdate(
    {
      old: original,
      new: {
        ...original,
        content: 'second <@123456789012345678> @everyone',
        embeds: [{ type: 'link', url: 'https://x' }],
      },
    },
    {},
    D
  );
  await bridgeIdle();
  assert.equal(fakes.transport.edits.length, 1);
});

test('an edit keeps the quote and the file links of the original copy', async () => {
  const { dCh, fCh } = await bridged();
  const original = fromF(fCh, { content: 'pizza?', member: { displayName: 'Bob' } });
  await relay(original, F);
  const reply = fromD(dCh, {
    content: 'yes',
    reference: { messageId: fakes.transport.sends[0].id },
    referencedMessage: { content: 'pizza?', author: { username: 'Bob [Fluxer]' } },
    attachments: new Map([['a', { name: 'big.zip', url: 'https://cdn/big.zip', size: 50 * 1024 * 1024 }]]),
  });
  await relay(reply, D);
  const first = fakes.transport.sends[1].payload.content;
  await handleUpdate({ old: reply, new: { ...reply, content: 'yes please' } }, {}, D);
  await bridgeIdle();
  const edited = fakes.transport.edits[0].payload.content;
  assert.match(first, /^> ↪ .*\nyes\n📎 big.zip: https:\/\/cdn\/big.zip$/s);
  assert.match(edited, /^> ↪ .*\nyes please\n📎 big.zip: https:\/\/cdn\/big.zip$/s);
});

test('only the original is mirrored: an edit of a copy, or of a message that was never relayed, does nothing', async () => {
  const { dCh, fCh } = await bridged();
  await relay(fromD(dCh, { content: 'one' }), D);
  const copyOnF = {
    id: fakes.transport.sends[0].id,
    channelId: fCh.id,
    content: 'tampered',
    client: p.fluxer,
    webhookId: 'x',
  };
  await handleUpdate({ old: copyOnF, new: copyOnF }, {}, F);
  await handleUpdate({ old: null, new: fromD(dCh, { content: 'never relayed' }) }, {}, D);
  await bridgeIdle();
  assert.equal(fakes.transport.edits.length, 0);
});

test('a delete is mirrored through the map, also for a purge of many; deleting a copy leaves the original', async () => {
  const { dCh, fCh } = await bridged();
  const m1 = fromD(dCh, { content: 'one' });
  const m2 = fromD(dCh, { content: 'two' });
  const m3 = fromD(dCh, { content: 'three' });
  for (const m of [m1, m2, m3]) await relay(m, D);
  const [c1, c2, c3] = fakes.transport.sends.map((s) => s.id);

  await handleDelete({ id: m1.id, channelId: dCh.id }, {}, D);
  await bridgeIdle();
  assert.deepEqual(
    fakes.transport.removes.map((r) => r.messageId),
    [c1]
  );
  assert.equal(fakes.transport.removes[0].guildKey, F);
  assert.equal(
    await store.mappingOf((await store.linksOfGuild(D))[0].id, 'a', m1.id),
    null,
    'the map row is gone'
  );

  await handleBulkDelete(
    {
      messages: new Map([
        [m2.id, {}],
        [m3.id, {}],
      ]),
      channel: dCh,
    },
    {},
    D
  );
  await bridgeIdle();
  assert.deepEqual(
    fakes.transport.removes.map((r) => r.messageId),
    [c1, c2, c3]
  );

  // someone deletes a copy on the Fluxer side: the original on Discord stays
  const m4 = fromD(dCh, { content: 'four' });
  await relay(m4, D);
  await handleDelete({ id: fakes.transport.sends[3].id, channelId: fCh.id }, {}, F);
  await bridgeIdle();
  assert.equal(fakes.transport.removes.length, 3, 'nothing else was deleted');
  await handleDelete({ id: snowflake(), channelId: dCh.id }, {}, D);
  assert.equal(fakes.transport.removes.length, 3, 'an unknown message is ignored');
});

test('a message older than the map (30 days) is no longer followed', async () => {
  const { dCh, link } = await bridged();
  const m = fromD(dCh, { content: 'old' });
  await relay(m, D);
  await store.sweepMappings(Date.now() + 31 * 86_400_000);
  assert.equal(await store.mappingOf(link.id, 'a', m.id), null);
  await handleDelete({ id: m.id, channelId: dCh.id }, {}, D);
  await handleUpdate({ old: m, new: { ...m, content: 'edited' } }, {}, D);
  await bridgeIdle();
  assert.equal(fakes.transport.removes.length + fakes.transport.edits.length, 0);
});

// --- files, stickers, embeds, polls, joins -----------------------------------------------------------------

test('a small file is re-uploaded, a big one or one that cannot be fetched becomes a link', async () => {
  const MB = 1024 * 1024;
  fakes = useFakes({ files: { 'https://cdn/cat.png': 'PNGDATA' } });
  const { dCh } = await bridged();
  const att = (name, size, url = `https://cdn/${name}`) => [name, { name, url, size }];
  await relay(
    fromD(dCh, {
      content: 'files',
      attachments: new Map([att('cat.png', 7), att('movie.mp4', 20 * MB), att('gone.png', 100)]),
    }),
    D
  );
  const { payload } = fakes.transport.sends[0];
  assert.deepEqual(
    payload.files.map((f) => [f.name, f.data.toString()]),
    [['cat.png', 'PNGDATA']]
  );
  assert.equal(
    payload.content,
    'files\n📎 movie.mp4: https://cdn/movie.mp4\n📎 gone.png: https://cdn/gone.png'
  );
  assert.deepEqual(
    fakes.downloads.map((d) => d.url),
    ['https://cdn/cat.png', 'https://cdn/gone.png'],
    'the big one was never fetched'
  );
});

test('a server can send every file as a link instead of copying it', async () => {
  fakes = useFakes({ files: { 'https://cdn/cat.png': 'PNGDATA' } });
  const { dCh } = await bridged({ optionsD: { uploadFiles: false } });
  await relay(
    fromD(dCh, {
      content: '',
      attachments: new Map([['a', { name: 'cat.png', url: 'https://cdn/cat.png', size: 7 }]]),
    }),
    D
  );
  assert.equal(fakes.downloads.length, 0);
  assert.equal(fakes.transport.sends[0].payload.files, undefined);
  assert.equal(fakes.transport.sends[0].payload.content, '📎 cat.png: https://cdn/cat.png');
});

test('stickers become a picture link, a poll becomes readable text, and link previews are left out', async () => {
  const { dCh } = await bridged({ optionsD: { bots: true } });
  await relay(
    fromD(dCh, {
      content: 'look',
      stickers: new Map([['s', { name: 'wave', url: 'https://cdn/stickers/1.png' }]]),
      poll: {
        question: { text: 'Pizza or pasta?' },
        answers: new Map([
          [1, { text: 'Pizza', emoji: { name: '🍕' } }],
          [2, { text: 'Pasta' }],
        ]),
      },
      embeds: [{ type: 'link', url: 'https://example.com', title: 'A preview' }],
    }),
    D
  );
  const { content, embeds } = fakes.transport.sends[0].payload;
  assert.equal(
    content,
    'look\n*sticker: wave* https://cdn/stickers/1.png\n📊 **Poll:** Pizza or pasta?\n• 🍕 Pizza\n• Pasta\n*Vote on the original server: polls do not cross the bridge.*'
  );
  assert.equal(embeds, undefined, 'a link preview is the other platform’s own job');
});

test('a rich embed from a bot crosses with its text made harmless', async () => {
  const { dCh } = await bridged({ optionsD: { bots: true } });
  await relay(
    fromD(dCh, {
      content: '',
      author: { bot: true, username: 'Deploy' },
      embeds: [
        {
          type: 'rich',
          title: 'Build done @everyone',
          description: 'by <@123456789012345678>',
          color: 0x00ff00,
          fields: [{ name: 'Env', value: 'prod', inline: true }],
          footer: { text: 'at <t:1700000000:f>' },
        },
      ],
    }),
    D
  );
  const [embed] = fakes.transport.sends[0].payload.embeds;
  assert.match(embed.title, /^Build done @.everyone$/);
  assert.match(embed.description, /^by @.user$/);
  assert.equal(embed.color, 0x00ff00);
  assert.deepEqual(embed.fields, [{ name: 'Env', value: 'prod', inline: true }]);
  assert.match(embed.footer.text, /^at 14 Nov 2023, 22:13 UTC$/);
});

test('join notices are off until a server turns them on, and go to the other side only', async () => {
  const { dCh, fCh, link } = await bridged();
  const member = { displayName: 'Zed', user: { bot: false } };
  await handleJoin(member, {}, D);
  await bridgeIdle();
  assert.equal(fakes.transport.sends.length, 0);
  await setSideOptions({ guildKey: D, id: link.id, options: { joinMessages: true }, actor: 'A' });
  await handleJoin(member, {}, D);
  await handleJoin({ displayName: 'AutoBot', user: { bot: true } }, {}, D);
  await handleJoin(member, {}, F);
  await bridgeIdle();
  assert.equal(
    fakes.transport.sends.length,
    1,
    'the Fluxer side never turned it on, and bots need their option'
  );
  const sent = fakes.transport.sends[0];
  assert.equal(sent.guildKey, F);
  assert.equal(sent.payload.content, '👋 **Zed** joined **Discord Home**');
  assert.equal(sent.payload.username, 'Discord Home [Discord]');
  assert.ok(dCh && fCh);
});

// --- the rate limit, back-off and failing links --------------------------------------------------------------

test('a rate limit is waited out and the message still arrives, in order', async () => {
  const { dCh } = await bridged();
  fakes.transport.sendFailures.push(apiError(429, { retryAfter: 1.5 }));
  await handleMessage(fromD(dCh, { content: 'first' }), {}, D);
  await handleMessage(fromD(dCh, { content: 'second' }), {}, D);
  await bridgeIdle();
  assert.deepEqual(
    fakes.transport.sends.map((s) => s.payload.content),
    ['first', 'second']
  );
  assert.deepEqual(fakes.sleeps, [1500], 'it waited exactly what the platform asked');
  assert.equal(fakes.transport.attempts, 3);
});

test('a short outage backs off and recovers, and the failure count starts over', async () => {
  const { dCh, link } = await bridged();
  fakes.transport.sendFailures.push(apiError(500), apiError(502));
  await relay(fromD(dCh, { content: 'try' }), D);
  assert.equal(fakes.transport.sends.length, 1);
  assert.deepEqual(fakes.sleeps, [1000, 2000], 'a growing pause');
  assert.equal((await store.getLink(link.id)).status, 'active');
});

test(`a link whose deliveries fail ${FAIL_THRESHOLD} times in a row is stopped, announced and not retried`, async () => {
  const { dCh, fCh, link } = await bridged();
  for (let i = 0; i < 4 * FAIL_THRESHOLD; i += 1) fakes.transport.sendFailures.push(apiError(500));
  for (let i = 0; i < FAIL_THRESHOLD; i += 1) await relay(fromD(dCh, { content: `m${i}` }), D);
  const row = await store.getLink(link.id);
  assert.deepEqual([row.status, row.failReason], ['failed', 'unreachable']);
  assert.ok(
    say(dCh).some((s) => /Bridge stopped/.test(s)) && say(fCh).some((s) => /Bridge stopped/.test(s)),
    'both channels say so'
  );
  const before = fakes.transport.attempts;
  await relay(fromD(dCh, { content: 'later' }), D);
  assert.equal(fakes.transport.attempts, before, 'a stopped link is not tried again');
  assert.ok((await listAudit(D)).some((e) => e.action === 'bridge:stopped'));
  assert.deepEqual(
    (await bridgeProblems(D)).map((x) => [x.linkId, x.channelId, x.code]),
    [[link.id, dCh.id, 'unreachable']],
    'and it is listed for the Health page'
  );
  assert.equal(linkView(row, D).problem.code, 'unreachable');
});

test('a success between failures starts the count again, so a flaky link keeps running', async () => {
  const { dCh, link } = await bridged();
  for (let round = 0; round < 3; round += 1) {
    for (let i = 0; i < 4 * (FAIL_THRESHOLD - 1); i += 1) fakes.transport.sendFailures.push(apiError(500));
    for (let i = 0; i < FAIL_THRESHOLD - 1; i += 1) await relay(fromD(dCh, { content: 'x' }), D);
    await relay(fromD(dCh, { content: 'ok' }), D);
  }
  assert.equal((await store.getLink(link.id)).status, 'active', 'never five in a row');
  assert.equal(fakes.transport.sends.filter((s) => s.payload.content === 'ok').length, 3);
});

test('a refused webhook (permissions) stops the link at once', async () => {
  const { dCh, link } = await bridged();
  fakes.transport.sendFailures.push(apiError(403));
  await relay(fromD(dCh, { content: 'x' }), D);
  const row = await store.getLink(link.id);
  assert.deepEqual([row.status, row.failReason], ['failed', 'permissions']);
});

test('a deleted webhook is made again, once, and the message still arrives', async () => {
  const { dCh, link } = await bridged();
  fakes.transport.sendFailures.push(apiError(404, { code: 10015 }));
  await relay(fromD(dCh, { content: 'after the webhook was deleted' }), D);
  assert.equal(fakes.transport.sends.length, 1);
  const row = await store.getLink(link.id);
  assert.equal(row.status, 'active');
  assert.notEqual(row.hookBId, link.hookBId, 'a new webhook for the Fluxer channel');
  assert.equal(fakes.transport.sends[0].hook.id, row.hookBId);
  assert.equal(fakes.transport.hooks.length, 3);
  assert.deepEqual(
    fakes.transport.deleted.map((d) => d.hook.id),
    [link.hookBId],
    'the old one is cleaned up'
  );
});

test('a webhook that cannot be made again stops the link', async () => {
  const { dCh, link } = await bridged();
  fakes.transport.sendFailures.push(apiError(404, { code: 10015 }));
  fakes.transport.hookFailures.push(apiError(403));
  await relay(fromD(dCh, { content: 'x' }), D);
  const row = await store.getLink(link.id);
  assert.equal(row.status, 'failed');
  assert.equal(fakes.transport.sends.length, 0);
});

test('one flooded channel drops its newest messages instead of growing; other links are unaffected', async () => {
  const gate = {};
  gate.open = new Promise((resolve) => {
    gate.release = resolve;
  });
  fakes = useFakes({ queue: createRelayQueue({ minGapMs: 0, maxQueued: 2, sleep: async () => {} }) });
  const realSend = fakes.transport.send;
  let sendCalls = 0;
  fakes.transport.send = async (...args) => {
    sendCalls += 1;
    await gate.open;
    return realSend(...args);
  };
  const { dCh, link } = await bridged();
  const other = p.extra('92');
  await setGuildModule(other.dGuild.id, 'bridge', { enabled: true });
  await setGuildModule(`fluxer:${other.fGuild.id}`, 'bridge', { enabled: true });
  const dCh2 = p.channel(other.dGuild, {});
  const fCh2 = p.channel(other.fGuild, {});
  const made = await requestLink({ guildKey: other.dGuild.id, channelId: dCh2.id, actor: 'A' });
  await acceptLink({
    guildKey: `fluxer:${other.fGuild.id}`,
    channelId: fCh2.id,
    code: made.code,
    actor: 'B',
  });

  for (let i = 0; i < 6; i += 1) await handleMessage(fromD(dCh, { content: `flood ${i}` }), {}, D);
  await handleMessage(fromD(dCh2, { content: 'quiet server' }), {}, other.dGuild.id);
  const view = linkView(await store.getLink(link.id), D);
  assert.equal(view.queued, 2, 'two wait');
  assert.equal(view.dropped, 4, 'four were dropped');
  gate.release();
  await bridgeIdle();
  const contents = fakes.transport.sends.map((s) => s.payload.content);
  assert.deepEqual(
    contents.filter((c) => c.startsWith('flood')),
    ['flood 0', 'flood 1']
  );
  assert.ok(contents.includes('quiet server'), 'the other server was not held up by the flood');
  assert.ok(sendCalls >= 3);
});

test('a failing link does not touch the links of other servers', async () => {
  const one = await bridged();
  const other = p.extra('93');
  const otherF = `fluxer:${other.fGuild.id}`;
  await setGuildModule(other.dGuild.id, 'bridge', { enabled: true });
  await setGuildModule(otherF, 'bridge', { enabled: true });
  const dCh2 = p.channel(other.dGuild, {});
  const fCh2 = p.channel(other.fGuild, {});
  const made = await requestLink({ guildKey: other.dGuild.id, channelId: dCh2.id, actor: 'A' });
  const second = await acceptLink({ guildKey: otherF, channelId: fCh2.id, code: made.code, actor: 'B' });

  fakes.transport.sendFailures.push(apiError(403));
  await relay(fromD(one.dCh, { content: 'breaks the first link' }), D);
  assert.equal((await store.getLink(one.link.id)).status, 'failed');
  assert.equal((await store.getLink(second.id)).status, 'active');
  await relay(fromD(dCh2, { content: 'still fine' }), other.dGuild.id);
  assert.equal(fakes.transport.sends.at(-1).payload.content, 'still fine');
  assert.ok(!say(dCh2).some((s) => /Bridge stopped/.test(s)), 'the other server was not told anything');
});

test('a deleted bridged channel stops its link', async () => {
  const { dCh, link } = await bridged();
  await handleChannelDelete(dCh, {}, D);
  const row = await store.getLink(link.id);
  assert.deepEqual([row.status, row.failReason], ['failed', 'channel-deleted']);
});

// --- pause, resume, unlink, leaving -----------------------------------------------------------------------------

test('a server that paused a link is the only one that can resume it; a stopped link can be resumed by either', async () => {
  const { dCh, fCh, link } = await bridged();
  await pauseLink({ guildKey: D, id: link.id, actor: 'A' });
  assert.ok(
    say(fCh).some((s) => /Bridge paused.*Discord Home/s.test(s)),
    'the other side is told who paused it'
  );
  await refuses(resumeLink({ guildKey: F, id: link.id, actor: 'B' }), /only they can resume/, 403);
  await refuses(pauseLink({ guildKey: D, id: link.id, actor: 'A' }), /not running/, 409);
  const view = linkView(await store.getLink(link.id), F);
  assert.deepEqual([view.status, view.pausedByMe, view.pausedByThem], ['paused', false, true]);
  await resumeLink({ guildKey: D, id: link.id, actor: 'A' });
  assert.equal((await store.getLink(link.id)).status, 'active');
  assert.match(say(dCh).at(-1), /Bridge on/);

  await store.setLinkStatus(link.id, { status: 'failed', reason: 'permissions' });
  dropBridgeCache();
  await resumeLink({ guildKey: F, id: link.id, actor: 'B' });
  assert.equal((await store.getLink(link.id)).status, 'active');
  await refuses(resumeLink({ guildKey: F, id: link.id, actor: 'B' }), /already running/, 409);
  assert.ok(fCh);
});

test('a stopped link is only resumed when its channels can be bridged again', async () => {
  const { dCh, fCh, link } = await bridged();
  await store.setLinkStatus(link.id, { status: 'failed', reason: 'permissions' });
  dCh.permissionsFor = () => ({ has: (perm) => perm !== 'ManageWebhooks' });
  await refuses(resumeLink({ guildKey: D, id: link.id, actor: 'A' }), /needs ManageWebhooks/);
  dCh.permissionsFor = () => ({ has: () => true });
  fCh.nsfw = true;
  await refuses(resumeLink({ guildKey: D, id: link.id, actor: 'A' }), /age-restricted/);
  fCh.nsfw = false;
  await resumeLink({ guildKey: D, id: link.id, actor: 'A' });
  assert.equal((await store.getLink(link.id)).status, 'active');
});

test('either side can unlink: both webhooks go, the rows go, both channels are told', async () => {
  const { dCh, fCh, link } = await bridged();
  const m = fromD(dCh, { content: 'hi' });
  await relay(m, D);
  await unlinkLink({ guildKey: F, id: link.id, actor: 'B' });
  assert.equal(await store.getLink(link.id), null);
  assert.equal(await store.linkForChannel(D, dCh.id), null);
  assert.deepEqual(fakes.transport.deleted.map((d) => d.hook.id).sort(), [link.hookAId, link.hookBId].sort());
  assert.match(say(dCh).at(-1), /Bridge ended.*Fluxer Home/s);
  assert.match(say(fCh).at(-1), /Bridge ended/);
  assert.equal(await store.mappingCount(link.id), 0, 'the message map of the link went with it');
  assert.ok((await listAudit(D)).some((e) => e.action === 'bridge:unlink'));
  assert.ok((await listAudit(F)).some((e) => e.action === 'bridge:unlink'));
  await relay(fromD(dCh, { content: 'after' }), D);
  assert.equal(fakes.transport.sends.length, 1, 'nothing crosses any more');
  // the channels can be bridged again
  const again = await requestLink({ guildKey: D, channelId: dCh.id, actor: 'A' });
  assert.ok(await acceptLink({ guildKey: F, channelId: fCh.id, code: again.code, actor: 'B' }));
});

test('a server never sees or changes a link it is not in', async () => {
  const { link } = await bridged();
  const { dGuild: stranger } = p.extra('94');
  for (const act of [
    () => pauseLink({ guildKey: stranger.id, id: link.id, actor: 'X' }),
    () => resumeLink({ guildKey: stranger.id, id: link.id, actor: 'X' }),
    () => unlinkLink({ guildKey: stranger.id, id: link.id, actor: 'X' }),
    () => setSideOptions({ guildKey: stranger.id, id: link.id, options: { bots: true }, actor: 'X' }),
  ]) {
    await refuses(act(), /No such bridged channel/, 404);
  }
  assert.equal((await store.getLink(link.id)).status, 'active');
  assert.deepEqual((await store.getLink(link.id)).optionsA, {
    bots: false,
    joinMessages: false,
    uploadFiles: true,
  });
});

test('when Sylo is removed from a server, the server on the other end loses its webhook and is told', async () => {
  const { dCh, fCh, link } = await bridged();
  await relay(fromD(dCh, { content: 'hi' }), D);
  await purgeGuild(F);
  assert.equal(await store.getLink(link.id), null);
  assert.deepEqual(
    fakes.transport.deleted.map((d) => [d.guildKey, d.hook.id]).sort(),
    [
      [D, link.hookAId],
      [F, link.hookBId],
    ].sort(),
    "the other side's webhook, and the leaving server's own"
  );
  assert.match(say(dCh).at(-1), /the other server removed Sylo/);
  assert.ok((await listAudit(D)).some((e) => e.action === 'bridge:unlink'));
  assert.ok(fCh);
});

test('the dashboard view never carries a webhook token', async () => {
  const { link } = await bridged();
  const text = JSON.stringify(linkView(await store.getLink(link.id), D));
  assert.ok(!text.includes(link.hookAToken) && !text.includes(link.hookBToken));
  assert.ok(!/hook/i.test(text));
});

test('a bulk delete finds the channel from the messages when the platform did not cache it (Fluxer)', async () => {
  const { dCh, fCh } = await bridged();
  const m = fromF(fCh, { content: 'gone soon' });
  await relay(m, F);
  await handleBulkDelete(
    { messages: new Map([[m.id, { id: m.id, channelId: fCh.id }]]), channel: null },
    {},
    F
  );
  await bridgeIdle();
  assert.deepEqual(
    fakes.transport.removes.map((r) => r.guildKey),
    [D]
  );
  assert.ok(dCh);
});

// --- round 2: age restriction on Fluxer, the person linking, deletes, loops, sealed tokens, budgets ---------

const waitFor = () => {
  const gate = {};
  gate.open = new Promise((resolve) => {
    gate.release = resolve;
  });
  return gate;
};

test('Fluxer age restriction counts the category, the server and what cannot be read, not only the own flag', async () => {
  const dCh = p.channel(p.dGuild, { name: 'ordinary-discord' });
  const made = await requestLink({ guildKey: D, channelId: dCh.id, actor: 'A' });
  const accept = (channel) => () =>
    acceptLink({ guildKey: F, channelId: channel.id, code: made.code, actor: 'B' });
  const tooStrict = /age-restricted channel can only be bridged with another age-restricted/;

  const category = p.channel(p.fGuild, { type: 4, nsfwOverride: true });
  const inheriting = p.channel(p.fGuild, { parentId: category.id }); // nsfw false, nsfwOverride null: inherits
  await refuses(accept(inheriting)(), tooStrict);

  p.fGuild.nsfw = true; // the whole Fluxer server is age-restricted
  const inServer = p.channel(p.fGuild, {});
  await refuses(accept(inServer)(), tooStrict);
  p.fGuild.nsfw = false;

  const unreadable = p.channel(p.fGuild, {});
  unreadable.nsfwOverride = undefined; // the field is missing: cannot tell, so restricted
  await refuses(accept(unreadable)(), tooStrict);
  const orphan = p.channel(p.fGuild, { parentId: snowflake() }); // its category is unknown
  await refuses(accept(orphan)(), tooStrict);
  assert.equal(fakes.transport.hooks.length, 0, 'refused before any webhook was made');

  const plain = p.channel(p.fGuild, {});
  assert.ok(await accept(plain)(), 'a channel that is clearly ordinary links');
});

test('an age-restricted Fluxer category is refused for an ordinary Discord channel, and the same the other way round', async () => {
  const category = p.channel(p.fGuild, { type: 4, nsfwOverride: true });
  const fCh = p.channel(p.fGuild, { parentId: category.id });
  const dNsfw = p.channel(p.dGuild, { nsfw: true });
  const dPlain = p.channel(p.dGuild, {});
  const made = await requestLink({ guildKey: D, channelId: dPlain.id, actor: 'A' });
  await refuses(
    acceptLink({ guildKey: F, channelId: fCh.id, code: made.code, actor: 'B' }),
    /age-restricted/
  );
  const made2 = await requestLink({ guildKey: D, channelId: dNsfw.id, actor: 'A' });
  assert.ok(
    await acceptLink({ guildKey: F, channelId: fCh.id, code: made2.code, actor: 'B' }),
    'restricted with restricted'
  );
});

test('a Discord server that is itself age-restricted counts for all its channels', async () => {
  p.dGuild.nsfwLevel = 3;
  const dCh = p.channel(p.dGuild, {});
  const fCh = p.channel(p.fGuild, {});
  const made = await requestLink({ guildKey: D, channelId: dCh.id, actor: 'A' });
  await refuses(
    acceptLink({ guildKey: F, channelId: fCh.id, code: made.code, actor: 'B' }),
    /age-restricted/
  );
});

test('a category that turns age-restricted later stops the link on the next message, and resume re-checks', async () => {
  const category = p.channel(p.fGuild, { type: 4, nsfwOverride: false });
  const dCh = p.channel(p.dGuild, {});
  const fCh = p.channel(p.fGuild, { parentId: category.id });
  const made = await requestLink({ guildKey: D, channelId: dCh.id, actor: 'A' });
  const link = await acceptLink({ guildKey: F, channelId: fCh.id, code: made.code, actor: 'B' });
  await relay(fromD(dCh, { content: 'fine' }), D);
  assert.equal(fakes.transport.sends.length, 1);

  category.nsfwOverride = true;
  await relay(fromD(dCh, { content: 'now what' }), D);
  await relay(fromF(fCh, { content: 'and back' }), F);
  assert.equal(fakes.transport.sends.length, 1, 'nothing crossed after the change');
  const row = await store.getLink(link.id);
  assert.deepEqual([row.status, row.failReason], ['failed', 'age-restriction']);
  await refuses(resumeLink({ guildKey: D, id: link.id, actor: 'A' }), /age-restricted/);
  category.nsfwOverride = false;
  await resumeLink({ guildKey: D, id: link.id, actor: 'A' });
  assert.equal((await store.getLink(link.id)).status, 'active');
});

test('the person linking must be able to view, read and send in the channel; open mode needs no check', async () => {
  const hidden = p.channel(p.dGuild, { name: 'staff' });
  const lacking = (denied) => ({ id: 'someone', denied });
  hidden.permissionsFor = (member) => ({ has: (perm) => !(member?.denied ?? []).includes(perm) });
  assert.doesNotThrow(() => assertActorMayUse(D, hidden.id, lacking([])));
  for (const perm of ['ViewChannel', 'ReadMessageHistory', 'SendMessages']) {
    assert.throws(
      () => assertActorMayUse(D, hidden.id, lacking([perm])),
      (e) => e instanceof BridgeError && e.status === 403 && /#staff/.test(e.message),
      perm
    );
  }
  assert.throws(() => assertActorMayUse(D, hidden.id, null), BridgeError, 'no member found: refused');
  assert.throws(() => assertActorMayUse(D, snowflake(), lacking([])), BridgeError, 'no such channel');
  assert.doesNotThrow(
    () => assertActorMayUse(D, hidden.id, null, { open: true }),
    'open mode: everyone is the admin'
  );
});

test("Sylo's own rights that cannot be read count as missing", async () => {
  const dCh = p.channel(p.dGuild, {});
  dCh.permissionsFor = undefined;
  await refuses(
    requestLink({ guildKey: D, channelId: dCh.id, actor: 'A' }),
    /Sylo needs ViewChannel, SendMessages, ManageWebhooks/
  );
  dCh.permissionsFor = () => null;
  await refuses(requestLink({ guildKey: D, channelId: dCh.id, actor: 'A' }), /Sylo needs/);
});

// deletes

/** A webhook send that waits at a gate, so a delete or an edit can arrive while the relay is in progress. */
function slowDownloads(gate) {
  useBridgeParts({
    transport: fakes.transport,
    queue: fakes.queue,
    download: async () => {
      await gate.open;
      return { ok: true, status: 200, body: Buffer.from('FILE') };
    },
  });
}
const withFile = (over = {}) => ({
  attachments: new Map([['a', { name: 'cat.png', url: 'https://cdn/cat.png', size: 4 }]]),
  ...over,
});

test('a delete that comes while the copy is still being made leaves no copy behind', async () => {
  const { dCh } = await bridged();
  const gate = waitFor();
  slowDownloads(gate);
  const m = fromD(dCh, withFile({ content: 'about to be removed by automod' }));
  await handleMessage(m, {}, D); // the relay is queued and waits for the download
  await handleDelete({ id: m.id, channelId: dCh.id }, {}, D);
  gate.release();
  await bridgeIdle();
  const standing =
    fakes.transport.sends.length - fakes.transport.removes.length - fakes.transport.botDeletes.length;
  assert.equal(standing, 0, 'no copy of the deleted message is left on the other side');
});

test('a delete that comes before the relay has even started stops the relay', async () => {
  const { dCh } = await bridged();
  const m = fromD(dCh, { content: 'gone first' });
  await handleDelete({ id: m.id, channelId: dCh.id }, {}, D);
  await relay(m, D);
  assert.equal(fakes.transport.sends.length, 0);
});

test('a copy posted while its original is deleted is taken down again', async () => {
  const { dCh } = await bridged();
  const gate = waitFor();
  const realSend = fakes.transport.send;
  fakes.transport.send = async (...args) => {
    await gate.open; // the delete lands while the send is in flight
    return realSend(...args);
  };
  const m = fromD(dCh, { content: 'raced' });
  await handleMessage(m, {}, D);
  await new Promise((r) => setImmediate(r));
  await handleDelete({ id: m.id, channelId: dCh.id }, {}, D);
  gate.release();
  await bridgeIdle();
  assert.equal(fakes.transport.sends.length, 1);
  assert.equal(fakes.transport.removes.length, 1, 'removed as soon as it was posted');
  assert.equal(fakes.transport.removes[0].messageId, fakes.transport.sends[0].id);
});

test('a delete reaches the copy while the link is paused or stopped', async () => {
  const { dCh, link } = await bridged();
  const one = fromD(dCh, { content: 'one' });
  const two = fromD(dCh, { content: 'two' });
  await relay(one, D);
  await relay(two, D);
  await pauseLink({ guildKey: D, id: link.id, actor: 'A' });
  await handleDelete({ id: one.id, channelId: dCh.id }, {}, D);
  await bridgeIdle();
  assert.deepEqual(
    fakes.transport.removes.map((r) => r.messageId),
    [fakes.transport.sends[0].id],
    'paused'
  );
  await resumeLink({ guildKey: D, id: link.id, actor: 'A' });
  await failLink(link.id, 'permissions');
  await handleDelete({ id: two.id, channelId: dCh.id }, {}, D);
  await bridgeIdle();
  assert.equal(fakes.transport.removes.length, 2, 'stopped');
  assert.equal(await store.mappingOf(link.id, 'a', two.id), null);
});

test('the webhook that really posted a copy is the one remembered, so a delete after a recreation works', async () => {
  const { dCh, link } = await bridged();
  fakes.transport.sendFailures.push(apiError(404, { code: 10015 })); // the webhook was deleted: remade
  const m = fromD(dCh, { content: 'posted by the new webhook' });
  await relay(m, D);
  const row = await store.getLink(link.id);
  assert.notEqual(row.hookBId, link.hookBId);
  assert.equal(
    (await store.mappingOf(link.id, 'a', m.id)).copyHookId,
    row.hookBId,
    'the id of the webhook that sent it'
  );
  await handleDelete({ id: m.id, channelId: dCh.id }, {}, D);
  await bridgeIdle();
  assert.equal(fakes.transport.removes.length, 1);
  assert.equal(fakes.transport.botDeletes.length, 0, 'the webhook did it');
});

test('when the webhook cannot delete a copy (it was replaced, or is gone) the bot does', async () => {
  const { dCh, fCh, link } = await bridged();
  const m1 = fromD(dCh, { content: 'one' });
  const m2 = fromD(dCh, { content: 'two' });
  const m3 = fromD(dCh, { content: 'three' });
  for (const m of [m1, m2, m3]) await relay(m, D);
  const copies = fakes.transport.sends.map((s) => s.id);
  // m1: its copy was posted by a webhook that has since been replaced
  db.prepare('UPDATE bridge_messages SET copy_hook_id = ? WHERE a_message_id = ?').run(
    'an-older-webhook',
    m1.id
  );
  // m2: the webhook is gone when the delete is tried
  fakes.transport.removeFailures.push(apiError(404, { code: 10015 }));
  await handleDelete({ id: m1.id, channelId: dCh.id }, {}, D);
  await handleDelete({ id: m2.id, channelId: dCh.id }, {}, D);
  await bridgeIdle();
  assert.deepEqual(
    fakes.transport.botDeletes.map((d) => [d.guildKey, d.channelId, d.messageId]),
    [
      [F, fCh.id, copies[0]],
      [F, fCh.id, copies[1]],
    ]
  );
  // m3: nothing can delete it (no Manage Messages): the failure is quiet and the link keeps running
  fakes.transport.removeFailures.push(apiError(404, { code: 10015 }));
  fakes.transport.botDeleteFailures.push(apiError(403));
  await handleDelete({ id: m3.id, channelId: dCh.id }, {}, D);
  await bridgeIdle();
  assert.equal((await store.getLink(link.id)).status, 'active', 'a delete that fails never stops the link');
});

test('a purge of 100 messages on a busy lane removes every copy; deletes are not dropped for a full lane', async () => {
  const gate = waitFor();
  fakes = useFakes({ queue: createRelayQueue({ minGapMs: 0, maxQueued: 2, sleep: async () => {} }) });
  const realSend = fakes.transport.send;
  fakes.transport.send = async (...args) => {
    await gate.open;
    return realSend(...args);
  };
  const { dCh, link } = await bridged();
  const ids = Array.from({ length: 100 }, (_, i) => `9000000000000${String(1000 + i)}`);
  for (const [i, id] of ids.entries())
    await store.saveMapping(link.id, 'a', { sourceId: id, copyId: `c${i}`, hookId: link.hookBId });
  for (let i = 0; i < 4; i += 1) await handleMessage(fromD(dCh, { content: `busy ${i}` }), {}, D); // the lane is full (cap 2)
  await handleBulkDelete({ messages: new Map(ids.map((id) => [id, { id }])), channel: dCh }, {}, D);
  gate.release();
  await bridgeIdle();
  assert.equal(fakes.transport.removes.length, 100);
  assert.equal(
    await store.mappingCount(link.id),
    2,
    'only the two busy messages that fit are left in the map'
  );
});

test('a delete is not dropped for waiting too long', async () => {
  let clock = 1_000_000;
  fakes = useFakes({
    queue: createRelayQueue({
      minGapMs: 0,
      maxAgeMs: 1000,
      now: () => clock,
      sleep: async () => {
        clock += 5000;
      },
    }),
  });
  const gate = waitFor();
  const realSend = fakes.transport.send;
  fakes.transport.send = async (...args) => {
    await gate.open;
    return realSend(...args);
  };
  const { dCh, link } = await bridged();
  await store.saveMapping(link.id, 'a', {
    sourceId: '900000000000009001',
    copyId: 'old-copy',
    hookId: link.hookBId,
  });
  await handleMessage(fromD(dCh, { content: 'blocker' }), {}, D);
  await handleDelete({ id: '900000000000009001', channelId: dCh.id }, {}, D);
  clock += 60_000; // far past the age at which an ordinary job is dropped
  gate.release();
  await bridgeIdle();
  assert.deepEqual(
    fakes.transport.removes.map((r) => r.messageId),
    ['old-copy']
  );
});

test('an edit that comes while the copy is still being made reaches it', async () => {
  const { dCh } = await bridged();
  const gate = waitFor();
  slowDownloads(gate);
  const m = fromD(dCh, withFile({ content: 'first' }));
  await handleMessage(m, {}, D);
  await handleUpdate({ old: m, new: { ...m, content: 'second' } }, {}, D);
  gate.release();
  await bridgeIdle();
  assert.equal(fakes.transport.sends.length, 1);
  assert.equal(fakes.transport.edits.length, 1);
  assert.equal(fakes.transport.edits[0].payload.content, 'second');
});

// loops with other bridges

test('a webhook message is never relayed, even with bots on, so another bridge on the same channels cannot make a loop', async () => {
  const { dCh, fCh } = await bridged({ optionsD: { bots: true }, optionsF: { bots: true } });
  // Another bridge relays Alice's message into the Discord channel through its own webhook
  await relay(
    fromD(dCh, {
      content: 'echo',
      webhookId: snowflake(),
      author: { bot: true, username: 'Alice [Fluxer]' },
      member: null,
    }),
    D
  );
  await relay(
    fromF(fCh, {
      content: 'echo',
      webhookId: snowflake(),
      author: { bot: true, username: 'Bob [Discord]' },
      member: null,
    }),
    F
  );
  // and a bot account that already wears a platform tag (a bridge's relay account)
  await relay(
    fromD(dCh, { content: 'echo', author: { bot: true, username: 'Alice [Fluxer]' }, member: null }),
    D
  );
  assert.equal(fakes.transport.sends.length, 0);
  // an ordinary bot account still crosses
  await relay(fromD(dCh, { content: 'real', author: { bot: true, username: 'Deploy' }, member: null }), D);
  assert.equal(fakes.transport.sends.length, 1);
});

// sealed tokens

test('webhook tokens are stored sealed; a token that cannot be opened leads to a new webhook, not a failure', async () => {
  const { dCh, link } = await bridged();
  const stored = db.prepare('SELECT hook_a_token, hook_b_token FROM bridge_links WHERE id = ?').get(link.id);
  for (const [column, token] of [
    [stored.hook_a_token, link.hookAToken],
    [stored.hook_b_token, link.hookBToken],
  ]) {
    assert.ok(token.startsWith('tok-'), 'the code sees the real token');
    assert.ok(column.startsWith('v1.') && !column.includes(token), 'the table holds a sealed value');
  }
  await relay(fromD(dCh, { content: 'works' }), D);
  assert.equal(fakes.transport.sends.length, 1);

  // the session secret changed since: the stored value cannot be opened
  db.prepare('UPDATE bridge_links SET hook_b_token = ? WHERE id = ?').run(
    seal('another secret', 'bridge-webhook', 'tok-x'),
    link.id
  );
  dropBridgeCache();
  assert.equal((await store.getLink(link.id)).hookBToken, '');
  const before = fakes.transport.hooks.length;
  await relay(fromD(dCh, { content: 'after the secret changed' }), D);
  assert.equal(fakes.transport.hooks.length, before + 1, 'a new webhook was made');
  assert.equal(fakes.transport.sends.at(-1).payload.content, 'after the secret changed');
  assert.ok(fakes.transport.sends.at(-1).hook.token, 'sent with the new token');
  assert.equal((await store.getLink(link.id)).status, 'active');
  assert.ok(config.sessionSecret);
});

// download budget

test('files that do not fit the process-wide download budget cross as links instead of waiting', async () => {
  const gate = waitFor();
  fakes = useFakes({ files: {} });
  useBridgeParts({
    transport: fakes.transport,
    queue: fakes.queue,
    budget: { concurrent: 1, bytes: 1024 },
    download: async (url) => {
      fakes.downloads.push({ url });
      await gate.open;
      return { ok: true, status: 200, body: Buffer.from('FILE') };
    },
  });
  const one = await bridged();
  const other = p.extra('95');
  const otherF = `fluxer:${other.fGuild.id}`;
  await setGuildModule(other.dGuild.id, 'bridge', { enabled: true });
  await setGuildModule(otherF, 'bridge', { enabled: true });
  const dCh2 = p.channel(other.dGuild, {});
  const fCh2 = p.channel(other.fGuild, {});
  const made = await requestLink({ guildKey: other.dGuild.id, channelId: dCh2.id, actor: 'A' });
  await acceptLink({ guildKey: otherF, channelId: fCh2.id, code: made.code, actor: 'B' });

  const file = (name, size = 4) => ({
    attachments: new Map([['a', { name, url: `https://cdn/${name}`, size }]]),
  });
  await handleMessage(fromD(one.dCh, file('first.png')), {}, D); // takes the only slot and waits
  await new Promise((r) => setImmediate(r));
  await handleMessage(fromD(dCh2, file('second.png')), {}, other.dGuild.id); // another server: no room
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(
    fakes.downloads.map((d) => d.url),
    ['https://cdn/first.png'],
    'the second never started a download'
  );
  const second = fakes.transport.sends.find((s) => s.payload.content?.includes('second.png'));
  assert.equal(second.payload.content, '📎 second.png: https://cdn/second.png', 'it went as a link at once');
  assert.equal(second.payload.files, undefined);
  gate.release();
  await bridgeIdle();
  const first = fakes.transport.sends.find((s) => s.payload.files?.length);
  assert.equal(first.payload.files[0].name, 'first.png');
  // and a file larger than the whole byte budget is a link too
  gate.release();
  await relay(fromD(one.dCh, file('huge.png', 2048)), D);
  assert.ok(fakes.transport.sends.at(-1).payload.content.includes('huge.png: https://cdn/huge.png'));
});

// minor findings

test('names that Sylo puts in its own text cannot carry markdown links', async () => {
  p.fGuild.name = 'x](https://evil.example)[y';
  const { dCh } = await bridged();
  const notice = say(dCh)[0];
  assert.ok(!notice.includes('](https://evil.example)'), notice);
  assert.ok(notice.includes('x\\]\\(https://evil.example\\)\\[y'));
  await handleJoin({ displayName: 'a](https://evil.example)[b', user: { bot: false } }, {}, F);
  const { link } = { link: (await store.linksOfGuild(F))[0] };
  await setSideOptions({ guildKey: F, id: link.id, options: { joinMessages: true }, actor: 'B' });
  await handleJoin({ displayName: 'a](https://evil.example)[b', user: { bot: false } }, {}, F);
  await bridgeIdle();
  const join = fakes.transport.sends.at(-1).payload.content;
  assert.ok(!join.includes('](https://evil.example)'), join);
});

test('sticker, poll and file names get the same mention rules as the text', async () => {
  const { dCh } = await bridged();
  await relay(
    fromD(dCh, {
      content: 'x',
      stickers: new Map([['s', { name: '@everyone', url: 'https://cdn/s.png' }]]),
      poll: {
        question: { text: '@here vote <@123456789012345678>' },
        answers: new Map([[1, { text: '@everyone' }]]),
      },
      attachments: new Map([
        ['a', { name: '@everyone.zip', url: 'https://cdn/a.zip', size: 99 * 1024 * 1024 }],
      ]),
    }),
    D
  );
  const text = fakes.transport.sends[0].payload.content;
  assert.ok(!/@everyone|@here|<@\d/.test(text), text);
});

test('a link a server paused is not turned into a stopped one by a late failure', async () => {
  const { link } = await bridged();
  await pauseLink({ guildKey: D, id: link.id, actor: 'A' });
  await failLink(link.id, 'unreachable');
  const row = await store.getLink(link.id);
  assert.deepEqual(
    [row.status, row.pausedSide],
    ['paused', 'a'],
    'still paused by Discord, so only Discord can resume it'
  );
  await refuses(resumeLink({ guildKey: F, id: link.id, actor: 'B' }), /only they can resume/, 403);
});

test('the dashboard names only your own side, not the other server staff', async () => {
  const { link } = await bridged();
  assert.equal(linkView(await store.getLink(link.id), D).by, 'Alice (dashboard)');
  assert.equal(linkView(await store.getLink(link.id), F).by, 'Bob (dashboard)');
  const text = JSON.stringify(linkView(await store.getLink(link.id), D));
  assert.ok(!text.includes('Bob (dashboard)'));
});

test('a platform that refuses a message gets a plain name, then the text without files and embeds', async () => {
  const { dCh } = await bridged({ optionsD: { bots: true } });
  fakes.transport.sendFailures.push(apiError(400));
  await relay(
    fromD(dCh, { content: 'name refused', member: null, author: { bot: true, username: 'Weird' } }),
    D
  );
  assert.equal(fakes.transport.sends[0].payload.username, 'Bridge [Discord]');

  fakes.transport.sendFailures.push(apiError(400), apiError(400));
  await relay(
    fromD(dCh, {
      content: 'text survives',
      member: null,
      author: { bot: true, username: 'Deploy' },
      embeds: [{ type: 'rich', title: 'big embed' }],
    }),
    D
  );
  const last = fakes.transport.sends.at(-1).payload;
  assert.equal(last.content, 'text survives');
  assert.equal(last.embeds, undefined);
  assert.equal(last.files, undefined);
});
