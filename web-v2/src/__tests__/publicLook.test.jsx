import { render, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import MemberShell from '../components/MemberShell.jsx';
import PublicShell from '../components/PublicShell.jsx';
import {
  SYLO_ACCENT,
  accentNote,
  accentOutcome,
  contrast,
  normaliseAccent,
  onAccent,
  useServerLook,
} from '../publicLook.js';
// The server's own half of the same rules: the page must agree with it.
import * as server from '../../../src/lib/publicLook.js';

afterEach(() => {
  cleanup();
  document.head.querySelectorAll('link[rel=stylesheet]').forEach((l) => l.remove());
  document.body.className = '';
});

describe('the accent rules agree with the server', () => {
  const colours = ['#5865f2', '#ffe14d', '#1a2a6c', '#ff0000', '#787878', '#000000', '#ffffff', '#07a', ''];

  it('normalises the same way', () => {
    for (const c of [...colours, 'red', '#12', 'ABCDEF', ' #abc ', null, undefined, 5, ['#fff']]) {
      expect(normaliseAccent(c), String(c)).toBe(server.normaliseAccent(c));
    }
  });

  it('gives the same outcome per theme and the same sentence', () => {
    for (const raw of colours) {
      const c = normaliseAccent(raw);
      const mine = accentOutcome(c);
      const theirs = server.effectiveAccent(c);
      const check = server.accentCheck(c);
      expect(mine.dark.color, c).toBe(theirs.dark);
      expect(mine.light.color, c).toBe(theirs.light);
      expect(mine.dark.ok, c).toBe(check.dark.ok);
      expect(mine.light.ok, c).toBe(check.light.ok);
      expect(accentNote(c), c).toBe(server.fallbackNote(c));
      if (c) expect(onAccent(c), c).toBe(server.onAccent(c));
    }
  });

  it('falls back to Sylo’s colour where the accent is hard to read on the card', () => {
    expect(accentOutcome('#1a2a6c').dark.color).toBe(SYLO_ACCENT.dark);
    expect(accentOutcome('#1a2a6c').light.color).toBe('#1a2a6c');
    expect(accentOutcome('#ffe14d').light.color).toBe(SYLO_ACCENT.light);
    expect(accentOutcome('#5865f2').dark.ok && accentOutcome('#5865f2').light.ok).toBe(true);
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 0);
  });
});

function Probe({ look }) {
  useServerLook(look);
  return null;
}

describe('useServerLook', () => {
  it('loads the server’s style sheet and marks the page, and undoes both when the page closes', () => {
    const css = '/look/123456789012345678.0123456789abcdef.css';
    const { unmount } = render(<Probe look={{ css, image: true }} />);
    expect(document.head.querySelector(`link[rel=stylesheet][href="${css}"]`)).not.toBeNull();
    expect(document.body.classList.contains('has-look')).toBe(true);
    expect(document.body.classList.contains('has-look-image')).toBe(true);
    unmount();
    expect(document.head.querySelector(`link[href="${css}"]`)).toBeNull();
    expect(document.body.classList.contains('has-look')).toBe(false);
    expect(document.body.classList.contains('has-look-image')).toBe(false);
  });

  it('marks an accent-only look without the image class', () => {
    render(<Probe look={{ css: '/look/fluxer-123.0123456789abcdef.css', image: false }} />);
    expect(document.body.classList.contains('has-look')).toBe(true);
    expect(document.body.classList.contains('has-look-image')).toBe(false);
  });

  it('does nothing without a look, and never loads an address that is not one of Sylo’s look files', () => {
    render(<Probe look={null} />);
    render(<Probe look={{ css: 'https://evil.example/x.css', image: true }} />);
    render(<Probe look={{ css: '/look/../../x.css', image: false }} />);
    expect(document.head.querySelectorAll('link[rel=stylesheet]').length).toBe(0);
    expect(document.body.classList.contains('has-look')).toBe(false);
  });
});

describe('the Powered by Sylo link', () => {
  it('ends the member pages and the signed-out public pages', () => {
    for (const Shell of [MemberShell, PublicShell]) {
      const { container, unmount } = render(
        <MemoryRouter>
          <Shell />
        </MemoryRouter>
      );
      const link = container.querySelector('footer a');
      expect(link.textContent).toBe('Powered by Sylo');
      expect(link.getAttribute('href')).toBe('https://github.com/Ferdinand99/Sylo');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
      unmount();
    }
  });
});
