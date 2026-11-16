// The pure rules of the bridge: how text, names, replies, files, embeds and options are made safe and
// fit for the other platform. No database and no platform needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMBED_LIMIT,
  FILE_BYTES_LIMIT,
  FILE_COUNT_LIMIT,
  MESSAGE_LIMIT,
  TOTAL_BYTES_LIMIT,
  ZWSP,
  clip,
  fileLinkLines,
  hashContent,
  inertAt,
  joinParts,
  mapEmoji,
  neutraliseMentions,
  normaliseOptions,
  planAttachments,
  plainEmbed,
  plainEmbeds,
  plainTimestamps,
  pollText,
  replyHead,
  senderName,
  stickerLines,
} from '../src/modules/lib/bridgeText.js';

const plain = (s) => s.split(ZWSP).join('<z>');

test('every kind of mention is replaced by a name, and @everyone and @here are broken', () => {
  const names = { user: () => 'Bob', role: () => 'mods', channel: () => 'rules' };
  assert.equal(
    plain(neutraliseMentions('<@111111> <@!111111> <@&222222> <#333333> @everyone @here @EVERYONE', names)),
    '@<z>Bob @<z>Bob @<z>mods #rules @<z>everyone @<z>here @<z>EVERYONE'
  );
  assert.equal(plain(neutraliseMentions('<@111111> <@&222222> <#333333>')), '@<z>user @<z>role #channel');
  assert.equal(neutraliseMentions('</ban:123456> and </mod warn:123456>'), '/ban and /mod warn');
  assert.equal(
    neutraliseMentions('plain text, an email a@b.c and 5 > 3'),
    'plain text, an email a@b.c and 5 > 3'
  );
});

test('a name cannot smuggle a mention: control characters go and an @ is broken', () => {
  const out = neutraliseMentions('<@111111>', { user: () => '@everyone‮\u0000x' });
  assert.ok(!/@everyone/.test(out), out);
  assert.equal(plain(inertAt('@a@b')), '@<z>a@<z>b');
});

test('custom emoji map by name to the other server, else become :name:; Unicode is untouched', () => {
  const find = (name) =>
    name === 'wave'
      ? { id: '999', name: 'wave', animated: false }
      : name === 'dance'
        ? { id: '888', name: 'dance', animated: true }
        : undefined;
  assert.equal(
    mapEmoji('a <:wave:12345> b <a:dance:67890> c <:gone:11111> 🎉', find),
    'a <:wave:999> b <a:dance:888> c :gone: 🎉'
  );
  assert.equal(mapEmoji('<:wave:12345>'), ':wave:', 'no lookup at all: names only');
});

test('a Discord timestamp is written out in UTC', () => {
  assert.equal(
    plainTimestamps('at <t:1700000000:R> or <t:0>'),
    'at 14 Nov 2023, 22:13 UTC or 1 Jan 1970, 00:00 UTC'
  );
});

test('the sender name carries the platform, fits 80 characters, is never empty, and cannot ping', () => {
  assert.equal(senderName('Alice', 'discord'), 'Alice [Discord]');
  assert.equal(senderName('Bob', 'fluxer'), 'Bob [Fluxer]');
  assert.equal(plain(senderName('@everyone', 'fluxer')), '@<z>everyone [Fluxer]');
  assert.equal(senderName('', 'fluxer'), 'Someone [Fluxer]');
  assert.equal(senderName('‮\u0000', 'fluxer'), 'Someone [Fluxer]');
  const long = senderName('x'.repeat(200), 'discord');
  assert.equal(long.length, 80);
  assert.ok(long.endsWith('… [Discord]'));
  // Discord refuses a webhook name with "discord" or "clyde" in it
  const forDiscord = senderName('ClydeBot and Discordian', 'fluxer', { forDiscord: true });
  assert.ok(!/clyde|discord/i.test(forDiscord), forDiscord);
  assert.ok(/Clyde/.test(forDiscord.split(ZWSP).join('')), 'the name is still readable');
  assert.ok(senderName('Zoë 🧑‍🚀', 'discord').includes('🧑‍🚀'), 'a joiner in an emoji sequence stays');
});

test('a reply head is a short one-line quote with a link when the copy is known', () => {
  assert.equal(
    replyHead({ name: 'Bob', snippet: 'hello\nthere   world', url: 'https://x/y' }),
    '> ↪ [**Bob**](<https://x/y>): hello there world'
  );
  assert.equal(replyHead({ name: 'Bob', snippet: '' }), '> ↪ **Bob**');
  assert.equal(replyHead({ name: '', snippet: '> nested quote' }), '> ↪ **someone**: nested quote');
  const head = replyHead({ name: 'x'.repeat(100), snippet: 'y'.repeat(500) });
  assert.ok(head.length < 190);
  assert.ok(head.endsWith('…'));
});

test('stickers become a picture link, and a poll becomes plain text', () => {
  assert.deepEqual(stickerLines([{ name: 'wave', url: 'https://cdn/1.png' }, { name: 'nolink' }]), [
    '*sticker: wave* https://cdn/1.png',
    '*sticker: nolink*',
  ]);
  assert.deepEqual(stickerLines(null), []);
  assert.equal(
    pollText({ question: 'Pizza?', answers: ['Yes', { text: 'No', emoji: '👎' }, { text: '' }] }),
    '📊 **Poll:** Pizza?\n• Yes\n• 👎 No\n*Vote on the original server: polls do not cross the bridge.*'
  );
  assert.equal(pollText(null), '');
});

test('files are uploaded only within the per-file, total and count limits, the rest are links', () => {
  const MB = 1024 * 1024;
  const att = (name, size) => ({ name, url: `https://cdn/${name}`, size });
  const plan = planAttachments([
    att('a', 1 * MB),
    att('b', 9 * MB),
    att('c', 7 * MB),
    att('d', 2 * MB),
    att('e', 0),
  ]);
  assert.deepEqual(
    plan.upload.map((a) => a.name),
    ['a', 'c'],
    'a (1) + c (7) = 8 MB; d would pass the total'
  );
  assert.deepEqual(
    plan.links.map((a) => a.name),
    ['b', 'd', 'e']
  );
  assert.deepEqual(
    planAttachments([att('a', 5)], { upload: false }).links.map((a) => a.name),
    ['a']
  );
  const many = planAttachments(Array.from({ length: 14 }, (_, i) => att(`f${i}`, 10)));
  assert.equal(many.upload.length, FILE_COUNT_LIMIT);
  assert.equal(many.links.length, 4);
  assert.equal(FILE_BYTES_LIMIT, 8 * MB);
  assert.equal(TOTAL_BYTES_LIMIT, 8 * MB);
  assert.deepEqual(fileLinkLines([att('a b.png', 3)]), ['📎 a b.png: https://cdn/a b.png']);
});

test('only rich embeds cross, as plain API objects, with their text made harmless and their limits kept', () => {
  assert.equal(plainEmbed({ type: 'link', url: 'https://x', title: 'preview' }), null);
  assert.equal(plainEmbed({ type: 'image', url: 'https://x/a.png' }), null);
  assert.equal(plainEmbed({ type: 'rich' }), null, 'an empty embed is nothing');
  const up = (t) => t.toUpperCase();
  const embed = plainEmbed(
    {
      type: 'rich',
      title: 'Hi',
      description: 'there',
      url: 'javascript:alert(1)',
      color: 255,
      timestamp: '2030-01-01T00:00:00.000Z',
      author: { name: 'me', iconURL: 'https://x/a.png' },
      footer: { text: 'f', iconUrl: 'https://x/f.png' },
      image: { url: 'https://x/i.png' },
      thumbnail: { url: 'ftp://nope' },
      fields: [
        { name: 'n', value: 'v' },
        { name: '', value: 'x' },
      ],
    },
    up
  );
  assert.deepEqual(embed, {
    title: 'HI',
    description: 'THERE',
    color: 255,
    timestamp: '2030-01-01T00:00:00.000Z',
    footer: { text: 'F', icon_url: 'https://x/f.png' },
    image: { url: 'https://x/i.png' },
    author: { name: 'ME', icon_url: 'https://x/a.png' },
    fields: [{ name: 'N', value: 'V', inline: false }],
  });
  assert.equal(
    plainEmbed({ toJSON: () => ({ type: 'rich', title: 't' }) }).title,
    't',
    'a discord.js embed class'
  );
  assert.equal(
    plainEmbeds(Array.from({ length: 14 }, () => ({ type: 'rich', title: 't' }))).length,
    EMBED_LIMIT
  );
  assert.deepEqual(plainEmbeds(null), []);
});

test('text is cut to the limit without half an emoji, and parts join without blank lines', () => {
  assert.equal(clip('abcdef', 4), 'abc…');
  assert.equal(clip('ab😀cd', 4), 'ab…', 'a surrogate pair is not cut in two');
  assert.equal(clip('short', 10), 'short');
  assert.equal(joinParts(['a', '', null, ' b ', undefined, 'c']), 'a\nb\nc');
  assert.equal(joinParts(['x'.repeat(5000)]).length, MESSAGE_LIMIT);
});

test('options are always booleans, bots and joins are off by default, files are copied by default', () => {
  assert.deepEqual(normaliseOptions(undefined), { bots: false, joinMessages: false, uploadFiles: true });
  assert.deepEqual(normaliseOptions({}), { bots: false, joinMessages: false, uploadFiles: true });
  assert.deepEqual(normaliseOptions({ bots: 'yes', joinMessages: 1, uploadFiles: 'no' }), {
    bots: false,
    joinMessages: false,
    uploadFiles: false,
  });
  assert.deepEqual(normaliseOptions({ bots: true, joinMessages: true, uploadFiles: true, extra: 1 }), {
    bots: true,
    joinMessages: true,
    uploadFiles: true,
  });
  assert.deepEqual(normaliseOptions('junk'), { bots: false, joinMessages: false, uploadFiles: true });
});

test('the content hash tells a changed text from an unchanged one', () => {
  assert.equal(hashContent('a'), hashContent('a'));
  assert.notEqual(hashContent('a'), hashContent('b'));
  assert.equal(hashContent(null), hashContent(''));
});
