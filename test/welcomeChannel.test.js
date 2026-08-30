import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WC_PRESETS,
  normaliseWelcomeChannelConfig,
  substitutePlaceholders,
  resolveWelcomeSpec,
} from '../src/modules/welcomeChannel.js';

test('WC_PRESETS: every preset makes a valid element with a kind', () => {
  assert.ok(WC_PRESETS.length >= 8);
  for (const p of WC_PRESETS) {
    const e = p.make();
    assert.ok(e.kind === 'embed' || e.kind === 'banner', `${p.id} kind`);
  }
});

test('normaliseWelcomeChannelConfig: validates ids, clamps, sanitises embeds', () => {
  const c = normaliseWelcomeChannelConfig({
    channelId: 'nope',
    messageId: '123456789012345678',
    spec: {
      content: 'x'.repeat(5000),
      embeds: [
        { kind: 'banner', image: 'https://cdn/a.png', title: 'ignored-on-banner-but-kept' },
        { kind: 'embed', title: 'Hi', color: '5865f2', image: 'ftp://bad', thumbnail: 'https://t/1.png' },
        ...Array.from({ length: 20 }, () => ({ kind: 'embed', description: 'd' })),
      ],
    },
  });
  assert.equal(c.channelId, '');
  assert.equal(c.messageId, '123456789012345678');
  assert.equal(c.spec.content.length, 2000);
  assert.equal(c.spec.embeds.length, 10); // capped
  assert.equal(c.spec.embeds[0].kind, 'banner');
  assert.equal(c.spec.embeds[0].image, 'https://cdn/a.png');
  assert.equal(c.spec.embeds[1].color, '#5865f2'); // hash added
  assert.equal(c.spec.embeds[1].image, ''); // non-http rejected
  assert.equal(c.spec.embeds[1].thumbnail, 'https://t/1.png');
});

test('substitutePlaceholders / resolveWelcomeSpec: fills server placeholders', () => {
  const guild = { name: 'Priv Stuff', id: '999', memberCount: 42 };
  assert.equal(substitutePlaceholders('Welcome to {server} ({memberCount})', guild), 'Welcome to Priv Stuff (42)');

  const cfg = normaliseWelcomeChannelConfig({
    spec: { content: '{server}', embeds: [{ kind: 'embed', title: 'Hi {server}', description: '{memberCount} members' }] },
  });
  const spec = resolveWelcomeSpec(cfg, guild);
  assert.equal(spec.content, 'Priv Stuff');
  assert.equal(spec.embeds[0].title, 'Hi Priv Stuff');
  assert.equal(spec.embeds[0].description, '42 members');
});
