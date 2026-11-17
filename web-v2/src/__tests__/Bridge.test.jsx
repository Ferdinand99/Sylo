import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Bridge from '../moduleForms/Bridge.jsx';
import { renderAtGuild } from './routerHarness.jsx';

vi.mock('../api.js', () => ({
  ApiError: class ApiError extends Error {},
  getBridge: vi.fn(),
  requestBridgeLink: vi.fn(),
  cancelBridgeRequest: vi.fn(),
  acceptBridgeLink: vi.fn(),
  setBridgeOptions: vi.fn(),
  bridgeLinkAction: vi.fn(),
}));
vi.mock('../notify.js', () => ({ notify: vi.fn() }));
vi.mock('../components/ConfirmDialog.jsx', () => ({ confirmDialog: vi.fn().mockResolvedValue(true) }));
const api = await import('../api.js');
const { confirmDialog } = await import('../components/ConfirmDialog.jsx');
const { notify } = await import('../notify.js');

const GUILD = '123456789012345678';
const MAIN = '666666666666666661';
const TWO = '666666666666666662';

const link = (over = {}) => ({
  id: 7,
  status: 'active',
  pausedByMe: false,
  pausedByThem: false,
  problem: null,
  mine: { channelId: MAIN, platform: 'discord', server: 'Home', channel: 'general', ageRestricted: false },
  theirs: { platform: 'fluxer', server: 'Fluxer Home', channel: 'chat', ageRestricted: false },
  options: { bots: false, joinMessages: false, uploadFiles: true },
  theirOptions: { bots: true, joinMessages: false, uploadFiles: true },
  createdAt: Date.UTC(2030, 0, 2),
  by: 'Alice (dashboard)',
  queued: 0,
  dropped: 0,
  ...over,
});
const overview = (over = {}) => ({
  platform: 'discord',
  bothPlatforms: true,
  enabled: true,
  owner: true,
  limits: { links: 10, requests: 5 },
  links: [],
  requests: [],
  channels: [
    { id: MAIN, name: 'general', ageRestricted: false, taken: false },
    { id: TWO, name: 'off-topic', ageRestricted: true, taken: false },
  ],
  ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  confirmDialog.mockResolvedValue(true);
  api.getBridge.mockResolvedValue(overview());
});

describe('Bridge page', () => {
  it('says there is nothing bridged yet and offers the two ways to start', async () => {
    renderAtGuild(<Bridge />, GUILD);
    expect(await screen.findByRole('heading', { name: 'Bridge' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Bridged channels (0 of 10)' })).toBeTruthy();
    expect(screen.getByText(/No channel is bridged yet/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Ask the other server' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Use a code' })).toBeTruthy();
    expect(api.getBridge).toHaveBeenCalledWith(GUILD);
  });

  it('points the owner of a Discord server to Mirror to Fluxer, and shows it to nobody else', async () => {
    renderAtGuild(<Bridge />, GUILD);
    expect(await screen.findByText(/Setting up a whole Fluxer server\?/)).toBeTruthy();
    expect(
      screen.getByText(/copy channels, roles and emoji and\s+bridge every channel at once/)
    ).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Mirror to Fluxer' });
    expect(link.getAttribute('href')).toBe(`/guilds/${GUILD}/mirror`);
  });

  it('hides the Mirror hint from people who are not the owner, on a Fluxer server, and without both platforms', async () => {
    for (const over of [{ owner: false }, { platform: 'fluxer' }, { bothPlatforms: false }]) {
      api.getBridge.mockResolvedValue(overview(over));
      const { unmount } = renderAtGuild(<Bridge />, GUILD);
      await screen.findByRole('heading', { name: 'Bridge' });
      expect(screen.queryByText(/Setting up a whole Fluxer server/)).toBeNull();
      expect(screen.queryByRole('link', { name: 'Mirror to Fluxer' })).toBeNull();
      unmount();
    }
  });

  it('names the other platform, and explains that nothing pings and bots are off', async () => {
    renderAtGuild(<Bridge />, GUILD);
    await screen.findByRole('heading', { name: 'Bridge' });
    expect(screen.getAllByText(/Fluxer/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/pings/).length).toBeGreaterThan(0);
  });

  it('does not offer anything when this Sylo is not on both platforms, or the module is off', async () => {
    api.getBridge.mockResolvedValue(overview({ bothPlatforms: false }));
    const { unmount } = renderAtGuild(<Bridge />, GUILD);
    expect(await screen.findByText(/not connected to both Discord and Fluxer/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Get a code' }).disabled).toBe(true);
    unmount();
    api.getBridge.mockResolvedValue(overview({ enabled: false }));
    renderAtGuild(<Bridge />, GUILD);
    expect(await screen.findByText(/Turn the module on above/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Link the channels' }).disabled).toBe(true);
  });

  it('is read-only for everyone but the server owner, with a note that says so', async () => {
    api.getBridge.mockResolvedValue(
      overview({
        owner: false,
        links: [link({ pauseNote: 'The owner of one of the servers changed.' })],
        requests: [
          {
            id: 3,
            channelId: MAIN,
            channel: 'general',
            expiresAt: Date.now() + 900_000,
            requestedBy: 'Alice',
          },
        ],
      })
    );
    renderAtGuild(<Bridge />, GUILD);
    expect(await screen.findByText(/Only the server owner can ask for a link/)).toBeTruthy();
    expect(screen.getByText(/#general ↔ #chat/)).toBeTruthy();
    expect(screen.getByText('The owner of one of the servers changed.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pause' }).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'More actions for #general' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'More actions for the request of #general' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Get a code' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Link the channels' }).disabled).toBe(true);
    expect(
      screen.getByLabelText('Share messages from bots', { selector: '#opt-7-bots' }).matches(':disabled')
    ).toBe(true);
    expect(screen.getByLabelText('Code').closest('fieldset').disabled).toBe(true);
  });

  it('lists a link with the other side, its status, and what each side shares', async () => {
    api.getBridge.mockResolvedValue(overview({ links: [link({ queued: 3 })] }));
    renderAtGuild(<Bridge />, GUILD);
    expect(await screen.findByText(/#general ↔ #chat/)).toBeTruthy();
    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.getByText(/Fluxer Home on Fluxer/)).toBeTruthy();
    expect(screen.getByText(/3 waiting to send/)).toBeTruthy();
    expect(screen.getByText(/Bot messages: shared. Who joins: not shared./)).toBeTruthy();
    expect(
      screen
        .getByLabelText('Share messages from bots', { selector: '#opt-7-bots' })
        .getAttribute('aria-checked')
    ).toBe('false');
  });

  it('shows why a stopped link stopped, and who paused a paused one', async () => {
    api.getBridge.mockResolvedValue(
      overview({
        links: [
          link({
            id: 1,
            status: 'failed',
            problem: { code: 'permissions', text: 'Sylo is missing a permission here.' },
          }),
          link({
            id: 2,
            status: 'paused',
            pausedByThem: true,
            mine: {
              channelId: TWO,
              platform: 'discord',
              server: 'Home',
              channel: 'off-topic',
              ageRestricted: true,
            },
          }),
        ],
      })
    );
    renderAtGuild(<Bridge />, GUILD);
    expect(await screen.findByText('Stopped')).toBeTruthy();
    expect(screen.getByText('Sylo is missing a permission here.')).toBeTruthy();
    expect(screen.getByText('Paused by the other server')).toBeTruthy();
    expect(screen.getByText(/Fluxer Home paused this bridge. Only they can resume it./)).toBeTruthy();
    // a stopped link can be resumed; one the other server paused cannot
    expect(screen.getAllByRole('button', { name: 'Resume' })).toHaveLength(1);
  });

  it('pauses a link and shows the fresh state the server answers with', async () => {
    api.getBridge.mockResolvedValue(overview({ links: [link()] }));
    api.bridgeLinkAction.mockResolvedValue({
      overview: overview({ links: [link({ status: 'paused', pausedByMe: true })] }),
    });
    renderAtGuild(<Bridge />, GUILD);
    fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(api.bridgeLinkAction).toHaveBeenCalledWith(GUILD, 7, 'pause'));
    expect(await screen.findByText('Paused by this server')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();
  });

  it('a bridge the server mirror holds has no Resume button; one whose mirror ended has', async () => {
    api.getBridge.mockResolvedValue(
      overview({
        links: [
          link({
            id: 7,
            status: 'paused',
            resumable: false,
            pauseNote: 'This bridge was made by the server mirror and is paused with it.',
          }),
          link({
            id: 8,
            status: 'paused',
            resumable: true,
            mine: {
              channelId: TWO,
              platform: 'discord',
              server: 'Home',
              channel: 'rules',
              ageRestricted: false,
            },
            pauseNote: 'The server mirror that made this bridge ended.',
          }),
        ],
      })
    );
    renderAtGuild(<Bridge />, GUILD);
    expect(await screen.findByText(/paused with it/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Resume' })).toHaveLength(1);
  });

  it('changes a switch of this side through the server', async () => {
    api.getBridge.mockResolvedValue(overview({ links: [link()] }));
    api.setBridgeOptions.mockResolvedValue({
      overview: overview({
        links: [link({ options: { bots: true, joinMessages: false, uploadFiles: true } })],
      }),
    });
    renderAtGuild(<Bridge />, GUILD);
    fireEvent.click(await screen.findByLabelText('Share messages from bots', { selector: '#opt-7-bots' }));
    await waitFor(() => expect(api.setBridgeOptions).toHaveBeenCalledWith(GUILD, 7, { bots: true }));
    await waitFor(() =>
      expect(
        screen
          .getByLabelText('Share messages from bots', { selector: '#opt-7-bots' })
          .getAttribute('aria-checked')
      ).toBe('true')
    );
  });

  it('asks before unlinking, and only unlinks when confirmed', async () => {
    api.getBridge.mockResolvedValue(overview({ links: [link()] }));
    api.bridgeLinkAction.mockResolvedValue({ overview: overview() });
    confirmDialog.mockResolvedValueOnce(false);
    renderAtGuild(<Bridge />, GUILD);
    const open = async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'More actions for #general' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Unlink' }));
    };
    await open();
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(1));
    expect(confirmDialog.mock.calls[0][0].title).toBe('Unlink #general?');
    expect(api.bridgeLinkAction).not.toHaveBeenCalled();
    await open();
    await waitFor(() => expect(api.bridgeLinkAction).toHaveBeenCalledWith(GUILD, 7, 'unlink'));
    expect(await screen.findByText(/No channel is bridged yet/)).toBeTruthy();
  });

  it('asks for a code, shows it once with its expiry and a copy button', async () => {
    api.requestBridgeLink.mockResolvedValue({
      code: 'ABCD-EFGH-JKMN',
      expiresAt: Date.now() + 900_000,
      overview: overview({
        requests: [
          {
            id: 3,
            channelId: MAIN,
            channel: 'general',
            expiresAt: Date.now() + 900_000,
            requestedBy: 'Alice',
          },
        ],
        channels: [
          { id: MAIN, name: 'general', ageRestricted: false, taken: true },
          { id: TWO, name: 'off-topic', ageRestricted: true, taken: false },
        ],
      }),
    });
    renderAtGuild(<Bridge />, GUILD);
    const button = await screen.findByRole('button', { name: 'Get a code' });
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Channel here', { selector: '#bridge-ask-channel' }), {
      target: { value: MAIN },
    });
    fireEvent.click(screen.getByLabelText('Share who joins', { selector: '#ask-joinMessages' }));
    fireEvent.click(screen.getByRole('button', { name: 'Get a code' }));
    await waitFor(() =>
      expect(api.requestBridgeLink).toHaveBeenCalledWith(GUILD, {
        channelId: MAIN,
        options: { bots: false, joinMessages: true, uploadFiles: true },
      })
    );
    expect(await screen.findByText('ABCD-EFGH-JKMN')).toBeTruthy();
    expect(screen.getByText(/works once/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Waiting for the other server' })).toBeTruthy();
    expect(screen.getByText(/code valid until/)).toBeTruthy();
    // the channel that has a request waiting can no longer be picked
    const options = [
      ...screen
        .getByLabelText('Channel here', { selector: '#bridge-ask-channel' })
        .querySelectorAll('option'),
    ].map((o) => o.textContent);
    expect(options).toEqual(['Pick a channel', '#off-topic (age-restricted)']);
  });

  it('uses a code with a channel and says so', async () => {
    api.acceptBridgeLink.mockResolvedValue({ overview: overview({ links: [link()] }) });
    renderAtGuild(<Bridge />, GUILD);
    await screen.findByRole('button', { name: 'Link the channels' });
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: ' abcd-efgh-jkmn ' } });
    fireEvent.change(screen.getByLabelText('Channel here', { selector: '#bridge-use-channel' }), {
      target: { value: TWO },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Link the channels' }));
    await waitFor(() =>
      expect(api.acceptBridgeLink).toHaveBeenCalledWith(GUILD, {
        code: 'abcd-efgh-jkmn',
        channelId: TWO,
        options: { bots: false, joinMessages: false, uploadFiles: true },
      })
    );
    expect(await screen.findByText(/#general ↔ #chat/)).toBeTruthy();
    expect(notify).toHaveBeenCalledWith('The bridge is on.');
  });

  it('shows the refusal of the server as it is', async () => {
    const { ApiError } = await import('../api.js');
    api.acceptBridgeLink.mockRejectedValue(
      new ApiError('That code is not valid, has expired or was already used.')
    );
    renderAtGuild(<Bridge />, GUILD);
    await screen.findByRole('button', { name: 'Link the channels' });
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: 'WRONG' } });
    fireEvent.change(screen.getByLabelText('Channel here', { selector: '#bridge-use-channel' }), {
      target: { value: MAIN },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Link the channels' }));
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith('That code is not valid, has expired or was already used.')
    );
  });

  it('cancels a waiting request after asking', async () => {
    api.getBridge.mockResolvedValue(
      overview({
        requests: [
          {
            id: 3,
            channelId: MAIN,
            channel: 'general',
            expiresAt: Date.now() + 900_000,
            requestedBy: 'Alice',
          },
        ],
      })
    );
    api.cancelBridgeRequest.mockResolvedValue({ overview: overview() });
    renderAtGuild(<Bridge />, GUILD);
    fireEvent.click(await screen.findByRole('button', { name: 'More actions for the request of #general' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Cancel request' }));
    await waitFor(() => expect(api.cancelBridgeRequest).toHaveBeenCalledWith(GUILD, 3));
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Waiting for the other server' })).toBeNull()
    );
  });
});
