import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Overview from '../pages/Overview.jsx';
import { renderAtGuild } from './routerHarness.jsx';

vi.mock('../api.js', () => ({
  ApiError: class ApiError extends Error {},
  setModuleEnabled: vi.fn(),
  setModulesEnabledBulk: vi.fn(),
}));
vi.mock('../notify.js', () => ({ notify: vi.fn() }));
vi.mock('../moduleForms/index.js', () => ({ v2Href: (card, guildId) => `/guilds/${guildId}/m/${card.id}` }));
vi.mock('../OverviewContext.jsx', () => ({ useOverview: vi.fn() }));
const { useOverview } = await import('../OverviewContext.jsx');

const GUILD = '123456789012345678';

const card = (id) => ({
  id,
  name: id,
  description: id,
  hasToggle: true,
  enabled: true,
  status: 'on',
  missingIntents: [],
  lines: [{ label: 'Channel', value: '#general', state: 'on' }],
});

function overviewWith(count) {
  useOverview.mockReturnValue({
    data: {
      guild: { name: 'Hedgerow', icon: null, memberCount: 12 },
      groups: [{ title: 'Utility', cards: Array.from({ length: count }, (_, i) => card(`m${i}`)) }],
      openTickets: 0,
      openAppeals: 0,
    },
    dataGuildId: GUILD,
    error: null,
    setData: vi.fn(),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  try {
    localStorage.clear();
  } catch {
    // storage is optional
  }
});

describe('the setup offer on the overview', () => {
  it('is shown on a server with fewer than 3 modules set up, and opens the wizard', async () => {
    overviewWith(2);
    renderAtGuild(<Overview />, GUILD);
    const link = await screen.findByRole('link', { name: 'Set up Sylo' });
    expect(link.getAttribute('href')).toBe(`/guilds/${GUILD}/setup`);
  });

  it('is not shown once 3 modules are set up', async () => {
    overviewWith(3);
    renderAtGuild(<Overview />, GUILD);
    await screen.findByText(/3 of 3 modules on/);
    expect(screen.queryByRole('link', { name: 'Set up Sylo' })).toBeNull();
  });
});
