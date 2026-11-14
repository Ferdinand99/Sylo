import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessBadge, AccessLock, AccessProvider } from '../access.jsx';
import SaveBar from '../components/SaveBar.jsx';
import Switch from '../components/Switch.jsx';
import RowActions from '../components/RowActions.jsx';
import Settings from '../pages/Settings.jsx';

vi.mock('../api.js', () => ({
  ApiError: class ApiError extends Error {},
  getGuildAccess: vi.fn(),
  saveGuildAccess: vi.fn(),
  getGuildSettings: vi.fn(),
  saveGuildSettings: vi.fn(),
  exportGuildConfig: vi.fn(),
}));
vi.mock('../notify.js', () => ({ notify: vi.fn() }));
const { getGuildAccess, saveGuildAccess, getGuildSettings, saveGuildSettings } = await import('../api.js');

const GUILD = '123456789012345678';

/** `element` under a data router (SaveBar needs one) and the access provider for GUILD. */
function renderWithAccess(element) {
  const router = createMemoryRouter(
    [{ path: '/g/:guildId', element: <AccessProvider guildId={GUILD}>{element}</AccessProvider> }],
    { initialEntries: [`/g/${GUILD}`] }
  );
  return render(<RouterProvider router={router} />);
}

const access = (level, over = {}) => ({
  level,
  editRoleIds: [],
  inboxRoleIds: [],
  viewRoleIds: [],
  canChangeEditRoles: level === 'edit',
  ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
});

describe('the access badge', () => {
  it.each([
    ['view', 'View only'],
    ['inbox', 'Inbox only'],
  ])('shows %s in the top bar', async (level, label) => {
    getGuildAccess.mockResolvedValue(access(level));
    renderWithAccess(<AccessBadge />);
    expect(await screen.findByText(label)).toBeTruthy();
    expect(getGuildAccess).toHaveBeenCalledWith(GUILD);
  });

  it('shows nothing with Edit, or when the level cannot be read', async () => {
    getGuildAccess.mockResolvedValue(access('edit'));
    const { container } = renderWithAccess(<AccessBadge />);
    await waitFor(() => expect(getGuildAccess).toHaveBeenCalled());
    expect(container.textContent).toBe('');
    getGuildAccess.mockRejectedValue(new Error('offline'));
    const other = renderWithAccess(<AccessBadge />);
    await waitFor(() => expect(getGuildAccess).toHaveBeenCalledTimes(2));
    expect(other.container.textContent).toBe('');
  });
});

describe('controls below the level they need', () => {
  it('View: the switch, the save button and the row actions are disabled, with the reason', async () => {
    getGuildAccess.mockResolvedValue(access('view'));
    renderWithAccess(
      <>
        <Switch checked={false} onChange={() => {}} label="Enable AFK" />
        <RowActions
          edit={{ onClick: () => {} }}
          menuLabel="More"
          items={[{ label: 'Delete', onClick: () => {} }]}
        />
        <SaveBar dirty onSave={() => {}} onReset={() => {}} />
      </>
    );
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Enable AFK' }).disabled).toBe(true));
    expect(screen.getByRole('button', { name: 'Edit' }).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Save' }).disabled).toBe(true);
    expect(screen.getByText("View only: you can't save changes here")).toBeTruthy();
  });

  it('Inbox: an inbox action is open, a settings form is locked', async () => {
    getGuildAccess.mockResolvedValue(access('inbox'));
    renderWithAccess(
      <>
        <AccessLock need="inbox">
          <button type="button">Reply</button>
        </AccessLock>
        <AccessLock need="edit" note>
          <input aria-label="Channel" />
        </AccessLock>
      </>
    );
    await screen.findByText(/Inbox only: you can look at this/);
    expect(screen.getByRole('button', { name: 'Reply' }).closest('fieldset').disabled).toBe(false);
    expect(screen.getByLabelText('Channel').closest('fieldset').disabled).toBe(true);
  });

  it('Edit (and no provider at all): nothing is locked', async () => {
    getGuildAccess.mockResolvedValue(access('edit'));
    renderWithAccess(
      <AccessLock need="edit" note>
        <input aria-label="Channel" />
      </AccessLock>
    );
    await waitFor(() => expect(getGuildAccess).toHaveBeenCalled());
    expect(screen.getByLabelText('Channel').closest('fieldset').disabled).toBe(false);
    expect(screen.queryByText(/you can look at this/)).toBeNull();
    render(<Switch checked={false} onChange={() => {}} label="Alone" />);
    expect(screen.getByRole('switch', { name: 'Alone' }).disabled).toBe(false);
  });
});

describe('Server settings: dashboard access', () => {
  const settings = () => ({
    guild: { id: GUILD, name: 'Hedgerow', icon: null },
    platform: 'discord',
    commandPrefix: '',
    defaultCommandPrefix: '!',
    effectiveCommandPrefix: '/',
    commandPrefixMaxLength: 5,
    modlogChannelId: '',
    embedColorHex: '#7aa2f7',
    channels: [],
    roles: [
      { id: '700000000000000001', name: 'Mods' },
      { id: '700000000000000002', name: 'Helpers' },
    ],
    botMasterRoleIds: ['700000000000000001'],
  });

  it('shows the three levels and saves the Inbox and View roles only when they changed', async () => {
    getGuildAccess.mockResolvedValue(access('edit', { editRoleIds: ['700000000000000001'] }));
    getGuildSettings.mockResolvedValue(settings());
    saveGuildSettings.mockResolvedValue({ ok: true });
    saveGuildAccess.mockResolvedValue(access('edit', { inboxRoleIds: ['700000000000000002'] }));
    renderWithAccess(<Settings />);
    expect(await screen.findByRole('group', { name: 'Edit' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Inbox' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'View' })).toBeTruthy();

    // Another setting only: the access roles are not written.
    fireEvent.change(screen.getByLabelText('Default embed colour'), { target: { value: '#112233' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saveGuildSettings).toHaveBeenCalledTimes(1));
    expect(saveGuildSettings.mock.calls[0][1]).not.toHaveProperty('inboxRoleIds');
    expect(saveGuildAccess).not.toHaveBeenCalled();

    // An Inbox role: written to the access route.
    const inbox = screen.getByRole('group', { name: 'Inbox' });
    fireEvent.change(inbox.querySelector('select'), { target: { value: '700000000000000002' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(saveGuildAccess).toHaveBeenCalledWith(GUILD, {
        inboxRoleIds: ['700000000000000002'],
        viewRoleIds: [],
      })
    );
  });

  it('locks the Edit roles for a bot master, and the whole form below Edit', async () => {
    getGuildAccess.mockResolvedValue(access('edit', { canChangeEditRoles: false }));
    getGuildSettings.mockResolvedValue(settings());
    renderWithAccess(<Settings />);
    const edit = await screen.findByRole('group', { name: 'Edit' });
    expect(edit.querySelector('fieldset').disabled).toBe(true);
    expect(screen.getByText(/Only the server owner or someone with Manage Server/)).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Inbox' }).closest('fieldset.v2-access-lock').disabled).toBe(
      false
    );
  });

  it('View: the form is disabled and says why', async () => {
    getGuildAccess.mockResolvedValue(access('view'));
    getGuildSettings.mockResolvedValue(settings());
    renderWithAccess(<Settings />);
    await screen.findByText(/View only: you can look at this/);
    expect(screen.getByLabelText('Default embed colour').closest('fieldset').disabled).toBe(true);
  });
});
