// The server's own look on the public member pages (the application form, the ban appeal, the event and quote
// pages, the web shop): an accent colour and a background, and nothing else. The community owns the content,
// Sylo owns the frame: the layout, the typography, the components, the light and dark themes and the
// readability stay Sylo's, and every page ends with a "Powered by Sylo" link that cannot be turned off.
//
// This file is the pure part: checking an accent colour, the contrast rule, and the style sheet a page loads.
// The style sheet carries custom properties only (--accent, --on-accent, --look-image). Everything that uses
// them (the card, the dim overlay, the buttons) is written once in Sylo's own style sheets, so a server cannot
// change a rule, only the two values the rules read.
import { createHash } from 'node:crypto';

/** What a server may choose for its background. */
export const BACKGROUNDS = Object.freeze(['none', 'upload', 'discord-splash']);

/** Sylo's own accent per theme (public.css and the dashboard's styles.css), the fallback. */
export const SYLO_ACCENT = Object.freeze({ dark: '#38c8f0', light: '#076787' });
/** The colour of the card the form sits on, per theme (--bg-surface). */
export const CARD = Object.freeze({ dark: '#161618', light: '#ffffff' });
/**
 * The least contrast an accent needs against the card: 3:1, the WCAG minimum for interface elements and large text
 * (links on these pages are underlined). No colour reaches 4.5:1 on both the dark and the light card, so a higher bar
 * would send every server back to Sylo's colour in one theme; at 3:1 mid-tones such as #5865f2 read in both.
 * The text on a button fill is chosen separately and always reaches 4.5:1 (onAccent).
 */
export const MIN_CONTRAST = 3;

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * An accent as '#rrggbb' in lower case, '' for none, or null when it is not a colour.
 * @param {unknown} value
 * @returns {string | null}
 */
export function normaliseAccent(value) {
  if (value == null) return '';
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '') return '';
  const m = HEX.exec(text);
  if (!m) return null;
  let hex = m[1].toLowerCase();
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join('');
  return `#${hex}`;
}

function channels(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The relative luminance of a '#rrggbb' colour (WCAG 2). */
export function luminance(hex) {
  const [r, g, b] = channels(hex).map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The contrast ratio of two '#rrggbb' colours, 1 to 21. */
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The text colour on a fill of this accent (a button): black or white, whichever reads better (4.58:1 at worst). */
export function onAccent(accent) {
  return contrast(accent, '#ffffff') >= contrast(accent, '#000000') ? '#ffffff' : '#000000';
}

/**
 * Is the accent readable on the card, in each theme? `fallback` lists the themes where Sylo's own accent is
 * used instead, because this one would be too faint or too dark to read there.
 * @param {string} accent  '#rrggbb', or '' for none
 * @returns {{ dark: { ratio: number, ok: boolean }, light: { ratio: number, ok: boolean }, fallback: Array<'dark'|'light'> }}
 */
export function accentCheck(accent) {
  const out = { fallback: [] };
  for (const theme of ['dark', 'light']) {
    if (!accent) {
      out[theme] = { ratio: contrast(SYLO_ACCENT[theme], CARD[theme]), ok: true };
      continue;
    }
    const ratio = contrast(accent, CARD[theme]);
    const ok = ratio >= MIN_CONTRAST;
    out[theme] = { ratio: Math.round(ratio * 100) / 100, ok };
    if (!ok) out.fallback.push(theme);
  }
  return out;
}

/** The accent that is really used per theme (the chosen one where it is readable, else Sylo's). */
export function effectiveAccent(accent) {
  const check = accentCheck(accent);
  return {
    dark: accent && check.dark.ok ? accent : SYLO_ACCENT.dark,
    light: accent && check.light.ok ? accent : SYLO_ACCENT.light,
  };
}

/** The sentence that says Sylo's accent was used, or null when the chosen one is fine everywhere. */
export function fallbackNote(accent) {
  const { fallback } = accentCheck(accent);
  if (!accent || fallback.length === 0) return null;
  const where = fallback.length === 2 ? 'both the light and the dark theme' : `the ${fallback[0]} theme`;
  return `This colour is too hard to read on the card in ${where}, so public pages use Sylo's own colour there. Pick a darker or lighter shade.`;
}

/** A short hash of what makes a look: it is in the address of the style sheet, so a change is a new address. */
export function lookHash({ accent, imageHash }) {
  return createHash('sha256')
    .update(JSON.stringify([accent || '', imageHash || '']))
    .digest('hex')
    .slice(0, 16);
}

/** The short hash of a picture's bytes. */
export const imageHashOf = (data) => createHash('sha256').update(data).digest('hex').slice(0, 16);

/**
 * The style sheet of a look. Custom properties only: the accent in each theme where it is readable (Sylo's
 * own stays where it is not) and the background picture as a same-origin address.
 * @param {{ accent: string, imageUrl: string | null }} look
 */
export function lookCss({ accent, imageUrl }) {
  const lines = [
    "/* The look of one server's public pages: an accent colour and a background, nothing else. */",
  ];
  const check = accentCheck(accent);
  if (accent && check.dark.ok) {
    lines.push(`:root { --accent: ${accent}; --on-accent: ${onAccent(accent)}; }`);
  }
  if (accent && check.light.ok) {
    lines.push(`:root[data-theme='light'] { --accent: ${accent}; --on-accent: ${onAccent(accent)}; }`);
  }
  if (imageUrl) {
    // Only an address this site made (see src/web/routes/publicLook.js): never user text.
    if (!/^\/look\/[a-z0-9-]+\.[0-9a-f]{16}\.webp$/.test(imageUrl)) throw new Error('bad look image address');
    lines.push(`:root { --look-image: url('${imageUrl}'); }`);
  }
  return `${lines.join('\n')}\n`;
}

/** The slug of a server key in an address: "fluxer:123" is "fluxer-123". */
export const slugOf = (key) => String(key).replace(':', '-');
/** The server key a slug stands for, or null for a slug of the wrong shape. */
export function keyOfSlug(slug) {
  const m = /^(?:(fluxer)-)?(\d{1,25})$/.exec(String(slug));
  return m ? (m[1] ? `fluxer:${m[2]}` : m[2]) : null;
}
