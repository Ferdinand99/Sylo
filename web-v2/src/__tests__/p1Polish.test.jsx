// The fixes and polish of the 5.2 review (package P1): the mention layer while the suggestions are open, no chip
// row under a field that shows names, the no-access page, the placeholder row on a phone, Needs attention on a
// phone, the empty-list start button, the counters and the CSS that keeps the save bar off the field.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MentionTextarea from '../components/MentionTextarea.jsx';
import PlaceholderBar from '../components/PlaceholderBar.jsx';
import LoadError from '../components/LoadError.jsx';
import EmptyList from '../components/EmptyList.jsx';
import Overview from '../pages/Overview.jsx';
import { counter } from '../components/useModuleLimits.js';
import { renderAtGuild } from './routerHarness.jsx';

vi.mock('../api.js', () => ({
  ApiError: class ApiError extends Error {
    constructor(message, { status } = {}) {
      super(message);
      this.status = status;
    }
  },
  searchMembers: vi.fn(),
  setModuleEnabled: vi.fn(),
  setModulesEnabledBulk: vi.fn(),
}));
vi.mock('../notify.js', () => ({ notify: vi.fn() }));
vi.mock('../moduleForms/index.js', () => ({ v2Href: (card, guildId) => `/guilds/${guildId}/m/${card.id}` }));
vi.mock('../OverviewContext.jsx', () => ({ useOverview: vi.fn() }));
const { ApiError, searchMembers } = await import('../api.js');
const { useOverview } = await import('../OverviewContext.jsx');

const here = dirname(fileURLToPath(import.meta.url));
const css = (name) => readFileSync(join(here, '..', name), 'utf8').replace(/\r\n/g, '\n');
const GUILD = '123456789012345678';
const CH = '100000000000000021';
const channels = [
  { id: CH, name: 'welcome' },
  { id: '100000000000000022', name: 'rules' },
];

beforeEach(() => {
  vi.resetAllMocks();
  searchMembers.mockResolvedValue({ members: [] });
});

function Harness({ start = '', as }) {
  const [value, setValue] = useState(start);
  return (
    <MemoryRouter initialEntries={[`/guilds/${GUILD}`]}>
      <Routes>
        <Route
          path="/guilds/:guildId"
          element={
            <MentionTextarea
              id="msg"
              aria-label="Message"
              as={as}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              channels={channels}
              roles={[]}
            />
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

function type(el, text) {
  fireEvent.change(el, { target: { value: text } });
  el.setSelectionRange(text.length, text.length);
  fireEvent.input(el);
}

describe('A1: the mention layer while a mention is being typed', () => {
  const token = `<#${CH}>`;

  it('is gone while the suggestions are open, so "#wel" is never drawn twice, and back once one is picked', async () => {
    render(<Harness start={`Say hi in ${token}. `} />);
    const field = screen.getByLabelText('Message');
    expect(screen.queryByTestId('mention-mirror')).not.toBeNull();
    type(field, `Say hi in ${token}. And #wel`);
    expect(await screen.findByRole('listbox', { name: 'Channels' })).toBeTruthy();
    // the finished token is still in the text, but the field shows it itself while the list is open
    expect(screen.queryByTestId('mention-mirror')).toBeNull();
    expect(screen.queryByTestId('mention-names')).toBeNull();
    expect(field.className).not.toContain('is-mirrored');
    fireEvent.mouseDown(screen.getByRole('option', { name: /welcome/ }));
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.queryByTestId('mention-mirror')).not.toBeNull();
    expect(field.className).toContain('is-mirrored');
  });

  it('draws a name only for a finished token, never for a half-typed one', () => {
    render(<Harness start={`<#${CH.slice(0, 10)} and <#${CH}`} />);
    // neither of them is closed: no layer at all
    expect(screen.queryByTestId('mention-mirror')).toBeNull();
    fireEvent.change(screen.getByLabelText('Message'), {
      target: { value: `<#${CH.slice(0, 10)} and ${token}` },
    });
    const names = [...screen.getByTestId('mention-names').querySelectorAll('.v2-mm-name')];
    expect(names.map((n) => n.textContent)).toEqual(['#welcome']);
  });
});

describe('A3: no chip row under a field that shows its names', () => {
  const token = `<#${CH}>`;

  it('keeps the list for a screen reader, and shows nothing under the field', () => {
    render(<Harness start={`Hi ${token}`} />);
    const list = screen.getByRole('list', { name: 'Mentions in this text' });
    expect(list.className).toContain('is-quiet');
    expect(list.textContent).toBe('#welcome');
    // the stylesheet takes it out of sight, and shows it again where no names are drawn (forced colours)
    const sheet = css('styles/mention-mirror.css');
    expect(sheet).toMatch(/\.v2-mention-chips\.is-quiet \{[^}]*clip-path: inset\(50%\)/);
    expect(sheet).toMatch(/@media \(forced-colors: active\) \{\s*\.v2-mention-chips\.is-quiet/);
  });

  it('still shows the chips under a one-line input, which draws no names', () => {
    render(<Harness as="input" start={`Hi ${token}`} />);
    expect(screen.getByRole('list', { name: 'Mentions in this text' }).className).not.toContain('is-quiet');
  });
});

describe('A4: a server the person does not manage', () => {
  it('gets a friendly page with a way back, not the raw refusal', () => {
    const err = new ApiError('You do not manage this server.', { status: 403 });
    render(
      <MemoryRouter>
        <LoadError error={err} what="this server" />
      </MemoryRouter>
    );
    expect(screen.queryByText(/Couldn't load/)).toBeNull();
    expect(screen.queryByText(/You do not manage this server/)).toBeNull();
    expect(screen.getByText(/don't have access to this server/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Choose another server' }).getAttribute('href')).toBe('/');
  });

  it('keeps the plain message for any other failure', () => {
    render(
      <MemoryRouter>
        <LoadError error={new ApiError('Boom', { status: 500 })} what="this server" />
      </MemoryRouter>
    );
    expect(screen.getByText("Couldn't load this server (Boom).")).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Choose another server' })).toBeNull();
  });
});

describe('A8: the placeholder row on a phone', () => {
  const fields = [
    { id: 'a', label: 'Welcome message', tokens: [{ token: '{user}' }, { token: '{server}' }] },
  ];

  const widths = (scrollWidth, clientWidth) => {
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
      configurable: true,
      get: () => scrollWidth,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => clientWidth,
    });
  };

  it('fades the edge that has more chips behind it, and only while the row overflows', () => {
    widths(500, 200);
    render(<PlaceholderBar fields={fields} />);
    const row = screen.getByRole('group', { name: 'Insert a placeholder' });
    expect(row.className).toContain('has-more-end');
    expect(row.className).not.toContain('has-more-start');
    row.scrollLeft = 120;
    fireEvent.scroll(row);
    expect(row.className).toContain('has-more-start');
    expect(row.className).toContain('has-more-end');
    row.scrollLeft = 300;
    fireEvent.scroll(row);
    expect(row.className).toContain('has-more-start');
    expect(row.className).not.toContain('has-more-end');
  });

  it('has no fade when everything fits', () => {
    widths(200, 200);
    render(<PlaceholderBar fields={fields} />);
    const row = screen.getByRole('group', { name: 'Insert a placeholder' });
    expect(row.className).not.toContain('has-more');
  });

  it('scrolls sideways under 860 px, with the fades in the stylesheet', () => {
    const sheet = css('dashux.css');
    expect(sheet).toMatch(/\.v2-ph-bar \.v2-ph-chips \{\s*flex-wrap: nowrap;\s*overflow-x: auto;/);
    expect(sheet).toMatch(/\.v2-ph-chips\.has-more-end \{[^}]*mask-image/);
    expect(sheet).toMatch(/\.v2-ph-chips\.has-more-start \{[^}]*mask-image/);
  });
});

describe('A2: the save bar never covers the field being edited', () => {
  it('leaves room for the bar under a form, and scrolls a focused field clear of it', () => {
    const sheet = css('styles/p1-polish.css');
    expect(sheet).toMatch(/--savebar-h: 72px/);
    expect(sheet).toMatch(
      /\.v2-page:has\(\.v2-savebar\.is-visible\) form\[data-savebar\] \{\s*padding-bottom: calc\(var\(--savebar-h\) \+ 24px\);/
    );
    expect(sheet).toMatch(
      /html:has\(\.v2-savebar\.is-visible\) \{\s*scroll-padding-bottom: calc\(var\(--savebar-h\) \+ 24px\);/
    );
  });
});

describe('B2: Needs attention on a phone', () => {
  const cards = Array.from({ length: 5 }, (_, i) => ({
    id: `mod-${i}`,
    name: `Module ${i}`,
    description: '',
    icon: 'shield',
    hasToggle: true,
    enabled: true,
    missingIntents: [],
    status: 'ok',
    lines: [],
    summaryParts: [],
  }));
  const mock = (problems) =>
    useOverview.mockReturnValue({
      data: {
        guild: { name: 'Hedgerow', icon: null, memberCount: 12 },
        groups: [{ title: 'All', cards }],
        openTickets: 0,
        openAppeals: 0,
        attention: {
          waiting: { tickets: 2 },
          problems: problems.map((p) => ({ id: p, name: p, issues: ['No channel'] })),
        },
      },
      dataGuildId: GUILD,
      error: null,
      setData: vi.fn(),
    });

  it('offers "Show all (n)" when there are more than three rows, and "Show fewer" after it', () => {
    mock(['mod-0', 'mod-1', 'mod-2', 'mod-3']);
    const { container } = renderAtGuild(<Overview />, GUILD);
    // one waiting row and four setup rows: five items
    const more = screen.getByRole('button', { name: 'Show all (5)' });
    const list = container.querySelector('.v2-attention-list');
    expect(list.className).not.toContain('is-all');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    expect(list.className).toContain('is-all');
    expect(screen.getByRole('button', { name: 'Show fewer' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('has no button for three rows or fewer', () => {
    mock(['mod-0', 'mod-1']);
    renderAtGuild(<Overview />, GUILD);
    expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull();
  });

  it('hides the rows after the third and the button on a wide screen, in the stylesheet', () => {
    const sheet = css('styles/p1-polish.css');
    expect(sheet).toMatch(/\.v2-attention-more \{\s*display: none;/);
    expect(sheet).toMatch(
      /@media \(max-width: 600px\) \{\s*\.v2-attention-list:not\(\.is-all\) > li:nth-child\(n \+ 4\) \{\s*display: none;/
    );
  });
});

describe('B3: the empty list', () => {
  it('says what the list gives and has one primary start button, as an action or a link', () => {
    const onClick = vi.fn();
    const { container, rerender } = render(
      <MemoryRouter>
        <EmptyList start={{ label: 'Add your first reminder', onClick }}>
          Post a message on a schedule.
        </EmptyList>
      </MemoryRouter>
    );
    expect(screen.getByText('Post a message on a schedule.')).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Add your first reminder' });
    expect(button.className).toContain('v2-btn-primary');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.v2-empty').className).toContain('has-start');
    rerender(
      <MemoryRouter>
        <EmptyList start={{ label: 'Create it', to: '/guilds/1/messages/new' }}>Words.</EmptyList>
      </MemoryRouter>
    );
    expect(screen.getByRole('link', { name: 'Create it' }).getAttribute('href')).toBe(
      '/guilds/1/messages/new'
    );
  });

  it('keeps the older form: an action element in the same place', () => {
    render(<EmptyList action={<button type="button">+ New</button>}>None yet.</EmptyList>);
    expect(screen.getByRole('button', { name: '+ New' }).className).not.toContain('v2-btn-primary');
  });
});

describe('B5: counters', () => {
  it('writes "n / limit" when the limit is known and the plain count otherwise', () => {
    expect(counter(2, 200)).toBe('2 / 200');
    expect(counter(0, 50)).toBe('0 / 50');
    expect(counter(3, undefined)).toBe('3');
    expect(counter(3, 0)).toBe('3');
  });
});
