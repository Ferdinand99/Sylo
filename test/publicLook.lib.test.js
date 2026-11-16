// The pure rules of a server's look on its public pages (src/lib/publicLook.js): what counts as an accent colour,
// the contrast check against the card in both themes with the fallback to Sylo's own colour, and the style sheet,
// which may carry custom properties only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CARD,
  MIN_CONTRAST,
  SYLO_ACCENT,
  accentCheck,
  contrast,
  effectiveAccent,
  fallbackNote,
  keyOfSlug,
  lookCss,
  lookHash,
  normaliseAccent,
  onAccent,
  slugOf,
} from '../src/lib/publicLook.js';

test('an accent is #rgb or #rrggbb, with or without the hash, in any case; empty is none; the rest is refused', () => {
  assert.equal(normaliseAccent('#5865F2'), '#5865f2');
  assert.equal(normaliseAccent('5865f2'), '#5865f2');
  assert.equal(normaliseAccent(' #abc '), '#aabbcc');
  assert.equal(normaliseAccent(''), '');
  assert.equal(normaliseAccent(null), '');
  assert.equal(normaliseAccent(undefined), '');
  for (const bad of [
    'red',
    '#12',
    '#12345',
    '#1234567',
    '#gggggg',
    'rgb(1,2,3)',
    'url(x)',
    '#fff;}body{display:none',
    "#fff' onload='x",
    {},
    ['#fff'],
  ]) {
    assert.equal(normaliseAccent(bad), null, JSON.stringify(bad));
  }
});

test('contrast is the WCAG ratio', () => {
  assert.equal(Math.round(contrast('#000000', '#ffffff')), 21);
  assert.equal(contrast('#777777', '#777777'), 1);
  assert.ok(contrast('#ffffff', '#767676') > 4.5 && contrast('#ffffff', '#767676') < 4.6);
});

test("an accent is checked against the card of each theme; where it is too faint Sylo's own colour is used", () => {
  // Sylo's own colours pass on their card.
  assert.deepEqual(accentCheck('').fallback, []);
  assert.ok(contrast(SYLO_ACCENT.dark, CARD.dark) >= MIN_CONTRAST);
  assert.ok(contrast(SYLO_ACCENT.light, CARD.light) >= MIN_CONTRAST);
  // A deep blue reads on the white card but not on the dark one; a pale yellow the other way round.
  const blue = accentCheck('#1a2a6c');
  assert.deepEqual(blue.fallback, ['dark']);
  assert.equal(blue.light.ok, true);
  const yellow = accentCheck('#ffe14d');
  assert.deepEqual(yellow.fallback, ['light']);
  assert.equal(yellow.dark.ok, true);
  // A mid-tone such as Discord's blurple reads on both cards. No colour reaches 4.5:1 on both, so 3:1 is the bar.
  assert.deepEqual(accentCheck('#5865f2').fallback, []);
  assert.ok(!(contrast('#5865f2', CARD.dark) >= 4.5 && contrast('#5865f2', CARD.light) >= 4.5));

  assert.deepEqual(effectiveAccent('#1a2a6c'), { dark: SYLO_ACCENT.dark, light: '#1a2a6c' });
  assert.deepEqual(effectiveAccent('#ffe14d'), { dark: '#ffe14d', light: SYLO_ACCENT.light });
  assert.deepEqual(effectiveAccent(''), SYLO_ACCENT);

  assert.match(fallbackNote('#1a2a6c'), /too hard to read on the card/);
  assert.match(fallbackNote('#1a2a6c'), /the dark theme/);
  assert.match(fallbackNote('#1a2a6c'), /Sylo's own colour/);
  assert.equal(fallbackNote('#5865f2'), null, 'a readable accent needs no note');
  assert.equal(fallbackNote(''), null);
});

test('the text on an accent fill is white or near-black, whichever reads better', () => {
  assert.equal(onAccent('#ffe14d'), '#000000');
  assert.equal(onAccent('#1a2a6c'), '#ffffff');
  for (const c of ['#5865f2', '#ff0000', '#00ff00', '#808080', '#787878', '#123456', '#fedcba']) {
    assert.ok(contrast(c, onAccent(c)) >= 4.5, c);
  }
});

test('the style sheet holds custom properties only, and the accent only in the themes where it is readable', () => {
  const both = lookCss({ accent: '#5865f2', imageUrl: null });
  assert.match(
    both,
    /:root \{ --accent: #5865f2; --on-accent: #ffffff; --accent-hover: #[0-9a-f]{6}; --accent-text: #[0-9a-f]{6}; \}/
  );
  assert.match(both, /:root\[data-theme='light'\] \{ --accent: #5865f2;/);
  assert.doesNotMatch(both, /--look-image/);

  const darkOnly = lookCss({ accent: '#ffe14d', imageUrl: null });
  assert.match(darkOnly, /:root \{ --accent: #ffe14d;/);
  assert.doesNotMatch(darkOnly, /data-theme/);

  const lightOnly = lookCss({ accent: '#1a2a6c', imageUrl: null });
  assert.doesNotMatch(lightOnly, /^:root \{/m, "too dark for the dark card: Sylo's own colour stays there");
  assert.match(lightOnly, /data-theme='light'\] \{ --accent: #1a2a6c/);

  const image = lookCss({ accent: '', imageUrl: '/look/123456789012345678.0123456789abcdef.webp' });
  assert.doesNotMatch(image, /--accent/);
  assert.match(image, /--look-image: url\('\/look\/123456789012345678\.0123456789abcdef\.webp'\)/);
  // Only custom properties: no selector other than :root, nothing but "--name: value" inside.
  for (const css of [both, darkOnly, lightOnly, image]) {
    for (const line of css.split('\n').filter((l) => l && !l.startsWith('/*'))) {
      assert.match(line, /^:root(\[data-theme='light'\])? \{( --[a-z-]+: [^;{}]+;)+ \}$/, line);
    }
  }
  for (const url of [
    'https://evil.example/x.webp',
    "/look/x');}body{x:y",
    '/look/../../etc.webp',
    '//evil/x.webp',
  ]) {
    assert.throws(() => lookCss({ accent: '', imageUrl: url }), /bad look image address/, url);
  }
});

test('the hash of a look changes with the accent and the picture, and not otherwise', () => {
  const a = lookHash({ accent: '#0a5c36', imageHash: '' });
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(lookHash({ accent: '#0a5c36', imageHash: '' }), a);
  assert.notEqual(lookHash({ accent: '#0a5c37', imageHash: '' }), a);
  assert.notEqual(lookHash({ accent: '#0a5c36', imageHash: 'abc' }), a);
});

test('a server key is a slug in an address and back; anything else is not a key', () => {
  assert.equal(slugOf('900000000000000123'), '900000000000000123');
  assert.equal(slugOf('fluxer:123'), 'fluxer-123');
  assert.equal(keyOfSlug('900000000000000123'), '900000000000000123');
  assert.equal(keyOfSlug('fluxer-123'), 'fluxer:123');
  for (const bad of ['', 'x', 'fluxer-', 'discord-1', '../1', '1/2', 'FLUXER-1', '1'.repeat(26)]) {
    assert.equal(keyOfSlug(bad), null, bad);
  }
});
