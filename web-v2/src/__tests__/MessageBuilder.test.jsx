import { render, screen } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MessageBuilder from '../pages/MessageBuilder.jsx';

vi.mock('../api.js', () => ({
  ApiError: class ApiError extends Error {},
  getComposedMessage: vi.fn(),
  saveComposedMessage: vi.fn(),
}));
const { getComposedMessage } = await import('../api.js');

function renderAt(guildId) {
  const router = createMemoryRouter(
    [{ path: '/guilds/:guildId/messages/:id', element: <MessageBuilder /> }],
    {
      initialEntries: [`/guilds/${guildId}/messages/new`],
    }
  );
  return render(<RouterProvider router={router} />);
}

beforeEach(() => {
  vi.resetAllMocks();
  getComposedMessage.mockResolvedValue({
    rec: { name: '', channelId: '', messageId: null, spec: { content: 'Hello', embeds: [] } },
    channels: [],
  });
});

// The Message Creator is not a module page, so it has no platform context: the server id in the
// address says which platform's tag to show next to the bot name.
describe('Message Creator preview', () => {
  it('tags the bot APP on a Discord server', async () => {
    renderAt('123456789012345678');
    expect(await screen.findByText('APP')).toBeTruthy();
  });

  it('tags the bot BOT on a Fluxer server', async () => {
    renderAt('fluxer:123456789012345678');
    expect(await screen.findByText('BOT')).toBeTruthy();
    expect(screen.queryByText('APP')).toBeNull();
  });
});
