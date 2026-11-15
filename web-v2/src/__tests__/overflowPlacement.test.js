import { describe, expect, it } from 'vitest';
import { menuPlacement } from '../components/overflowPlacement.js';

const size = { width: 160, height: 172 };
const rect = (left, top, w = 40, h = 36) => ({ left, top, right: left + w, bottom: top + h });

describe('menuPlacement', () => {
  it('lines the menu up with the right edge of the trigger and opens below it', () => {
    const out = menuPlacement(rect(1280, 300), size, { width: 1600, height: 900 });
    expect(out).toEqual({ left: 1320 - 160, top: 336 + 4 });
  });

  it('keeps 8 px from the left edge when the trigger is near it (a phone)', () => {
    // the trigger ends at x = 150, so a right-aligned 160 px menu would start at x = -10
    const out = menuPlacement(rect(110, 400), size, { width: 390, height: 844 });
    expect(out.left).toBe(8);
  });

  it('never crosses the right edge either', () => {
    const out = menuPlacement(rect(350, 100), size, { width: 390, height: 844 });
    expect(out.left + size.width).toBeLessThanOrEqual(390 - 8);
    expect(out.left).toBe(390 - 160 - 8);
  });

  it('puts a menu wider than the window at the left margin', () => {
    expect(menuPlacement(rect(60, 100), size, { width: 150, height: 600 }).left).toBe(8);
  });

  it('opens above the trigger when there is no room below and more room above', () => {
    const out = menuPlacement(rect(200, 800), size, { width: 390, height: 844 });
    expect(out.top).toBe(800 - 4 - size.height);
  });

  it('keeps the menu inside the window when it fits on neither side', () => {
    const out = menuPlacement(rect(200, 100), size, { width: 390, height: 260 });
    expect(out.top).toBeGreaterThanOrEqual(8);
    expect(out.top + size.height).toBeLessThanOrEqual(260 - 8);
  });

  it('stays at least 8 px inside the window on every side, wherever the trigger is', () => {
    const viewport = { width: 390, height: 844 };
    for (let x = 0; x <= 350; x += 25) {
      for (let y = 0; y <= 808; y += 40) {
        const { left, top } = menuPlacement(rect(x, y), size, viewport);
        expect(left, `x=${x}`).toBeGreaterThanOrEqual(8);
        expect(left + size.width, `x=${x}`).toBeLessThanOrEqual(viewport.width - 8);
        expect(top, `y=${y}`).toBeGreaterThanOrEqual(8);
        expect(top + size.height, `y=${y}`).toBeLessThanOrEqual(viewport.height - 8);
      }
    }
  });
});
