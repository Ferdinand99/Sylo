import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import AppTag from '../components/AppTag.jsx';
import Badge, { appealTone, caseTone, sentenceCase } from '../components/Badge.jsx';
import TabRow, { nextTabIndex, scrollTarget } from '../components/TabRow.jsx';
import { ROADMAP_STATUS } from '../roadmapStatus.js';
import UnitInput from '../components/UnitInput.jsx';
import EmbedEditor from '../components/EmbedEditor.jsx';
import { DISCORD, PlatformContext } from '../platformContext.jsx';

describe('Badge', () => {
  it('writes labels in Sentence case', () => {
    expect(sentenceCase('timeout')).toBe('Timeout');
    expect(sentenceCase('PUBLISHED')).toBe('Published');
    expect(sentenceCase('not_set')).toBe('Not set');
    expect(sentenceCase('Fluxer')).toBe('Fluxer');
    // Short acronyms and mixed-case words keep their capitals.
    expect(sentenceCase('API')).toBe('API');
    expect(sentenceCase('DM')).toBe('DM');
    expect(sentenceCase('iOS')).toBe('iOS');
    expect(sentenceCase('DM sent')).toBe('DM sent');
    expect(sentenceCase('')).toBe('');
  });

  it('shows the tidied label and the tone class', () => {
    render(<Badge tone="danger">ban</Badge>);
    const badge = screen.getByText('Ban');
    expect(badge.className).toContain('v2-status-pill');
    expect(badge.className).toContain('is-danger');
  });

  it('falls back to neutral for an unknown tone and keeps `raw` labels as given', () => {
    render(
      <Badge tone="purple" raw>
        iOS
      </Badge>
    );
    expect(screen.getByText('iOS').className).toContain('is-neutral');
  });

  it('adds the inline spacing class only when asked', () => {
    const { rerender } = render(<Badge>note</Badge>);
    expect(screen.getByText('Note').className).not.toContain('v2-badge-inline');
    rerender(<Badge inline>note</Badge>);
    expect(screen.getByText('Note').className).toContain('v2-badge-inline');
  });

  it('picks tones by meaning for infractions and appeals', () => {
    expect(caseTone('ban')).toBe('danger');
    expect(caseTone('kick')).toBe('danger');
    expect(caseTone('warn')).toBe('warning');
    expect(caseTone('timeout')).toBe('warning');
    expect(caseTone('note')).toBe('neutral');
    expect(caseTone(undefined)).toBe('neutral');
    expect(appealTone('accepted')).toBe('success');
    expect(appealTone('denied')).toBe('danger');
    expect(appealTone('open')).toBe('warning');
    expect(appealTone('weird')).toBe('neutral');
  });
});

describe('AppTag', () => {
  it('says APP on Discord (the default) and BOT on Fluxer', () => {
    const { unmount } = render(<AppTag />);
    expect(screen.getByText('APP')).toBeTruthy();
    unmount();
    render(
      <PlatformContext.Provider value={{ ...DISCORD, platform: 'fluxer' }}>
        <AppTag />
      </PlatformContext.Provider>
    );
    expect(screen.getByText('BOT')).toBeTruthy();
  });

  it('is what the single-embed editor preview shows next to the bot name', () => {
    render(<EmbedEditor spec={{}} onChange={() => {}} />);
    expect(screen.getByText('APP')).toBeTruthy();
    expect(screen.queryByText('BOT')).toBeNull();
  });
});

describe('scrollTarget', () => {
  const view = { scrollLeft: 100, clientWidth: 200 };
  it('is null when the tab is fully in view', () => {
    expect(scrollTarget(view, { offsetLeft: 120, offsetWidth: 80 })).toBeNull();
  });
  it('centres a tab that sticks out on the right', () => {
    expect(scrollTarget(view, { offsetLeft: 260, offsetWidth: 100 })).toBe(210);
  });
  it('never scrolls before the start', () => {
    expect(scrollTarget(view, { offsetLeft: 10, offsetWidth: 100 })).toBe(0);
  });
});

describe('roadmap labels', () => {
  it('has one label and tone per stage, shared by the public page and the admin list', () => {
    expect(ROADMAP_STATUS.started).toEqual({ label: 'In progress', tone: 'warning' });
    expect(Object.keys(ROADMAP_STATUS)).toEqual(['planned', 'started', 'completed']);
  });
});

describe('nextTabIndex', () => {
  const tabs = ['a', 'b', 'c'];
  it('moves with the arrows, wrapping around, and Home/End jump', () => {
    expect(nextTabIndex('ArrowRight', tabs, 'a')).toBe(1);
    expect(nextTabIndex('ArrowRight', tabs, 'c')).toBe(0);
    expect(nextTabIndex('ArrowLeft', tabs, 'a')).toBe(2);
    expect(nextTabIndex('Home', tabs, 'c')).toBe(0);
    expect(nextTabIndex('End', tabs, 'a')).toBe(2);
  });
  it('ignores other keys and elements that are not tabs', () => {
    expect(nextTabIndex('Enter', tabs, 'a')).toBeNull();
    expect(nextTabIndex('ArrowRight', tabs, 'x')).toBeNull();
  });
});

describe('TabRow', () => {
  function Row({ wide = false, active = 'a' }) {
    return (
      <TabRow className="v2-hub-tabs" role="tablist" activeKey={active} panelId="panel">
        {['a', 'b', 'c'].map((k) => (
          <button key={k} type="button" role="tab" className={`v2-tab${active === k ? ' is-active' : ''}`}>
            {k}
            {wide && k === 'c' ? ' (off)' : ''}
          </button>
        ))}
      </TabRow>
    );
  }
  function fakeLayout(row, { scrollLeft, clientWidth, scrollWidth }) {
    Object.defineProperty(row, 'scrollLeft', { configurable: true, writable: true, value: scrollLeft });
    Object.defineProperty(row, 'clientWidth', { configurable: true, value: clientWidth });
    Object.defineProperty(row, 'scrollWidth', { configurable: true, get: () => scrollWidth.value });
  }

  it('renders its tabs in one .v2-tabs row and passes the role through', () => {
    render(<Row />);
    const list = screen.getByRole('tablist');
    expect(list.className).toContain('v2-tabs');
    expect(list.className).toContain('v2-hub-tabs');
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    // Nothing overflows without layout, so no edge fades.
    expect(list.className).not.toContain('fade-');
  });

  it('fades the end that has more tabs, and notices when the tabs widen without the row resizing', () => {
    const width = { value: 300 };
    const { rerender } = render(<Row />);
    const row = screen.getByRole('tablist');
    fakeLayout(row, { scrollLeft: 0, clientWidth: 300, scrollWidth: width });
    rerender(<Row />);
    expect(row.className).not.toContain('fade-');
    // A suffix arrives and the tabs are now wider than the row.
    width.value = 420;
    rerender(<Row wide />);
    expect(row.className).toContain('fade-end');
    expect(row.className).not.toContain('fade-start');
    // Scrolled to the far end: only the start fades.
    row.scrollLeft = 120;
    fireEvent.scroll(row);
    expect(row.className).toContain('fade-start');
    expect(row.className).not.toContain('fade-end');
  });

  it('keeps only the active tab in the Tab order and points it at the panel', () => {
    render(<Row active="b" />);
    const [a, b, c] = screen.getAllByRole('tab');
    expect([a.tabIndex, b.tabIndex, c.tabIndex]).toEqual([-1, 0, -1]);
    expect(b.getAttribute('aria-controls')).toBe('panel');
    expect(a.getAttribute('aria-controls')).toBeNull();
  });

  it('moves focus with the arrow keys', () => {
    render(<Row />);
    const [a, b, c] = screen.getAllByRole('tab');
    a.focus();
    fireEvent.keyDown(a, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(b);
    fireEvent.keyDown(b, { key: 'End' });
    expect(document.activeElement).toBe(c);
    fireEvent.keyDown(c, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(a);
  });
});

describe('UnitInput', () => {
  it('is a number field with the unit announced as part of its description', () => {
    render(<UnitInput id="d" unit="days" value={90} onChange={() => {}} min={1} />);
    const input = screen.getByRole('spinbutton');
    expect(input.className).toContain('v2-input-num');
    expect(screen.getByText('days').id).toBe(input.getAttribute('aria-describedby'));
  });

  it('keeps a description the caller passed', () => {
    render(<UnitInput unit="min" aria-describedby="hint" value={5} onChange={() => {}} />);
    expect(screen.getByRole('spinbutton').getAttribute('aria-describedby')).toMatch(/^hint /);
  });
});
