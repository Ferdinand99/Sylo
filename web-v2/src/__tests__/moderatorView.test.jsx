import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Shell from '../components/Shell.jsx';
import GuildHome from '../pages/GuildHome.jsx';
import { focusedLanding, navModel, switchSubpath } from '../overviewModel.js';
import { paletteItems } from '../paletteModel.js';

const G = '123456789012345678';
const H = '223456789012345678';

vi.mock('../pages/Overview.jsx', () => ({ default: () => <p>overview page</p> }));
vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getGuilds: vi.fn(),
  getGuildAccess: vi.fn(),
  getOverview: vi.fn(),
  getAnnouncement: vi.fn().mockResolvedValue(null),
  getAccount: vi.fn(),
  getInvites: vi.fn().mockResolvedValue([]),
  getCsrfToken: vi.fn().mockResolvedValue('t'),
  searchMembers: vi.fn().mockResolvedValue({ members: [] }),
  searchInbox: vi.fn().mockResolvedValue({ items: [] }),
}));
const api = await import('../api.js');
const { resetOperatorCache } = await import('../useOperator.js');

const INBOX_CARDS = ['tickets', 'appeals', 'applications', 'suggestions'];

/** The overview of a server; `off` lists the inbox modules that are switched off. */
const overviewOf = (off = []) => ({
  openTickets: 2,
  openAppeals: 0,
  attention: { waiting: { tickets: 2, appeals: 0, applications: 0, suggestions: 0 }, problems: [] },
  groups: [
    {
      title: 'Inbox modules',
      cards: INBOX_CARDS.map((id) => ({
        id,
        name: id,
        hasToggle: true,
        enabled: !off.includes(id),
        beta: false,
        lines: [],
      })),
    },
    {
      title: 'Engagement',
      cards: [
        { id: 'welcome', name: 'Welcome', hasToggle: true, enabled: true, beta: false, lines: [] },
        { id: 'leveling', name: 'Leveling', hasToggle: true, enabled: true, beta: false, lines: [] },
      ],
    },
  ],
});
const overview = overviewOf();

const MOD_TOOLS = ['Tickets', 'Appeals', 'Applications', 'Suggestions', 'Moderation hub', 'Member data'];
const SETUP_PAGES = [
  'Overview',
  'Audit log',
  'Server settings',
  'Commands',
  'Leaderboard',
  'Welcome',
  'Leveling',
  'Roadmap',
];

function setLevel(level) {
  api.getGuildAccess.mockImplementation((id) => Promise.resolve({ level: id === G ? level : 'edit' }));
}

async function open(path = `/guilds/${G}`) {
  const router = createMemoryRouter(
    [
      {
        element: <Shell />,
        children: [
          { path: '/guilds/:guildId', element: <GuildHome /> },
          { path: '/guilds/:guildId/tickets', element: <p>tickets page</p> },
          { path: '/guilds/:guildId/appeals', element: <p>appeals page</p> },
          { path: '/guilds/:guildId/moderation', element: <p>moderation page</p> },
          { path: '/guilds/:guildId/settings', element: <p>settings page</p> },
        ],
      },
    ],
    { initialEntries: [path] }
  );
  await act(async () => {
    render(<RouterProvider router={router} />);
  });
  return router;
}

const hasLink = (name) => screen.queryByRole('link', { name: new RegExp(`^${name}`) }) !== null;

beforeEach(() => {
  vi.clearAllMocks();
  resetOperatorCache();
  localStorage.clear();
  window.scrollTo = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  api.getGuilds.mockResolvedValue([
    { id: G, name: 'Home', icon: null, platform: 'discord', access: 'inbox' },
    { id: H, name: 'Other', icon: null, platform: 'discord', access: 'edit' },
  ]);
  api.getOverview.mockResolvedValue(overview);
  api.getAccount.mockResolvedValue({ open: false, operator: false, platforms: [], devices: [] });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the focused moderator view', () => {
  it('opens an Inbox person on the inbox, with only the moderation tools in the sidebar', async () => {
    setLevel('inbox');
    const router = await open();
    expect(router.state.location.pathname).toBe(`/guilds/${G}/tickets`);
    expect(screen.getByText('tickets page')).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'Dashboard' });
    for (const name of MOD_TOOLS) {
      expect(within(nav).getByRole('link', { name: new RegExp(`^${name}`) })).toBeTruthy();
    }
    for (const name of SETUP_PAGES) expect(hasLink(name), name).toBe(false);
    expect(within(nav).queryByText('Modules')).toBeNull();
    expect(within(nav).queryByRole('group', { name: 'Server' })).toBeNull();
    expect(within(nav).getByRole('button', { name: 'Show everything' })).toBeTruthy();
  });

  it('shows the full navigation after "Show everything", keeps the choice and can undo it', async () => {
    setLevel('inbox');
    const router = await open();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show everything' }));
    });
    for (const name of [...MOD_TOOLS, ...SETUP_PAGES]) expect(hasLink(name), name).toBe(true);
    expect(localStorage.getItem('sylo:v2:showEverything')).toBe('1');
    expect(screen.getByRole('button', { name: 'Show only moderation' })).toBeTruthy();
    // The overview link now stays on the overview.
    await act(async () => {
      fireEvent.click(screen.getByRole('link', { name: 'Overview' }));
    });
    expect(router.state.location.pathname).toBe(`/guilds/${G}`);
    expect(screen.getByText('overview page')).toBeTruthy();

    // A new visit (a reload) keeps the choice.
    cleanup();
    const again = await open();
    expect(again.state.location.pathname).toBe(`/guilds/${G}`);
    expect(screen.getByText('overview page')).toBeTruthy();
    expect(hasLink('Server settings')).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show only moderation' }));
    });
    expect(hasLink('Server settings')).toBe(false);
    expect(localStorage.getItem('sylo:v2:showEverything')).toBeNull();
  });

  it('still switches when the browser has no usable storage', async () => {
    setLevel('inbox');
    const blocked = () => {
      throw new Error('blocked');
    };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(blocked);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(blocked);
    await open();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show everything' }));
    });
    expect(hasLink('Server settings')).toBe(true);
  });

  it.each(['view', 'edit'])(
    '%s keeps the overview and the full navigation, with no switch',
    async (level) => {
      setLevel(level);
      const router = await open();
      expect(router.state.location.pathname).toBe(`/guilds/${G}`);
      expect(screen.getByText('overview page')).toBeTruthy();
      for (const name of [...MOD_TOOLS, ...SETUP_PAGES]) expect(hasLink(name), name).toBe(true);
      expect(screen.queryByRole('button', { name: /Show everything|Show only moderation/ })).toBeNull();
    }
  );

  it("opens another server on its own level, not the previous server's", async () => {
    // Inbox in G, Edit in H.
    setLevel('inbox');
    const router = await open(`/guilds/${H}`);
    expect(router.state.location.pathname).toBe(`/guilds/${H}`);
    expect(screen.getByText('overview page')).toBeTruthy();
    expect(hasLink('Server settings')).toBe(true);
  });

  it('keeps the bot pages of an operator', async () => {
    setLevel('inbox');
    api.getAccount.mockResolvedValue({ open: false, operator: true, platforms: [], devices: [] });
    await open();
    expect(hasLink('Health')).toBe(true);
    expect(hasLink('Server settings')).toBe(false);
  });

  it('lists only what the focused view can open in the command palette', async () => {
    setLevel('inbox');
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Search the dashboard' }));
    const labels = () => screen.getAllByRole('option').map((o) => o.textContent);
    for (const name of MOD_TOOLS)
      expect(
        labels().some((l) => l.startsWith(name)),
        name
      ).toBe(true);
    for (const name of SETUP_PAGES)
      expect(
        labels().some((l) => l.startsWith(name)),
        name
      ).toBe(false);
    // A typed text finds no module or settings page either.
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'welcome' } });
    expect(screen.queryAllByRole('option').filter((o) => /Welcome/.test(o.textContent))).toHaveLength(0);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'settings' } });
    expect(screen.queryAllByRole('option').filter((o) => /settings/i.test(o.textContent))).toHaveLength(0);
  });

  it('lists the modules in the palette for Edit', async () => {
    setLevel('edit');
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Search the dashboard' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'welcome' } });
    expect(screen.getAllByRole('option').some((o) => /Welcome/.test(o.textContent))).toBe(true);
  });
});

describe('landing, flash and server switching', () => {
  it('lands on the first inbox that is on: appeals when tickets are off, and the sidebar leaves tickets out', async () => {
    setLevel('inbox');
    api.getOverview.mockResolvedValue(overviewOf(['tickets']));
    const router = await open();
    expect(router.state.location.pathname).toBe(`/guilds/${G}/appeals`);
    expect(screen.getByText('appeals page')).toBeTruthy();
    expect(hasLink('Tickets')).toBe(false);
    expect(hasLink('Appeals')).toBe(true);
  });

  it('lands on the Moderation hub when no inbox is on', async () => {
    setLevel('inbox');
    api.getOverview.mockResolvedValue(overviewOf(INBOX_CARDS));
    const router = await open();
    expect(router.state.location.pathname).toBe(`/guilds/${G}/moderation`);
    const nav = screen.getByRole('navigation', { name: 'Dashboard' });
    expect(within(nav).queryByRole('group', { name: 'Inbox' })).toBeNull();
    expect(hasLink('Moderation hub')).toBe(true);
  });

  it('falls back to the tickets when the overview does not load', async () => {
    setLevel('inbox');
    api.getOverview.mockRejectedValue(new Error('down'));
    const router = await open();
    expect(router.state.location.pathname).toBe(`/guilds/${G}/tickets`);
  });

  it('does not show the full navigation while the level is still being read, when the list says Inbox', async () => {
    api.getGuildAccess.mockReturnValue(new Promise(() => {}));
    await open();
    expect(hasLink('Tickets')).toBe(true);
    for (const name of SETUP_PAGES) expect(hasLink(name), name).toBe(false);
    expect(screen.queryByText('overview page')).toBeNull();
  });

  it('holds the setup groups back while neither the list nor the server has given the level', async () => {
    api.getGuildAccess.mockReturnValue(new Promise(() => {}));
    api.getGuilds.mockReturnValue(new Promise(() => {}));
    await open();
    for (const name of SETUP_PAGES) expect(hasLink(name), name).toBe(false);
  });

  it('opens the overview at once for Edit when the list gives the level, before the access call answers', async () => {
    api.getGuildAccess.mockReturnValue(new Promise(() => {}));
    api.getGuilds.mockResolvedValue([
      { id: G, name: 'Home', icon: null, platform: 'discord', access: 'edit' },
    ]);
    await open();
    expect(screen.getByText('overview page')).toBeTruthy();
    expect(hasLink('Server settings')).toBe(true);
  });

  it('switching from an Inbox server to an Edit server in the session shows the overview, and back lands on the inbox', async () => {
    setLevel('inbox');
    const router = await open();
    expect(router.state.location.pathname).toBe(`/guilds/${G}/tickets`);
    await act(async () => {
      await router.navigate(`/guilds/${H}`);
    });
    expect(router.state.location.pathname).toBe(`/guilds/${H}`);
    expect(screen.getByText('overview page')).toBeTruthy();
    expect(hasLink('Server settings')).toBe(true);
    await act(async () => {
      await router.navigate(`/guilds/${G}`);
    });
    expect(router.state.location.pathname).toBe(`/guilds/${G}/tickets`);
    expect(hasLink('Server settings')).toBe(false);
  });

  it('the server switcher does not carry a page the focused view hides into an Inbox server', async () => {
    setLevel('inbox');
    const router = await open(`/guilds/${H}/settings`);
    expect(screen.getByText('settings page')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('link', { name: /Home/ }));
    });
    expect(router.state.location.pathname).toBe(`/guilds/${G}/tickets`);
  });

  it('the switcher keeps a page the focused view lists, and every page for the other levels', () => {
    expect(switchSubpath('/appeals', { access: 'inbox' })).toBe('/appeals');
    expect(switchSubpath('/m/applications', { access: 'inbox' })).toBe('/m/applications');
    expect(switchSubpath('/applications/12', { access: 'inbox' })).toBe('/applications/12');
    expect(switchSubpath('/settings', { access: 'inbox' })).toBe('');
    expect(switchSubpath('/m/welcome', { access: 'inbox' })).toBe('');
    expect(switchSubpath('/settings', { access: 'inbox', showEverything: true })).toBe('/settings');
    expect(switchSubpath('/settings', { access: 'edit' })).toBe('/settings');
    expect(switchSubpath('/settings', { access: 'view' })).toBe('/settings');
    expect(switchSubpath('', { access: 'inbox' })).toBe('');
  });
});

describe('the models of the focused view', () => {
  const nav = (focused) => navModel({ guildId: G, data: overview, operator: false, focused });

  it('keeps the inboxes and three moderation tools, and drops the rest', () => {
    const n = nav(true);
    expect(n.top).toEqual([]);
    expect(n.inbox.map((i) => i.key)).toEqual(['tickets', 'appeals', 'applications', 'suggestions']);
    expect(n.people.map((i) => i.key)).toEqual(['moderation', 'member-data']);
    expect(n.modules).toEqual([]);
    expect(n.server).toEqual([]);
    expect(n.more).toEqual([]);
  });

  it('lists only the inboxes whose module is on, keeping the Moderation hub', () => {
    const d = overviewOf(['suggestions', 'appeals']);
    const n = navModel({ guildId: G, data: d, operator: false, focused: true });
    expect(n.inbox.map((i) => i.key)).toEqual(['tickets', 'applications']);
    expect(n.people.map((i) => i.key)).toContain('moderation');
    // The full view still lists them all, so an admin can find where to switch them on.
    expect(navModel({ guildId: G, data: d, operator: false }).inbox).toHaveLength(4);
    // A card the overview does not list counts as on.
    expect(navModel({ guildId: G, data: { groups: [] }, operator: false, focused: true }).inbox).toHaveLength(
      4
    );
  });

  it('picks the landing from the modules that are on', () => {
    expect(focusedLanding(G, overviewOf())).toBe(`/guilds/${G}/tickets`);
    expect(focusedLanding(G, overviewOf(['tickets']))).toBe(`/guilds/${G}/appeals`);
    expect(focusedLanding(G, overviewOf(['tickets', 'appeals']))).toBe(`/guilds/${G}/m/applications`);
    expect(focusedLanding(G, overviewOf(['tickets', 'appeals', 'applications']))).toBe(
      `/guilds/${G}/m/suggestions`
    );
    expect(focusedLanding(G, overviewOf(INBOX_CARDS))).toBe(`/guilds/${G}/moderation`);
    expect(focusedLanding(G, null)).toBe(`/guilds/${G}/tickets`);
  });

  it('is unchanged when not focused', () => {
    const n = nav(false);
    expect(n.top).toHaveLength(1);
    expect(n.people).toHaveLength(4);
    expect(n.modules.length).toBeGreaterThan(0);
    expect(n.server).toHaveLength(2);
  });

  it('gives the palette no module pages and no setup pages', () => {
    const keys = paletteItems({ guildId: G, data: overview, operator: false, focused: true }).map(
      (i) => i.key
    );
    expect(keys.some((k) => k.startsWith('module:'))).toBe(false);
    expect(keys).not.toContain('page:settings');
    expect(keys).not.toContain('page:overview');
    expect(keys).toContain('page:tickets');
  });
});
