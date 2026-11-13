import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Welcome from '../moduleForms/Welcome.jsx';
import { resetModuleLimits } from '../components/useModuleLimits.js';
import { renderAtGuild } from './routerHarness.jsx';

vi.mock('../api.js', () => ({
  ApiError: class ApiError extends Error {},
  getModuleConfig: vi.fn(),
  saveModuleConfig: vi.fn(),
  getModuleLimits: vi.fn(),
  getAccount: vi.fn(),
  sendModuleTest: vi.fn(),
  welcomeCardPreviewUrl: () => '/preview.png',
}));
const api = await import('../api.js');

const GUILD = '123456789012345678';
const CHANNEL = '555555555555555555';
const roles = Array.from({ length: 12 }, (_, i) => ({
  id: `1000000000000000${String(i).padStart(2, '0')}`,
  name: `Role ${i}`,
}));

const data = (config = {}) => ({
  config: {
    joinEnabled: true,
    joinChannel: CHANNEL,
    joinMessage: 'Welcome {user}!',
    useEmbed: false,
    card: false,
    cardBackground: '',
    dmEnabled: false,
    dmMessage: '',
    leaveEnabled: false,
    leaveChannel: '',
    leaveMessage: '',
    autoroleEnabled: false,
    autoroles: [],
    trigger: 'join',
    triggerRoleIds: [],
    ...config,
  },
  channels: [{ id: CHANNEL, name: 'general' }],
  roles,
  verificationEnabled: false,
  verificationMode: 'button',
  placeholders: ['{user}', '{role}'],
});

beforeEach(() => {
  vi.resetAllMocks();
  resetModuleLimits();
  api.getModuleLimits.mockResolvedValue({ _embed: {}, welcome: { triggerRoleIds: { maxItems: 10 } } });
});

describe('Welcome: when to welcome', () => {
  it('offers the two moments, with "when a member joins" on by default and no role picker', async () => {
    api.getModuleConfig.mockResolvedValue(data());
    renderAtGuild(<Welcome />, GUILD);
    const join = await screen.findByLabelText('When a member joins');
    expect(join.checked).toBe(true);
    expect(screen.getByLabelText('When a member gets a role').checked).toBe(false);
    expect(screen.queryByText('Roles that start the welcome')).toBeNull();
  });

  it('a config from before the setting existed reads as "when a member joins"', async () => {
    const old = data();
    delete old.config.trigger;
    delete old.config.triggerRoleIds;
    api.getModuleConfig.mockResolvedValue(old);
    renderAtGuild(<Welcome />, GUILD);
    expect((await screen.findByLabelText('When a member joins')).checked).toBe(true);
  });

  it('role mode shows the roles, the hint with its links, and warns while none is picked', async () => {
    api.getModuleConfig.mockResolvedValue(data({ trigger: 'role' }));
    renderAtGuild(<Welcome />, GUILD);
    expect((await screen.findByLabelText('When a member gets a role')).checked).toBe(true);
    expect(screen.getByText('Roles that start the welcome')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Verification' }).getAttribute('href')).toBe(
      `/guilds/${GUILD}/m/verification`
    );
    expect(screen.getByRole('link', { name: 'application' }).getAttribute('href')).toBe(
      `/guilds/${GUILD}/m/applications`
    );
    expect(screen.getByText(/are not welcomed by a role/)).toBeTruthy();
    expect(screen.getByText(/No role is picked, so no welcome is sent/)).toBeTruthy();
  });

  it('picking a role clears the warning, and the choice is saved with the form', async () => {
    api.getModuleConfig.mockResolvedValue(data());
    api.saveModuleConfig.mockImplementation(async (_g, _id, body) => ({ config: body }));
    renderAtGuild(<Welcome />, GUILD);
    fireEvent.click(await screen.findByLabelText('When a member gets a role'));
    expect(screen.getByText(/No role is picked/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Add a role'), { target: { value: roles[3].id } });
    expect(screen.queryByText(/No role is picked/)).toBeNull();
    expect(screen.getByText('Role 3')).toBeTruthy();

    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.saveModuleConfig).toHaveBeenCalled());
    const body = api.saveModuleConfig.mock.calls[0][2];
    expect(body.trigger).toBe('role');
    expect(body.triggerRoleIds).toEqual([roles[3].id]);
  });

  it('at most 10 roles can be picked', async () => {
    api.getModuleConfig.mockResolvedValue(
      data({ trigger: 'role', triggerRoleIds: roles.slice(0, 10).map((r) => r.id) })
    );
    renderAtGuild(<Welcome />, GUILD);
    // the limit arrives with the module limits, a moment after the form
    expect(await screen.findByRole('option', { name: 'At most 10 picked' })).toBeTruthy();
    expect(screen.getByLabelText('Add a role').disabled).toBe(true);
  });

  it('offers {role} under the welcome message and the DM, but not under the leave message', async () => {
    api.getModuleConfig.mockResolvedValue(data({ dmEnabled: true, leaveEnabled: true }));
    renderAtGuild(<Welcome />, GUILD);
    await screen.findByLabelText('When a member joins');
    expect(screen.getAllByRole('button', { name: 'Insert {role}' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Insert {user}' })).toHaveLength(3);
  });
});
