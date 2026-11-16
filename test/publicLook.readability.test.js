// What a server's look may NOT do to readability. The accent is held to 3:1 for fills, borders and focus rings; where
// it is used as TEXT the pages use --accent-text, which is the accent or the same hue lightened (dark theme) or
// darkened (light theme) until it reaches 4.5:1 on the card, the page and the accent-tinted card. The text on a
// button fill, also hovered, keeps 4.5:1. Over a background picture Sylo's own text keeps 4.5:1 on the panel and on
// the top bar's glass, whatever the picture is. Values are read from the style sheets themselves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CARD,
  PAGE,
  accentHover,
  accentText,
  contrast,
  effectiveAccentText,
  lookCss,
  mixHex,
  normaliseAccent,
  onAccent,
  accentCheck,
} from '../src/lib/publicLook.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// A sweep over the colour wheel at several lightnesses, plus the colours that tend to break rules.
const sweep = [];
for (let r = 0; r <= 255; r += 51)
  for (let g = 0; g <= 255; g += 51)
    for (let b = 0; b <= 255; b += 51) {
      sweep.push(`#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`);
    }
const edge = [
  '#5865f2',
  '#757575',
  '#787878',
  '#ffe14d',
  '#1a2a6c',
  '#ff0000',
  '#00ff00',
  '#0000ff',
  '#07a',
  '#cc2266',
];
const colours = [...new Set([...sweep, ...edge.map(normaliseAccent)])];

test('accent text reaches 4.5:1 on the card, the page and both tinted backgrounds in both themes, for every colour', () => {
  for (const c of colours) {
    for (const theme of ['dark', 'light']) {
      const text = accentText(c, theme);
      const tint = mixHex(CARD[theme], c, 0.14);
      const pageTint = mixHex(PAGE[theme], c, 0.14); // the active period pill sits on the page or the panel
      for (const [name, back] of [
        ['card', CARD[theme]],
        ['page', PAGE[theme]],
        ['card tint', tint],
        ['page tint', pageTint],
      ]) {
        assert.ok(
          contrast(text, back) >= 4.5,
          `${c} as ${theme} text on the ${name}: ${text} ${contrast(text, back)}`
        );
      }
    }
  }
});

test('blurple stays blurple-ish: the same hue, lightened on the dark theme and darkened on the light one', () => {
  const dark = accentText('#5865f2', 'dark');
  const light = accentText('#5865f2', 'light');
  assert.notEqual(dark, '#5865f2', 'it is 3.9:1 on the dark card: not enough for text');
  assert.ok(contrast(dark, '#161618') >= 4.5 && contrast(dark, '#0b0b0d') >= 4.5);
  assert.ok(contrast(light, '#ffffff') >= 4.5 && contrast(light, '#f5f5f7') >= 4.5);
  // lighter than the accent in dark, darker in light
  assert.ok(contrast(dark, '#000000') > contrast('#5865f2', '#000000'));
  assert.ok(contrast(light, '#ffffff') > contrast('#5865f2', '#ffffff'));
  // a colour that already reads as text is kept as it is
  assert.equal(accentText('#ffe14d', 'dark'), '#ffe14d');
  assert.equal(accentText('#1a2a6c', 'light'), '#1a2a6c');
});

test('the text on a button fill reaches 4.5:1, also hovered, for every colour', () => {
  for (const c of colours) {
    const text = onAccent(c);
    assert.ok(contrast(c, text) >= 4.5, `${c} with ${text}`);
    assert.ok(contrast(accentHover(c), text) >= 4.5, `${c} hovered with ${text}: ${accentHover(c)}`);
  }
  // the example from the review: a grey that is 4.61:1 with white must not drop below 4.5 on hover
  assert.ok(contrast('#757575', '#ffffff') >= 4.5);
  assert.ok(contrast(accentHover('#757575'), onAccent('#757575')) >= 4.5);
});

test('the style sheet gives each theme where the accent is used its fill, button text, hover and text colour', () => {
  const css = lookCss({ accent: '#5865f2', imageUrl: null });
  const dark = /^:root \{ (.*) \}$/m.exec(css)[1];
  const light = /^:root\[data-theme='light'\] \{ (.*) \}$/m.exec(css)[1];
  for (const [block, theme] of [
    [dark, 'dark'],
    [light, 'light'],
  ]) {
    assert.match(block, /--accent: #5865f2;/);
    assert.ok(block.includes(`--on-accent: ${onAccent('#5865f2')};`));
    assert.ok(block.includes(`--accent-hover: ${accentHover('#5865f2')};`));
    assert.ok(block.includes(`--accent-text: ${accentText('#5865f2', theme)};`));
  }
  // a theme where the accent is not used keeps Sylo's own text colour too
  assert.deepEqual(effectiveAccentText('#1a2a6c').dark, '#38c8f0');
  assert.equal(effectiveAccentText('#1a2a6c').light, accentText('#1a2a6c', 'light'));
  assert.deepEqual(accentCheck('#1a2a6c').fallback, ['dark']);
});

test('a stored accent that is not a colour this code wrote never reaches a style sheet', () => {
  for (const bad of ['red', '#fff', '#FFFFFF', '#12345g', '#fff;} body{display:none', 'url(x)', '#1234567']) {
    assert.throws(() => lookCss({ accent: bad, imageUrl: null }), /bad look accent/, bad);
  }
  assert.doesNotThrow(() => lookCss({ accent: '', imageUrl: null }));
});

// --- text on the panel and on the top bar over a picture ---------------------------------------------------------

function tokens(css, selector) {
  const out = {};
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const [, body] of css.matchAll(new RegExp(`^${esc} \\{([^}]*)\\}`, 'gm'))) {
    for (const m of body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  }
  return out;
}
const hex = (c) => `#${c.map((n) => Math.round(n).toString(16).padStart(2, '0')).join('')}`;
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const over = (fg, alpha, bg) => fg.map((c, i) => c * alpha + bg[i] * (1 - alpha));

const publicCss = read('src/web/public/public.css');
const lookCssFile = read('web-v2/src/styles/p3-look.css');
const dashCss = read('web-v2/src/styles.css');

for (const [name, css] of [
  ['public.css (server-rendered pages)', publicCss],
  ['p3-look.css (dashboard member pages)', lookCssFile],
]) {
  const base = { ...tokens(css, ':root') };
  const lightLook = { ...base, ...tokens(css, ":root[data-theme='light']") };
  const darkTokens = tokens(publicCss, ':root');
  const lightTokens = { ...darkTokens, ...tokens(publicCss, ":root[data-theme='light']") };

  for (const theme of ['dark', 'light']) {
    test(`${name}: over the worst picture, ${theme} theme, Sylo's text on the panel keeps 4.5:1`, () => {
      const look = theme === 'dark' ? base : lightLook;
      const t = theme === 'dark' ? darkTokens : lightTokens;
      const dim = /rgba\((\d+), (\d+), (\d+), ([\d.]+)\)/.exec(look['--look-dim']);
      const veil = [Number(dim[1]), Number(dim[2]), Number(dim[3])];
      const veilAlpha = Number(dim[4]);
      const panel = Number.parseFloat(look['--look-panel']) / 100;
      assert.ok(panel > 0 && panel <= 1);
      // The picture can be anything from black to white; the veil goes over it, the panel over that.
      for (const picture of [rgb('#000000'), rgb('#ffffff'), rgb('#808080')]) {
        const backdrop = over(veil, veilAlpha, picture);
        const surface = hex(over(rgb(t['--bg-main']), panel, backdrop));
        for (const token of ['--text', '--text-muted']) {
          const ratio = contrast(t[token], surface);
          assert.ok(ratio >= 4.5, `${token} on the panel over ${hex(picture)}: ${ratio.toFixed(2)}`);
        }
      }
    });
  }
}

test('over a picture the top bar glass is always on, and its text keeps 4.5:1 on it, whatever the picture', () => {
  assert.match(lookCssFile, /body\.has-look-image \.v2-topbar::before \{\s*opacity: 1;/);
  const glass = { dark: [11, 11, 13, 0.72], light: [245, 245, 247, 0.72] };
  const dashDark = tokens(dashCss, ':root');
  const dashLight = { ...dashDark, ...tokens(dashCss, ":root[data-theme='light']") };
  const look = {
    dark: tokens(lookCssFile, ':root'),
    light: tokens(lookCssFile, ":root[data-theme='light']"),
  };
  for (const theme of ['dark', 'light']) {
    const t = theme === 'dark' ? dashDark : dashLight;
    const dim = /rgba\((\d+), (\d+), (\d+), ([\d.]+)\)/.exec(
      look[theme]['--look-dim'] ?? look.dark['--look-dim']
    );
    const veil = [Number(dim[1]), Number(dim[2]), Number(dim[3])];
    for (const picture of [rgb('#000000'), rgb('#ffffff'), rgb('#808080')]) {
      const backdrop = over(veil, Number(dim[4]), picture);
      const [r, g, b, a] = glass[theme];
      const surface = hex(over([r, g, b], a, backdrop));
      assert.ok(contrast(t['--text'], surface) >= 4.5, `${theme} brand text over ${hex(picture)}`);
    }
  }
});

test('the accent is read as text only through --accent-text', () => {
  assert.match(publicCss, /^a \{\s*color: var\(--accent-text\);/m);
  assert.match(publicCss, /\.lb-periods a\.on \{[^}]*color: var\(--accent-text\);/);
  assert.match(publicCss, /\.lb-top \.lb-rank \{\s*color: var\(--accent-text\);/);
  assert.match(dashCss, /^a \{\s*color: var\(--accent-text, var\(--accent\)\);/m);
  assert.match(publicCss, /\.btn:hover \{\s*background: var\(--accent-hover\);/);
});

// --- the cascade: a theme where the accent falls back keeps Sylo's own text colour ------------------------------

/**
 * The custom properties of a theme after the cascade over the given style sheets in order, "var(--x)" resolved:
 * `:root` counts for both themes, `:root[data-theme='light']` (more specific) only for the light one; at equal
 * specificity the later sheet wins.
 */
function cascade(theme, sheets) {
  const won = {};
  for (const css of sheets) {
    const blocks = [[1, tokens(css, ':root')]];
    if (theme === 'light') blocks.push([2, tokens(css, ":root[data-theme='light']")]);
    for (const [spec, map] of blocks) {
      for (const [name, value] of Object.entries(map)) {
        if (!won[name] || spec >= won[name].spec) won[name] = { spec, value };
      }
    }
  }
  const resolve = (name, depth = 0) => {
    const raw = won[name]?.value;
    if (raw == null || depth > 8) return raw;
    const ref = /^var\((--[a-z0-9-]+)\)$/.exec(raw);
    return ref ? resolve(ref[1], depth + 1) : raw;
  };
  return (name) => resolve(name);
}

const SYLO = { dark: '#38c8f0', light: '#076787' };
const surfaces = {
  'the server-rendered pages': [publicCss],
  'the dashboard pages': [dashCss, read('web-v2/src/dashux.css')],
};

for (const [where, sheets] of Object.entries(surfaces)) {
  for (const accent of ['#ffe14d', '#00ff00', '#1a2a6c', '#5865f2']) {
    for (const theme of ['dark', 'light']) {
      test(`${where}: ${accent} in the ${theme} theme resolves its text colour like the rule says`, () => {
        const look = lookCss({ accent, imageUrl: null });
        const get = cascade(theme, [...sheets, look]);
        const used = accentCheck(accent)[theme].ok;
        const accentTextHere = get('--accent-text');
        if (used) {
          assert.equal(get('--accent'), accent);
          assert.equal(accentTextHere, accentText(accent, theme));
        } else {
          // the accent falls back here: Sylo's own colour, for the fill AND for text and hover
          assert.equal(get('--accent'), SYLO[theme]);
          assert.equal(accentTextHere, SYLO[theme], `${accent} leaked into ${theme} as text`);
        }
        assert.ok(contrast(accentTextHere, CARD[theme]) >= 4.5, `${accent} ${theme} link on the card`);
        assert.ok(contrast(accentTextHere, PAGE[theme]) >= 4.5, `${accent} ${theme} link on the page`);
      });
    }
  }
}
