// A mirror links its channels through the bridge (src/mirror/bridgeLink.js, createMirrorLink and the held-link helpers in
// src/modules/bridge.js): which channels, what is recorded, every safety rule of the bridge, running it again, and
// links that follow the state of their mirror. Platforms and webhooks are the bridge tests' fakes.
import './helpers/tmpDb.js';
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import * as mdb from '../src/db/mirror.js';
import * as bridgeDb from '../src/db/bridge.js';
import { listAudit } from '../src/db/audit.js';
import { getGuildModule, setGuildModule } from '../src/db/modules.js';
import { purgeGuild } from '../src/db/purge.js';
import { requestMirror } from '../src/mirror/consent.js';
import {
  LINKS_PER_RUN,
  linkMirroredChannels,
  releaseMirrorLinks,
  syncMirrorLinks,
} from '../src/mirror/bridgeLink.js';
import {
  BridgeError,
  MAX_MIRROR_LINKS,
  bridgeIdle,
  bridgeProblems,
  dropBridgeCache,
  handleMessage,
  linkView,
  resumeLink,
  unlinkLink,
  useBridgeParts,
} from '../src/modules/bridge.js';
import {
  D,
  F,
  installPlatforms,
  message,
  removePlatforms,
  useFakes,
} from './helpers/fakeBridge.js';

let p;
let fakes;
const noSleep = async () => {};

beforeEach(async () => {
  p = installPlatforms();
  useFakes();
  dropBridgeCache();
  for (const key of [D, F]) await purgeGuild(key);
  fakes = useFakes();
  await setGuildModule(D, 'bridge', { enabled: false });
  await setGuildModule(F, 'bridge', { enabled: false });
});
afterEach(() => {
  useBridgeParts();
  removePlatforms();
});

/** A live mirror of the Discord server onto the Fluxer server, agreed by both owners. */
async function livePair(over = {}) {
  const { pair } = await requestMirror({
    sourceGuild: D,
    targetGuild: F,
    actor: 'Anna',
    sourceUser: p.dGuild.ownerId,
    targetUser: p.fGuild.ownerId,
    targetOwner: true,
    ...over,
  });
  return mdb.updatePair(pair.id, { status: 'live', targetConsentBy: 'Bo' });
}
/** A Discord channel and its Fluxer copy, in the pair's channel map. */
async function mirrored(pair, name, { type = ChannelType.GuildText, dOpts = {}, fOpts = {} } = {}) {
  const d = p.channel(p.dGuild, { name, type, ...dOpts });
  const f = p.channel(p.fGuild, { name, type, ...fOpts });
  await mdb.putMapping({
    pairId: pair.id,
    kind: 'channel',
    sourceId: d.id,
    targetId: f.id,
    owned: true,
    specHash: 'h',
    label: name,
  });
  return { d, f };
}
const run = (pair, opts = {}) => linkMirroredChannels(pair.id, { sleep: noSleep, ...opts });
const send = async (channel, key, over = {}) => {
  await handleMessage(
    message({ channelId: channel.id, client: key === D ? p.discord : p.fluxer, ...over }),
    {},
    key
  );
  await bridgeIdle();
};

test('every mirrored text channel pair is linked, voice channels and categories are left alone', async () => {
  const pair = await livePair();
  const chat = await mirrored(pair, 'chat');
  const news = await mirrored(pair, 'news', { type: ChannelType.GuildAnnouncement });
  await mirrored(pair, 'lounge', { type: ChannelType.GuildVoice });
  await mirrored(pair, 'Info', { type: ChannelType.GuildCategory });

  const res = await run(pair);
  assert.deepEqual([res.linked, res.already, res.remaining, res.skipped.length], [2, 0, 0, 0]);
  for (const { d, f } of [chat, news]) {
    const found = await bridgeDb.linkForChannel(D, d.id);
    assert.ok(found, 'the Discord channel is linked');
    assert.deepEqual(
      [found.link.guildA, found.link.channelA, found.link.guildB, found.link.channelB, found.link.status],
      [D, d.id, F, f.id, 'active']
    );
    assert.equal((await mdb.getMirrorLink(pair.id, d.id)).linkId, found.link.id);
  }
  assert.equal((await bridgeDb.linkCount(D)), 2);
  assert.equal(fakes.transport.hooks.length, 4, 'a webhook in each of the four channels, none for voice');
});

test('no link code is used: the link records the two owners who agreed to the mirror and their ids', async () => {
  const pair = await livePair();
  const { d, f } = await mirrored(pair, 'chat');
  await run(pair);
  const link = (await bridgeDb.linkForChannel(D, d.id)).link;
  assert.equal(link.requestedBy, 'Anna (server mirror)');
  assert.equal(link.acceptedBy, 'Bo (server mirror)');
  assert.deepEqual([link.ownerA, link.ownerB], [p.dGuild.ownerId, p.fGuild.ownerId]);
  assert.equal((await bridgeDb.pendingCodes(D)).length, 0, 'no request or code was made');
  assert.deepEqual([link.optionsA.bots, link.optionsB.bots], [false, false], 'bots are off on both sides');
  // the owners' own side of it, as the dashboard of each server shows it
  assert.equal(linkView(link, D).by, 'Anna (server mirror)');
  assert.equal(linkView(link, F).by, 'Bo (server mirror)');
  // visible notice in both channels, naming the mirror
  for (const channel of [d, f]) {
    assert.equal(channel.said.length, 1);
    assert.match(channel.said[0].content, /Bridge on/);
    assert.match(channel.said[0].content, /server mirror/);
    assert.deepEqual(channel.said[0].allowedMentions, { parse: [] });
  }
  for (const key of [D, F]) {
    const entry = (await listAudit(key)).find((e) => e.action === 'bridge:link');
    assert.ok(entry, 'both servers record it');
    assert.match(entry.detail, /through the server mirror/);
  }
});

test('the Bridge module is switched on in both servers, and both audit logs say so', async () => {
  const pair = await livePair();
  await mirrored(pair, 'chat');
  assert.equal((await getGuildModule(D, 'bridge')).enabled, false);
  await run(pair);
  for (const key of [D, F]) {
    assert.equal((await getGuildModule(key, 'bridge')).enabled, true);
    assert.ok((await listAudit(key)).some((e) => e.action === 'bridge:module'));
  }
});

test('a linked pair relays messages both ways, with nobody pinged', async () => {
  const pair = await livePair();
  const { d, f } = await mirrored(pair, 'chat');
  await run(pair);
  await send(d, D, { content: 'hello from Discord @everyone' });
  await send(f, F, { content: 'hello from Fluxer' });
  assert.equal(fakes.transport.sends.length, 2);
  assert.equal(fakes.transport.sends[0].guildKey, F);
  assert.deepEqual(fakes.transport.sends[0].payload.allowedMentions ?? { parse: [] }, { parse: [] });
  assert.equal(fakes.transport.sends[1].guildKey, D);
  // a bot's message stays on its side (bots are off)
  await send(d, D, { content: 'beep', author: { bot: true } });
  assert.equal(fakes.transport.sends.length, 2);
});

test('running it again links only what is missing', async () => {
  const pair = await livePair();
  await mirrored(pair, 'chat');
  await mirrored(pair, 'rules');
  assert.equal((await run(pair)).linked, 2);
  const again = await run(pair);
  assert.deepEqual([again.linked, again.already, again.reason], [0, 2, undefined]);
  assert.equal(fakes.transport.hooks.length, 4, 'nothing was made twice');

  await mirrored(pair, 'offers');
  const third = await run(pair);
  assert.deepEqual([third.linked, third.already], [1, 2], 'only the new pair is linked');
  assert.equal(fakes.transport.hooks.length, 6);
  assert.equal((await mdb.listMirrorLinks(pair.id)).length, 3);
});

test('a pair that has nothing to link says so', async () => {
  const pair = await livePair();
  await mirrored(pair, 'lounge', { type: ChannelType.GuildVoice });
  assert.equal((await run(pair)).reason, 'nothing-to-link');
  assert.equal((await getGuildModule(D, 'bridge')).enabled, false, 'and the module is left alone');
});

test('a channel somebody unlinked on purpose is not linked again', async () => {
  const pair = await livePair();
  const { d } = await mirrored(pair, 'chat');
  await mirrored(pair, 'rules');
  await run(pair);
  const link = (await bridgeDb.linkForChannel(D, d.id)).link;
  await unlinkLink({ guildKey: D, id: link.id, actor: 'Anna' });
  assert.equal(await bridgeDb.linkForChannel(D, d.id), null);
  const again = await run(pair);
  assert.deepEqual([again.linked, again.already], [0, 2]);
  assert.equal(await bridgeDb.linkForChannel(D, d.id), null, 'it stays unlinked');
});

test('the age rule: an age-restricted channel is linked only to an age-restricted one', async () => {
  const pair = await livePair();
  const plain = await mirrored(pair, 'chat');
  const mismatch = await mirrored(pair, 'adult', { dOpts: { nsfw: true } });
  const both = await mirrored(pair, 'adult-too', { dOpts: { nsfw: true }, fOpts: { nsfw: true } });
  const res = await run(pair);
  assert.equal(res.linked, 2);
  assert.deepEqual(
    res.skipped.map((s) => [s.sourceId, s.code]),
    [[mismatch.d.id, 'age-restriction']]
  );
  assert.ok(await bridgeDb.linkForChannel(D, plain.d.id));
  assert.ok(await bridgeDb.linkForChannel(D, both.d.id));
  assert.equal(await bridgeDb.linkForChannel(D, mismatch.d.id), null);
  assert.equal(mismatch.d.said.length + mismatch.f.said.length, 0, 'no notice, no webhook');
});

test('a private channel is not linked to an open one, and two private channels are linked', async () => {
  const pair = await livePair();
  const closed = (guild) => (target) => ({
    has: (perm) => !(perm === 'ViewChannel' && target === String(guild.id)),
  });
  const leak = await mirrored(pair, 'staff');
  leak.d.permissionsFor = closed(p.dGuild); // private on Discord, open on Fluxer
  const pulled = await mirrored(pair, 'staff-too');
  pulled.f.permissionsFor = closed(p.fGuild); // open on Discord, private on Fluxer
  const same = await mirrored(pair, 'mods');
  same.d.permissionsFor = closed(p.dGuild);
  same.f.permissionsFor = closed(p.fGuild);
  const res = await run(pair);
  assert.equal(res.linked, 1);
  assert.deepEqual(
    res.skipped.map((s) => s.code),
    ['visibility', 'visibility']
  );
  assert.ok(await bridgeDb.linkForChannel(D, same.d.id));
  assert.equal(await bridgeDb.linkForChannel(D, leak.d.id), null);
  assert.equal(await bridgeDb.linkForChannel(D, pulled.d.id), null);
});

test('with sign-in on, each owner must be able to see, read and send in the channel themselves', async () => {
  const pair = await livePair();
  const ok = await mirrored(pair, 'chat');
  const hidden = await mirrored(pair, 'hidden');
  const owner = { id: p.dGuild.ownerId };
  p.dGuild.members.cache.set(owner.id, owner);
  const fluxerOwner = { id: p.fGuild.ownerId };
  p.fGuild.members.cache.set(fluxerOwner.id, fluxerOwner);
  // the Fluxer owner cannot read the history of one channel
  const real = hidden.f.permissionsFor;
  hidden.f.permissionsFor = (t) =>
    t?.id === fluxerOwner.id
      ? { has: (perm) => perm !== 'ReadMessageHistory' }
      : real(t);
  const res = await run(pair, { open: false });
  assert.equal(res.linked, 1);
  assert.deepEqual(
    res.skipped.map((s) => [s.sourceId, s.code]),
    [[hidden.d.id, 'visibility']]
  );
  assert.ok(await bridgeDb.linkForChannel(D, ok.d.id));
});

test('with sign-in on, an owner who cannot be found fails closed: nothing is linked', async () => {
  const pair = await livePair();
  await mirrored(pair, 'chat');
  const res = await run(pair, { open: false });
  assert.equal(res.linked, 0);
  assert.deepEqual(
    res.skipped.map((s) => s.code),
    ['visibility']
  );
});

test('Sylo missing a permission in one channel skips only that pair', async () => {
  const pair = await livePair();
  const fine = await mirrored(pair, 'chat');
  const broken = await mirrored(pair, 'locked');
  broken.f.permissionsFor = () => ({ has: (perm) => perm !== 'ManageWebhooks' });
  const res = await run(pair);
  assert.equal(res.linked, 1);
  assert.deepEqual(
    res.skipped.map((s) => [s.sourceId, s.code]),
    [[broken.d.id, 'permissions']]
  );
  assert.ok(await bridgeDb.linkForChannel(D, fine.d.id));
});

test('a channel already bridged by hand to another channel is left as it is; the pair itself is taken over', async () => {
  const pair = await livePair();
  const other = await mirrored(pair, 'other');
  const lost = await mirrored(pair, 'lost');
  // somebody linked "other" to an unrelated Fluxer channel through the bridge page
  const stray = p.channel(p.fGuild, { name: 'stray' });
  await bridgeDb.createLink({
    guildA: D,
    channelA: other.d.id,
    guildB: F,
    channelB: stray.id,
    hookA: { id: '1', token: 'a' },
    hookB: { id: '2', token: 'b' },
  });
  // and a link of exactly the pair "lost" exists whose record was never written
  const made = await bridgeDb.createLink({
    guildA: D,
    channelA: lost.d.id,
    guildB: F,
    channelB: lost.f.id,
    hookA: { id: '3', token: 'c' },
    hookB: { id: '4', token: 'd' },
  });
  const res = await run(pair);
  assert.deepEqual([res.linked, res.already], [0, 1]);
  assert.deepEqual(
    res.skipped.map((s) => [s.sourceId, s.code]),
    [[other.d.id, 'exists']]
  );
  assert.equal((await mdb.getMirrorLink(pair.id, lost.d.id)).linkId, made, 'taken over');
  assert.equal(fakes.transport.hooks.length, 0, 'no new webhook');
});

test('a batch links at most the limit, and the next run carries on without trying the same pairs again', async () => {
  assert.ok(LINKS_PER_RUN >= 10);
  const pair = await livePair();
  for (let i = 0; i < 5; i += 1) await mirrored(pair, `c${i}`);
  const bad = await mirrored(pair, 'adult', { dOpts: { nsfw: true } }); // the sixth is refused
  const first = await run(pair, { limit: 3 });
  assert.deepEqual([first.linked, first.remaining, first.tried.length], [3, 3, 3]);
  const second = await run(pair, { limit: 3, skip: new Set(first.tried) });
  assert.deepEqual([second.linked, second.remaining], [2, 0]);
  assert.deepEqual(
    second.skipped.map((s) => s.sourceId),
    [bad.d.id]
  );
  // a third run that skips what was tried has nothing left
  const third = await run(pair, { limit: 3, skip: new Set([...first.tried, ...second.tried]) });
  assert.deepEqual([third.linked, third.remaining, third.skipped.length], [0, 0, 0]);
});

test('the ceiling of links per server is respected and reported', async () => {
  const pair = await livePair();
  const one = await mirrored(pair, 'chat');
  for (let i = 0; i < MAX_MIRROR_LINKS; i += 1) {
    await bridgeDb.createLink({
      guildA: D,
      channelA: `filler-${i}`,
      guildB: F,
      channelB: `filler-f-${i}`,
      hookA: { id: `a${i}`, token: 'a' },
      hookB: { id: `b${i}`, token: 'b' },
    });
  }
  const res = await run(pair);
  assert.equal(res.linked, 0);
  assert.deepEqual(
    res.skipped.map((s) => [s.sourceId, s.code]),
    [[one.d.id, 'limit']]
  );
});

test('a webhook that cannot be made skips the pair and leaves nothing half made', async () => {
  const pair = await livePair();
  const a = await mirrored(pair, 'chat');
  fakes.transport.hookFailures.push(new Error('boom'));
  const res = await run(pair);
  assert.equal(res.linked, 0);
  assert.deepEqual(
    res.skipped.map((s) => s.code),
    ['webhook']
  );
  assert.equal(await bridgeDb.linkForChannel(D, a.d.id), null);
  assert.equal(await mdb.getMirrorLink(pair.id, a.d.id), null, 'so a later run tries it again');
  const later = await run(pair);
  assert.equal(later.linked, 1);
});

test('when the clients are not both connected, nothing is linked and the reason says so', async () => {
  const pair = await livePair();
  await mirrored(pair, 'chat');
  p.fluxer.user = p.fluxer.user; // still there
  removePlatforms();
  assert.equal((await run(pair)).reason, 'bridge-not-available');
  assert.equal((await linkMirroredChannels(999_999, { sleep: noSleep })).reason, 'no-such-mirror');
});

test('a mirror that is not running links nothing', async () => {
  const pair = await livePair();
  await mirrored(pair, 'chat');
  await mdb.updatePair(pair.id, { status: 'paused' });
  assert.equal((await run(pair)).reason, 'mirror-not-running');
});

// --- links follow the state of their mirror ---------------------------------------------------------------

test('a paused mirror pauses its links, nothing crosses, and they run again with the mirror', async () => {
  const pair = await livePair();
  const { d, f } = await mirrored(pair, 'chat');
  await run(pair);
  await send(d, D, { content: 'one' });
  assert.equal(fakes.transport.sends.length, 1);

  await mdb.updatePair(pair.id, { status: 'paused' });
  assert.deepEqual(await syncMirrorLinks(pair.id), { held: 1, resumed: 0, waiting: [] });
  const held = (await bridgeDb.linkForChannel(D, d.id)).link;
  assert.deepEqual([held.status, held.failReason], ['paused', 'mirror']);
  await send(d, D, { content: 'two' });
  await send(f, F, { content: 'three' });
  assert.equal(fakes.transport.sends.length, 1, 'nothing crosses while the mirror is paused');
  assert.deepEqual(await bridgeProblems(D), [], 'the mirror has its own Health entry');
  assert.match(linkView(held, D).pauseNote, /server mirror/);

  // the bridge page cannot resume it on its own
  await assert.rejects(
    resumeLink({ guildKey: D, id: held.id, actor: 'Anna' }),
    (err) => err instanceof BridgeError && err.status === 409 && /mirror/.test(err.message)
  );

  await mdb.updatePair(pair.id, { status: 'live' });
  assert.deepEqual(await syncMirrorLinks(pair.id), { held: 0, resumed: 1, waiting: [] });
  assert.equal((await bridgeDb.getLink(held.id)).status, 'active');
  await send(d, D, { content: 'four' });
  assert.equal(fakes.transport.sends.length, 2, 'and it carries messages again');
});

test('a stopped mirror pauses its links too, and only the ones the mirror paused come back', async () => {
  const pair = await livePair();
  const a = await mirrored(pair, 'chat');
  const b = await mirrored(pair, 'rules');
  await run(pair);
  const own = (await bridgeDb.linkForChannel(D, b.d.id)).link;
  await bridgeDb.setLinkStatus(own.id, { status: 'paused', pausedSide: 'b' }); // the Fluxer server paused this one
  await mdb.updatePair(pair.id, { status: 'stopped' });
  assert.equal((await syncMirrorLinks(pair.id)).held, 1);
  await mdb.updatePair(pair.id, { status: 'live' });
  assert.equal((await syncMirrorLinks(pair.id)).resumed, 1);
  assert.equal((await bridgeDb.linkForChannel(D, a.d.id)).link.status, 'active');
  const still = (await bridgeDb.linkForChannel(D, b.d.id)).link;
  assert.deepEqual([still.status, still.pausedSide], ['paused', 'b'], "a server's own pause is left alone");
});

test('a server that changed hands while the mirror was paused keeps the link paused until its new owner confirms', async () => {
  const pair = await livePair();
  const { d } = await mirrored(pair, 'chat');
  await run(pair);
  await mdb.updatePair(pair.id, { status: 'paused' });
  await syncMirrorLinks(pair.id);
  p.fGuild.ownerId = 'new-owner';
  await mdb.updatePair(pair.id, { status: 'live' });
  const res = await syncMirrorLinks(pair.id);
  assert.deepEqual([res.resumed, res.waiting], [0, ['owner-changed']]);
  const link = (await bridgeDb.linkForChannel(D, d.id)).link;
  assert.deepEqual([link.status, link.pausedSide, link.failReason], ['paused', 'b', 'owner-changed']);
});

test('a link whose channel can no longer be used stays paused with the mirror and is reported', async () => {
  const pair = await livePair();
  const { d, f } = await mirrored(pair, 'chat');
  await run(pair);
  await mdb.updatePair(pair.id, { status: 'paused' });
  await syncMirrorLinks(pair.id);
  f.permissionsFor = () => ({ has: (perm) => perm !== 'ManageWebhooks' });
  await mdb.updatePair(pair.id, { status: 'live' });
  const res = await syncMirrorLinks(pair.id);
  assert.equal(res.resumed, 0);
  assert.match(res.waiting[0], /ManageWebhooks/);
  assert.equal((await bridgeDb.linkForChannel(D, d.id)).link.failReason, 'mirror');
});

test('removing a mirror releases its links: they stay, paused, and either owner can resume or unlink them', async () => {
  const pair = await livePair();
  const { d } = await mirrored(pair, 'chat');
  await run(pair);
  assert.equal(await releaseMirrorLinks(pair.id), 1);
  const link = (await bridgeDb.linkForChannel(D, d.id)).link;
  assert.deepEqual([link.status, link.pausedSide, link.failReason], ['paused', '', 'mirror-ended']);
  assert.match(linkView(link, F).pauseNote, /mirror that made this bridge ended/);
  await mdb.deletePair(pair.id);
  assert.equal((await mdb.listMirrorLinks(pair.id)).length, 0, 'the record goes with the pair');
  // the Fluxer owner resumes it on the Bridge page
  await resumeLink({ guildKey: F, id: link.id, actor: 'Bo' });
  assert.equal((await bridgeDb.getLink(link.id)).status, 'active');
  // a second release does nothing to a link that is no longer the mirror's to hold
  assert.equal(await releaseMirrorLinks(pair.id), 0);
});

test('a link the mirror made can be unlinked by either owner, and leaving the server purges it with the pair', async () => {
  const pair = await livePair();
  const { d } = await mirrored(pair, 'chat');
  await run(pair);
  const link = (await bridgeDb.linkForChannel(D, d.id)).link;
  await unlinkLink({ guildKey: F, id: link.id, actor: 'Bo' });
  assert.equal(await bridgeDb.getLink(link.id), null);
  await purgeGuild(F);
  assert.equal(await mdb.getPair(pair.id), null);
  assert.equal((await mdb.listMirrorLinks(pair.id)).length, 0);
});
