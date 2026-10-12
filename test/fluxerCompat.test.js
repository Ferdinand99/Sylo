import test from 'node:test';
import assert from 'node:assert/strict';
import * as sdk from '@fluxerjs/core';
import { installFluxerCompat } from '../src/platform/compat.js';

// These run against the real SDK classes: an alias that is only wired to a fake
// proves nothing about the library the bot actually talks to.
installFluxerCompat(sdk);

const messageData = (extra = {}) => ({
  id: '1558984911136751616',
  channel_id: '1558984910436302848',
  author: { id: '2', username: 'u', discriminator: '0', avatar: null },
  content: 'hi',
  timestamp: '2026-10-12T09:50:00.000Z',
  edited_timestamp: null,
  tts: false,
  mention_everyone: false,
  mentions: [],
  mention_roles: [],
  attachments: [],
  embeds: [],
  pinned: false,
  type: 0,
  flags: 0,
  ...extra,
});
const makeMessage = (extra) => new sdk.Message(new sdk.Client({}), messageData(extra));

test('Message.createdTimestamp is the creation time in ms, as discord.js has it', () => {
  assert.equal(makeMessage().createdTimestamp, Date.parse('2026-10-12T09:50:00.000Z'));
});

test('Message.editedTimestamp is null until edited, then the edit time in ms', () => {
  assert.equal(makeMessage().editedTimestamp, null);
  assert.equal(
    makeMessage({ edited_timestamp: '2026-10-12T10:00:00.000Z' }).editedTimestamp,
    Date.parse('2026-10-12T10:00:00.000Z')
  );
});

test('installing twice, or over a class that already has the member, changes nothing', () => {
  const before = Object.getOwnPropertyDescriptor(sdk.Message.prototype, 'createdTimestamp').get;
  installFluxerCompat(sdk);
  assert.equal(Object.getOwnPropertyDescriptor(sdk.Message.prototype, 'createdTimestamp').get, before);
});
