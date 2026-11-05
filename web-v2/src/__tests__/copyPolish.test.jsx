import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Welcome from '../moduleForms/Welcome.jsx';
import TwitchAlerts from '../moduleForms/TwitchAlerts.jsx';
import KickAlerts from '../moduleForms/KickAlerts.jsx';
import YoutubeAlerts from '../moduleForms/YoutubeAlerts.jsx';
import RssAlerts from '../moduleForms/RssAlerts.jsx';
import AutoThreads from '../moduleForms/AutoThreads.jsx';
import Appeals from '../moduleForms/Appeals.jsx';
import InviteTracker from '../moduleForms/InviteTracker.jsx';
import AutoReact from '../moduleForms/AutoReact.jsx';
import Logging, { groupEvents } from '../moduleForms/Logging.jsx';
import SetupCallout from '../components/SetupCallout.jsx';
import Time from '../components/Time.jsx';
import { postsTo } from '../components/SendTestButton.jsx';
import { resetModuleLimits } from '../components/useModuleLimits.js';
import { resetOperatorCache } from '../useOperator.js';
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
const { getModuleConfig, getModuleLimits, getAccount } = await import('../api.js');

const GUILD = '123456789012345678';
const CHANNEL = '555555555555555555';
const channels = [{ id: CHANNEL, name: 'general' }];

beforeEach(() => {
  vi.resetAllMocks();
  resetModuleLimits();
  resetOperatorCache();
  getModuleLimits.mockResolvedValue({ _embed: {} });
});

const welcomeData = (over = {}) => ({
  config: {
    joinEnabled: true,
    joinChannel: CHANNEL,
    joinMessage: 'Welcome {user} to {server}!',
    useEmbed: false,
    card: false,
    cardBackground: '',
    dmEnabled: true,
    dmMessage: 'Hi {username}',
    leaveEnabled: true,
    leaveChannel: CHANNEL,
    leaveMessage: '{user.tag} left.',
    autoroleEnabled: false,
    autoroles: [],
  },
  channels,
  roles: [],
  verificationEnabled: true,
  verificationMode: 'button',
  placeholders: ['{user}', '{user.tag}', '{user.name}', '{user.id}', '{server}', '{memberCount}'],
  ...over,
});

describe('Welcome', () => {
  it('names the verification mode on the verify row', async () => {
    getModuleConfig.mockResolvedValue(welcomeData());
    const { unmount } = renderAtGuild(<Welcome />, GUILD);
    expect(await screen.findByText('Verify new members')).toBeTruthy();
    expect(screen.getByRole('link', { name: /On \(button\) — configure/ })).toBeTruthy();
    unmount();

    getModuleConfig.mockResolvedValue(welcomeData({ verificationMode: 'captcha' }));
    renderAtGuild(<Welcome />, GUILD);
    expect(await screen.findByRole('link', { name: /On \(captcha\) — configure/ })).toBeTruthy();
  });

  it('says "Set up" when verification is off', async () => {
    getModuleConfig.mockResolvedValue(welcomeData({ verificationEnabled: false }));
    renderAtGuild(<Welcome />, GUILD);
    expect(await screen.findByRole('link', { name: /Set up/ })).toBeTruthy();
  });

  it("offers the server's placeholders under each message and inserts at the cursor", async () => {
    getModuleConfig.mockResolvedValue(welcomeData());
    renderAtGuild(<Welcome />, GUILD);
    const join = await screen.findByLabelText('Message', { selector: '#joinMessage' });
    expect(screen.getAllByRole('button', { name: 'Insert {memberCount}' })).toHaveLength(3);

    join.focus();
    join.setSelectionRange(8, 8); // after "Welcome "
    fireEvent.click(screen.getAllByRole('button', { name: 'Insert {user.name}' })[0]);
    expect(join.value).toBe('Welcome {user.name}{user} to {server}!');
  });

  it('warns about a placeholder that is not supported, but the text stays', async () => {
    getModuleConfig.mockResolvedValue(welcomeData());
    renderAtGuild(<Welcome />, GUILD);
    const dm = await screen.findByLabelText('DM text');
    expect(dm.value).toBe('Hi {username}');
    const warning = screen.getByText(/isn't a placeholder here/, { selector: 'p' });
    expect(warning.textContent).toContain('{username}');
    expect(warning.textContent).toContain('did you mean {user.name}?');
  });
});

describe('Alert pages', () => {
  const twitch = (over = {}) => ({
    config: {
      alerts: [
        { login: 'someone', channelId: CHANNEL, roleId: '', message: '', plainText: false, onEnd: 'delete' },
      ],
    },
    channels,
    roles: [],
    twitchEnabled: false,
    defaultMessage: '{name} is live',
    ...over,
  });

  it('explains missing Twitch keys in plain words and keeps the variable names for the bot owner', async () => {
    getAccount.mockResolvedValue({ operator: false });
    getModuleConfig.mockResolvedValue(twitch());
    const { unmount } = renderAtGuild(<TwitchAlerts />, GUILD);
    const note = await screen.findByRole('note');
    expect(note.textContent).toContain("Twitch alerts aren't active on this Sylo yet");
    expect(note.textContent).toContain('the bot owner needs to add Twitch API keys');
    expect(note.textContent).not.toContain('TWITCH_CLIENT_ID');
    unmount();

    resetOperatorCache();
    getAccount.mockResolvedValue({ operator: true });
    renderAtGuild(<TwitchAlerts />, GUILD);
    const owner = await screen.findByText(/For the bot owner/);
    expect(owner.textContent).toContain('TWITCH_CLIENT_ID');
    expect(owner.textContent).toContain('TWITCH_CLIENT_SECRET');
  });

  it('shows no setup note when the keys are set, and offers the stream placeholders', async () => {
    getModuleConfig.mockResolvedValue(twitch({ twitchEnabled: true }));
    renderAtGuild(<TwitchAlerts />, GUILD);
    expect(await screen.findByRole('button', { name: 'Insert {viewers}' })).toBeTruthy();
    expect(screen.queryByRole('note')).toBeNull();
    expect(screen.getByLabelText('Announce in')).toBeTruthy();
  });

  it('uses a made-up handle as the Kick example', async () => {
    getModuleConfig.mockResolvedValue({
      config: { alerts: [] },
      channels,
      roles: [],
      kickEnabled: true,
      defaultMessage: '',
    });
    renderAtGuild(<KickAlerts />, GUILD);
    expect(await screen.findByPlaceholderText('e.g. streamer_name')).toBeTruthy();
  });

  it('shows the YouTube channel name that was found, with the id after it', async () => {
    getModuleConfig.mockResolvedValue({
      config: {
        alerts: [
          {
            ytChannelId: 'UC123',
            name: 'Cool Channel',
            discordChannelId: CHANNEL,
            roleId: '',
            onVideo: true,
            onLive: false,
          },
        ],
      },
      channels,
      roles: [],
      defaultVideoMessage: '',
      defaultLiveMessage: '',
    });
    renderAtGuild(<YoutubeAlerts />, GUILD);
    const found = await screen.findByText(/Found: Cool Channel/);
    expect(found.textContent).toContain('ID UC123');
    expect(screen.getAllByRole('button', { name: 'Insert {title}' })).toHaveLength(2);
  });

  it('calls the RSS channel "Announce in" and the text "Message"', async () => {
    getModuleConfig.mockResolvedValue({
      config: {
        feeds: [
          { type: 'url', ref: 'https://example.com/feed.xml', channelId: CHANNEL, roleId: '', template: '' },
        ],
      },
      channels,
      roles: [],
      feedTypes: ['url', 'reddit'],
      defaultTemplate: '{title} {link}',
    });
    renderAtGuild(<RssAlerts />, GUILD);
    expect(await screen.findByLabelText('Announce in')).toBeTruthy();
    expect(screen.getByLabelText(/^Message/)).toBeTruthy();
    expect(screen.queryByText('Post in')).toBeNull();
  });
});

describe('Auto threads', () => {
  it('flags the placeholders it does not fill in ({username}, {content}) without blocking the form', async () => {
    getModuleConfig.mockResolvedValue({
      config: {
        rules: [
          {
            id: 'r1',
            channelId: CHANNEL,
            nameTemplate: '{username}: {content}',
            archiveMinutes: 1440,
            onlyWithAttachments: false,
            onlyWithLinks: false,
            skipBots: true,
            skipStaff: false,
            staffRoleIds: [],
            firstMessage: '',
            slowmodeSeconds: 0,
          },
        ],
      },
      channels,
      roles: [],
    });
    renderAtGuild(<AutoThreads />, GUILD);
    const name = await screen.findByLabelText('Thread name');
    expect(name.value).toBe('{username}: {content}');
    const warnings = screen.getAllByRole('status').map((w) => w.textContent);
    expect(warnings.some((w) => w.includes('{username}') && w.includes('exactly as typed'))).toBe(true);
    expect(warnings.some((w) => w.includes('{content}'))).toBe(true);
    expect(name.disabled).toBe(false);
  });
});

describe('Logging', () => {
  const logEvents = [
    ['memberJoin', 'Member joined'],
    ['memberTimeout', 'Member timed out / untimed'],
    ['messageDelete', 'Message deleted'],
    ['roleCreateDelete', 'Role created / deleted'],
    ['somethingNew', 'Something new'],
  ];

  it('groups the events and renames the timeout one', () => {
    const groups = groupEvents(logEvents);
    expect(groups.map((g) => g.title)).toEqual(['Members', 'Messages', 'Server', 'Other']);
    expect(groups[0].events).toEqual([
      ['memberJoin', 'Member joined'],
      ['memberTimeout', 'Timeout added / removed'],
    ]);
    expect(groups[3].events).toEqual([['somethingNew', 'Something new']]);
  });

  it('selects and clears every event with one button, and says how it differs from the mod-log', async () => {
    getModuleConfig.mockResolvedValue({
      config: { channel: CHANNEL, events: { memberJoin: true } },
      channels,
      logEvents,
    });
    renderAtGuild(<Logging />, GUILD);
    expect(await screen.findByText(/separate from the mod-log channel/)).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Members' })).toBeTruthy();
    const boxes = () => screen.getAllByRole('checkbox');
    expect(boxes().filter((b) => b.checked)).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    expect(boxes().every((b) => b.checked)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(boxes().some((b) => b.checked)).toBe(false);
  });
});

describe('Appeals form', () => {
  const appeals = (over = {}) => ({
    config: {
      questions: ['Why were you banned?'],
      autoUnbanOnAccept: false,
      reviewChannelId: '',
      cooldownDays: 7,
      appealMessage: '',
      appealServerInvite: '',
    },
    channels,
    dashboardUrlSet: false,
    ...over,
  });

  it('renders the loaded form (the owner hint reads the operator flag without breaking the hook order)', async () => {
    getAccount.mockResolvedValue({ operator: true });
    getModuleConfig.mockResolvedValue(appeals());
    renderAtGuild(<Appeals />, GUILD);
    expect(await screen.findByRole('heading', { name: 'Ban appeals' })).toBeTruthy();
    expect(await screen.findByText(/DASHBOARD_URL/)).toBeTruthy();
  });

  it('shows no variable names to someone who is not the owner', async () => {
    getAccount.mockResolvedValue({ operator: false });
    getModuleConfig.mockResolvedValue(appeals());
    renderAtGuild(<Appeals />, GUILD);
    expect(await screen.findByRole('heading', { name: 'Ban appeals' })).toBeTruthy();
    await waitFor(() => expect(getAccount).toHaveBeenCalled());
    expect(screen.queryByText(/DASHBOARD_URL/)).toBeNull();
  });

  it('counts everyone as the operator when the dashboard has no login (open mode)', async () => {
    getAccount.mockResolvedValue({ open: true, platforms: [], devices: [] });
    getModuleConfig.mockResolvedValue(appeals());
    renderAtGuild(<Appeals />, GUILD);
    expect(await screen.findByText(/DASHBOARD_URL/)).toBeTruthy();
  });
});

describe('Invite tracker and Auto-react wording', () => {
  it('names the grace window in the invite formula, and leaves it out when the guard is off', async () => {
    const data = (graceHours) => ({
      config: { graceHours, announce: false },
      board: {
        canReadInvites: true,
        total: 1,
        rows: [{ userId: '1', rank: 1, name: 'Alice', net: 2, regular: 3, leaves: 1, bonus: 0 }],
      },
    });
    getModuleConfig.mockResolvedValue(data(6));
    const { unmount } = renderAtGuild(<InviteTracker />, GUILD);
    expect(await screen.findByText(/minus those who left within the grace window (6 h)/)).toBeTruthy();
    unmount();
    getModuleConfig.mockResolvedValue(data(0));
    renderAtGuild(<InviteTracker />, GUILD);
    expect(await screen.findByText(/minus those who left, plus any bonus/)).toBeTruthy();
  });

  it('tells an empty auto-react rule that it is removed on save', async () => {
    getModuleConfig.mockResolvedValue({
      config: { cooldownSeconds: 5, logChannelId: '', rules: [] },
      channels,
      roles: [],
      modes: ['always', 'random'],
      roleActions: ['add', 'remove'],
    });
    renderAtGuild(<AutoReact />, GUILD);
    expect(await screen.findByText(/will be removed when you save/)).toBeTruthy();
    expect(screen.queryByText(/won't match anything/)).toBeNull();
  });
});

describe('small pieces', () => {
  it('SetupCallout says "isn\'t" for a single feature', async () => {
    getAccount.mockResolvedValue({ operator: false });
    render(<SetupCallout what="Captcha mode" singular keys="Turnstile keys" vars={['TURNSTILE_SITE_KEY']} />);
    expect((await screen.findByRole('note')).textContent).toContain(
      "Captcha mode isn't active on this Sylo yet"
    );
    await waitFor(() => expect(getAccount).toHaveBeenCalled());
    expect(screen.queryByText(/TURNSTILE_SITE_KEY/)).toBeNull();
  });

  it("Time shows the server's own wording when it has no time, and nothing without either", () => {
    const { container, rerender } = render(<Time value={null} fallback="5m ago" />);
    expect(container.textContent).toBe('5m ago');
    rerender(<Time value={undefined} />);
    expect(container.textContent).toBe('');
  });

  it('Time puts the other form in the tooltip', () => {
    const at = Date.now() - 3 * 60_000;
    const { container } = render(<Time value={at} relative />);
    const el = container.querySelector('time');
    expect(el.textContent).toBe('3m ago');
    expect(el.title).not.toBe('');
    expect(el.title).not.toBe('3m ago');
    expect(el.dateTime).toBe(new Date(at).toISOString());
  });

  it('the test-message hint says what is posted and where', () => {
    expect(postsTo('a sample alert', 'streams', 'the first one in the list')).toBe(
      'Posts a sample alert to #streams (the first one in the list).'
    );
    expect(postsTo('', '')).toBe('Posts a sample message to the channel set above.');
  });
});
