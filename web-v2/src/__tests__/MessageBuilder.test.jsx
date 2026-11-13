import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MessageBuilder from '../pages/MessageBuilder.jsx';

vi.mock('../api.js', () => ({
  ApiError: class ApiError extends Error {},
  getComposedMessage: vi.fn(),
  saveComposedMessage: vi.fn(),
}));
vi.mock('../notify.js', () => ({ notify: vi.fn() }));
const { getComposedMessage, saveComposedMessage } = await import('../api.js');
const { notify } = await import('../notify.js');

function renderAt(guildId, id = 'new') {
  const router = createMemoryRouter(
    [{ path: '/guilds/:guildId/messages/:id', element: <MessageBuilder /> }],
    {
      initialEntries: [`/guilds/${guildId}/messages/${id}`],
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

// A posted message lives in the channel it was posted to: another channel applies on publish.
describe('Message Creator channel of a published message', () => {
  const rec = {
    id: 5,
    name: 'Rules',
    channelId: '100000000000000001',
    messageId: 'm1',
    spec: { content: 'Hi' },
  };
  beforeEach(() => {
    getComposedMessage.mockResolvedValue({
      rec,
      channels: [
        { id: '100000000000000001', name: 'rules' },
        { id: '100000000000000002', name: 'news' },
      ],
    });
  });

  it('says that publishing again moves the post', async () => {
    renderAt('123456789012345678', '5');
    expect(await screen.findByText(/the old post is deleted and a fresh one is posted there/)).toBeTruthy();
  });

  it('tells that a draft saved with another channel leaves the post where it is', async () => {
    saveComposedMessage.mockResolvedValue({ rec, status: 'saved' });
    renderAt('123456789012345678', '5');
    fireEvent.change(await screen.findByLabelText('Channel'), { target: { value: '100000000000000002' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(notify).toHaveBeenCalled());
    expect(notify.mock.calls[0][0]).toMatch(/stays in its channel until you click "Update published"/);
    // The picked channel stays in the picker and the page stays unsaved on it, so "Update published" moves the post.
    expect(screen.getByLabelText('Channel').value).toBe('100000000000000002');
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
  });

  it('keeps the picked channel after a draft save and sends it on "Update published"', async () => {
    saveComposedMessage.mockResolvedValueOnce({ rec, status: 'saved' });
    saveComposedMessage.mockResolvedValueOnce({
      rec: { ...rec, channelId: '100000000000000002', messageId: 'm2' },
      status: 'sent',
    });
    renderAt('123456789012345678', '5');
    fireEvent.change(await screen.findByLabelText('Channel'), { target: { value: '100000000000000002' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(saveComposedMessage).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(notify).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Update published' }));
    await waitFor(() => expect(saveComposedMessage).toHaveBeenCalledTimes(2));
    expect(saveComposedMessage.mock.calls[1][2]).toMatchObject({
      action: 'publish',
      channelId: '100000000000000002',
    });
  });

  it('says nothing about a posted message for a draft that was never posted', async () => {
    const draft = { ...rec, messageId: null };
    getComposedMessage.mockResolvedValue({
      rec: draft,
      channels: [
        { id: '100000000000000001', name: 'rules' },
        { id: '100000000000000002', name: 'news' },
      ],
    });
    saveComposedMessage.mockResolvedValue({
      rec: { ...draft, channelId: '100000000000000002' },
      status: 'saved',
    });
    renderAt('123456789012345678', '5');
    fireEvent.change(await screen.findByLabelText('Channel'), { target: { value: '100000000000000002' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(notify).toHaveBeenCalled());
    expect(notify.mock.calls[0][0]).toBe('Draft saved.');
    expect(screen.getByLabelText('Channel').value).toBe('100000000000000002');
  });
});
