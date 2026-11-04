import { act, render } from '@testing-library/react';
import { Link, Outlet, RouterProvider, ScrollRestoration, createMemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
