import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TwitchAlerts from '../moduleForms/TwitchAlerts.jsx';
import KickAlerts from '../moduleForms/KickAlerts.jsx';
import YoutubeAlerts from '../moduleForms/YoutubeAlerts.jsx';
import RssAlerts from '../moduleForms/RssAlerts.jsx';
import Tickets from '../moduleForms/Tickets.jsx';
import Verification from '../moduleForms/Verification.jsx';
import AutoThreads from '../moduleForms/AutoThreads.jsx';
import ServerStats from '../moduleForms/ServerStats.jsx';
import TempVoice from '../moduleForms/TempVoice.jsx';
import Polls from '../moduleForms/Polls.jsx';
import Giveaways from '../moduleForms/Giveaways.jsx';
import AppleConnect from '../moduleForms/AppleConnect.jsx';
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
  searchMembers: vi.fn(),
  getMemberNames: vi.fn(),
}));
const { getModuleConfig, getModuleLimits, getAccount, searchMembers, getMemberNames } = await import(
  '../api.js'
);

const GUILD = '123456789012345678';
const CHANNEL = '555555555555555555';
const CHANNEL2 = '555555555555555556';
const ROLE = '777777777777777777';
const channels = [
  { id: CHANNEL, name: 'general' },
  { id: CHANNEL2, name: 'rules' },
];
const roles = [{ id: ROLE, name: 'Moderators' }];

// PreviewLayout puts the preview in a column on a wide window and folds it away on a narrow one.
function stubMedia(matches) {
  window.matchMedia = vi.fn().mockImplementation(() => ({
    matches,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

beforeEach(() => {
  vi.resetAllMocks();
  resetModuleLimits();
  resetOperatorCache();
  getModuleLimits.mockResolvedValue({ _embed: {} });
  getAccount.mockResolvedValue({ operator: false });
  searchMembers.mockResolvedValue({ members: [] });
  getMemberNames.mockResolvedValue({ names: {} });
  stubMedia(true);
});
afterEach(() => {
  delete window.matchMedia;
});

const bars = (container) => container.querySelectorAll('.v2-ph-bar');
const preview = () => screen.getByRole('complementary', { name: 'Preview' });

// jsdom has no execCommand, so a picked mention is written by setting the value and firing input.
function type(el, text) {
  fireEvent.change(el, { target: { value: text } });
  el.setSelectionRange(text.length, text.length);
  fireEvent.input(el);
}

const twitch = (alerts) => ({
  config: { alerts },
  channels,
  roles,
  twitchEnabled: true,
  defaultMessage: '🔴 **{name}** is live on Twitch!',
});
const streamer = (over = {}) => ({
  login: 'ninja',
  channelId: CHANNEL,
  roleId: '',
  message: '',
  plainText: false,
  onEnd: 'delete',
  ...over,
});

describe('Social alerts', () => {
  it('shows one placeholder bar per card, not one per message field', async () => {
    getModuleConfig.mockResolvedValue(twitch([streamer(), streamer({ login: 'shroud' })]));
    const twitchView = renderAtGuild(<TwitchAlerts />, GUILD);
    await screen.findAllByLabelText('Message');
    expect(bars(twitchView.container)).toHaveLength(2);
    // The old "Insert:" row under the field is gone.
    expect(twitchView.container.querySelectorAll('.v2-ph-chips')).toHaveLength(2);
    twitchView.unmount();

    getModuleConfig.mockResolvedValue({
      config: {
        alerts: [
          { ytChannelId: 'UC1', name: 'Cool', discordChannelId: CHANNEL, onVideo: true, onLive: true },
        ],
      },
      channels,
      roles,
      defaultVideoMessage: '',
      defaultLiveMessage: '',
    });
    const yt = renderAtGuild(<YoutubeAlerts />, GUILD);
    await screen.findByLabelText('New-video message');
    // Two message fields on the card, one bar for both.
    expect(screen.getByLabelText('Went-live message')).toBeTruthy();
    expect(bars(yt.container)).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Insert {title}' })).toHaveLength(1);
  });

  it('offers channels after # in the alert message and writes the <#id> token', async () => {
    getModuleConfig.mockResolvedValue(twitch([streamer()]));
    renderAtGuild(<TwitchAlerts />, GUILD);
    const field = await screen.findByLabelText('Message');
    type(field, 'Live in #gen');
    const list = await screen.findByRole('listbox');
    fireEvent.mouseDown(within(list).getByRole('option', { name: /general/ }));
    expect(field.value).toBe(`Live in <#${CHANNEL}>`);
  });

  it('previews the alert with sample data and follows the message', async () => {
    getModuleConfig.mockResolvedValue(twitch([streamer({ message: 'Hi {name}, {viewers} watching' })]));
    renderAtGuild(<TwitchAlerts />, GUILD);
    const field = await screen.findByLabelText('Message');
    expect(preview().textContent).toContain('Hi ninja, 218 watching');
    expect(preview().textContent).toContain('ninja is live on Twitch');
    expect(preview().textContent).toContain('Playing Celeste');
    expect(preview().textContent).not.toContain('{name}');

    fireEvent.change(field, { target: { value: `See <#${CHANNEL}> {title}` } });
    expect(preview().textContent).toContain('See #general Pixel art night');
  });

  it('shows the server default in the preview while the message is empty, and the role ping', async () => {
    getModuleConfig.mockResolvedValue(twitch([streamer({ roleId: ROLE })]));
    renderAtGuild(<TwitchAlerts />, GUILD);
    await screen.findByLabelText('Message');
    expect(preview().textContent).toContain('@Moderators');
    expect(preview().textContent).toContain('ninja is live on Twitch!');
  });

  it('previews the card that was edited last', async () => {
    getModuleConfig.mockResolvedValue(
      twitch([streamer({ message: 'first {name}' }), streamer({ login: 'shroud', message: 'second {name}' })])
    );
    renderAtGuild(<TwitchAlerts />, GUILD);
    const [, second] = await screen.findAllByLabelText('Message');
    expect(preview().textContent).toContain('first ninja');
    fireEvent.focus(second);
    expect(preview().textContent).toContain('second shroud');
  });

  it('previews both YouTube alerts, and leaves out the one that is not chosen without losing focus', async () => {
    getModuleConfig.mockResolvedValue({
      config: {
        alerts: [
          {
            ytChannelId: 'UC1',
            name: 'Cool',
            discordChannelId: CHANNEL,
            onVideo: true,
            onLive: true,
            videoMessage: 'Video {title}',
            liveMessage: 'Live {title}',
          },
        ],
      },
      channels,
      roles,
      defaultVideoMessage: '',
      defaultLiveMessage: '',
    });
    renderAtGuild(<YoutubeAlerts />, GUILD);
    const video = await screen.findByLabelText('New-video message');
    expect(preview().textContent).toContain('Video Pixel art night');
    expect(preview().textContent).toContain('Live Pixel art night');
    expect(preview().textContent).not.toContain('(ID ');

    video.focus();
    fireEvent.change(screen.getByLabelText('Notify on'), { target: { value: 'live' } });
    expect(preview().textContent).not.toContain('Video Pixel art night');
    expect(preview().textContent).toContain('Live Pixel art night');
    expect(screen.getByLabelText('New-video message')).toBe(video);
    expect(document.activeElement).toBe(video);
  });

  it('keeps focus when the preview folds in on a narrow window', async () => {
    stubMedia(false);
    getModuleConfig.mockResolvedValue(twitch([streamer()]));
    renderAtGuild(<TwitchAlerts />, GUILD);
    const field = await screen.findByLabelText('Message');
    field.focus();
    fireEvent.click(screen.getByRole('button', { name: 'Show preview' }));
    expect(screen.getByRole('complementary', { name: 'Preview' })).toBeTruthy();
    expect(document.activeElement).toBe(field);
    fireEvent.click(screen.getByRole('button', { name: 'Hide preview' }));
    expect(screen.getByLabelText('Message')).toBe(field);
    expect(document.activeElement).toBe(field);
  });

  it('gives the RSS address the whole row and previews the post', async () => {
    getModuleConfig.mockResolvedValue({
      config: {
        feeds: [
          {
            type: 'url',
            ref: 'https://example.com/blog/feed.xml',
            channelId: CHANNEL,
            roleId: '',
            template: 'New: {title} by {author}',
          },
        ],
      },
      channels,
      roles,
      feedTypes: ['url', 'reddit'],
      defaultTemplate: '{title} {link}',
    });
    const view = renderAtGuild(<RssAlerts />, GUILD);
    const url = await screen.findByLabelText('Feed URL');
    const field = url.closest('.v2-field');
    expect(field.classList.contains('v2-field-full')).toBe(true);
    expect(field.closest('.v2-field-row')).toBeNull();
    // The source is above it, on a row of its own.
    expect(screen.getByLabelText('Source').closest('.v2-field')).not.toBe(field);
    expect(bars(view.container)).toHaveLength(1);
    expect(preview().textContent).toContain('New: Pixel art night by Mara');
  });

  it('starts with a one-line empty state and adds a streamer from the button', async () => {
    getModuleConfig.mockResolvedValue({
      config: { alerts: [] },
      channels,
      roles,
      kickEnabled: true,
      defaultMessage: '',
    });
    renderAtGuild(<KickAlerts />, GUILD);
    expect(await screen.findByText('No streamers yet — add one below.')).toBeTruthy();
    expect(screen.queryByText('New streamer')).toBeNull();
    expect(screen.queryByPlaceholderText('e.g. streamer_name')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '+ Add streamer' }));
    expect(screen.getByPlaceholderText('e.g. streamer_name')).toBeTruthy();
    expect(screen.queryByText('No streamers yet — add one below.')).toBeNull();
  });
});

describe('Tickets', () => {
  const ticketData = (config = {}) => ({
    config: {
      greeting: '',
      closeMessage: '',
      notifyChannel: '',
      staffRoles: [],
      showMessageInAlert: false,
      transcriptRetentionDays: 0,
      ...config,
    },
    channels,
    roles,
  });

  it('has one placeholder bar for both messages and a mention field for each', async () => {
    getModuleConfig.mockResolvedValue(ticketData());
    const view = renderAtGuild(<Tickets />, GUILD);
    const greeting = await screen.findByLabelText('Greeting sent when a ticket opens');
    expect(screen.getByRole('heading', { name: 'Tickets' })).toBeTruthy();
    expect(bars(view.container)).toHaveLength(1);
    expect(greeting.getAttribute('role')).toBe('combobox');
    expect(screen.getByLabelText('Message sent when a ticket is closed').getAttribute('role')).toBe(
      'combobox'
    );
    type(greeting, 'Read #ru');
    const list = await screen.findByRole('listbox');
    fireEvent.mouseDown(within(list).getByRole('option', { name: /rules/ }));
    expect(greeting.value).toBe(`Read <#${CHANNEL2}>`);
  });

  it('previews the greeting and the closing message and follows them', async () => {
    getModuleConfig.mockResolvedValue(ticketData({ greeting: 'Welcome to {server}' }));
    renderAtGuild(<Tickets />, GUILD);
    const close = await screen.findByLabelText('Message sent when a ticket is closed');
    expect(preview().textContent).toContain('Welcome to Your server');
    // An empty closing message shows the bot's default.
    expect(preview().textContent).toContain('This ticket has been closed.');
    fireEvent.change(close, { target: { value: 'Bye from {server}' } });
    expect(preview().textContent).toContain('Bye from Your server');
    expect(preview().textContent).toContain('A transcript of this conversation is attached.');
  });
});

describe('Verification', () => {
  it('previews the title, text and button, and the reply after verifying', async () => {
    getModuleConfig.mockResolvedValue({
      config: {
        mode: 'button',
        verifiedRoleId: ROLE,
        channelId: CHANNEL,
        title: 'Welcome!',
        message: 'Press the button.',
        successMessage: 'Thanks',
        logChannelId: '',
        kickAfterMinutes: 0,
      },
      modes: ['button', 'captcha'],
      channels,
      roles,
      turnstileEnabled: true,
    });
    renderAtGuild(<Verification />, GUILD);
    const body = await screen.findByLabelText('Message body');
    expect(body.getAttribute('role')).toBe('combobox');
    expect(preview().textContent).toContain('Welcome!');
    expect(preview().textContent).toContain('Press the button.');
    expect(preview().textContent).toContain('Verify');
    expect(preview().textContent).toContain('Thanks');

    fireEvent.change(screen.getByLabelText('Message title'), { target: { value: 'Rules check' } });
    fireEvent.change(body, { target: { value: `Read <#${CHANNEL}> first` } });
    fireEvent.change(screen.getByLabelText('Reply after verifying'), { target: { value: 'Done' } });
    expect(preview().textContent).toContain('Rules check');
    expect(preview().textContent).toContain('Read #general first');
    expect(preview().textContent).toContain('Done');
  });
});

describe('Auto threads', () => {
  const rule = (over = {}) => ({
    id: 'r1',
    channelId: CHANNEL,
    nameTemplate: '{author}: {words}',
    archiveMinutes: 1440,
    onlyWithAttachments: false,
    onlyWithLinks: false,
    skipBots: true,
    skipStaff: false,
    staffRoleIds: [],
    firstMessage: '',
    slowmodeSeconds: 0,
    ...over,
  });

  it('has one bar per rule and shows the thread with its first message', async () => {
    getModuleConfig.mockResolvedValue({
      config: { rules: [rule({ firstMessage: 'Welcome {author}!' }), rule({ id: 'r2' })] },
      channels,
      roles,
    });
    const view = renderAtGuild(<AutoThreads />, GUILD);
    await screen.findAllByLabelText('Thread name');
    expect(bars(view.container)).toHaveLength(2);
    const cards = view.container.querySelectorAll('.v2-thread-card');
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain('Alex:');
    expect(cards[0].textContent).toContain('Welcome @Alex!');
    expect(cards[1].textContent).toContain('No first message');
  });
});

describe('Server statistics and temporary voice', () => {
  it('shows a bar and a preview on each stat channel', async () => {
    getModuleConfig.mockResolvedValue({
      config: {
        refreshMinutes: 10,
        channels: [
          { channelId: '1', type: 'members', template: 'Members: {count}' },
          { channelId: '2', type: 'members', template: 'Online: {count}' },
        ],
      },
      statTypes: [['members', 'Members']],
      voiceChannels: [],
    });
    const view = renderAtGuild(<ServerStats />, GUILD);
    await screen.findByText('Preview: Members: 1,284');
    expect(screen.getByText('Preview: Online: 1,284')).toBeTruthy();
    expect(bars(view.container)).toHaveLength(2);
  });

  it('folds the hub into four sections that each say what is set in them', async () => {
    getModuleConfig.mockResolvedValue({
      config: {
        hubs: [
          {
            id: 'h1',
            hubChannelId: 'v1',
            roleMode: 'deny',
            roleList: [ROLE],
            moderatorRoles: [ROLE],
            ownerPerms: { manageChannels: true, moveMembers: true },
            textChannel: { enabled: true, restrict: true },
          },
        ],
      },
      voiceChannels: [{ id: 'v1', name: 'Join to create' }],
      categories: [],
      roles,
    });
    const view = renderAtGuild(<TempVoice />, GUILD);
    await screen.findByLabelText('Temporary channel name');
    expect(bars(view.container)).toHaveLength(1);
    const folds = [...view.container.querySelectorAll('details.v2-fold')];
    expect(folds.map((d) => d.querySelector('.v2-fold-title').textContent)).toEqual([
      'Who can join',
      'Moderation',
      'Owner permissions',
      'Paired text channel',
    ]);
    expect(folds.map((d) => d.querySelector('.v2-fold-summary').textContent)).toEqual([
      'Only members with 1 role',
      '1 role can moderate',
      'Manage Channel, Move Members',
      'On · 1 option',
    ]);
    // Folded until opened; the fields are still in the page.
    expect(folds.every((d) => !d.open)).toBe(true);
    expect(within(folds[2]).getByLabelText('Priority Speaker')).toBeTruthy();
  });
});

describe('Small form fixes', () => {
  it('writes the poll variable chips with their braces', async () => {
    getModuleConfig.mockResolvedValue({
      config: { voteRoleMode: 'allow', voteRoles: [], pollMessage: {}, resultsMessage: {} },
      roles,
      pollPlaceholders: ['{question}', '{ends}'],
      resultsPlaceholders: ['{question}', '{winner}'],
    });
    renderAtGuild(<Polls />, GUILD);
    const row = (await screen.findAllByRole('group', { name: 'Insert a variable' }))[0];
    expect(within(row).getByRole('button', { name: '{question}' })).toBeTruthy();
    expect(within(row).queryByRole('button', { name: 'question' })).toBeNull();
  });

  it('styles the giveaway reroll input and points the empty state at the command', async () => {
    getModuleConfig.mockResolvedValue({
      config: { ping: 'none', dmWinners: false },
      giveaways: [{ id: 4, prize: 'Nitro', state: 'ended', entries: 3, wonIds: [], wonNames: [] }],
    });
    const view = renderAtGuild(<Giveaways />, GUILD);
    const input = await screen.findByLabelText(/^Reroll/);
    expect(input.classList.contains('v2-input-sm')).toBe(true);
    expect(view.container.textContent).toContain('None running. Start one with /giveaway start in your server.');
  });

  it('lays the App Store Connect alerts out as one grid row each', async () => {
    const ev = (extra = {}) => ({ enabled: true, channelId: '', ...extra });
    getModuleConfig.mockResolvedValue({
      config: {
        channelId: CHANNEL,
        roleId: '',
        apps: [],
        events: {
          versionState: ev(),
          build: ev(),
          betaReview: ev(),
          feedback: ev(),
          reviews: ev({ maxStars: 3 }),
          expiry: ev({ days: 30 }),
        },
      },
      channels,
      roles,
      appleEnabled: true,
    });
    const view = renderAtGuild(<AppleConnect />, GUILD);
    const stars = await screen.findByLabelText('Highest star rating to alert on');
    const lines = [...view.container.querySelectorAll('.v2-alert-grid > .v2-alert-line')];
    expect(lines).toHaveLength(6);
    // Every row has the alert, its number cell and its channel select, in that order.
    for (const line of lines) {
      expect(line.children).toHaveLength(line.querySelector('.v2-alert-hint') ? 4 : 3);
      expect(line.children[0].querySelector('input[type="checkbox"]')).toBeTruthy();
      expect(line.children[1].classList.contains('v2-alert-option')).toBe(true);
      expect(line.children[2].tagName).toBe('SELECT');
    }
    expect(stars.closest('.v2-alert-option')).toBe(lines[4].children[1]);
    expect(stars.value).toBe('3');
    expect(screen.getByLabelText('Days before expiry to start alerting').value).toBe('30');
    // The footnote sits under its own row, not inside the number cell.
    expect(lines[5].querySelector('.v2-alert-hint').closest('.v2-alert-option')).toBeNull();
  });
});
