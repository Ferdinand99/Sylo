import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Mirror from '../pages/Mirror.jsx';
import { renderAtGuild } from './routerHarness.jsx';

vi.mock('../api.js', () => ({
  ApiError: class ApiError extends Error {},
  getMirror: vi.fn(),
  getMirrorFluxerServers: vi.fn(),
  allowMirrorDeletes: vi.fn(),
  getMirrorPreview: vi.fn(),
  getMirrorReport: vi.fn(),
  requestMirror: vi.fn(),
  acceptMirror: vi.fn(),
  setMirrorOptions: vi.fn(),
  startMirror: vi.fn(),
  mirrorAction: vi.fn(),
}));
vi.mock('../notify.js', () => ({ notify: vi.fn() }));
vi.mock('../components/ConfirmDialog.jsx', () => ({ confirmDialog: vi.fn().mockResolvedValue(true) }));
const api = await import('../api.js');
const { confirmDialog } = await import('../components/ConfirmDialog.jsx');

const GUILD = '123456789012345678';
const FLUXER = 'fluxer:223456789012345678';
const OPTIONS = {
  name: true,
  icon: true,
  banner: true,
  roles: true,
  channels: true,
  emoji: true,
  stickers: true,
  modules: true,
  continuous: true,
  mirrorDeletes: false,
  mirrorDeletesRequested: false,
};

const pair = (over = {}) => ({
  id: 1,
  side: 'source',
  status: 'ready',
  resumeStatus: '',
  options: OPTIONS,
  otherId: FLUXER,
  otherName: 'Fluxer copy',
  otherPresent: true,
  requestedBy: 'Anna (dashboard)',
  consent: { source: { by: 'Anna', at: 1 }, target: { by: 'Bo', at: 2 } },
  codeExpiresAt: 0,
  pauseKind: '',
  pausedBy: '',
  lastError: '',
  copiedAt: 0,
  copyRun: 0,
  ...over,
});
const state = (over = {}) => ({
  platform: 'discord',
  canMirror: true,
  isOwner: true,
  fluxerConnected: true,
  pair: null,
  progress: null,
  defaults: OPTIONS,
  limits: { emoji: 50, stickers: 50 },
  ...over,
});
const progress = (over = {}) => ({
  run: 1,
  total: 8,
  done: 0,
  skipped: 0,
  failed: 0,
  waiting: 8,
  percent: 0,
  waitingChanges: 0,
  ...over,
});
const fluxerState = (p) => state({ platform: 'fluxer', canMirror: false, pair: p });

const choice = (over = {}) => ({
  id: FLUXER,
  name: 'Fluxer copy',
  icon: null,
  memberCount: 12,
  inUse: false,
  notes: [],
  ...over,
});
const choices = (servers, over = {}) => ({ fluxerConnected: true, connected: true, servers, ...over });

beforeEach(() => {
  vi.resetAllMocks();
  confirmDialog.mockResolvedValue(true);
  api.getMirrorFluxerServers.mockResolvedValue(choices([]));
});

describe('Mirror: the Discord server', () => {
  it('asks for a mirror with the id of the Fluxer server, and shows the one-time code that comes back', async () => {
    api.getMirror.mockResolvedValue(state());
    api.getMirrorFluxerServers.mockResolvedValue(choices([choice()]));
    api.requestMirror.mockResolvedValue({
      ...state({ pair: pair({ status: 'pending', otherName: null, codeExpiresAt: Date.now() + 3_000_000 }) }),
      code: 'K7QW-H2NP',
    });
    renderAtGuild(<Mirror />, GUILD);
    const button = await screen.findByRole('button', { name: 'Ask for the mirror' });
    fireEvent.click(await screen.findByRole('button', { name: 'Enter an id instead' }));
    const input = screen.getByLabelText('Fluxer server id');
    fireEvent.change(input, { target: { value: 'nonsense' } });
    expect(button.disabled).toBe(true);
    fireEvent.change(input, { target: { value: FLUXER } });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(api.requestMirror).toHaveBeenCalledWith(GUILD, FLUXER));
    expect(await screen.findByText('K7QW-H2NP')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Ask again with a new code/ })).toBeTruthy();
  });

  it('shows the preview, what cannot be carried over, and only copies after a confirmation', async () => {
    api.getMirror.mockResolvedValue(state({ pair: pair() }));
    api.getMirrorPreview.mockResolvedValue({
      ok: true,
      blockers: [],
      warnings: [{ code: 'target-not-empty', message: 'The Fluxer server already has 2 channel(s).' }],
      summary: {
        role: { create: 2, update: 1, unchanged: 0, skip: 1 },
        channel: { create: 5, update: 0, unchanged: 0, skip: 0 },
      },
      notes: [
        {
          code: 'managed-role',
          scope: 'role',
          ref: { id: '1' },
          message: 'A bot: managed by an integration.',
        },
      ],
      target: { id: '2', name: 'Fluxer copy' },
      steps: [{ key: 'role:1', kind: 'role', name: 'Member', op: 'create', reason: null, notes: 0 }],
    });
    api.startMirror.mockResolvedValue(
      state({ pair: pair({ status: 'copying', copyRun: 1 }), progress: progress() })
    );
    renderAtGuild(<Mirror />, GUILD);
    fireEvent.click(await screen.findByRole('button', { name: 'Show the preview' }));
    expect(await screen.findByText('Create 2 roles, update 1, skip 1')).toBeTruthy();
    expect(screen.getByText('Create 5 channels')).toBeTruthy();
    expect(screen.getByText(/already has 2 channel/)).toBeTruthy();
    expect(screen.getByText(/Roles \(1\)/)).toBeTruthy();
    expect(api.startMirror).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Copy to Fluxer copy' }));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalled());
    await waitFor(() => expect(api.startMirror).toHaveBeenCalledWith(GUILD));
    expect(await screen.findByText('0 of 8 steps done')).toBeTruthy();
  });

  it('does not offer to copy while something blocks it', async () => {
    api.getMirror.mockResolvedValue(state({ pair: pair() }));
    api.getMirrorPreview.mockResolvedValue({
      ok: false,
      blockers: [{ code: 'target-permissions', message: 'Sylo needs ManageRoles on the Fluxer server.' }],
      warnings: [],
      summary: {},
      notes: [],
      target: null,
      steps: [],
    });
    renderAtGuild(<Mirror />, GUILD);
    fireEvent.click(await screen.findByRole('button', { name: 'Show the preview' }));
    expect(await screen.findByText(/Sylo needs ManageRoles/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Copy to/ }).disabled).toBe(true);
  });

  it('shows why a mirror is paused, and resumes it', async () => {
    api.getMirror.mockResolvedValue(
      state({
        pair: pair({
          status: 'paused',
          resumeStatus: 'copying',
          copyRun: 1,
          lastError: 'Fluxer refused Sylo: Missing Permissions.',
        }),
        progress: progress({ total: 10, done: 3, failed: 1, waiting: 6, percent: 40 }),
      })
    );
    api.mirrorAction.mockResolvedValue(
      state({ pair: pair({ status: 'copying', copyRun: 1 }), progress: progress() })
    );
    renderAtGuild(<Mirror />, GUILD);
    expect(await screen.findByText(/Fluxer refused Sylo: Missing Permissions/)).toBeTruthy();
    expect(screen.getByText('4 of 10 steps done, 1 failed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(api.mirrorAction).toHaveBeenCalledWith(GUILD, 'resume', {}));
  });

  it('stops the mirror only after a confirmation', async () => {
    api.getMirror.mockResolvedValue(
      state({
        pair: pair({ status: 'live', copyRun: 1, copiedAt: Date.now() - 60_000 }),
        progress: progress({ total: 4, done: 4, waiting: 0, percent: 100 }),
      })
    );
    api.mirrorAction.mockResolvedValue(state({ pair: pair({ status: 'stopped', copyRun: 1 }) }));
    confirmDialog.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    renderAtGuild(<Mirror />, GUILD);
    const stop = await screen.findByRole('button', { name: 'Stop' });
    fireEvent.click(stop);
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(1));
    expect(api.mirrorAction).not.toHaveBeenCalled();
    fireEvent.click(stop);
    await waitFor(() => expect(api.mirrorAction).toHaveBeenCalledWith(GUILD, 'stop'));
    expect(await screen.findByText(/The mirror was stopped/)).toBeTruthy();
  });

  it('lists what failed and what could not be carried over in the report', async () => {
    api.getMirror.mockResolvedValue(
      state({
        pair: pair({ status: 'live', copyRun: 1 }),
        progress: progress({ total: 2, done: 1, failed: 1, waiting: 0, percent: 100 }),
      })
    );
    api.getMirrorReport.mockResolvedValue({
      run: 1,
      items: [],
      notes: [
        {
          code: 'permissions-dropped',
          scope: 'channel',
          ref: { id: '9' },
          message: 'rules: Fluxer has no permission for Manage Events.',
        },
      ],
      failed: [{ kind: 'channel', sourceId: '9', name: 'rules', detail: 'Invalid Form Body' }],
      bridge: { status: 'done', detail: 'not linked: bridge-not-available' },
      summary: {},
    });
    renderAtGuild(<Mirror />, GUILD);
    fireEvent.click(await screen.findByRole('button', { name: 'Show the report' }));
    expect(await screen.findByText('rules: Invalid Form Body')).toBeTruthy();
    expect(screen.getByText(/bridge-not-available/)).toBeTruthy();
  });
});

describe('Mirror: picking the Fluxer server', () => {
  it('lists the Fluxer servers the person owns with name, members and notes, and picking one fills the request', async () => {
    api.getMirror.mockResolvedValue(state());
    api.getMirrorFluxerServers.mockResolvedValue(
      choices([
        choice({
          notes: [
            {
              code: 'target-permissions',
              message: "Sylo's role needs the Administrator permission on this server.",
            },
            {
              code: 'role-hierarchy',
              message: "Sylo's role is not the highest on this server (1 role ranks above or level with it).",
            },
          ],
        }),
        choice({
          id: 'fluxer:323456789012345678',
          name: 'Second',
          memberCount: 1204,
          icon: 'https://cdn.test/i.png',
        }),
        choice({ id: 'fluxer:423456789012345678', name: 'Busy', memberCount: null, inUse: true }),
      ])
    );
    api.requestMirror.mockResolvedValue(state({ pair: pair({ status: 'pending', otherName: null }) }));
    renderAtGuild(<Mirror />, GUILD);
    const button = await screen.findByRole('button', { name: 'Ask for the mirror' });
    expect(api.getMirrorFluxerServers).toHaveBeenCalledWith(GUILD);
    expect(await screen.findByText('Fluxer copy')).toBeTruthy();
    expect(screen.getByText('12 members')).toBeTruthy();
    expect(screen.getByText('1,204 members')).toBeTruthy();
    expect(screen.getByText(/needs the Administrator permission/)).toBeTruthy();
    expect(screen.getByText(/not the highest on this server/)).toBeTruthy();
    expect(screen.getByText(/already part of a mirror/)).toBeTruthy();
    expect(screen.getByLabelText(/Busy/).disabled).toBe(true);
    expect(screen.queryByLabelText('Fluxer server id')).toBeNull();
    // Nothing is picked for the person.
    expect(button.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/Fluxer copy/));
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(api.requestMirror).toHaveBeenCalledWith(GUILD, FLUXER));
  });

  it('keeps the manual id field behind "Enter an id instead", and back', async () => {
    api.getMirror.mockResolvedValue(state());
    api.getMirrorFluxerServers.mockResolvedValue(choices([choice()]));
    renderAtGuild(<Mirror />, GUILD);
    fireEvent.click(await screen.findByLabelText(/Fluxer copy/));
    fireEvent.click(screen.getByRole('button', { name: 'Enter an id instead' }));
    const input = screen.getByLabelText('Fluxer server id');
    expect(input.value).toBe('');
    expect(screen.getByRole('button', { name: 'Ask for the mirror' }).disabled).toBe(true);
    expect(screen.getByText(/If you do not own that Fluxer server/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pick from my Fluxer servers instead' }));
    expect(screen.queryByLabelText('Fluxer server id')).toBeNull();
    expect(screen.getByLabelText(/Fluxer copy/)).toBeTruthy();
  });

  it('says to connect Fluxer under Account when the person has no Fluxer login', async () => {
    api.getMirror.mockResolvedValue(state());
    api.getMirrorFluxerServers.mockResolvedValue(choices([], { connected: false }));
    renderAtGuild(<Mirror />, GUILD);
    const link = await screen.findByRole('link', { name: 'Connect Fluxer under Account' });
    expect(link.getAttribute('href')).toBe('/account');
    expect(screen.getByText(/to pick your Fluxer servers/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Enter an id instead' })).toBeTruthy();
  });

  it('says so when no Fluxer server is found, and falls back to the id field when the list fails', async () => {
    api.getMirror.mockResolvedValue(state());
    const { unmount } = renderAtGuild(<Mirror />, GUILD);
    expect(
      await screen.findByText(/No Fluxer server was found where Sylo is a member and you are the owner/)
    ).toBeTruthy();
    unmount();
    api.getMirrorFluxerServers.mockRejectedValue(new Error('boom'));
    renderAtGuild(<Mirror />, GUILD);
    expect(await screen.findByLabelText('Fluxer server id')).toBeTruthy();
    expect(screen.getByText(/could not be listed/)).toBeTruthy();
  });
});

describe('Mirror: the Fluxer server', () => {
  it('explains how to start when there is no mirror', async () => {
    api.getMirror.mockResolvedValue(fluxerState(null));
    renderAtGuild(<Mirror />, FLUXER);
    expect(await screen.findByText(/is not the mirror of a Discord server/)).toBeTruthy();
  });

  it('shows who asks and agrees with the code', async () => {
    const asked = pair({ side: 'target', status: 'pending', otherName: 'Home Discord', otherId: GUILD });
    api.getMirror.mockResolvedValue(fluxerState(asked));
    api.acceptMirror.mockResolvedValue(fluxerState({ ...asked, status: 'ready' }));
    renderAtGuild(<Mirror />, FLUXER);
    expect(await screen.findByText('Home Discord', { selector: 'strong' })).toBeTruthy();
    const agree = screen.getByRole('button', { name: 'Agree to the mirror' });
    expect(agree.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: 'K7QW-H2NP' } });
    fireEvent.click(agree);
    await waitFor(() => expect(api.acceptMirror).toHaveBeenCalledWith(FLUXER, 'K7QW-H2NP'));
    expect(await screen.findByText('Agreed, not copied yet')).toBeTruthy();
  });

  it('lets this side pause a running mirror', async () => {
    const live = pair({ side: 'target', status: 'live', otherName: 'Home Discord', otherId: GUILD });
    api.getMirror.mockResolvedValue(fluxerState(live));
    api.mirrorAction.mockResolvedValue(fluxerState({ ...live, status: 'paused', resumeStatus: 'live' }));
    renderAtGuild(<Mirror />, FLUXER);
    fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(api.mirrorAction).toHaveBeenCalledWith(FLUXER, 'pause'));
    expect(await screen.findByRole('button', { name: 'Resume' })).toBeTruthy();
    const heading = screen.getByRole('heading', { level: 2 });
    expect(within(heading).getByText('Paused')).toBeTruthy();
  });
});

describe('Mirror: only the owner, and the pauses', () => {
  it('lets people without ownership look, but not change anything', async () => {
    api.getMirror.mockResolvedValue(state({ isOwner: false }));
    renderAtGuild(<Mirror />, GUILD);
    expect(await screen.findByText(/Only the server owner can do this/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ask for the mirror' }).matches(':disabled')).toBe(true);
    expect(screen.getByLabelText('Fluxer server id').matches(':disabled')).toBe(true);
    expect(api.getMirrorFluxerServers).not.toHaveBeenCalled();
  });

  it('shows the status and the stop button as locked for a non-owner on a running mirror', async () => {
    api.getMirror.mockResolvedValue(
      state({
        isOwner: false,
        pair: pair({ status: 'live', copyRun: 1 }),
        progress: progress({ total: 2, done: 2, waiting: 0, percent: 100 }),
      })
    );
    renderAtGuild(<Mirror />, GUILD);
    const stop = await screen.findByRole('button', { name: 'Stop' });
    expect(stop.matches(':disabled')).toBe(true);
    expect(screen.getByText('Mirroring')).toBeTruthy();
  });

  it('asks the owner to confirm a burst of deletions, with the list, before they are applied', async () => {
    api.getMirror.mockResolvedValue(
      state({
        pair: pair({
          status: 'paused',
          pauseKind: 'deletes',
          pausedBy: 'system',
          copyRun: 1,
          lastError: '6 things were deleted on Discord within 10 minutes.',
        }),
        progress: progress({ total: 2, done: 2, waiting: 0, percent: 100 }),
      })
    );
    const needs = () =>
      Object.assign(new api.ApiError('Confirm the deletions first.'), {
        code: 'confirm-needed',
        deleteCount: 6,
        deletes: [{ kind: 'channel', name: 'chat', action: 'lock' }],
      });
    api.mirrorAction
      .mockRejectedValueOnce(needs())
      .mockRejectedValueOnce(needs())
      .mockResolvedValueOnce(state({ pair: pair({ status: 'live', copyRun: 1 }) }));
    confirmDialog.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    renderAtGuild(<Mirror />, GUILD);
    const review = await screen.findByRole('button', { name: 'Review the deletions' });
    fireEvent.click(review);
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(1));
    expect(confirmDialog.mock.calls[0][0].body).toMatch(/lock channel chat, and 5 more/);
    expect(api.mirrorAction).toHaveBeenCalledTimes(1);
    fireEvent.click(review);
    await waitFor(() =>
      expect(api.mirrorAction).toHaveBeenLastCalledWith(GUILD, 'resume', { confirm: true })
    );
  });

  it('asks a new owner to confirm the mirror after a server changed hands', async () => {
    api.getMirror.mockResolvedValue(
      state({
        pair: pair({
          status: 'paused',
          pauseKind: 'ownership',
          pausedBy: 'system',
          copyRun: 1,
          lastError: 'The owner of the Fluxer server is not the person who agreed to the mirror.',
        }),
        progress: progress({ total: 2, done: 2, waiting: 0, percent: 100 }),
      })
    );
    renderAtGuild(<Mirror />, GUILD);
    expect(await screen.findByRole('button', { name: 'Confirm the mirror as the owner' })).toBeTruthy();
  });

  it('does not let the other side resume a mirror the first owner paused', async () => {
    api.getMirror.mockResolvedValue(
      fluxerState(
        pair({
          side: 'target',
          status: 'paused',
          pauseKind: 'owner',
          pausedBy: 'source',
          otherName: 'Home Discord',
          otherId: GUILD,
        })
      )
    );
    renderAtGuild(<Mirror />, FLUXER);
    const resume = await screen.findByRole('button', { name: 'Resume' });
    expect(resume.disabled).toBe(true);
    expect(screen.getByText(/paused this mirror, so only that owner can resume it/)).toBeTruthy();
  });

  it('lists what was removed on Discord and kept, locked, on Fluxer', async () => {
    api.getMirror.mockResolvedValue(
      state({
        pair: pair({ status: 'live', copyRun: 1 }),
        progress: {
          ...progress({ total: 2, done: 2, waiting: 0, percent: 100 }),
          removed: [{ kind: 'channel', label: 'old-chat', at: 1 }],
        },
      })
    );
    renderAtGuild(<Mirror />, GUILD);
    expect(await screen.findByText('Removed on Discord (1)')).toBeTruthy();
    expect(screen.getByText('channel: old-chat')).toBeTruthy();
  });

  it('warns about deleting before the option is turned on', async () => {
    api.getMirror.mockResolvedValue(state({ pair: pair() }));
    renderAtGuild(<Mirror />, GUILD);
    expect(await screen.findByText(/it is deleted on Fluxer too, with all its messages/)).toBeTruthy();
    expect(screen.getByText('Delete on Fluxer what is deleted on Discord')).toBeTruthy();
  });
});

describe('Mirror: real deletion needs the Fluxer owner', () => {
  it('shows the Discord owner that the request waits for the Fluxer owner', async () => {
    api.getMirror.mockResolvedValue(
      state({ pair: pair({ options: { ...OPTIONS, mirrorDeletesRequested: true } }) })
    );
    renderAtGuild(<Mirror />, GUILD);
    expect(await screen.findByText(/Waiting for the owner of the Fluxer server to allow it/)).toBeTruthy();
  });

  it('lets the Fluxer owner allow deleting after a confirmation that says what it does', async () => {
    const asked = pair({
      side: 'target',
      status: 'live',
      otherName: 'Home Discord',
      otherId: GUILD,
      options: { ...OPTIONS, mirrorDeletesRequested: true },
    });
    api.getMirror.mockResolvedValue(fluxerState(asked));
    api.allowMirrorDeletes.mockResolvedValue(
      fluxerState({ ...asked, options: { ...asked.options, mirrorDeletes: true } })
    );
    confirmDialog.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    renderAtGuild(<Mirror />, FLUXER);
    const allow = await screen.findByRole('button', { name: 'Allow deleting' });
    fireEvent.click(allow);
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(1));
    expect(confirmDialog.mock.calls[0][0].body).toMatch(/loses all its messages/);
    expect(api.allowMirrorDeletes).not.toHaveBeenCalled();
    fireEvent.click(allow);
    await waitFor(() => expect(api.allowMirrorDeletes).toHaveBeenCalledWith(FLUXER, true));
    expect(await screen.findByRole('button', { name: 'Stop deleting here' })).toBeTruthy();
  });

  it('shows what will be deleted before deletions that waited are applied', async () => {
    api.getMirror.mockResolvedValue(
      state({
        pair: pair({
          status: 'paused',
          pauseKind: 'owner',
          pausedBy: 'system',
          copyRun: 1,
          lastError: '',
        }),
        progress: progress({ total: 2, done: 2, waiting: 0, percent: 100 }),
      })
    );
    const { ApiError } = api;
    api.mirrorAction
      .mockRejectedValueOnce(
        Object.assign(new ApiError('Confirm the deletions first.'), {
          code: 'confirm-needed',
          deleteCount: 7,
          deletes: [
            { kind: 'channel', name: 'chat', action: 'delete' },
            { kind: 'role', name: 'Mod', action: 'lock' },
          ],
        })
      )
      .mockResolvedValueOnce(state({ pair: pair({ status: 'live', copyRun: 1 }) }));
    confirmDialog.mockResolvedValueOnce(true);
    renderAtGuild(<Mirror />, GUILD);
    fireEvent.click(await screen.findByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(1));
    expect(confirmDialog.mock.calls[0][0].body).toMatch(/delete channel chat, lock role Mod, and 5 more/);
    await waitFor(() =>
      expect(api.mirrorAction).toHaveBeenLastCalledWith(GUILD, 'resume', { confirm: true })
    );
  });
});
