import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TempRoles from '../moduleForms/TempRoles.jsx';
import { resetModuleLimits } from '../components/useModuleLimits.js';
import { renderAtGuild } from './routerHarness.jsx';

vi.mock('../api.js', () => ({
  ApiError: class ApiError extends Error {},
  getModuleConfig: vi.fn(),
  saveModuleConfig: vi.fn(),
  getModuleLimits: vi.fn(),
  getTempRoles: vi.fn(),
  searchTempRoleMembers: vi.fn(),
  addTempRole: vi.fn(),
  removeTempRole: vi.fn(),
}));
vi.mock('../notify.js', () => ({ notify: vi.fn() }));
vi.mock('../components/ConfirmDialog.jsx', () => ({ confirmDialog: vi.fn().mockResolvedValue(true) }));
const { getModuleConfig, getModuleLimits, getTempRoles, searchTempRoleMembers, addTempRole, removeTempRole } =
  await import('../api.js');
const { confirmDialog } = await import('../components/ConfirmDialog.jsx');
const { notify } = await import('../notify.js');

const GUILD = '123456789012345678';
const ROLE_A = '555555555555555551';
const ROLE_B = '555555555555555552';

// What GET /api/v2/modules/limits answers for the temp-roles module (src/modules/tempRoles.js, LIMITS).
const limits = {
  'temp-roles': { reason: { maxLength: 500 }, staffRoles: { maxItems: 25 } },
  _embed: {},
};

const row = (over = {}) => ({
  userId: '111111111111111111',
  member: 'Alice',
  roleId: ROLE_A,
  role: 'Supporter',
  expiresAt: Date.UTC(2030, 0, 5, 12, 30),
  createdAt: Date.UTC(2030, 0, 1),
  addedBy: '222222222222222222',
  addedByName: 'Bob',
  reason: 'Trial',
  ...over,
});
const listOf = (rows, total = rows.length, matching = rows.length) => ({ total, matching, rows });

const config = { staffRoles: [], dmMember: false, defaultDuration: '7d' };

beforeEach(() => {
  vi.resetAllMocks();
  confirmDialog.mockResolvedValue(true);
  resetModuleLimits();
  getModuleLimits.mockResolvedValue(limits);
  getModuleConfig.mockResolvedValue({
    config,
    roles: [
      { id: ROLE_A, name: 'Supporter' },
      { id: ROLE_B, name: 'Guest' },
    ],
    list: listOf([
      row(),
      row({
        userId: '333333333333333333',
        member: 'Carol',
        roleId: ROLE_B,
        role: 'Guest',
        reason: '',
        addedByName: null,
      }),
    ]),
  });
});

describe('TempRoles form', () => {
  it('lists the active temporary roles with end time, who set them and why', async () => {
    renderAtGuild(<TempRoles />, GUILD);
    expect(await screen.findByRole('heading', { name: 'Temporary roles' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Active temporary roles (2)' })).toBeTruthy();
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.getByText(/Ends 2030-01-05 12:30 UTC · set by Bob · Trial/)).toBeTruthy();
    expect(screen.getByText('Carol')).toBeTruthy();
    expect(getModuleConfig).toHaveBeenCalledWith(GUILD, 'temp-roles');
  });

  it('shows the settings, the default duration in the Add form, and the reason limit from the server', async () => {
    renderAtGuild(<TempRoles />, GUILD);
    expect((await screen.findByLabelText('Default duration')).value).toBe('7d');
    expect(screen.getByLabelText(/Send the member a DM/).checked).toBe(false);
    expect(screen.getByLabelText('For how long').value).toBe('7d');
    const reason = screen.getByLabelText(/Reason/);
    await waitFor(() => expect(reason.maxLength).toBe(500));
  });

  it('typing in the search or choosing a role asks the server for the matching rows', async () => {
    getTempRoles.mockResolvedValue({ list: listOf([row()], 2, 1) });
    renderAtGuild(<TempRoles />, GUILD);
    fireEvent.change(await screen.findByLabelText('Search'), { target: { value: 'ali' } });
    await waitFor(() => expect(getTempRoles).toHaveBeenCalledWith(GUILD, { q: 'ali', roleId: '' }));
    expect(await screen.findByRole('heading', { name: 'Active temporary roles (1 of 2)' })).toBeTruthy();
    expect(screen.queryByText('Carol')).toBeNull();
    fireEvent.change(screen.getByLabelText('Role', { selector: '#tr-filter-role' }), {
      target: { value: ROLE_B },
    });
    await waitFor(() => expect(getTempRoles).toHaveBeenCalledWith(GUILD, { q: 'ali', roleId: ROLE_B }));
  });

  it('finds a member by name, gives the role through the same call, and reloads the list', async () => {
    searchTempRoleMembers.mockResolvedValue({
      members: [{ id: '444444444444444444', name: 'Dave', username: 'dave99' }],
    });
    addTempRole.mockResolvedValue({
      replaced: false,
      expiresAt: Date.UTC(2030, 0, 2, 8, 0),
      list: listOf([row({ userId: '444444444444444444', member: 'Dave' })]),
    });
    renderAtGuild(<TempRoles />, GUILD);
    fireEvent.change(await screen.findByPlaceholderText(/Type a name/), { target: { value: 'dav' } });
    await waitFor(() => expect(searchTempRoleMembers).toHaveBeenCalledWith(GUILD, 'dav'));
    fireEvent.click(await screen.findByRole('option', { name: /Dave \(dave99\)/ }));
    expect(screen.getByRole('button', { name: 'Clear Dave' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Role', { selector: '#tr-role' }), { target: { value: ROLE_A } });
    fireEvent.change(screen.getByLabelText('For how long'), { target: { value: '1d12h' } });
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Welcome gift' } });
    fireEvent.click(screen.getByRole('button', { name: 'Give role' }));
    await waitFor(() =>
      expect(addTempRole).toHaveBeenCalledWith(GUILD, {
        userId: '444444444444444444',
        roleId: ROLE_A,
        duration: '1d12h',
        reason: 'Welcome gift',
        filter: { q: '', roleId: '' },
      })
    );
    expect(await screen.findByText('Dave')).toBeTruthy();
    expect(notify).toHaveBeenCalledWith('Dave has the role until 2030-01-02 08:00 UTC.');
    expect(screen.queryByRole('button', { name: 'Clear Dave' }), 'the member is cleared').toBeNull();
  });

  it('says when a time was replaced, and shows the server error when the add is refused', async () => {
    searchTempRoleMembers.mockResolvedValue({
      members: [{ id: '444444444444444444', name: 'Dave', username: 'dave' }],
    });
    addTempRole.mockResolvedValueOnce({
      replaced: true,
      expiresAt: Date.UTC(2030, 0, 2),
      list: listOf([row()]),
    });
    addTempRole.mockRejectedValueOnce(new Error('That role is above Sylo’s highest role.'));
    renderAtGuild(<TempRoles />, GUILD);
    const pick = async () => {
      fireEvent.change(await screen.findByPlaceholderText(/Type a name/), { target: { value: 'dav' } });
      fireEvent.click(await screen.findByRole('option', { name: /Dave/ }));
      fireEvent.change(screen.getByLabelText('Role', { selector: '#tr-role' }), {
        target: { value: ROLE_A },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Give role' }));
    };
    await pick();
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(expect.stringMatching(/replaced the earlier time/))
    );
    await pick();
    await waitFor(() => expect(notify).toHaveBeenCalledWith('That role is above Sylo’s highest role.'));
  });

  it('asks for a member and a role before it calls the server', async () => {
    renderAtGuild(<TempRoles />, GUILD);
    fireEvent.click(await screen.findByRole('button', { name: 'Give role' }));
    expect(notify).toHaveBeenCalledWith('Pick a member.');
    expect(addTempRole).not.toHaveBeenCalled();
  });

  it('removes a row after confirming and shows the answer; a declined confirmation does nothing', async () => {
    removeTempRole.mockResolvedValue({
      roleRemoved: false,
      warning: 'The record is gone, but the role is still on the member.',
      list: listOf([row({ userId: '333333333333333333', member: 'Carol', roleId: ROLE_B, role: 'Guest' })]),
    });
    renderAtGuild(<TempRoles />, GUILD);
    confirmDialog.mockResolvedValueOnce(false);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Remove' }))[0]);
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(1));
    expect(removeTempRole).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]);
    await waitFor(() =>
      expect(removeTempRole).toHaveBeenCalledWith(GUILD, {
        userId: '111111111111111111',
        roleId: ROLE_A,
        filter: { q: '', roleId: '' },
      })
    );
    expect(confirmDialog).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: 'Take Supporter back from Alice?' })
    );
    await waitFor(() => expect(screen.queryByText('Alice')).toBeNull());
    expect(notify).toHaveBeenCalledWith('The record is gone, but the role is still on the member.');
  });

  it('says so when nothing matches', async () => {
    getModuleConfig.mockResolvedValue({ config, roles: [], list: listOf([], 0) });
    renderAtGuild(<TempRoles />, GUILD);
    expect(await screen.findByText('Nothing here.')).toBeTruthy();
  });
});
