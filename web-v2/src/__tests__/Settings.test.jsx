import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Settings from '../pages/Settings.jsx';
import { renderAtGuild } from './routerHarness.jsx';

vi.mock('../api.js', () => ({
  ApiError: class ApiError extends Error {},
  getGuildSettings: vi.fn(),
  saveGuildSettings: vi.fn(),
  exportGuildConfig: vi.fn(),
  getGuildAccess: vi.fn(),
  saveGuildAccess: vi.fn(),
  getPublicLook: vi.fn(),
  savePublicLook: vi.fn(),
  uploadPublicLookImage: vi.fn(),
  deletePublicLookImage: vi.fn(),
  refreshPublicLookSplash: vi.fn(),
}));
vi.mock('../notify.js', () => ({ notify: vi.fn() }));
const { getGuildSettings, saveGuildSettings, getPublicLook, savePublicLook } = await import('../api.js');
const { notify } = await import('../notify.js');

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

const look = (over = {}) => ({
  platform: 'discord',
  accent: '',
  background: 'none',
  upload: null,
  splash: { available: false, copied: null },
  ...over,
});

describe('Settings: public pages share the page save bar', () => {
  it('an edit in "Public pages" shows the bar, and Save writes only the public pages when nothing else changed', async () => {
    getGuildSettings.mockResolvedValue(settings());
    getPublicLook.mockResolvedValue(look());
    savePublicLook.mockResolvedValue(look({ accent: '#5865f2' }));
    renderAtGuild(<Settings />, GUILD);
    const accent = await screen.findByLabelText('Accent colour');
    expect(screen.queryByText('Unsaved changes')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save public pages' })).toBeNull();

    fireEvent.change(accent, { target: { value: '#5865f2' } });
    expect(await screen.findByText('Unsaved changes')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(savePublicLook).toHaveBeenCalledWith(GUILD, { accent: '#5865f2', background: 'none' })
    );
    expect(saveGuildSettings).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' }).disabled).toBe(true));
  });

  it('saves the settings first and then the public pages when both changed', async () => {
    getGuildSettings.mockResolvedValue(settings({ platform: 'fluxer' }));
    getPublicLook.mockResolvedValue(look());
    savePublicLook.mockResolvedValue(look({ background: 'none', accent: '#5865f2' }));
    renderAtGuild(<Settings />, GUILD);
    fireEvent.change(await screen.findByLabelText(/Command prefix/), { target: { value: '>>' } });
    fireEvent.change(await screen.findByLabelText('Accent colour'), { target: { value: '#5865f2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(savePublicLook).toHaveBeenCalledTimes(1));
    expect(saveGuildSettings).toHaveBeenCalledTimes(1);
  });

  it('does not save the public pages when the settings are refused', async () => {
    getGuildSettings.mockResolvedValue(settings({ platform: 'fluxer' }));
    getPublicLook.mockResolvedValue(look());
    renderAtGuild(<Settings />, GUILD);
    fireEvent.change(await screen.findByLabelText(/Command prefix/), { target: { value: 'a b' } });
    fireEvent.change(await screen.findByLabelText('Accent colour'), { target: { value: '#5865f2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith('The prefix can not contain spaces.'));
    expect(savePublicLook).not.toHaveBeenCalled();
  });

  it('Reset drops the edit in "Public pages" too', async () => {
    getGuildSettings.mockResolvedValue(settings());
    getPublicLook.mockResolvedValue(look());
    renderAtGuild(<Settings />, GUILD);
    const accent = await screen.findByLabelText('Accent colour');
    fireEvent.change(accent, { target: { value: '#5865f2' } });
    expect(accent.value).toBe('#5865f2');
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(screen.getByLabelText('Accent colour').value).toBe(''));
    expect(screen.getByRole('button', { name: 'Save' }).disabled).toBe(true);
  });
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
    expect(screen.getByText('?help', { selector: 'code' })).toBeTruthy();
    expect(screen.getByText('!', { selector: 'code' })).toBeTruthy();
  });

  it('with no prefix of its own it explains with the default', async () => {
    getGuildSettings.mockResolvedValue(settings({ platform: 'fluxer' }));
    renderAtGuild(<Settings />, GUILD);
    const input = await screen.findByLabelText(/Command prefix/);
    expect(input.value).toBe('');
    expect(screen.getByText('!help', { selector: 'code' })).toBeTruthy();
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

  it('flags a backtick and invisible characters', async () => {
    getGuildSettings.mockResolvedValue(settings({ platform: 'fluxer' }));
    renderAtGuild(<Settings />, GUILD);
    const input = await screen.findByLabelText(/Command prefix/);
    fireEvent.change(input, { target: { value: '`' } });
    expect(screen.getByText('The prefix can not contain a backtick (`).')).toBeTruthy();
    fireEvent.change(input, { target: { value: '!\u200d' } });
    expect(screen.getByText('The prefix can not contain invisible or control characters.')).toBeTruthy();
  });

  it('does not send a prefix that is not allowed, and says why', async () => {
    getGuildSettings.mockResolvedValue(settings({ platform: 'fluxer' }));
    renderAtGuild(<Settings />, GUILD);
    const input = await screen.findByLabelText(/Command prefix/);
    fireEvent.change(input, { target: { value: 'a b' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith('The prefix can not contain spaces.'));
    expect(saveGuildSettings).not.toHaveBeenCalled();
  });

  it('trims the prefix: what is sent and what the field shows after saving', async () => {
    getGuildSettings.mockResolvedValue(settings({ platform: 'fluxer' }));
    renderAtGuild(<Settings />, GUILD);
    const input = await screen.findByLabelText(/Command prefix/);
    fireEvent.change(input, { target: { value: ' ?? ' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saveGuildSettings).toHaveBeenCalledTimes(1));
    expect(saveGuildSettings.mock.calls[0][1].commandPrefix).toBe('??');
    await waitFor(() => expect(screen.getByLabelText(/Command prefix/).value).toBe('??'));
  });
});
