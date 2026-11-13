// The colour pairs the dashboard UX pass added or leaned on, checked against the WCAG AA text contrast
// (4.5:1) in both themes, from the tokens in the style sheets themselves.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(here, '..', name), 'utf8');
const css = `${read('styles.css')}\n${read('dashux.css')}`;

/** The custom properties declared in the first block that starts with `selector {`. */
function tokens(selector) {
  const start = css.indexOf(`${selector} {`);
  const body = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries(
    [...body.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map((m) => [m[1], m[2]])
  );
}
const dark = tokens(':root');
const light = { ...dark, ...tokens(":root[data-theme='light']") };
// dashux.css declares --on-accent in its own :root blocks, after the main ones
const onAccent = { dark: '#04141a', light: '#ffffff' };

const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe('contrast of the colours added by the dashboard UX pass', () => {
  it('reads the tokens it checks', () => {
    expect(dark['--accent']).toBe('#38c8f0');
    expect(light['--accent']).toBe('#076787');
    expect(css).toContain(`--on-accent: ${onAccent.dark}`);
    expect(css).toContain(`--on-accent: ${onAccent.light}`);
  });

  for (const [name, t, on] of [
    ['dark', dark, onAccent.dark],
    ['light', light, onAccent.light],
  ]) {
    it(`${name}: text on the accent fill (primary buttons, count pills)`, () => {
      expect(ratio(on, t['--accent'])).toBeGreaterThanOrEqual(4.5);
    });

    it(`${name}: status colours read as text on the card surface`, () => {
      for (const token of ['--success', '--warn', '--danger', '--text-muted']) {
        expect(ratio(t[token], t['--bg-surface']), token).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`${name}: the warning count pill (page background on the warning colour)`, () => {
      expect(ratio(t['--bg-main'], t['--warn'])).toBeGreaterThanOrEqual(4.5);
    });
  }
});
