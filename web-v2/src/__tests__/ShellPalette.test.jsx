import { act, fireEvent, render, screen } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Shell from '../components/Shell.jsx';
import GuildPicker from '../pages/GuildPicker.jsx';

const GUILD = '123456789012345678';

vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getGuilds: vi
    .fn()
    .mockResolvedValue([{ id: '123456789012345678', name: 'Home', icon: null, platform: 'discord' }]),
  getOverview: vi.fn().mockResolvedValue(null),
  getAnnouncement: vi.fn().mockResolvedValue(null),
  getAccount: vi.fn().mockResolvedValue({ open: true, platforms: [], devices: [] }),
  getInvites: vi.fn().mockResolvedValue([]),
  getCsrfToken: vi.fn().mockResolvedValue('t'),
}));

describe('the command palette in the Shell', () => {
  beforeEach(() => {
    window.scrollTo = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  });
  afterEach(() => vi.restoreAllMocks());

  async function setup() {
    const router = createMemoryRouter(
      [
        {
          element: <Shell />,
          children: [
            { path: '/', element: <GuildPicker /> },
            { path: '/guilds/:guildId', element: <p>overview page</p> },
          ],
        },
      ],
      { initialEntries: ['/'] }
    );
    await act(async () => {
      render(<RouterProvider router={router} />);
    });
    return router;
  }

  it('opens with Ctrl+K and closes with Ctrl+K again, through the animated close', async () => {
    await setup();
    expect(screen.queryByRole('combobox')).toBeNull();
    await act(async () => {
      fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    });
    expect(screen.getByRole('combobox')).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    });
    // Closing goes through finish(): the dialog is still there for the length of the close animation.
    expect(screen.queryByRole('combobox')).toBeTruthy();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
    });
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('does not take Cmd+K away from a platform that is not Apple, and opens from the search button', async () => {
    await setup();
    await act(async () => {
      fireEvent.keyDown(document, { key: 'k', metaKey: true });
    });
    expect(screen.queryByRole('combobox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Search the dashboard' }));
    expect(screen.getByRole('combobox')).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
      await new Promise((r) => setTimeout(r, 250));
    });
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('takes Cmd+K, and not Ctrl+K, on a Mac', async () => {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel');
    await setup();
    expect(screen.getByRole('button', { name: 'Search the dashboard' }).textContent).toContain('⌘K');
    await act(async () => {
      fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    });
    expect(screen.queryByRole('combobox')).toBeNull();
    await act(async () => {
      fireEvent.keyDown(document, { key: 'k', metaKey: true });
    });
    expect(screen.getByRole('combobox')).toBeTruthy();
  });

  it('finds a server of the person and opens its overview', async () => {
    const router = await setup();
    fireEvent.click(screen.getByRole('button', { name: 'Search the dashboard' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'home' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /Switch to Home/ }));
    });
    expect(router.state.location.pathname).toBe(`/guilds/${GUILD}`);
  });

  it('says on the server picker that every feature is free', async () => {
    await setup();
    expect(screen.getByText('Every Sylo feature is free — no premium tier.')).toBeTruthy();
  });
});
