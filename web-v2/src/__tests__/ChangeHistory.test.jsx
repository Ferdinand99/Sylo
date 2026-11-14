// The change history in the audit log: the diff of changed fields (configDiff.js, ConfigDiff.jsx), the
// "Show changes" and "Undo this change" controls on an entry, and the confirmation when the settings were
// changed again since.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AuditLog from '../pages/AuditLog.jsx';
import ConfigDiff from '../components/ConfigDiff.jsx';
import { MASK, diffSettings, formatValue, labelFor, pathText } from '../configDiff.js';
import { renderAtGuild } from './routerHarness.jsx';

vi.mock('../api.js', () => ({
  ApiError: class ApiError extends Error {},
  getAuditLog: vi.fn(),
  getAuditChange: vi.fn(),
  undoAuditChange: vi.fn(),
  getMemberNames: vi.fn().mockResolvedValue({ names: {} }),
}));
vi.mock('../notify.js', () => ({ notify: vi.fn() }));
vi.mock('../components/ConfirmDialog.jsx', () => ({ confirmDialog: vi.fn() }));
vi.mock('../OverviewContext.jsx', () => ({ useOverview: vi.fn().mockReturnValue({ data: { groups: [] } }) }));
const api = await import('../api.js');
const { notify } = await import('../notify.js');
const { confirmDialog } = await import('../components/ConfirmDialog.jsx');

const GUILD = '123456789012345678';

describe('diffSettings', () => {
  it('shows changed fields only, with the readable name where one is known and the key otherwise', () => {
    const { rows } = diffSettings(
      { joinChannel: '1', unknownKey: 'a' },
      { joinChannel: '2', unknownKey: 'b' }
    );
    expect(rows.map((r) => [pathText(r.path), r.kind, r.before, r.after])).toEqual([
      ['Welcome channel', 'changed', '1', '2'],
      ['unknownKey', 'changed', 'a', 'b'],
    ]);
    expect(labelFor('somethingNew')).toBe('somethingNew');
  });

  it('shows a list of plain values as what was added and what was removed', () => {
    const { rows } = diffSettings({ ignoreRoles: ['a', 'b'] }, { ignoreRoles: ['b', 'c'] });
    expect(rows).toEqual([{ path: ['ignoreRoles'], kind: 'list', added: ['c'], removed: ['a'] }]);
  });

  it('matches the items of a list by id, so only the item that changed shows', () => {
    const before = {
      rules: [
        { id: 'r1', name: 'Rules', channelId: '1', emoji: 'x' },
        { id: 'r2', name: 'Gone', channelId: '2' },
      ],
    };
    const after = {
      rules: [
        { id: 'r1', name: 'Rules', channelId: '9', emoji: 'x' },
        { id: 'r3', name: 'New one', channelId: '3' },
      ],
    };
    const { rows } = diffSettings(before, after);
    expect(rows.map((r) => [r.path.join(' > '), r.kind])).toEqual([
      ['rules > Rules > channelId', 'changed'],
      ['rules > New one', 'added'],
      ['rules > Gone', 'removed'],
    ]);
  });

  it('does not turn every later item into a change when one item without an id is removed', () => {
    const before = {
      responders: [
        { name: 'a', text: '1' },
        { name: 'b', text: '2' },
        { name: 'c', text: '3' },
      ],
    };
    const after = {
      responders: [
        { name: 'b', text: '2' },
        { name: 'c', text: '3' },
      ],
    };
    const { rows } = diffSettings(before, after);
    expect(rows.map((r) => [r.path.join(' > '), r.kind])).toEqual([['responders > a', 'removed']]);
  });

  it('says a value changed when only a hidden one did, and caps the rows', () => {
    expect(
      diffSettings({ feeds: [{ id: 'a', url: MASK }] }, { feeds: [{ id: 'a', url: MASK }] }).rows
    ).toEqual([{ path: ['feeds'], kind: 'hidden' }]);
    const many = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`k${i}`, i]));
    const grown = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`k${i}`, i + 1]));
    const { rows, more } = diffSettings(many, grown);
    expect(rows).toHaveLength(60);
    expect(more).toBe(10);
  });

  it('writes values as people read them', () => {
    expect(formatValue(true)).toBe('On');
    expect(formatValue(false)).toBe('Off');
    expect(formatValue('')).toBe('(empty)');
    expect(formatValue(undefined)).toBe('(not set)');
    expect(formatValue(MASK)).toBe(`${MASK} (hidden)`);
    expect(formatValue('123456789012345678', { '123456789012345678': '#general' })).toBe('#general');
    expect(formatValue(['a', 'b'])).toBe('a, b');
    expect(formatValue('x'.repeat(300))).toHaveLength(201);
  });
});

describe('ConfigDiff', () => {
  it('labels each value in words, not only in colour', () => {
    render(
      <ConfigDiff
        before={{ joinChannel: '123456789012345678', cardBackground: '' }}
        after={{ joinChannel: '223456789012345678', cardBackground: 'https://e.com/a.png' }}
        names={{ '123456789012345678': '#old', '223456789012345678': '#new' }}
      />
    );
    const row = screen.getByText('Welcome channel').closest('li');
    expect(within(row).getByText('Before').parentElement.textContent).toContain('#old');
    expect(within(row).getByText('After').parentElement.textContent).toContain('#new');
    expect(screen.getByText('Card background').closest('li').textContent).toContain('(empty)');
  });
});

describe('Audit log: show changes and undo', () => {
  const entry = (id, over = {}) => ({
    id,
    action: 'module:afk',
    actor: 'Ann (dashboard)',
    detail: 'settings saved',
    at: id,
    ago: '1m ago',
    hasChange: true,
    revertsId: null,
    ...over,
  });
  const change = (undo = {}) => ({
    entry: { id: 9 },
    before: { setNickname: false },
    after: { setNickname: true },
    names: {},
    kind: 'module',
    undo: { available: true, reason: null, state: 'clean', laterChanges: [], token: null, ...undo },
  });
  const list = (...entries) => ({ kept: 500, hasMore: false, actions: [], entries });
  const open = async () => {
    renderAtGuild(<AuditLog />, GUILD);
    fireEvent.click(await screen.findByRole('button', { name: 'Show changes' }));
  };

  beforeEach(() => {
    vi.clearAllMocks();
    api.getMemberNames.mockResolvedValue({ names: {} });
    api.getAuditLog.mockResolvedValue(list(entry(9)));
    api.getAuditChange.mockResolvedValue(change());
    api.undoAuditChange.mockResolvedValue({ ok: true, adjusted: [] });
    confirmDialog.mockResolvedValue(true);
  });

  it('shows the difference when an entry is opened, and loads it only then', async () => {
    renderAtGuild(<AuditLog />, GUILD);
    const toggle = await screen.findByRole('button', { name: 'Show changes' });
    expect(api.getAuditChange).not.toHaveBeenCalled();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(await screen.findByText('setNickname')).toBeTruthy();
    expect(api.getAuditChange).toHaveBeenCalledWith(GUILD, 9);
    expect(screen.getByRole('button', { name: 'Hide changes' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Before').parentElement.textContent).toContain('Off');
    expect(screen.getByText('After').parentElement.textContent).toContain('On');
    // the scope of an undo is said in the page
    expect(screen.getByText(/Lists kept on their own/)).toBeTruthy();
    // closing and opening again does not load it a second time
    fireEvent.click(screen.getByRole('button', { name: 'Hide changes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show changes' }));
    expect(api.getAuditChange).toHaveBeenCalledTimes(1);
  });

  it('an entry that kept nothing has no button', async () => {
    api.getAuditLog.mockResolvedValue(list(entry(9, { hasChange: false })));
    renderAtGuild(<AuditLog />, GUILD);
    await screen.findByText(/settings saved/);
    expect(screen.queryByRole('button', { name: 'Show changes' })).toBeNull();
  });

  it('undoes a clean change in one click, tells the person, and reads the log again', async () => {
    await open();
    fireEvent.click(await screen.findByRole('button', { name: 'Undo this change' }));
    await waitFor(() =>
      expect(api.undoAuditChange).toHaveBeenCalledWith(GUILD, 9, { confirm: false, token: '' })
    );
    expect(confirmDialog).not.toHaveBeenCalled();
    await waitFor(() => expect(notify).toHaveBeenCalledWith('Change undone.', 'info'));
    await waitFor(() => expect(api.getAuditLog).toHaveBeenCalledTimes(2));
  });

  it('warns that later changes are lost and asks before it undoes, naming the settings', async () => {
    api.getAuditChange.mockResolvedValue(
      change({ state: 'changed', laterChanges: ['joinChannel'], token: 'tok1' })
    );
    await open();
    expect((await screen.findByRole('note')).textContent).toMatch(/changed again.*Welcome channel.*lose/s);
    fireEvent.click(screen.getByRole('button', { name: 'Undo this change' }));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalled());
    expect(confirmDialog.mock.calls[0][0].confirmLabel).toBe('Undo and lose later changes');
    await waitFor(() =>
      expect(api.undoAuditChange).toHaveBeenCalledWith(GUILD, 9, { confirm: true, token: 'tok1' })
    );
  });

  it('does nothing when the confirmation is declined', async () => {
    api.getAuditChange.mockResolvedValue(change({ state: 'changed', laterChanges: ['setNickname'] }));
    confirmDialog.mockResolvedValue(false);
    await open();
    fireEvent.click(await screen.findByRole('button', { name: 'Undo this change' }));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalled());
    expect(api.undoAuditChange).not.toHaveBeenCalled();
  });

  it('asks for the confirmation when the server says the settings moved on after the page loaded', async () => {
    const refusal = Object.assign(new Error('These settings were changed again'), {
      code: 'changed-since',
      laterChanges: ['setNickname'],
      token: 'fresh',
    });
    api.undoAuditChange.mockRejectedValueOnce(refusal).mockResolvedValueOnce({ ok: true, adjusted: [] });
    await open();
    fireEvent.click(await screen.findByRole('button', { name: 'Undo this change' }));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalled());
    await waitFor(() =>
      expect(api.undoAuditChange).toHaveBeenLastCalledWith(GUILD, 9, { confirm: true, token: 'fresh' })
    );
    expect(api.undoAuditChange).toHaveBeenCalledTimes(2);
  });

  it('names the settings an undo leaves alone and the secrets it does not restore', async () => {
    api.getAuditChange.mockResolvedValue(
      change({
        notRestored: [
          { key: 'autoroleEnabled', reason: 'It goes together with the auto-roles of the Roles page.' },
        ],
        droppedSecrets: ['feeds'],
      })
    );
    await open();
    expect(
      await screen.findByText(/An undo leaves these as they are: Give auto-roles \(It goes together/)
    ).toBeTruthy();
    expect(screen.getByText(/Feeds holds a secret|feeds holds a secret/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Undo this change' })).toBeTruthy();
  });

  it('shows no module hint on a server-settings entry', async () => {
    api.getAuditChange.mockResolvedValue({ ...change(), kind: 'settings' });
    await open();
    await screen.findByRole('button', { name: 'Undo this change' });
    expect(screen.queryByText(/Lists kept on their own/)).toBeNull();
  });

  it('shows why there is no undo, and a refusal from the server', async () => {
    api.getAuditChange.mockResolvedValue(
      change({ available: false, reason: 'Changes to this module cannot be undone from here yet.' })
    );
    await open();
    expect(await screen.findByText(/cannot be undone from here yet/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Undo this change' })).toBeNull();
  });

  it('says so when the copy was too large to keep, and when it cannot be loaded', async () => {
    api.getAuditChange.mockResolvedValueOnce({
      entry: { id: 9 },
      tooLarge: true,
      undo: { available: false, reason: 'This change was too large to keep a copy of.' },
    });
    await open();
    expect(await screen.findByText('This change was too large to keep a copy of.')).toBeTruthy();
    expect(screen.queryByText(/Lists kept on their own/)).toBeNull();
  });

  it('shows an error when the change cannot be loaded, and when the undo is refused', async () => {
    api.getAuditChange.mockRejectedValueOnce(new Error('That entry has no saved change.'));
    await open();
    expect((await screen.findByRole('alert')).textContent).toBe('That entry has no saved change.');

    fireEvent.click(screen.getByRole('button', { name: 'Hide changes' }));
    api.undoAuditChange.mockRejectedValueOnce(new Error('Sylo needs View Channel in the mod-log channel.'));
    fireEvent.click(screen.getByRole('button', { name: 'Show changes' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo this change' }));
    expect((await screen.findByText(/needs View Channel/)).getAttribute('role')).toBe('alert');
  });
});
