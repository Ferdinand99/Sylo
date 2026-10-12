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

test('an edit keeps an empty content string so it can clear old text', () => {
  assert.equal(toFluxerPayload({ content: '' }, { edit: true }).payload.content, '');
  assert.equal('content' in toFluxerPayload({ content: '' }).payload, false);
});

test('timestamps in embed text that Fluxer does not render become plain UTC text', () => {
  const ts = Date.UTC(2026, 9, 12, 19, 49, 5) / 1000; // 2026-10-12 19:49:05 UTC
  const embed = new EmbedBuilder()
    .setTitle(`Poll <t:${ts}:R>`)
    .setDescription(`Description keeps <t:${ts}:R>`)
    .setFooter({ text: `Ends <t:${ts}:R> · One vote each` })
    .addFields({ name: `Closes <t:${ts}:t>`, value: `Value keeps <t:${ts}:R>` });
  const { payload } = toFluxerPayload({ embeds: [embed] });
  const [e] = payload.embeds;
  assert.equal(e.footer.text, 'Ends 12 Oct 2026, 19:49 UTC · One vote each');
  assert.equal(e.title, 'Poll 12 Oct 2026, 19:49 UTC');
  assert.equal(e.fields[0].name, 'Closes 19:49 UTC');
  // Descriptions and field values are markdown, which Fluxer does render.
  assert.equal(e.description, `Description keeps <t:${ts}:R>`);
  assert.equal(e.fields[0].value, `Value keeps <t:${ts}:R>`);
});
