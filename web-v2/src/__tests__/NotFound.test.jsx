import { render, screen } from '@testing-library/react';
import {
  RouterProvider,
  createMemoryRouter,
  Outlet,
  Route,
  createRoutesFromElements,
} from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import NotFound from '../components/NotFound.jsx';
import RouteError from '../components/RouteError.jsx';
import ModulePage from '../pages/ModulePage.jsx';
import { OverviewProvider } from '../OverviewContext.jsx';

vi.mock('../api.js', () => ({
  ApiError: class ApiError extends Error {},
  getOverview: vi.fn(),
  getPlatformInfo: vi.fn(),
  setModuleEnabled: vi.fn(),
}));
vi.mock('../moduleForms/index.js', () => ({
  MODULE_FORMS: { 'auto-threads': () => <h2>Auto threads form</h2> },
}));
const { getOverview, getPlatformInfo } = await import('../api.js');

// The shape of App.jsx: a Shell stand-in (the sidebar), an inner route with the error element and
// the catch-all.
function renderRoutes(initial, extra = null) {
  const router = createMemoryRouter(
    createRoutesFromElements(
      <Route
        element={
          <>
            <nav aria-label="Sidebar" />
            <Outlet />
          </>
        }
        errorElement={<RouteError />}
      >
        <Route errorElement={<RouteError />}>
          <Route index element={<p>Servers</p>} />
          {extra}
          <Route path="*" element={<NotFound />} />
        </Route>
      </Route>
    ),
    { initialEntries: [initial] }
  );
  return render(<RouterProvider router={router} />);
}

beforeEach(() => {
  vi.resetAllMocks();
  getPlatformInfo.mockResolvedValue({
    platform: 'discord',
    capabilities: {},
    notes: {},
    commandPrefix: '/',
    webAppUrl: 'https://discord.com',
  });
  getOverview.mockResolvedValue({ groups: [] });
});

describe('NotFound', () => {
  it('shows the not-found page next to the sidebar for an unknown address, with no Reload', () => {
    renderRoutes('/guilds/1/nothing/here');
    expect(screen.getByText('Page not found')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Sidebar' })).toBeTruthy();
    expect(screen.queryByText('Reload')).toBeNull();
    expect(screen.queryByText('Something went wrong on this page.')).toBeNull();
    const back = screen.getByRole('link', { name: 'Back to your servers' });
    expect(back.getAttribute('href')).toBe('/');
    // The address was under a server, so that server is offered too.
    expect(screen.getByRole('link', { name: 'Back to this server' }).getAttribute('href')).toBe('/guilds/1');
  });

  it('offers only the server list for an address outside any server', () => {
    renderRoutes('/nothing/here');
    expect(screen.queryByRole('link', { name: 'Back to this server' })).toBeNull();
  });

  it('offers the server page when it knows the server', () => {
    render(
      <RouterProvider router={createMemoryRouter([{ path: '*', element: <NotFound guildId="42" /> }])} />
    );
    expect(screen.getByRole('link', { name: 'Back to this server' }).getAttribute('href')).toBe('/guilds/42');
  });
});

describe('RouteError', () => {
  it('treats a 404 response as not found, not as a crash', () => {
    const router = createMemoryRouter(
      [
        {
          path: '/',
          loader: () => {
            throw new Response(null, { status: 404, statusText: 'Not Found' });
          },
          element: <p>never</p>,
          errorElement: <RouteError />,
        },
      ],
      { initialEntries: ['/'] }
    );
    render(<RouterProvider router={router} />);
    return screen.findByText('Page not found').then(() => {
      expect(screen.queryByText('Reload')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  it('still shows a thrown error with Reload', () => {
    function Boom() {
      throw new Error('kaboom');
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderRoutes('/boom', <Route path="boom" element={<Boom />} />);
    expect(screen.getByText('Something went wrong on this page.')).toBeTruthy();
    expect(screen.getByText('kaboom')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
    spy.mockRestore();
  });
});

describe('ModulePage with an id that has no settings page', () => {
  it('shows the not-found page, with a way back to the server', async () => {
    const router = createMemoryRouter([{ path: 'guilds/:guildId/m/:moduleId', element: <ModulePage /> }], {
      initialEntries: ['/guilds/123456789012345678/m/not-a-module'],
    });
    render(
      <OverviewProvider guildId="123456789012345678">
        <RouterProvider router={router} />
      </OverviewProvider>
    );
    expect(await screen.findByText('Settings page not found')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to this server' }).getAttribute('href')).toBe(
      '/guilds/123456789012345678'
    );
    expect(screen.queryByText(/V2 settings page/)).toBeNull();
  });
});
