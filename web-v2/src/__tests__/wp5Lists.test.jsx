import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, RouterProvider, createMemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ChipPicker from '../components/ChipPicker.jsx';
import RowActions from '../components/RowActions.jsx';
import Reminders from '../moduleForms/Reminders.jsx';
import ChannelCleanup from '../moduleForms/ChannelCleanup.jsx';
import GithubAlerts from '../moduleForms/GithubAlerts.jsx';
import Roles from '../moduleForms/Roles.jsx';
import CustomCommands from '../moduleForms/CustomCommands.jsx';
import Starboard from '../moduleForms/Starboard.jsx';
import Messages from '../pages/Messages.jsx';
import RoadmapAdmin from '../pages/RoadmapAdmin.jsx';
import Personalizer from '../pages/Personalizer.jsx';
import { appendEmoji } from '../emojiText.js';
import { resetModuleLimits } from '../components/useModuleLimits.js';
import { renderAtGuild } from './routerHarness.jsx';

vi.mock('../api.js', () => ({
  ApiError: class ApiError extends Error {},
  getModuleConfig: vi.fn(),
  saveModuleConfig: vi.fn(),
  getModuleLimits: vi.fn(),
  getGuildEmojis: vi.fn(),
  searchMembers: vi.fn(),
  getReminders: vi.fn(),
  deleteReminder: vi.fn(),
  toggleReminder: vi.fn(),
  getCleanupSchedules: vi.fn(),
  deleteCleanupSchedule: vi.fn(),
  toggleCleanupSchedule: vi.fn(),
  getGithubWatches: vi.fn(),
  deleteGithubWatch: vi.fn(),
  toggleGithubWatch: vi.fn(),
  getRoles: vi.fn(),
  deleteReactionRole: vi.fn(),
  getComposedMessages: vi.fn(),
  unpublishComposedMessage: vi.fn(),
  deleteComposedMessage: vi.fn(),
  getCustomCommands: vi.fn(),
  saveCustomCommand: vi.fn(),
  deleteCustomCommand: vi.fn(),
  getRoadmapAdmin: vi.fn(),
  deleteRoadmapPost: vi.fn(),
  getPersonalizer: vi.fn(),
  getPersonalizerPresence: vi.fn(),
  getAnnouncement: vi.fn(),
  savePersonalizerIdentity: vi.fn(),
  savePersonalizerPresence: vi.fn(),
  savePersonalizerAnnouncement: vi.fn(),
  clearPersonalizerAnnouncement: vi.fn(),
}));
vi.mock('../notify.js', () => ({ notify: vi.fn() }));
vi.mock('../components/ConfirmDialog.jsx', () => ({ confirmDialog: vi.fn().mockResolvedValue(true) }));
const api = await import('../api.js');
const { confirmDialog } = await import('../components/ConfirmDialog.jsx');

const GUILD = '123456789012345678';
const CH = '222222222222222222';
const ROLE = '333333333333333333';
const CHANNELS = [{ id: CH, name: 'welcome' }];
const ROLES = [{ id: ROLE, name: 'Verified' }];

beforeEach(() => {
  vi.resetAllMocks();
  confirmDialog.mockResolvedValue(true);
  resetModuleLimits();
  api.getModuleLimits.mockResolvedValue({ _embed: {} });
  api.searchMembers.mockResolvedValue({ members: [] });
  api.getGuildEmojis.mockResolvedValue({ custom: [] });
});
afterEach(() => {
  delete window.matchMedia;
});

// The accent buttons of a page, not counting the SaveBar's (it is always on the page, hidden until an edit).
const accentButtons = (container) =>
  [...container.querySelectorAll('.v2-btn-primary')].filter((b) => !b.closest('.v2-savebar'));
const openMenu = (name) => fireEvent.click(screen.getByRole('button', { name }));
const menuLabels = () => screen.getAllByRole('menuitem').map((i) => i.textContent);

// jsdom has no execCommand, so MentionTextarea falls back to setting the value and firing an input event.
function type(el, text) {
  fireEvent.change(el, { target: { value: text } });
  el.setSelectionRange(text.length, text.length);
  fireEvent.input(el);
}

describe('ChipPicker (one control for one field)', () => {
  function Harness({ start = [] }) {
    const [value, setValue] = useState(start);
    return <ChipPicker items={ROLES} value={value} onChange={setValue} />;
  }

  it('shows only the select while nothing is picked, with no "None selected" box', () => {
    const { container } = render(<Harness />);
    expect(screen.queryByText('None selected')).toBeNull();
    expect(container.querySelector('.v2-chip-row').classList.contains('is-bare')).toBe(true);
    expect(container.querySelectorAll('.v2-chip')).toHaveLength(0);
    expect(screen.getByRole('combobox', { name: 'Add a role' })).toBeTruthy();
  });

  it('puts the select inline after the last chip once something is picked, and keeps it mounted', () => {
    const { container } = render(<Harness />);
    const select = screen.getByRole('combobox', { name: 'Add a role' });
    fireEvent.change(select, { target: { value: ROLE } });
    const row = container.querySelector('.v2-chip-row');
    expect(row.classList.contains('is-bare')).toBe(false);
    expect(row.querySelectorAll('.v2-chip')).toHaveLength(1);
    expect(row.lastElementChild).toBe(select);
    expect(screen.getByRole('combobox', { name: 'Add a role' })).toBe(select);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Verified' }));
    expect(container.querySelector('.v2-chip-row').classList.contains('is-bare')).toBe(true);
  });
});

describe('RowActions', () => {
  it('shows Edit as a button or a link, and the rest in a menu that runs the item', () => {
    const onEdit = vi.fn();
    const onPause = vi.fn();
    render(
      <MemoryRouter>
        <RowActions
          edit={{ onClick: onEdit }}
          menuLabel="More actions for A"
          items={[{ label: 'Pause', onClick: onPause }]}
        />
        <RowActions edit={{ to: '/x' }} menuLabel="More actions for B" items={[]} />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('link', { name: 'Edit' }).getAttribute('href')).toBe('/x');
    // no items, no "⋯"
    expect(screen.queryByRole('button', { name: 'More actions for B' })).toBeNull();
    openMenu('More actions for A');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pause' }));
    expect(onPause).toHaveBeenCalledTimes(1);
  });
});

describe('list rows: Edit plus a "⋯" menu, one accent button', () => {
  const reminder = {
    id: 1,
    name: 'Stretch',
    channelId: CH,
    mode: 'multiple',
    intervalMinutes: 60,
    days: [0, 1, 2, 3, 4, 5, 6],
    enabled: true,
  };
  const loadReminders = (reminders) =>
    api.getReminders.mockResolvedValue({
      channels: CHANNELS,
      schedulePresets: [[60, 'Every hour']],
      weekdays: [],
      allowPings: false,
      reminders,
    });

  it('Reminders', async () => {
    loadReminders([reminder]);
    api.toggleReminder.mockResolvedValue({});
    api.deleteReminder.mockResolvedValue({});
    const { container } = renderAtGuild(<Reminders />, GUILD);
    await screen.findByText(/Stretch/);
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
    // Pause and Delete are not on the row
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(accentButtons(container).map((b) => b.textContent)).toEqual(['+ New reminder']);

    openMenu('More actions for Stretch');
    expect(menuLabels()).toEqual(['Pause', 'Delete']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pause' }));
    await waitFor(() => expect(api.toggleReminder).toHaveBeenCalledWith(GUILD, 1));

    openMenu('More actions for Stretch');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.deleteReminder).toHaveBeenCalledWith(GUILD, 1));
  });

  it('Reminders: a declined confirmation deletes nothing', async () => {
    loadReminders([reminder]);
    confirmDialog.mockResolvedValue(false);
    renderAtGuild(<Reminders />, GUILD);
    await screen.findByText(/Stretch/);
    openMenu('More actions for Stretch');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(1));
    expect(api.deleteReminder).not.toHaveBeenCalled();
  });

  it('Reminders: the new button is an accent in the header, and the empty state has the same one as a secondary', async () => {
    loadReminders([]);
    const { container } = renderAtGuild(<Reminders />, GUILD);
    await screen.findByText(/Post a message in a channel on a schedule/);
    // one accent button: the empty state's own start button; the header's "+ New reminder" steps aside
    expect(accentButtons(container).map((b) => b.textContent)).toEqual(['Add your first reminder']);
    const header = container.querySelector('.v2-listhead');
    expect(within(header).queryByRole('button', { name: '+ New reminder' })).toBeNull();
    const empty = container.querySelector('.v2-empty');
    fireEvent.click(within(empty).getByRole('button', { name: 'Add your first reminder' }));
    // the editor opened
    expect(await screen.findByRole('heading', { name: 'New reminder' })).toBeTruthy();
  });

  it('Channel cleanup', async () => {
    api.getCleanupSchedules.mockResolvedValue({
      channels: CHANNELS,
      weekdays: [],
      maxAgeHoursCap: 720,
      schedules: [{ id: 5, channelId: CH, days: [1], timeHhmm: '04:00', maxAgeHours: 24, enabled: false }],
    });
    api.toggleCleanupSchedule.mockResolvedValue({});
    api.deleteCleanupSchedule.mockResolvedValue({});
    const { container } = renderAtGuild(<ChannelCleanup />, GUILD);
    await screen.findByText('#welcome');
    expect(accentButtons(container).map((b) => b.textContent)).toEqual(['+ New schedule']);
    openMenu('More actions for #welcome');
    expect(menuLabels()).toEqual(['Resume', 'Delete']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Resume' }));
    await waitFor(() => expect(api.toggleCleanupSchedule).toHaveBeenCalledWith(GUILD, 5));
    openMenu('More actions for #welcome');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    await waitFor(() => expect(api.deleteCleanupSchedule).toHaveBeenCalledWith(GUILD, 5));
    expect(confirmDialog).toHaveBeenCalledTimes(1);
  });

  it('GitHub alerts: the add button is an accent in the header; the menu holds webhook setup, pause and delete', async () => {
    api.getGithubWatches.mockResolvedValue({
      channels: CHANNELS,
      roles: [],
      eventTypes: [],
      dashboardUrlSet: true,
      watches: [
        { id: 9, repo: 'a/one', channelId: CH, roleId: '', changelogPath: '', events: [], enabled: true },
      ],
    });
    api.deleteGithubWatch.mockResolvedValue({});
    const { container } = renderAtGuild(<GithubAlerts />, GUILD);
    await screen.findByText('a/one');
    expect(accentButtons(container).map((b) => b.textContent)).toEqual(['+ Add repository']);
    openMenu('More actions for a/one');
    expect(menuLabels()).toEqual(['Webhook setup', 'Pause', 'Delete']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Webhook setup' }));
    expect(await screen.findByText(/Settings → Webhooks → Add webhook/)).toBeTruthy();
    openMenu('More actions for a/one');
    expect(menuLabels()[0]).toBe('Hide webhook setup');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    await waitFor(() => expect(api.deleteGithubWatch).toHaveBeenCalledWith(GUILD, 9));
  });

  it('Reaction roles: Edit and a menu with Delete; the autoroles keep the SaveBar', async () => {
    api.getRoles.mockResolvedValue({
      channels: CHANNELS,
      roles: ROLES,
      autoroles: [],
      reactionMessages: [
        { id: 'rm1', channelId: CH, message: 'Pick one', style: 'buttons', pairs: [], messageId: '1' },
      ],
    });
    api.deleteReactionRole.mockResolvedValue({});
    const { container } = renderAtGuild(<Roles />, GUILD);
    await screen.findByText('Pick one');
    expect(accentButtons(container).map((b) => b.textContent)).toEqual(['+ New reaction role']);
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    openMenu('More actions for Pick one');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    await waitFor(() => expect(api.deleteReactionRole).toHaveBeenCalledWith(GUILD, 'rm1'));
    expect(confirmDialog).toHaveBeenCalledTimes(1);
    // the empty autoroles picker shows only its select
    expect(screen.queryByText('None selected')).toBeNull();
  });

  it('Embed messages: Edit is a link; Unpublish only on a published message, with Delete, in the menu', async () => {
    api.getComposedMessages.mockResolvedValue({
      items: [
        { id: 1, name: 'Rules', published: true, channel: 'general', when: 'today' },
        { id: 2, name: 'Draft', published: false, channel: 'general', when: 'today' },
      ],
    });
    api.unpublishComposedMessage.mockResolvedValue({});
    api.deleteComposedMessage.mockResolvedValue({});
    const { container } = renderAtGuild(<Messages />, GUILD);
    await screen.findByText('Rules');
    expect(accentButtons(container).map((b) => b.textContent)).toEqual(['+ New embed message']);
    expect(screen.getAllByRole('link', { name: 'Edit' })).toHaveLength(2);
    openMenu('More actions for Rules');
    expect(menuLabels()).toEqual(['Unpublish', 'Delete']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unpublish' }));
    await waitFor(() => expect(api.unpublishComposedMessage).toHaveBeenCalledWith(GUILD, 1));
    openMenu('More actions for Draft');
    expect(menuLabels()).toEqual(['Delete']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    await waitFor(() => expect(api.deleteComposedMessage).toHaveBeenCalledWith(GUILD, 2));
  });

  it('Roadmap admin: a public post has a status, Edit and a menu with Delete', async () => {
    api.getRoadmapAdmin.mockResolvedValue({
      pending: [],
      statuses: ['planned', 'done'],
      posts: [
        {
          id: 4,
          title: 'Dark mode',
          description: 'x',
          descriptionHtml: '<p>x</p>',
          status: 'planned',
          votes: 2,
          ago: '1d ago',
        },
      ],
    });
    api.deleteRoadmapPost.mockResolvedValue({});
    render(
      <MemoryRouter>
        <RoadmapAdmin />
      </MemoryRouter>
    );
    await screen.findByText('Dark mode');
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    openMenu('More actions for Dark mode');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    await waitFor(() => expect(api.deleteRoadmapPost).toHaveBeenCalledWith(4));
    expect(confirmDialog).toHaveBeenCalledTimes(1);
  });
});

describe('Custom commands', () => {
  const command = {
    id: 'c1',
    name: 'hello',
    description: 'Says hi',
    actions: [
      {
        type: 'reply',
        private: false,
        messages: [
          { content: 'Hello {user}', embed: null },
          { content: 'Hi again', embed: null },
        ],
      },
      { type: 'add-role', roleId: ROLE },
    ],
    allowedRoles: [],
    allowedChannels: [],
    cooldownSeconds: 0,
    reserved: false,
  };
  const load = (commands = [command]) =>
    api.getCustomCommands.mockResolvedValue({ commands, channels: CHANNELS, roles: ROLES, placeholders: [] });

  it('lists a command with Edit and a menu that holds Delete; one accent button in the header', async () => {
    load();
    api.deleteCustomCommand.mockResolvedValue({});
    const { container } = renderAtGuild(<CustomCommands />, GUILD);
    expect(await screen.findByRole('heading', { name: 'Custom commands' })).toBeTruthy();
    expect(accentButtons(container).map((b) => b.textContent)).toEqual(['+ New command']);
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    openMenu('More actions for /hello');
    expect(menuLabels()).toEqual(['Delete']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    await waitFor(() => expect(api.deleteCustomCommand).toHaveBeenCalledWith(GUILD, 'c1'));
    expect(confirmDialog).toHaveBeenCalledTimes(1);
  });

  it('over 100 commands: the count says how many Discord has, a warning names the rest, and rows beyond it say so', async () => {
    const list = Array.from({ length: 102 }, (_, i) => ({
      ...command,
      id: `c${i + 1}`,
      name: `cmd-${i + 1}`,
      beyondLimit: i >= 100,
    }));
    api.getCustomCommands.mockResolvedValue({
      commands: list,
      channels: CHANNELS,
      roles: ROLES,
      placeholders: [],
      registeredLimit: 100,
      overLimit: 2,
    });
    renderAtGuild(<CustomCommands />, GUILD);
    expect(await screen.findByRole('heading', { name: /Your commands \(102/ })).toBeTruthy();
    expect(screen.getByTestId('cc-registered').textContent).toBe('100 / 100 registered on Discord');
    const warning = screen.getByRole('alert');
    expect(warning.textContent).toMatch(/2 commands after #100 won't appear on Discord/);
    expect(warning.textContent).toMatch(/Delete the commands you no longer need/);
    expect(
      screen.getAllByText(/Not on Discord: only the first 100 commands are registered there/)
    ).toHaveLength(2);
  });

  it('no Discord counter where the platform has no such limit', async () => {
    api.getCustomCommands.mockResolvedValue({
      commands: [command],
      channels: CHANNELS,
      roles: ROLES,
      placeholders: [],
      registeredLimit: null,
      overLimit: 0,
    });
    renderAtGuild(<CustomCommands />, GUILD);
    await screen.findByText('/hello');
    expect(screen.queryByTestId('cc-registered')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('an empty list says what commands give and has one start button, not a second one in the header', async () => {
    load([]);
    const { container } = renderAtGuild(<CustomCommands />, GUILD);
    await screen.findByText(/Give members a command of your own/);
    expect(accentButtons(container).map((b) => b.textContent)).toEqual(['Create your first command']);
    expect(screen.queryByRole('button', { name: '+ New command' })).toBeNull();
  });

  it('opens an editor with one placeholder bar for all the messages, and # picks a channel', async () => {
    load();
    const { container } = renderAtGuild(<CustomCommands />, GUILD);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(await screen.findByRole('heading', { name: 'Edit /hello' })).toBeTruthy();
    // two messages in the reply, still one bar; the bar names the field it writes into
    expect(container.querySelectorAll('.v2-ph-bar')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /^Insert \{/ }).length).toBeGreaterThan(0);
    expect(container.querySelector('.v2-ph-bar').textContent).toContain('Action 1, message 1');
    // no chip row under each message field
    expect(screen.getAllByRole('group', { name: 'Insert a placeholder' })).toHaveLength(1);

    const first = screen.getByLabelText('Message 1 text');
    expect(first.getAttribute('role')).toBe('combobox');
    type(first, 'Read #wel');
    const list = await screen.findByRole('listbox', { name: 'Channels' });
    fireEvent.mouseDown(within(list).getByRole('option', { name: /welcome/ }));
    expect(first.value).toBe(`Read <#${CH}> `);
  });

  it('a placeholder chip goes into the message that was edited last', async () => {
    load();
    renderAtGuild(<CustomCommands />, GUILD);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const second = await screen.findByLabelText('Message 2 text');
    fireEvent.focus(second);
    fireEvent.click(screen.getByRole('button', { name: 'Insert {server}' }));
    expect(second.value).toContain('{server}');
    expect(screen.getByLabelText('Message 1 text').value).toBe('Hello {user}');
  });

  it('previews each message with sample data and follows the typing, without remounting the field', async () => {
    load();
    const { container } = renderAtGuild(<CustomCommands />, GUILD);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const field = await screen.findByLabelText('Message 1 text');
    // a narrow screen: the preview is folded behind a button
    expect(container.querySelector('.v2-preview-inline')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show preview' }));
    const panel = container.querySelector('.v2-preview-inline');
    expect(panel.textContent).toContain('Hello @Mara');
    expect(panel.textContent).toContain('Hi again');
    expect(panel.textContent).toContain('Action 1, message 1: reply');
    // the add-role action sends nothing, so it has no preview
    expect(within(panel).queryByText(/Action 2/)).toBeNull();
    // the field is the same element after the preview appeared
    expect(screen.getByLabelText('Message 1 text')).toBe(field);

    type(field, 'Bye {username}');
    expect(container.querySelector('.v2-preview-inline').textContent).toContain('Bye mara');
    fireEvent.click(screen.getByRole('button', { name: 'Hide preview' }));
    expect(screen.getByLabelText('Message 1 text')).toBe(field);
  });

  it('a new command opens the same editor and saving sends the messages', async () => {
    load([]);
    api.saveCustomCommand.mockResolvedValue({});
    renderAtGuild(<CustomCommands />, GUILD);
    fireEvent.click(await screen.findByRole('button', { name: 'Create your first command' }));
    expect(await screen.findByRole('heading', { name: 'New command' })).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('my-command'), { target: { value: 'ping' } });
    type(screen.getByLabelText('Message 1 text'), 'Pong');
    fireEvent.click(screen.getByRole('button', { name: 'Save & close' }));
    await waitFor(() => expect(api.saveCustomCommand).toHaveBeenCalledTimes(1));
    const [guild, body] = api.saveCustomCommand.mock.calls[0];
    expect(guild).toBe(GUILD);
    expect(body).toMatchObject({
      name: 'ping',
      actions: [{ type: 'reply', messages: [{ content: 'Pong' }] }],
    });
  });

  it('leaving the editor goes back to the list', async () => {
    load();
    renderAtGuild(<CustomCommands />, GUILD);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.click(await screen.findByRole('button', { name: '← Custom commands' }));
    expect(await screen.findByRole('heading', { name: 'Your commands (1)' })).toBeTruthy();
  });
});

describe('Starboard emoji field', () => {
  it('has the emoji picker, and a picked emoji is added after the ones already there', async () => {
    api.getModuleConfig.mockResolvedValue({
      config: { boards: [{ id: 'a', name: 'Main', channelId: CH, emojiText: '⭐' }] },
      channels: CHANNELS,
      roles: [],
    });
    renderAtGuild(<Starboard />, GUILD);
    const input = await screen.findByLabelText('Emoji(s)');
    expect(screen.getByLabelText('Pick an emoji')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '🔥' }));
    expect(input.value).toBe('⭐ 🔥');
  });

  it('appendEmoji starts clean and separates with one space', () => {
    expect(appendEmoji('', '🔥')).toBe('🔥');
    expect(appendEmoji('⭐ ', '🔥')).toBe('⭐ 🔥');
  });
});

describe('Personalizer', () => {
  function renderPage() {
    const router = createMemoryRouter(
      [
        { path: '/settings', element: <Personalizer /> },
        { path: '/elsewhere', element: <p>Elsewhere</p> },
      ],
      { initialEntries: ['/settings'] }
    );
    return { ...render(<RouterProvider router={router} />), router };
  }
  const presence = { status: 'online', type: 'Listening', text: 'music' };
  beforeEach(() => {
    api.getPersonalizer.mockResolvedValue({ bot: { tag: 'Sylo', username: 'Sylo', avatar: '' } });
    api.getPersonalizerPresence.mockResolvedValue({
      presence,
      types: ['Listening', 'Playing'],
      statuses: ['online', 'idle'],
      announcementSeverities: ['info', 'critical'],
    });
    api.getAnnouncement.mockResolvedValue({ announcement: null });
  });

  it('has no save buttons of its own for identity and presence, and one accent button (Publish)', async () => {
    const { container } = renderPage();
    await screen.findByRole('heading', { name: 'Bot personalizer' });
    expect(screen.queryByRole('button', { name: 'Save identity' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save presence' })).toBeNull();
    expect(accentButtons(container).map((b) => b.textContent)).toEqual(['Publish announcement']);
  });

  it('shows the SaveBar after an edit and saves the presence from it', async () => {
    api.savePersonalizerPresence.mockResolvedValue({ presence: { ...presence, text: 'jazz' } });
    const { container } = renderPage();
    const text = await screen.findByLabelText('Text');
    expect(container.querySelector('.v2-savebar').classList.contains('is-visible')).toBe(false);
    fireEvent.change(text, { target: { value: 'jazz' } });
    expect(container.querySelector('.v2-savebar').classList.contains('is-visible')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(api.savePersonalizerPresence).toHaveBeenCalledWith({ ...presence, text: 'jazz' })
    );
    // identity had no edits, so it was not sent
    expect(api.savePersonalizerIdentity).not.toHaveBeenCalled();
    await waitFor(() => expect(container.querySelector('.v2-savebar').dataset.mode).toBe('saved'));
  });

  it('saves identity and presence together when both changed, and Reset drops the edits', async () => {
    api.savePersonalizerIdentity.mockResolvedValue({ done: ['username'], failed: [] });
    api.savePersonalizerPresence.mockResolvedValue({ presence: { ...presence, text: 'jazz' } });
    renderPage();
    fireEvent.change(await screen.findByLabelText('Text'), { target: { value: 'jazz' } });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'Sylo2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(screen.getByLabelText('Text').value).toBe('music');
    expect(screen.getByLabelText('Username').value).toBe('Sylo');

    fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'jazz' } });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'Sylo2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.savePersonalizerIdentity).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.savePersonalizerPresence).toHaveBeenCalledTimes(1));
  });

  it('asks before leaving with unsaved edits', async () => {
    confirmDialog.mockResolvedValue(false);
    const { router } = renderPage();
    fireEvent.change(await screen.findByLabelText('Text'), { target: { value: 'jazz' } });
    await act(async () => {
      router.navigate('/elsewhere');
    });
    await waitFor(() =>
      expect(confirmDialog).toHaveBeenCalledWith(expect.objectContaining({ title: 'Leave without saving?' }))
    );
    expect(router.state.location.pathname).toBe('/settings');
    expect(screen.queryByText('Elsewhere')).toBeNull();
  });
});
