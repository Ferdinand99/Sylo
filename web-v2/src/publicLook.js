// The server's own look on the public member pages, on the page side (the server's half is
// src/lib/publicLook.js, which has the last word; the contrast rules below are the same, so the settings preview can
// say at once what a colour will do). Two things:
//   - useServerLook(look): the pages a member opens inside the dashboard (the application form, the web shop)
//     load the server's style sheet (custom properties only) and mark <body>, the same way the server renders the
//     appeal, quote and leaderboard pages (the event pages take no look: they carry no server address).
//   - the accent rules the "Public pages" settings preview uses.
import { useEffect } from 'react';

export const SYLO_ACCENT = { dark: '#38c8f0', light: '#076787' };
/** The card behind the form, per theme (--bg-surface). */
export const CARD = { dark: '#161618', light: '#ffffff' };
/** The least contrast of an accent against the card (3:1, see src/lib/publicLook.js). */
export const MIN_CONTRAST = 3;
/** WCAG AA for text, what accent text is held to. */
export const MIN_TEXT_CONTRAST = 4.5;
/** The page colour behind the card, per theme. */
export const PAGE = { dark: '#0b0b0d', light: '#f5f5f7' };

/** '#rrggbb' in lower case, '' for none, null when it is not a colour. */
export function normaliseAccent(value) {
  if (value == null) return '';
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '') return '';
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (!m) return null;
  let hex = m[1].toLowerCase();
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join('');
  return `#${hex}`;
}

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const hex2 = (n) =>
  Math.round(Math.min(255, Math.max(0, n)))
    .toString(16)
    .padStart(2, '0');
const channels = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** The colour `t` of the way from `a` to `b`, both '#rrggbb'. */
export function mixHex(a, b, t) {
  const [x, y] = [channels(a), channels(b)];
  return `#${x.map((c, i) => hex2(c + (y[i] - c) * t)).join('')}`;
}

/** The accent as a text colour in a theme (the same rule as the server: 4.5:1 on card, page and tinted card). */
export function accentText(accent, theme) {
  const backs = [CARD[theme], PAGE[theme], mixHex(CARD[theme], accent, 0.14)];
  const ok = (c) => backs.every((b) => contrast(c, b) >= MIN_TEXT_CONTRAST);
  if (ok(accent)) return accent;
  const target = theme === 'dark' ? '#ffffff' : '#000000';
  for (let t = 0.02; t < 1; t += 0.02) {
    const c = mixHex(accent, target, t);
    if (ok(c)) return c;
  }
  return target;
}

/** The text colour on a fill of this accent. */
export const onAccent = (accent) =>
  contrast(accent, '#ffffff') >= contrast(accent, '#000000') ? '#ffffff' : '#000000';

/** What a colour comes to per theme: the colour really used and whether Sylo's own replaced it. */
export function accentOutcome(accent) {
  const out = {};
  for (const theme of ['dark', 'light']) {
    const ratio = accent ? contrast(accent, CARD[theme]) : null;
    const ok = !accent || ratio >= MIN_CONTRAST;
    out[theme] = {
      ratio: ratio == null ? null : Math.round(ratio * 100) / 100,
      ok,
      color: accent && ok ? accent : SYLO_ACCENT[theme],
      text: accent && ok ? accentText(accent, theme) : SYLO_ACCENT[theme],
    };
  }
  return out;
}

/** The sentence for a colour that is replaced in a theme, or null. */
export function accentNote(accent) {
  if (!accent) return null;
  const out = accentOutcome(accent);
  const bad = ['dark', 'light'].filter((t) => !out[t].ok);
  if (bad.length === 0) return null;
  const where = bad.length === 2 ? 'both the light and the dark theme' : `the ${bad[0]} theme`;
  return `This colour is too hard to read on the card in ${where}, so public pages use Sylo's own colour there. Pick a darker or lighter shade.`;
}

/**
 * Load the server's look for the page that is open: its style sheet and the marks on <body> that the dim
 * overlay and the panel hang on (styles/p3-look.css). `look` is `{ css, image }` from the page's data, or
 * null for plain Sylo. Undone when the page closes.
 */
export function useServerLook(look) {
  const css = look?.css ?? null;
  const image = Boolean(look?.image);
  useEffect(() => {
    if (!css || !/^\/look\/[a-z0-9-]+\.[0-9a-f]{16}\.css$/.test(css)) return undefined;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = css;
    document.head.appendChild(link);
    const marks = image ? ['has-look', 'has-look-image'] : ['has-look'];
    document.body.classList.add(...marks);
    return () => {
      link.remove();
      document.body.classList.remove(...marks);
    };
  }, [css, image]);
}
