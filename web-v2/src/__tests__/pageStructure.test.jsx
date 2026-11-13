import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Overview from '../pages/Overview.jsx';
import AuditLog, { auditActionLabel } from '../pages/AuditLog.jsx';
import Counting from '../moduleForms/Counting.jsx';
import Leveling from '../moduleForms/Leveling.jsx';
import Starboard from '../moduleForms/Starboard.jsx';
import Giveaways from '../moduleForms/Giveaways.jsx';
import { signups } from '../moduleForms/Events.jsx';
import { fmtDurationShort } from '../pages/Insights.jsx';
import { platformLabel, playedLabel, statFacts } from '../pages/Stats.jsx';
import { sourceLabel } from '../pages/Health.jsx';
import { resetModuleLimits } from '../components/useModuleLimits.js';
import { renderAtGuild } from './routerHarness.jsx';

vi.mock('../api.js', () => ({
  ApiError: class ApiError extends Error {},
  getModuleConfig: vi.fn(),
  saveModuleConfig: vi.fn(),
  getModuleLimits: vi.fn(),
  getAuditLog: vi.fn(),
  apiFetch: vi.fn(),
  setModuleEnabled: vi.fn(),
  setModulesEnabledBulk: vi.fn(),
  setCountingCount: vi.fn(),
  resetCountingCount: vi.fn(),
  releaseCountingPenalty: vi.fn(),
  endGiveaway: vi.fn(),
  rerollGiveaway: vi.fn(),
}));
vi.mock('../notify.js', () => ({ notify: vi.fn() }));
vi.mock('../components/ConfirmDialog.jsx', () => ({ confirmDialog: vi.fn().mockResolvedValue(true) }));
vi.mock('../moduleForms/index.js', () => ({ v2Href: (card, guildId) => `/guilds/${guildId}/m/${card.id}` }));
vi.mock('../OverviewContext.jsx', () => ({ useOverview: vi.fn() }));
const api = await import('../api.js');
const { useOverview } = await import('../OverviewContext.jsx');
const { confirmDialog } = await import('../components/ConfirmDialog.jsx');

const GUILD = '123456789012345678';
const ROLE = '555555555555555551';
const CHANNEL = '666666666666666661';

beforeEach(() => {
  vi.resetAllMocks();
  resetModuleLimits();
  api.getModuleLimits.mockResolvedValue({ _embed: {} });
});

describe('Overview', () => {
  const card = (over) => ({
    id: 'afk',
    name: 'AFK',
    description: 'Away status',
    hasToggle: true,
    enabled: true,
    missingIntents: [],
    ...over,
  });
  function mockOverview(over = {}) {
    useOverview.mockReturnValue({
      data: {
        guild: { name: 'Hedgerow', icon: null, memberCount: 12 },
        groups: [{ title: 'Utility', cards: [card()] }],
        openTickets: 2,
        openAppeals: 1,
        ...over,
      },
      dataGuildId: GUILD,
      error: null,
      setData: vi.fn(),
    });
  }

  it('says how many modules are on in the heading, without a separate count strip', async () => {
    mockOverview();
    renderAtGuild(<Overview />, GUILD);
    expect(await screen.findByText(/1 of 1 modules on/)).toBeTruthy();
    expect(screen.queryByText('modules active')).toBeNull();
  });

  const ISSUE = {
    problems: [{ id: 'afk', name: 'AFK', issues: ['The channel is not set'] }],
    missingPermissions: [],
    waiting: { tickets: 2, appeals: 1, applications: 3, suggestions: 0 },
  };

  it('lists what needs attention at the top: the waiting work as one row of links, the rest with a link to fix it', async () => {
    mockOverview({ attention: ISSUE });
    renderAtGuild(<Overview />, GUILD);
    const panel = (await screen.findByRole('heading', { name: /Needs attention/ })).closest('section');
    expect(within(panel).getAllByText('Waiting for a person')).toHaveLength(1);
    const tickets = within(panel).getByRole('link', { name: '2 open tickets' });
    expect(tickets.getAttribute('href')).toBe(`/guilds/${GUILD}/tickets`);
    const applications = within(panel).getByRole('link', { name: '3 applications waiting' });
    expect(applications.getAttribute('href')).toBe(`/guilds/${GUILD}/m/applications`);
    expect(within(panel).getByText('AFK is on but not set up', { selector: 'strong' })).toBeTruthy();
    expect(within(panel).getByText('The channel is not set')).toBeTruthy();
    const fix = within(panel).getByRole('link', { name: /Fix AFK is on but not set up/ });
    expect(fix.getAttribute('href')).toBe(`/guilds/${GUILD}/m/afk`);
  });

  it('says so when nothing needs attention', async () => {
    mockOverview({ openTickets: 0, openAppeals: 0, attention: undefined });
    renderAtGuild(<Overview />, GUILD);
    expect(await screen.findByText('Nothing needs your attention right now.')).toBeTruthy();
  });

  it('shows a one-line summary and the status on each module card, and the card opens the module', async () => {
    mockOverview({
      groups: [
        {
          title: 'Utility',
          cards: [card({ lines: [{ label: 'Channel', value: '#general', state: 'on' }], icon: 'moon' })],
        },
      ],
    });
    renderAtGuild(<Overview />, GUILD);
    expect(await screen.findByText('Channel: #general')).toBeTruthy();
    expect(screen.getByText('On')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'AFK' }).getAttribute('href')).toBe(`/guilds/${GUILD}/m/afk`);
  });

  it('asks before switching a module off, and does nothing when the answer is no', async () => {
    const setData = vi.fn();
    mockOverview();
    useOverview.mockReturnValue({ ...useOverview(), setData });
    confirmDialog.mockResolvedValue(false);
    renderAtGuild(<Overview />, GUILD);
    fireEvent.click(await screen.findByRole('switch', { name: 'AFK' }));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalled());
    expect(confirmDialog.mock.calls[0][0].title).toBe('Switch off AFK?');
    expect(api.setModuleEnabled).not.toHaveBeenCalled();
    expect(setData).not.toHaveBeenCalled();
  });

  it('switches the module off when the answer is yes', async () => {
    mockOverview();
    api.setModuleEnabled.mockResolvedValue({});
    confirmDialog.mockResolvedValue(true);
    renderAtGuild(<Overview />, GUILD);
    fireEvent.click(await screen.findByRole('switch', { name: 'AFK' }));
    await waitFor(() => expect(api.setModuleEnabled).toHaveBeenCalledWith(GUILD, 'afk', false));
  });

  it('switches a module on without asking', async () => {
    mockOverview({ groups: [{ title: 'Utility', cards: [card({ enabled: false })] }] });
    api.setModuleEnabled.mockResolvedValue({});
    renderAtGuild(<Overview />, GUILD);
    fireEvent.click(await screen.findByRole('switch', { name: 'AFK' }));
    await waitFor(() => expect(api.setModuleEnabled).toHaveBeenCalledWith(GUILD, 'afk', true));
    expect(confirmDialog).not.toHaveBeenCalled();
  });

  it('asks before a bulk "Disable" too, and only calls the server on yes', async () => {
    mockOverview();
    api.setModulesEnabledBulk.mockResolvedValue({});
    confirmDialog.mockResolvedValueOnce(false);
    renderAtGuild(<Overview />, GUILD);
    fireEvent.click(await screen.findByRole('button', { name: 'Bulk edit' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select AFK' }));
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(1));
    expect(confirmDialog.mock.calls[0][0].title).toBe('Switch off 1 module?');
    expect(api.setModulesEnabledBulk).not.toHaveBeenCalled();

    confirmDialog.mockResolvedValueOnce(true);
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(api.setModulesEnabledBulk).toHaveBeenCalledWith(GUILD, ['afk'], false));
  });

  it('shows markup in a name or a summary as plain text', async () => {
    const evil = '<img src=x onerror="window.pwned=1"> <b>bold</b>';
    mockOverview({
      groups: [
        {
          title: 'Utility',
          cards: [card({ name: evil, summaryParts: [evil], icon: 'moon' })],
        },
      ],
      attention: {
        problems: [{ id: 'afk', name: evil, issues: [evil] }],
        missingPermissions: [],
        waiting: { tickets: 0, appeals: 0, applications: 0, suggestions: 0 },
      },
    });
    const { container } = renderAtGuild(<Overview />, GUILD);
    await screen.findAllByText(evil, { exact: false });
    expect(container.querySelector('img[src="x"]')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(window.pwned).toBeUndefined();
  });

  it('folds a category, remembers it, and opens it again while searching', async () => {
    mockOverview();
    renderAtGuild(<Overview />, GUILD);
    const head = await screen.findByRole('button', { name: /Utility/ });
    expect(head.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(head);
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(JSON.parse(localStorage.getItem('sylo:v2:overview-collapsed'))).toEqual(['Utility']);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search modules' }), { target: { value: 'afk' } });
    expect(screen.getByRole('button', { name: /Utility/ }).getAttribute('aria-expanded')).toBe('true');
    localStorage.removeItem('sylo:v2:overview-collapsed');
  });

  it('calls the bulk switch "Bulk edit" and gives one instruction instead of the old note', async () => {
    mockOverview();
    renderAtGuild(<Overview />, GUILD);
    const bulk = await screen.findByRole('button', { name: 'Bulk edit' });
    expect(screen.queryByText('Every module has its own page here.')).toBeNull();
    expect(screen.getByText(/Switch a module on or off here/)).toBeTruthy();
    fireEvent.click(bulk);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });
});

describe('Audit log', () => {
  it('names modules and other actions in plain words, and keeps the raw key as a tooltip', async () => {
    useOverview.mockReturnValue({
      data: { groups: [{ title: 'Engagement', cards: [{ id: 'starboard', name: 'Starboard' }] }] },
    });
    api.getAuditLog.mockResolvedValue({
      kept: 500,
      entries: [
        { id: 1, action: 'module:starboard', actor: 'Ann', detail: 'settings saved', at: 1, ago: '2m ago' },
        { id: 2, action: 'settings:server', actor: 'Bob', detail: '', at: 2, ago: '1h ago' },
      ],
    });
    renderAtGuild(<AuditLog />, GUILD);
    const heading = await screen.findByRole('heading', { name: 'Starboard' });
    expect(heading.getAttribute('title')).toBe('module:starboard');
    expect(screen.getByRole('heading', { name: 'Server settings' }).getAttribute('title')).toBe(
      'settings:server'
    );
    // "shown, newest first" is hint text now, not a heading; the breadcrumb leads back to Settings.
    expect(screen.queryByRole('heading', { name: /shown, newest first/ })).toBeNull();
    expect(screen.getByText('2 shown, newest first.')).toBeTruthy();
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: 'Settings' }).getAttribute('href')).toBe(
      `/guilds/${GUILD}/settings`
    );
    expect(within(crumbs).getByText('Audit log').getAttribute('aria-current')).toBe('page');
  });

  it('turns action keys into readable names', () => {
    const names = new Map([['welcome-channel', 'Welcome channel']]);
    expect(auditActionLabel('module:welcome-channel', names)).toBe('Welcome channel');
    expect(auditActionLabel('module:temp-voice')).toBe('Temp voice');
    expect(auditActionLabel('appeal:accepted')).toBe('Appeal accepted');
    expect(auditActionLabel('moderation:case-delete')).toBe('Case delete');
    expect(auditActionLabel('command:/afk')).toBe('Command /afk');
    expect(auditActionLabel('something:new-thing')).toBe('Something new thing');
  });
});

describe('Counting', () => {
  const load = (penaltyRoleId) =>
    api.getModuleConfig.mockResolvedValue({
      config: {
        channelId: CHANNEL,
        react: true,
        allowSameUser: false,
        resetOnFail: true,
        penaltyRoleId,
        penaltyMinutes: 15,
      },
      channels: [{ id: CHANNEL, name: 'counting' }],
      roles: [{ id: ROLE, name: 'Counters' }],
      state: { current: 3, record: 9, lastUserId: null },
      penalties: [],
    });

  it('renames the penalty role and keeps its duration off until a role is picked', async () => {
    load('');
    renderAtGuild(<Counting />, GUILD);
    expect(await screen.findByLabelText(/Counting access role/)).toBeTruthy();
    expect(screen.queryByText(/Penalty role/)).toBeNull();
    const minutes = screen.getByLabelText('Remove it for');
    expect(minutes.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Counting access role/), { target: { value: ROLE } });
    expect(screen.getByLabelText('Remove it for').disabled).toBe(false);
  });

  it('moves the explanations of the checkboxes into hint lines', async () => {
    load(ROLE);
    renderAtGuild(<Counting />, GUILD);
    expect(await screen.findByLabelText('React to correct counts')).toBeTruthy();
    expect(screen.getByText(/When off, counters must take turns/)).toBeTruthy();
    expect(screen.getByLabelText('Let the same person count twice in a row')).toBeTruthy();
  });
});

describe('Leveling', () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({
    rank: i + 1,
    name: `Member ${i + 1}`,
    level: 10 - i,
    xp: 100,
    voiceXp: 0,
    voiceMinutes: 0,
    messages: 5,
  }));
  beforeEach(() => {
    api.getModuleConfig.mockResolvedValue({
      config: {
        announce: 'channel',
        announceChannel: '',
        announceMessage: '',
        cooldownSeconds: 60,
        stackRewards: true,
        rewards: [{ level: 5, roleId: ROLE }],
        removeRewardsOnXpLoss: false,
        xpRate: 1.5,
        voiceXpEnabled: false,
        voiceXpPerMin: 5,
        voiceAfkExcluded: true,
        multipliers: [{ type: 'role', id: ROLE, factor: 2 }],
        noXpRolesMode: 'allow',
        noXpRoles: [],
        noXpChannelsMode: 'allow',
        noXpChannels: [],
      },
      announceModes: ['channel', 'off'],
      channels: [{ id: CHANNEL, name: 'general' }],
      roles: [{ id: ROLE, name: 'Veteran' }],
      xpRates: [0.5, 1, 1.5],
      board: { total: 8, rows },
    });
  });

  it('picks the XP rate from a list and names the filters by what they do', async () => {
    renderAtGuild(<Leveling />, GUILD);
    const rate = await screen.findByLabelText('Speed everyone levels up at');
    expect(rate.tagName).toBe('SELECT');
    expect(rate.value).toBe('1.5');
    expect(within(rate).getByRole('option', { name: 'x1 (normal)' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'XP by role' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'XP by channel' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /No-XP/ })).toBeNull();
  });

  it('labels the reward and multiplier inputs and shows only the top five of the leaderboard', async () => {
    renderAtGuild(<Leveling />, GUILD);
    expect((await screen.findByLabelText('Reward level')).value).toBe('5');
    expect(screen.getByLabelText('Reward role').value).toBe(ROLE);
    expect(screen.getByLabelText('XP factor').value).toBe('2');
    expect(screen.getByText(/#5 Member 5/)).toBeTruthy();
    expect(screen.queryByText(/#6 Member 6/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Full leaderboard →' }).getAttribute('href')).toBe(
      `/guilds/${GUILD}/leaderboard`
    );
  });
});

describe('Starboard', () => {
  it('hides the detailed options behind "Advanced" and disables options whose parent is off', async () => {
    api.getModuleConfig.mockResolvedValue({
      config: {
        boards: [
          {
            id: 'a',
            name: 'Main',
            channelId: CHANNEL,
            emojiText: '⭐',
            autoReact: false,
            ignoreSelfStars: true,
          },
        ],
      },
      channels: [{ id: CHANNEL, name: 'highlights' }],
      roles: [],
    });
    renderAtGuild(<Starboard />, GUILD);
    const summary = await screen.findByText('Advanced');
    const details = summary.closest('details');
    expect(details.open).toBe(false);
    // "Only with the first emoji" needs "React to the starboard post" (off here).
    expect(screen.getByLabelText('Only with the first emoji').disabled).toBe(true);
    expect(screen.getByLabelText(/Also remove that reaction/).disabled).toBe(false);
    fireEvent.click(screen.getByLabelText(/React to the starboard post/));
    expect(screen.getByLabelText('Only with the first emoji').disabled).toBe(false);
    // Both age fields say what 0 means.
    expect(screen.getAllByText(/0 = no limit/)).toHaveLength(2);
  });
});

describe('Giveaways', () => {
  it('labels the reroll number, counts the recently ended ones and names winners', async () => {
    api.getModuleConfig.mockResolvedValue({
      config: { ping: 'none', dmWinners: false },
      giveaways: [
        {
          id: 4,
          prize: 'Nitro',
          state: 'ended',
          entries: 3,
          wonIds: ['111111111111111111', '222222222222222222'],
          wonNames: ['alice', '222222222222222222'],
        },
      ],
    });
    renderAtGuild(<Giveaways />, GUILD);
    expect(await screen.findByRole('heading', { name: 'Recently ended (1)' })).toBeTruthy();
    const input = screen.getByLabelText(/^Reroll/);
    expect(input.value).toBe('1');
    expect(screen.getByText('winner')).toBeTruthy();
    fireEvent.change(input, { target: { value: '2' } });
    expect(screen.getByText('winners')).toBeTruthy();
    expect(screen.getByText(/won by alice, a member \(ID 222222222222222222\)/)).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Reroll/ }).textContent).toBe('Reroll giveaway #4')
    );
  });
});

describe('small formatters', () => {
  it('writes event sign-ups in words', () => {
    expect(signups({ joined: 4, capacity: 12, maybe: 1 })).toBe('4/12 going · 1 maybe');
    expect(signups({ joined: 3, capacity: null, maybe: 0 })).toBe('3 going');
  });

  it('keeps long voice totals on one line', () => {
    expect(fmtDurationShort(90)).toBe('1 h 30 m');
    expect(fmtDurationShort(144135)).toBe('2,402 h');
  });

  it('shows only the stats a game has, with readable platform and time', () => {
    expect(platformLabel('xboxone')).toBe('Xbox One');
    expect(platformLabel('pc')).toBe('PC');
    expect(playedLabel('412h')).toBe('412 h played');
    expect(playedLabel(1483200)).toBe('412 h played');
    expect(playedLabel('—')).toBe('');
    expect(statFacts({ platform: 'pc', kd: '1.4', winRate: '—', timePlayed: '412h', ago: '2h ago' })).toEqual(
      ['PC', 'K/D 1.4', false, '412 h played', '2h ago']
    );
  });

  it('names an error source by module, then by system part', () => {
    expect(sourceLabel({ scope: 'module:starboard', source: 'Starboard' })).toBe('Starboard');
    expect(sourceLabel({ scope: 'db' })).toBe('Database');
    expect(sourceLabel({ scope: 'odd-one' })).toBe('odd-one');
    expect(sourceLabel({ scope: '' })).toBe('Unscoped');
  });
});
