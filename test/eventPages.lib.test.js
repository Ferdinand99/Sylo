// The small rules behind the public event pages: when an event counts as over, which image hosts are
// trusted, how the address is built, and the public-channel check that fails closed.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import {
  EVENT_TOKEN_RE,
  channelIsPublic,
  eventPagePath,
  eventPageUrl,
  eventStatus,
  publicLinkBase,
  trustedImageUrl,
} from '../src/modules/lib/eventPage.js';
import { END_GRACE_MS } from '../src/db/events.js';

const HOUR = 3_600_000;
const NOW = Date.UTC(2030, 0, 5, 12, 0);
const row = (over = {}) => ({ state: 'scheduled', start_at: NOW + HOUR, end_at: null, ...over });

test('eventStatus: upcoming until the end, cancelled and ended as stored', () => {
  assert.equal(eventStatus(row(), NOW), 'upcoming');
  assert.equal(eventStatus(row({ state: 'cancelled' }), NOW), 'cancelled');
  assert.equal(eventStatus(row({ state: 'ended' }), NOW), 'ended');
  // a cancelled event stays cancelled after its time has passed
  assert.equal(eventStatus(row({ state: 'cancelled', start_at: NOW - 9 * HOUR }), NOW), 'cancelled');
});

test('eventStatus: an open event is over at its end, or END_GRACE_MS after the start without one', () => {
  const start = NOW - HOUR;
  assert.equal(eventStatus(row({ start_at: start, end_at: NOW + 1 }), NOW), 'upcoming');
  assert.equal(eventStatus(row({ start_at: start, end_at: NOW }), NOW), 'ended');
  assert.equal(eventStatus(row({ start_at: NOW - END_GRACE_MS + 1 }), NOW), 'upcoming');
  assert.equal(eventStatus(row({ start_at: NOW - END_GRACE_MS }), NOW), 'ended');
});

test('trustedImageUrl: https links on the Discord image hosts only', () => {
  assert.equal(
    trustedImageUrl('https://cdn.discordapp.com/attachments/1/2/a.png?ex=1&is=2&hm=3'),
    'https://cdn.discordapp.com/attachments/1/2/a.png?ex=1&is=2&hm=3'
  );
  assert.equal(
    trustedImageUrl('https://media.discordapp.net/attachments/1/2/a.png'),
    'https://media.discordapp.net/attachments/1/2/a.png'
  );
  assert.equal(trustedImageUrl('HTTPS://CDN.DISCORDAPP.COM/a.png'), 'https://cdn.discordapp.com/a.png');
  for (const bad of [
    '',
    null,
    undefined,
    42,
    'not a url',
    'https://example.com/a.png',
    'http://cdn.discordapp.com/a.png',
    'https://cdn.discordapp.com.example.com/a.png',
    'https://notcdn.discordapp.com/a.png',
    'https://cdn.discordapp.com@example.com/a.png',
    'https://user:pw@cdn.discordapp.com/a.png',
    'https://cdn.discordapp.com:444/a.png',
    'ftp://cdn.discordapp.com/a.png',
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    '//cdn.discordapp.com/a.png',
    'https://cdn.discordapp.com/a.png"onerror="x',
    'https://cdn.discordapp.com/a b.png',
  ]) {
    assert.equal(trustedImageUrl(bad), null, String(bad));
  }
});

test('the address: /events/<token>, and a full link only where the dashboard address is known', () => {
  const token = 'a'.repeat(32);
  assert.equal(eventPagePath(token), `/events/${token}`);
  assert.equal(eventPageUrl(token, 'https://app.example.com'), `https://app.example.com/events/${token}`);
  assert.equal(eventPageUrl(token, 'https://example.com/sylo'), `https://example.com/sylo/events/${token}`);
  assert.equal(eventPageUrl(token, 'https://example.com/sylo/'), `https://example.com/sylo/events/${token}`);
  assert.equal(eventPageUrl(token, null), null);
  assert.equal(eventPageUrl(token, ''), null);
  assert.equal(eventPageUrl('', 'https://app.example.com'), null);
  assert.equal(eventPageUrl(null, 'https://app.example.com'), null);
  assert.equal(
    eventPageUrl('not a token', 'https://app.example.com'),
    null,
    'only a real token makes a link'
  );
  assert.ok(EVENT_TOKEN_RE.test(token));
  assert.ok(!EVENT_TOKEN_RE.test('A'.repeat(32)));
  assert.ok(!EVENT_TOKEN_RE.test('a'.repeat(31)));
  assert.ok(!EVENT_TOKEN_RE.test(`${token}\n`), 'no trailing newline');
});

// --- the public-channel check ------------------------------------------------------------------

const view = { has: (p) => p === 'ViewChannel' };
const none = { has: () => false };
const everyone = {};
const guildWith = (channels) => ({
  roles: { everyone },
  channels: { cache: new Map(Object.entries(channels)) },
});
const channel = (over = {}) => ({
  nsfw: false,
  type: ChannelType.GuildText,
  permissionsFor: (role) => (role === everyone ? view : none),
  ...over,
});

test('channelIsPublic: a channel everyone can view is public', () => {
  assert.equal(channelIsPublic(guildWith({ 1: channel() }), '1'), true);
});

test('channelIsPublic fails closed: private, age-restricted, unknown, broken or missing information', () => {
  assert.equal(channelIsPublic(guildWith({ 1: channel({ permissionsFor: () => none }) }), '1'), false);
  assert.equal(channelIsPublic(guildWith({ 1: channel({ nsfw: true }) }), '1'), false);
  assert.equal(channelIsPublic(guildWith({}), '1'), false, 'a channel that is not known');
  assert.equal(channelIsPublic(guildWith({ 1: channel({ permissionsFor: () => null }) }), '1'), false);
  assert.equal(channelIsPublic(guildWith({ 1: channel({ permissionsFor: undefined }) }), '1'), false);
  assert.equal(
    channelIsPublic(
      guildWith({
        1: channel({
          permissionsFor: () => {
            throw new Error('boom');
          },
        }),
      }),
      '1'
    ),
    false
  );
  assert.equal(
    channelIsPublic({ channels: { cache: new Map([['1', channel()]]) } }, '1'),
    false,
    'no @everyone'
  );
  assert.equal(channelIsPublic(null, '1'), false);
  assert.equal(channelIsPublic(undefined, '1'), false);
  assert.equal(channelIsPublic({}, '1'), false);
  assert.equal(channelIsPublic(guildWith({ 1: channel() }), ''), false);
  assert.equal(channelIsPublic(guildWith({ 1: channel() }), undefined), false);
});

test('channelIsPublic: a thread follows its parent, and a private thread is never public', () => {
  const thread = (type, parent) =>
    channel({ type, parent, isThread: () => true, permissionsFor: () => none });
  const open = channel();
  const closed = channel({ permissionsFor: () => none });
  assert.equal(channelIsPublic(guildWith({ t: thread(ChannelType.PublicThread, open) }), 't'), true);
  assert.equal(channelIsPublic(guildWith({ t: thread(ChannelType.PublicThread, closed) }), 't'), false);
  assert.equal(channelIsPublic(guildWith({ t: thread(ChannelType.PrivateThread, open) }), 't'), false);
});

test('publicLinkBase: only a public https address, never http, a local name or an IP address', () => {
  assert.equal(publicLinkBase('https://app.example.com'), 'https://app.example.com');
  assert.equal(publicLinkBase('https://app.example.com/sylo/'), 'https://app.example.com/sylo');
  assert.equal(publicLinkBase('https://app.example.com:8443'), 'https://app.example.com:8443');
  for (const refused of [
    null,
    undefined,
    '',
    'not a url',
    'http://app.example.com',
    'https://localhost',
    'https://localhost:3000',
    'https://sylo',
    'https://sylo.local',
    'https://sylo.lan',
    'https://nas.home.arpa',
    'https://192.168.1.20',
    'https://10.0.0.5:3000',
    'https://127.0.0.1',
    'https://8.8.8.8',
    'https://[::1]',
    'https://[2001:db8::1]',
    'https://user:pass@app.example.com',
    'ftp://app.example.com',
    'sylo://app.example.com',
  ]) {
    assert.equal(publicLinkBase(refused), null, String(refused));
    assert.equal(eventPageUrl('a'.repeat(32), refused), null, `no link for ${refused}`);
  }
});
