import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Settings from '../pages/Settings.jsx';
import { renderAtGuild } from './routerHarness.jsx';

vi.mock('../api.js', () => ({
  ApiError: class ApiError extends Error {},
  getGuildSettings: vi.fn(),
  saveGuildSettings: vi.fn(),
  exportGuildConfig: vi.fn(),
}));
vi.mock('../notify.js', () => ({ notify: vi.fn() }));
const { getGuildSettings, saveGuildSettings } = await import('../api.js');

const GUILD = '123456789012345678';

const settings = (over = {}) => ({
  guild: { id: GUILD, name: 'Hedgerow', icon: null },
  platform: 'discord',
  commandPrefix: '',
  defaultCommandPrefix: '!',
  effectiveCommandPrefix: '/',
  commandPrefixMaxLength: 5,
  modlogChannelId: '',
  embedColorHex: '#7aa2f7',
  channels: [],
  roles: [],
  botMasterRoleIds: [],
  ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  saveGuildSettings.mockResolvedValue({ ok: true });
});

describe('Settings: command prefix', () => {
  it('is not shown for a Discord server', async () => {
    getGuildSettings.mockResolvedValue(settings());
    renderAtGuild(<Settings />, GUILD);
    await screen.findByLabelText('Default embed colour');
    expect(screen.queryByLabelText(/Command prefix/)).toBeNull();
  });

  it('shows the server prefix, the default as the placeholder and what members type', async () => {
    getGuildSettings.mockResolvedValue(
      settings({ platform: 'fluxer', commandPrefix: '?', effectiveCommandPrefix: '?' })
    );
    renderAtGuild(<Settings />, GUILD);
    const input = await screen.findByLabelText(/Command prefix/);
    expect(input.value).toBe('?');
    expect(input.getAttribute('placeholder')).toBe('!');
    expect(input.getAttribute('maxlength')).toBe('5');
    expect(screen.getByText(/for example \?help/)).toBeTruthy();
    expect(screen.getByText(/default for this Sylo \(!\)/)).toBeTruthy();
  });

  it('with no prefix of its own it explains with the default', async () => {
    getGuildSettings.mockResolvedValue(settings({ platform: 'fluxer' }));
    renderAtGuild(<Settings />, GUILD);
    const input = await screen.findByLabelText(/Command prefix/);
    expect(input.value).toBe('');
    expect(screen.getByText(/for example !help/)).toBeTruthy();
  });

  it('saves the new prefix with the rest of the settings', async () => {
    getGuildSettings.mockResolvedValue(settings({ platform: 'fluxer' }));
    renderAtGuild(<Settings />, GUILD);
    const input = await screen.findByLabelText(/Command prefix/);
    fireEvent.change(input, { target: { value: '>>' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saveGuildSettings).toHaveBeenCalledTimes(1));
    expect(saveGuildSettings.mock.calls[0][1]).toMatchObject({ commandPrefix: '>>' });
  });

  it('flags a prefix with a space or too many characters before it is sent', async () => {
    getGuildSettings.mockResolvedValue(settings({ platform: 'fluxer' }));
    renderAtGuild(<Settings />, GUILD);
    const input = await screen.findByLabelText(/Command prefix/);
    fireEvent.change(input, { target: { value: 'a b' } });
    expect(screen.getByText('The prefix can not contain spaces.')).toBeTruthy();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(input, { target: { value: '!' } });
    expect(screen.queryByText('The prefix can not contain spaces.')).toBeNull();
  });
});
