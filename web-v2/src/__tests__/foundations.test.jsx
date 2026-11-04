import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import AppTag from '../components/AppTag.jsx';
import Badge, { appealTone, caseTone, sentenceCase } from '../components/Badge.jsx';
import TabRow, { scrollTarget } from '../components/TabRow.jsx';
import UnitInput from '../components/UnitInput.jsx';
import EmbedEditor from '../components/EmbedEditor.jsx';
import { DISCORD, PlatformContext } from '../platformContext.jsx';

describe('Badge', () => {
  it('writes labels in Sentence case', () => {
    expect(sentenceCase('timeout')).toBe('Timeout');
    expect(sentenceCase('PUBLISHED')).toBe('Published');
    expect(sentenceCase('not_set')).toBe('Not set');
    expect(sentenceCase('Fluxer')).toBe('Fluxer');
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

describe('TabRow', () => {
  it('renders its tabs in one .v2-tabs row and passes the role through', () => {
    render(
      <TabRow className="v2-hub-tabs" role="tablist" activeKey="a">
        <button type="button" role="tab" className="v2-tab is-active">
          A
        </button>
        <button type="button" role="tab" className="v2-tab">
          B
        </button>
      </TabRow>
    );
    const list = screen.getByRole('tablist');
    expect(list.className).toContain('v2-tabs');
    expect(list.className).toContain('v2-hub-tabs');
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    // Nothing overflows without layout, so no edge fades.
    fireEvent.scroll(list);
    expect(list.className).not.toContain('fade-');
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
