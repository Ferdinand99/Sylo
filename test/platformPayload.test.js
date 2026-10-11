import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} from 'discord.js';
import { toFluxerPayload } from '../src/platform/payload.js';

test('a string becomes { content }', () => {
  assert.deepEqual(toFluxerPayload('hi'), {
    payload: { content: 'hi' },
    ephemeral: false,
    wantsResponse: false,
  });
});

test('discord-only keys are stripped and reported', () => {
  const r = toFluxerPayload({
    content: 'x',
    ephemeral: true,
    flags: MessageFlags.Ephemeral,
    withResponse: true,
    fetchReply: true,
    allowedMentions: { parse: [] },
  });
  assert.deepEqual(r.payload, { content: 'x', allowedMentions: { parse: [] } });
  assert.equal(r.ephemeral, true);
  assert.equal(r.wantsResponse, true);
});

test('the ephemeral flag alone marks the payload ephemeral', () => {
  assert.equal(toFluxerPayload({ content: 'x', flags: MessageFlags.Ephemeral }).ephemeral, true);
  assert.equal(toFluxerPayload({ content: 'x', flags: 0 }).ephemeral, false);
});

test('components are dropped because Fluxer has no buttons or menus', () => {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('go').setLabel('Go').setStyle(ButtonStyle.Primary)
  );
  assert.deepEqual(toFluxerPayload({ content: 'x', components: [row] }).payload, { content: 'x' });
});

test('an empty content string is removed so an embed-only message is valid', () => {
  const r = toFluxerPayload({ content: '', embeds: [{ title: 't' }] });
  assert.equal('content' in r.payload, false);
});

test('embed builders are serialised to plain API objects', () => {
  const embed = new EmbedBuilder().setTitle('T').addFields({ name: 'a', value: 'b' });
  const { payload } = toFluxerPayload({ embeds: [embed, { title: 'plain' }] });
  assert.deepEqual(payload.embeds, [{ title: 'T', fields: [{ name: 'a', value: 'b' }] }, { title: 'plain' }]);
});

test('a discord.js AttachmentBuilder becomes { name, data }', () => {
  const buf = Buffer.from('png');
  const { payload } = toFluxerPayload({ files: [new AttachmentBuilder(buf, { name: 'rank.png' })] });
  assert.deepEqual(payload.files, [{ name: 'rank.png', data: buf }]);
});

test('attachment objects and url attachments convert, native shapes pass through', () => {
  const buf = Buffer.from('x');
  const native = { name: 'n.txt', data: buf };
  const { payload } = toFluxerPayload({
    files: [
      { attachment: buf, name: 'a.txt' },
      new AttachmentBuilder('https://example.com/p.png', { name: 'p.png' }),
      native,
    ],
  });
  assert.deepEqual(payload.files, [
    { name: 'a.txt', data: buf },
    { name: 'p.png', url: 'https://example.com/p.png' },
    native,
  ]);
});

test('the input object is not mutated', () => {
  const input = { content: 'x', ephemeral: true, components: [{}] };
  toFluxerPayload(input);
  assert.deepEqual(input, { content: 'x', ephemeral: true, components: [{}] });
});
