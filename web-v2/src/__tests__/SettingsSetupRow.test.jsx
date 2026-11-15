import { screen } from '@testing-library/react';
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
vi.mock('../setupAccess.js', () => ({ useCanSetUp: vi.fn() }));
const { getGuildSettings } = await import('../api.js');
const { useCanSetUp } = await import('../setupAccess.js');

const GUILD = '123456789012345678';

beforeEach(() => {
  vi.resetAllMocks();
  getGuildSettings.mockResolvedValue({
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
  });
});

describe('Settings: the setup wizard row', () => {
  it('links to the wizard for someone who may set the server up', async () => {
    useCanSetUp.mockReturnValue(true);
    renderAtGuild(<Settings />, GUILD);
    const link = await screen.findByRole('link', { name: /Setup wizard/ });
    expect(link.getAttribute('href')).toBe(`/guilds/${GUILD}/setup`);
  });

  it('is left out for someone who may not', async () => {
    useCanSetUp.mockReturnValue(false);
    renderAtGuild(<Settings />, GUILD);
    await screen.findByLabelText('Default embed colour');
    expect(screen.queryByRole('link', { name: /Setup wizard/ })).toBeNull();
  });
});
