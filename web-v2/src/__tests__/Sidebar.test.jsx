import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Sidebar from '../components/Sidebar.jsx';

vi.mock('../OverviewContext.jsx', () => ({ useOverview: vi.fn() }));
vi.mock('../useOperator.js', () => ({ useOperator: vi.fn() }));
vi.mock('../moduleForms/index.js', () => ({
  v2Href: (card, guildId) => `/guilds/${guildId}/m/${card.id}`,
}));
const { useOverview } = await import('../OverviewContext.jsx');
const { useOperator } = await import('../useOperator.js');

const A = '111111111111111111';
const B = '222222222222222222';

const data = (name, tickets) => ({
  openTickets: tickets,
  openAppeals: 0,
  attention: { waiting: { tickets, appeals: 0, applications: 0, suggestions: 0 } },
  groups: [
    {
      title: 'Engagement',
      cards: [{ id: 'welcome', name: name, hasToggle: true, enabled: true, beta: false, lines: [] }],
    },
  ],
});

function renderAt(path, guildId) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Sidebar activeGuildId={guildId} open={false} onClose={() => {}} returnFocusRef={{ current: null }} />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  window.matchMedia = vi.fn().mockImplementation(() => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  useOperator.mockReturnValue(false);
});
afterEach(() => {
  delete window.matchMedia;
});

describe('Sidebar', () => {
  it('the Applications entry opens the queue when applications wait, and is active on the page whatever the query', () => {
    const waiting = data('Welcome', 0);
    waiting.attention.waiting.applications = 3;
    useOverview.mockReturnValue({ data: waiting, dataGuildId: A });
    renderAt(`/guilds/${A}/m/applications`, A);
    const link = screen.getByRole('link', { name: /Applications/ });
    expect(link.getAttribute('href')).toBe(`/guilds/${A}/m/applications?tab=submissions`);
    expect(link.getAttribute('aria-current')).toBe('page');
  });

  it('opens with an Overview link that is active on the overview and nowhere else', () => {
    useOverview.mockReturnValue({ data: data('Welcome', 0), dataGuildId: A });
    const { unmount } = renderAt(`/guilds/${A}`, A);
    const overview = screen.getByRole('link', { name: 'Overview' });
    expect(overview.getAttribute('href')).toBe(`/guilds/${A}`);
    expect(overview.getAttribute('aria-current')).toBe('page');
    // it comes before the Inbox group
    const links = [...document.querySelectorAll('nav a')].map((a) => a.textContent);
    expect(links[0]).toBe('Overview');
    unmount();

    renderAt(`/guilds/${A}/tickets`, A);
    expect(screen.getByRole('link', { name: 'Overview' }).getAttribute('aria-current')).toBeNull();
  });

  it('shows the counts and modules of the server that is picked, not the previous one while it loads', () => {
    // the data on hand belongs to server A; server B is picked
    useOverview.mockReturnValue({ data: data('Welcome of A', 5), dataGuildId: A });
    renderAt(`/guilds/${B}`, B);
    expect(screen.queryByText('Welcome of A')).toBeNull();
    expect(screen.queryByLabelText('5 waiting')).toBeNull();
    // the links already point at server B
    expect(screen.getByRole('link', { name: 'Tickets' }).getAttribute('href')).toBe(`/guilds/${B}/tickets`);
  });

  it('shows the counts of the loaded server in the inbox', () => {
    useOverview.mockReturnValue({ data: data('Welcome', 5), dataGuildId: A });
    renderAt(`/guilds/${A}`, A);
    const inbox = screen.getByRole('group', { name: 'Inbox' });
    expect(within(inbox).getByLabelText('5 waiting').textContent).toBe('5');
    expect(screen.getByRole('link', { name: 'Welcome' })).toBeTruthy();
  });

  it('shows the bot pages, the Bot personalizer among them, only to the bot owner', () => {
    useOverview.mockReturnValue({ data: data('Welcome', 0), dataGuildId: A });
    const { unmount } = renderAt(`/guilds/${A}`, A);
    for (const name of ['Bot personalizer', 'Health', 'Roadmap admin', 'Game stats cache']) {
      expect(screen.queryByRole('link', { name })).toBeNull();
    }
    unmount();
    useOperator.mockReturnValue(true);
    renderAt(`/guilds/${A}`, A);
    for (const name of ['Bot personalizer', 'Health', 'Roadmap admin', 'Game stats cache']) {
      expect(screen.getByRole('link', { name })).toBeTruthy();
    }
  });
});
