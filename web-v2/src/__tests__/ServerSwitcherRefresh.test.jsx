import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, RouterProvider, createMemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ServerSwitcher from '../components/ServerSwitcher.jsx';
import Shell from '../components/Shell.jsx';
import GuildPicker from '../pages/GuildPicker.jsx';
import { getGuilds, refreshGuildList } from '../api.js';

vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getGuilds: vi.fn(),
  refreshGuildList: vi.fn(),
  getOverview: vi.fn().mockResolvedValue(null),
  getAnnouncement: vi.fn().mockResolvedValue(null),
  getAccount: vi.fn().mockResolvedValue({ open: true, platforms: [], devices: [] }),
  getInvites: vi.fn().mockResolvedValue([]),
  getCsrfToken: vi.fn().mockResolvedValue('t'),
}));

const HOME = { id: '123456789012345678', name: 'Home', icon: null, platform: 'discord' };
const NEW = { id: '223456789012345678', name: 'Brand new', icon: null, platform: 'discord' };

describe('"Refresh server list" in the server switcher', () => {
  beforeEach(() => {
    window.scrollTo = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    getGuilds.mockReset().mockResolvedValue([HOME]);
    refreshGuildList.mockReset().mockResolvedValue({ ok: true, added: 1 });
  });
  afterEach(() => vi.clearAllMocks());

  it('asks the server to look again, then lists the new server', async () => {
    getGuilds.mockResolvedValueOnce([HOME]).mockResolvedValue([HOME, NEW]);
    const router = createMemoryRouter(
      [{ element: <Shell />, children: [{ path: '/', element: <GuildPicker /> }] }],
      { initialEntries: ['/'] }
    );
    await act(async () => {
      render(<RouterProvider router={router} />);
    });
    expect(screen.queryByText('Brand new')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh server list' }));
    });
    expect(refreshGuildList).toHaveBeenCalledTimes(1);
    expect(getGuilds).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText('Brand new').length).toBeGreaterThan(0);
    expect(screen.getByText('Server list refreshed.')).toBeTruthy();
  });

  it('shows why when the server refuses (the 30 second limit) and keeps the list', async () => {
    refreshGuildList.mockRejectedValue(new Error('The server list was just refreshed. Wait a few seconds.'));
    render(
      <MemoryRouter>
        <ServerSwitcher
          guilds={[HOME]}
          activeGuildId={HOME.id}
          onSelectGuild={() => {}}
          onRefresh={async () => {
            await refreshGuildList();
          }}
        />
      </MemoryRouter>
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh server list' }));
    });
    expect(screen.getByText(/just refreshed/)).toBeTruthy();
    expect(screen.getAllByText('Home').length).toBeGreaterThan(0);
  });

  it('disables the button while it works', async () => {
    let finish;
    const onRefresh = () => new Promise((resolve) => (finish = resolve));
    render(
      <MemoryRouter>
        <ServerSwitcher
          guilds={[HOME]}
          activeGuildId={HOME.id}
          onSelectGuild={() => {}}
          onRefresh={onRefresh}
        />
      </MemoryRouter>
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh server list' }));
    });
    const busy = screen.getByRole('button', { name: 'Refreshing…' });
    expect(busy.disabled).toBe(true);
    await act(async () => finish());
    expect(screen.getByRole('button', { name: 'Refresh server list' }).disabled).toBe(false);
  });
});
