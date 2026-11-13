import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import WelcomeChannel from '../moduleForms/WelcomeChannel.jsx';
import { resetModuleLimits } from '../components/useModuleLimits.js';
import { renderAtGuild } from './routerHarness.jsx';

vi.mock('../api.js', () => ({
  ApiError: class ApiError extends Error {},
  getModuleLimits: vi.fn(),
  getWelcomeChannel: vi.fn(),
  saveWelcomeChannel: vi.fn(),
  publishWelcomeChannel: vi.fn(),
  unpublishWelcomeChannel: vi.fn(),
  createWelcomeReadOnlyChannel: vi.fn(),
}));
vi.mock('../notify.js', () => ({ notify: vi.fn() }));
const api = await import('../api.js');
const { notify } = await import('../notify.js');

const GUILD = '123456789012345678';
const OLD = '100000000000000001';
const NEW = '100000000000000002';
const channels = [
  { id: OLD, name: 'welcome' },
  { id: NEW, name: 'rules' },
];
const config = (extra = {}) => ({
  channelId: OLD,
  messageId: 'm1',
  spec: { content: 'Hello', embeds: [] },
  ...extra,
});

beforeEach(() => {
  vi.resetAllMocks();
  resetModuleLimits();
  api.getModuleLimits.mockResolvedValue({ 'welcome-channel': {}, _embed: {} });
  api.getWelcomeChannel.mockResolvedValue({ config: config(), channels, presets: [] });
});

const pick = async (id) =>
  fireEvent.change(await screen.findByLabelText('Channel'), { target: { value: id } });

describe('Welcome channel: the channel of a posted message', () => {
  it('keeps the picked channel after a draft save, says the post stays, and publishes to it', async () => {
    api.saveWelcomeChannel.mockResolvedValue({ config: config() }); // the server keeps the old channel
    api.publishWelcomeChannel.mockResolvedValue({ config: config({ channelId: NEW, messageId: 'm2' }) });
    renderAtGuild(<WelcomeChannel />, GUILD);
    await pick(NEW);
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(notify).toHaveBeenCalled());
    expect(notify.mock.calls[0][0]).toMatch(/stays in its channel until you publish/);
    expect(screen.getByLabelText('Channel').value).toBe(NEW);
    expect(screen.getByText('Unsaved changes')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Publish to channel' }));
    await waitFor(() => expect(api.publishWelcomeChannel).toHaveBeenCalled());
    expect(api.publishWelcomeChannel.mock.calls[0][1]).toMatchObject({ channelId: NEW });
  });

  it('says only "Draft saved." for a message that was never posted', async () => {
    api.getWelcomeChannel.mockResolvedValue({ config: config({ messageId: '' }), channels, presets: [] });
    api.saveWelcomeChannel.mockResolvedValue({ config: config({ messageId: '', channelId: NEW }) });
    renderAtGuild(<WelcomeChannel />, GUILD);
    await pick(NEW);
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(notify).toHaveBeenCalled());
    expect(notify.mock.calls[0][0]).toBe('Draft saved.');
    expect(screen.getByLabelText('Channel').value).toBe(NEW);
  });

  it('selects a channel it just created, while the stored channel of a posted message stays', async () => {
    api.createWelcomeReadOnlyChannel.mockResolvedValue({
      config: config(),
      createdChannelId: '100000000000000003',
      channels: [...channels, { id: '100000000000000003', name: 'welcome-2' }],
    });
    renderAtGuild(<WelcomeChannel />, GUILD);
    fireEvent.click(await screen.findByRole('button', { name: 'Create read-only #welcome' }));
    await waitFor(() => expect(screen.getByLabelText('Channel').value).toBe('100000000000000003'));
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
  });
});
