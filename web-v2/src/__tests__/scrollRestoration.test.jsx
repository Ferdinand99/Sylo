import { act, fireEvent, render, screen } from '@testing-library/react';
import { Link, Outlet, RouterProvider, ScrollRestoration, createMemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Shell from '../components/Shell.jsx';
import MemberData from '../pages/MemberData.jsx';

// Only what the real Shell and the Member data page call; everything resolves to an empty answer.
vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getGuilds: vi.fn().mockResolvedValue([]),
  getOverview: vi.fn().mockResolvedValue(null),
  getAnnouncement: vi.fn().mockResolvedValue(null),
  getAccount: vi.fn().mockResolvedValue({ open: true, platforms: [], devices: [] }),
  getInvites: vi.fn().mockResolvedValue([]),
  getCsrfToken: vi.fn().mockResolvedValue('t'),
  getPlatformInfo: vi.fn().mockResolvedValue({ platform: 'discord', capabilities: {} }),
  getMemberData: vi.fn().mockResolvedValue({ lookup: null }),
}));

// The same wiring as components/Shell.jsx: a <ScrollRestoration /> beside the layout of a data router.
function Layout() {
  return (
    <>
      <ScrollRestoration />
      <Link to="/b">to b</Link>
      <Outlet />
    </>
  );
}

function setup() {
  const router = createMemoryRouter(
    [
      {
        element: <Layout />,
        children: [
          { path: '/a', element: <p>page a</p> },
          { path: '/b', element: <p id="section">page b</p> },
        ],
      },
    ],
    { initialEntries: ['/a'] }
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe('scrolling between pages', () => {
  let scrollTo;
  beforeEach(() => {
    window.sessionStorage.clear();
    scrollTo = vi.fn();
    window.scrollTo = scrollTo;
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => vi.restoreAllMocks());

  it('opens a new page at the top', async () => {
    const router = setup();
    scrollTo.mockClear();
    await act(async () => {
      await router.navigate('/b');
    });
    expect(scrollTo).toHaveBeenLastCalledWith(0, 0);
  });

  it('goes to the spot a #hash link names instead of the top', async () => {
    const router = setup();
    Element.prototype.scrollIntoView.mockClear();
    await act(async () => {
      await router.navigate('/b#section');
    });
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });
});

describe('scrolling inside the real Shell', () => {
  const GUILD = '123456789012345678';
  let scrollTo;
  beforeEach(() => {
    window.sessionStorage.clear();
    scrollTo = vi.fn();
    window.scrollTo = scrollTo;
    Element.prototype.scrollIntoView = vi.fn();
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  });
  afterEach(() => vi.restoreAllMocks());

  function setupShell() {
    const router = createMemoryRouter(
      [
        {
          element: <Shell />,
          children: [
            { path: '/guilds/:guildId/member-data', element: <MemberData /> },
            { path: '/guilds/:guildId/other', element: <p>other page</p> },
          ],
        },
      ],
      { initialEntries: [`/guilds/${GUILD}/member-data`] }
    );
    render(<RouterProvider router={router} />);
    return router;
  }

  it('a member lookup (a new search on the same page) does not jump to the top, a new page does', async () => {
    const router = setupShell();
    const field = await screen.findByLabelText('User ID or @mention');
    scrollTo.mockClear();
    fireEvent.change(field, { target: { value: '222222222222222222' } });
    await act(async () => {
      fireEvent.submit(field.closest('form'));
    });
    expect(router.state.location.search).toBe('?user=222222222222222222');
    expect(scrollTo).not.toHaveBeenCalledWith(0, 0);

    await act(async () => {
      await router.navigate(`/guilds/${GUILD}/other`);
    });
    expect(scrollTo).toHaveBeenLastCalledWith(0, 0);
  });
});
