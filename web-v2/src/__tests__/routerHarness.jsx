import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { render } from '@testing-library/react';

/**
 * Renders `element` at `/g/:guildId/...` under a data router (SaveBar's unsaved-changes guard needs
 * one, like App.jsx's). Returns the render result plus the router, so a test can change the
 * server id with `router.navigate('/g/<other id>')`.
 */
export function renderAtGuild(element, guildId) {
  const router = createMemoryRouter([{ path: '/g/:guildId', element }], {
    initialEntries: [`/g/${guildId}`],
  });
  const view = render(<RouterProvider router={router} />);
  return { ...view, router };
}
