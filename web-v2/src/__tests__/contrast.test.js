// The colour pairs the dashboard UX pass added or leaned on, checked against the WCAG AA text contrast
// (4.5:1) in both themes. Every value is read from the style sheets themselves (the :root blocks of
// styles.css and dashux.css), none is written down here, so a changed token is checked as it changes.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(here, '..', name), 'utf8').replace(/\r\n/g, '\n');
const css = `${read('styles.css')}\n${read('dashux.css')}`;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The plain #rrggbb custom properties of every block that starts a line with `selector {`, merged. */
function tokens(selector) {
  const out = {};
  const block = new RegExp(`^${escapeRe(selector)} \\{([^}]*)\\}`, 'gm');
  for (const [, body] of css.matchAll(block)) {
    for (const m of body.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\b/g)) out[m[1]] = m[2];
  }
  return out;
}
const dark = tokens(':root');
const light = { ...dark, ...tokens(":root[data-theme='light']") };

/** The five rarity colours of the shop pills, from the style sheet. */
const rarities = Object.fromEntries(
  [...css.matchAll(/\.v2-rarity\.is-([a-z]+) \{\s*--rarity: (#[0-9a-fA-F]{6});/g)].map((m) => [m[1], m[2]])
);

const channels = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const lum = (hex) => {
  const [r, g, b] = channels(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** `fg` at `percent` over `bg`, as #rrggbb (what color-mix(in srgb, fg percent, transparent) shows). */
const over = (fg, bg, percent) => {
  const mixed = channels(fg).map((v, i) =>
    Math.round((v * percent + channels(bg)[i] * (100 - percent)) / 100)
  );
  return `#${mixed.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
};

describe('contrast of the colours added by the dashboard UX pass', () => {
  it('reads the tokens it checks from the style sheets', () => {
    for (const t of [dark, light]) {
      for (const token of [
        '--accent',
        '--on-accent',
        '--bg-main',
        '--bg-surface',
        '--text',
        '--text-muted',
        '--success',
        '--warn',
        '--danger',
      ]) {
        expect(t[token], token).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
    }
    expect(dark['--accent']).not.toBe(light['--accent']);
    expect(dark['--on-accent']).not.toBe(light['--on-accent']);
    expect(Object.keys(rarities).sort()).toEqual(['common', 'epic', 'legendary', 'rare', 'uncommon']);
  });

  for (const [name, t] of [
    ['dark', dark],
    ['light', light],
  ]) {
    it(`${name}: text on the accent fill (primary buttons, the open tab, count pills)`, () => {
      expect(ratio(t['--on-accent'], t['--accent'])).toBeGreaterThanOrEqual(4.5);
    });

    it(`${name}: status colours read as text on the card surface`, () => {
      for (const token of ['--success', '--warn', '--danger', '--text-muted']) {
        expect(ratio(t[token], t['--bg-surface']), token).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`${name}: the warning count pill (page background on the warning colour)`, () => {
      expect(ratio(t['--bg-main'], t['--warn'])).toBeGreaterThanOrEqual(4.5);
    });

    it(`${name}: the text of a rarity pill on its tinted fill`, () => {
      for (const [key, color] of Object.entries(rarities)) {
        expect(ratio(t['--text'], over(color, t['--bg-surface'], 16)), key).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});
