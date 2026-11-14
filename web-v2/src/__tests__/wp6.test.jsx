// Overview status and filter, the sticky jump list, the phone tab row, the audit log (filter, paging, names)
// and a few copy fixes: the dashboard polish package WP6.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Overview from '../pages/Overview.jsx';
import AuditLog, { idsInEntries, withNames } from '../pages/AuditLog.jsx';
import SectionIndex from '../components/SectionIndex.jsx';
import TabRow from '../components/TabRow.jsx';
import SetupCallout from '../components/SetupCallout.jsx';
import Health from '../pages/Health.jsx';
import {
  attentionItems,
  cardSummaryParts,
  cardTone,
  matchesStatus,
  startsFolded,
  toneLabel,
} from '../overviewModel.js';
import { renderAtGuild } from './routerHarness.jsx';

vi.mock('../api.js', () => ({
  ApiError: class ApiError extends Error {},
  getAuditLog: vi.fn(),
  getMemberNames: vi.fn(),
  getAccount: vi.fn(),
  setModuleEnabled: vi.fn(),
  setModulesEnabledBulk: vi.fn(),
  getHealth: vi.fn(),
  sendDevLogTest: vi.fn(),
  sendDevLogErrorTest: vi.fn(),
  createBackup: vi.fn(),
  deleteBackup: vi.fn(),
  restoreBackup: vi.fn(),
  importBackup: vi.fn(),
  backupDownloadUrl: vi.fn(),
}));
vi.mock('../notify.js', () => ({ notify: vi.fn() }));
vi.mock('../components/ConfirmDialog.jsx', () => ({ confirmDialog: vi.fn().mockResolvedValue(true) }));
vi.mock('../moduleForms/index.js', () => ({ v2Href: (card, guildId) => `/guilds/${guildId}/m/${card.id}` }));
vi.mock('../OverviewContext.jsx', () => ({ useOverview: vi.fn() }));
const api = await import('../api.js');
const { useOverview } = await import('../OverviewContext.jsx');
const { resetOperatorCache } = await import('../useOperator.js');

const here = dirname(fileURLToPath(import.meta.url));
const dashux = readFileSync(join(here, '..', 'dashux.css'), 'utf8').replace(/\r\n/g, '\n');
const GUILD = '123456789012345678';
const MEMBER = '800000000000000010';

const card = (over) => ({
  id: 'afk',
  name: 'AFK',
  description: 'Away status',
  hasToggle: true,
  enabled: true,
  missingIntents: [],
  status: 'on',
  lines: [{ label: 'Nickname tag', value: 'on', state: 'on' }],
  summaryParts: ['nickname tag'],
  ...over,
});
const line = (label, value, state) => ({ label, value, state });

beforeEach(() => {
  vi.resetAllMocks();
  resetOperatorCache();
  api.getAccount.mockResolvedValue({ operator: false });
  try {
    localStorage.clear();
  } catch {
    // storage is optional
  }
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('overview model: a module waiting for the bot owner', () => {
  const twitch = card({
    id: 'twitch-alerts',
    name: 'Twitch alerts',
    waitingForOwner: true,
    summaryParts: ['Waiting for the bot owner', '1 streamer'],
    lines: [line('Streamers', '1', 'on'), line('API', 'TWITCH_CLIENT_ID/SECRET not set', 'off')],
  });

  it('is amber with its own label, not a green "On"', () => {
    expect(cardTone(twitch)).toBe('warn');
    expect(toneLabel(twitch, 'warn')).toBe('Waiting for the bot owner');
    expect(toneLabel(card(), 'warn')).toBe('Needs setup');
    expect(toneLabel(card(), 'ok')).toBe('On');
    expect(cardSummaryParts(twitch)).toEqual(['Waiting for the bot owner', '1 streamer']);
  });

  it('shows "Off" alone for such a module that is switched off, and for an empty one', () => {
    expect(cardSummaryParts({ ...twitch, enabled: false })).toEqual(['Off']);
    expect(
      cardSummaryParts(
        card({ id: 'auto-react', enabled: false, empty: true, summaryParts: ['No rules yet'] })
      )
    ).toEqual(['Off']);
    expect(cardSummaryParts(card({ id: 'auto-react', empty: true, summaryParts: ['No rules yet'] }))).toEqual(
      ['No rules yet']
    );
  });

  it('adds an information item to Needs attention, without a fix link', () => {
    const data = {
      groups: [{ title: 'Social alerts', cards: [twitch] }],
      attention: {
        waitingForOwner: [{ id: 'twitch-alerts', name: 'Twitch alerts', keys: 'Twitch API keys' }],
      },
    };
    const items = attentionItems(data, GUILD);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'info', href: null });
    expect(items[0].title).toBe('Twitch alerts is waiting for the bot owner');
    expect(items[0].detail).toContain('Twitch API keys');
    // switched off since: nothing to wait for
    const off = { ...data, groups: [{ title: 'x', cards: [{ ...twitch, enabled: false }] }] };
    expect(attentionItems(off, GUILD)).toEqual([]);
  });

  it('filters by status: "Needs setup" is the amber ones, and a category is folded only when all green', () => {
    expect(matchesStatus('setup', 'warn')).toBe(true);
    expect(matchesStatus('setup', 'ok')).toBe(false);
    expect(matchesStatus('on', 'ok')).toBe(true);
    expect(matchesStatus('off', 'off')).toBe(true);
    expect(matchesStatus('all', 'link')).toBe(true);
    expect(matchesStatus('on', 'link')).toBe(false);
    expect(startsFolded([card(), card({ id: 'b' })])).toBe(true);
    expect(startsFolded([card(), twitch])).toBe(false);
    expect(startsFolded([card(), card({ id: 'c', enabled: false })])).toBe(false);
    expect(startsFolded([card({ id: 'x', hasToggle: false, enabled: null })])).toBe(false);
  });
});

describe('Overview: status filter, hint and phone default', () => {
  const cards = [
    card({ id: 'afk', name: 'AFK' }),
    card({
      id: 'twitch-alerts',
      name: 'Twitch alerts',
      waitingForOwner: true,
      summaryParts: ['Waiting for the bot owner'],
      lines: [line('API', 'x', 'off')],
    }),
    card({ id: 'polls', name: 'Polls', enabled: false, status: 'off', summaryParts: [] }),
    card({ id: 'general', name: 'Settings', hasToggle: false, enabled: null, status: 'link' }),
  ];
  const mock = (groups) =>
    useOverview.mockReturnValue({
      data: {
        guild: { name: 'Hedgerow', icon: null, memberCount: 12 },
        groups,
        openTickets: 0,
        openAppeals: 0,
      },
      dataGuildId: GUILD,
      error: null,
      setData: vi.fn(),
    });

  it('"Needs setup" shows only the amber cards, and "All" brings the rest back', async () => {
    mock([{ title: 'Utility', cards }]);
    renderAtGuild(<Overview />, GUILD);
    expect(await screen.findByRole('link', { name: 'AFK' })).toBeTruthy();
    const group = screen.getByRole('group', { name: 'Show modules by status' });
    fireEvent.click(within(group).getByRole('button', { name: /Needs setup/ }));
    expect(screen.queryByRole('link', { name: 'AFK' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Polls' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Twitch alerts' })).toBeTruthy();
    expect(screen.getByText('Waiting for the bot owner', { selector: '.v2-modrow-status' })).toBeTruthy();
    fireEvent.click(within(group).getByRole('button', { name: /^All/ }));
    expect(screen.getByRole('link', { name: 'AFK' })).toBeTruthy();
    // the counts on the chips
    expect(within(group).getByRole('button', { name: /Needs setup 1/ })).toBeTruthy();
    expect(within(group).getByRole('button', { name: /^On 1/ })).toBeTruthy();
    expect(within(group).getByRole('button', { name: /^Off 1/ })).toBeTruthy();
  });

  it('does not list Settings or Commands as module rows', async () => {
    mock([
      {
        title: 'Core',
        cards: [...cards, card({ id: 'commands', name: 'Commands', hasToggle: false, enabled: null })],
      },
    ]);
    renderAtGuild(<Overview />, GUILD);
    await screen.findByRole('link', { name: 'AFK' });
    expect(screen.queryByRole('link', { name: 'Settings' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Commands' })).toBeNull();
  });

  it('shows the on/off hint until the first switch, then not again', async () => {
    api.setModuleEnabled.mockResolvedValue({});
    mock([{ title: 'Utility', cards: [cards[2]] }]);
    const first = renderAtGuild(<Overview />, GUILD);
    expect(await screen.findByText(/Switch a module on or off here/)).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'Polls' }));
    await waitFor(() => expect(api.setModuleEnabled).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText(/Switch a module on or off here/)).toBeNull());
    first.unmount();
    renderAtGuild(<Overview />, GUILD);
    await screen.findByRole('switch', { name: 'Polls' });
    expect(screen.queryByText(/Switch a module on or off here/)).toBeNull();
  });

  it('on a phone, a category where every module is green starts folded; before that choice only', async () => {
    vi.stubGlobal('matchMedia', (q) => ({
      matches: q.includes('600px'),
      addEventListener() {},
      removeEventListener() {},
    }));
    mock([
      { title: 'All good', cards: [card({ id: 'afk', name: 'AFK' })] },
      { title: 'Some trouble', cards: [cards[1]] },
    ]);
    renderAtGuild(<Overview />, GUILD);
    const good = await screen.findByRole('button', { name: /All good/ });
    expect(good.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('button', { name: /Some trouble/ }).getAttribute('aria-expanded')).toBe('true');
    // opening it is remembered like any choice
    fireEvent.click(good);
    expect(good.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: /Some trouble/ }).getAttribute('aria-expanded')).toBe('true');
  });

  it('on a wide screen every category starts open', async () => {
    mock([{ title: 'All good', cards: [card({ id: 'afk', name: 'AFK' })] }]);
    renderAtGuild(<Overview />, GUILD);
    expect((await screen.findByRole('button', { name: /All good/ })).getAttribute('aria-expanded')).toBe(
      'true'
    );
  });
});

describe('SectionIndex', () => {
  it('sticks under the top bar, and marks the section on screen as current', () => {
    expect(dashux).toMatch(/\.v2-section-index \{[^}]*position: sticky;[^}]*top: var\(--topbar-h\)/);
    let callback;
    const observed = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb) {
          callback = cb;
        }
        observe(el) {
          observed.push(el.id);
        }
        disconnect() {}
      }
    );
    render(
      <>
        <SectionIndex
          sections={[
            ['a', 'First'],
            ['b', 'Second'],
          ]}
        />
        <h2 id="a">First section</h2>
        <h2 id="b">Second section</h2>
      </>
    );
    expect(observed).toEqual(['a', 'b']);
    expect(screen.getByRole('button', { name: 'First' }).getAttribute('aria-current')).toBeNull();
    act(() => callback([{ target: document.getElementById('b'), isIntersecting: true }]));
    expect(screen.getByRole('button', { name: 'Second' }).getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('button', { name: 'Second' }).className).toContain('is-active');
    expect(screen.getByRole('button', { name: 'First' }).getAttribute('aria-current')).toBeNull();
    // the first visible section in page order wins
    act(() => callback([{ target: document.getElementById('a'), isIntersecting: true }]));
    expect(screen.getByRole('button', { name: 'First' }).getAttribute('aria-current')).toBe('true');
  });
});

describe('TabRow on a phone', () => {
  it('carries the wrapping class, and the style sheet wraps it below 600 px', () => {
    render(
      <TabRow role="tablist" activeKey="a" className="v2-hub-tabs">
        <button role="tab" className="v2-tab is-active" type="button">
          A
        </button>
      </TabRow>
    );
    const row = screen.getByRole('tablist');
    expect(row.classList.contains('v2-tabs')).toBe(true);
    expect(row.classList.contains('v2-tabs-wrap')).toBe(true);
    expect(row.classList.contains('v2-hub-tabs')).toBe(true);
    expect(dashux).toMatch(/@media \(max-width: 599px\) \{\s*\.v2-tabs\.v2-tabs-wrap \{\s*flex-wrap: wrap;/);
  });
});

describe('Audit log', () => {
  const entry = (id, action, detail = '', actor = 'Ann') => ({
    id,
    action,
    actor,
    detail,
    at: id,
    ago: '1m ago',
  });
  const first = {
    kept: 500,
    hasMore: true,
    actions: [
      { action: 'economy:adjust', count: 3 },
      { action: 'module:starboard', count: 2 },
    ],
    entries: [
      entry(9, 'economy:adjust', `add 330 for ${MEMBER}`),
      entry(8, 'module:starboard', 'settings saved'),
    ],
  };
  const mockOverview = () =>
    useOverview.mockReturnValue({
      data: { groups: [{ title: 'Engagement', cards: [{ id: 'starboard', name: 'Starboard' }] }] },
    });

  it('resolves member ids to names, and shortens an id nobody can name', async () => {
    mockOverview();
    api.getAuditLog.mockResolvedValue({
      ...first,
      hasMore: false,
      entries: [
        entry(9, 'economy:adjust', `add 330 for ${MEMBER}`),
        entry(8, 'economy:adjust', 'add 5 for 800000000000000099'),
      ],
    });
    api.getMemberNames.mockResolvedValue({ names: { [MEMBER]: 'Alice' } });
    renderAtGuild(<AuditLog />, GUILD);
    expect(await screen.findByText(/add 330 for Alice/)).toBeTruthy();
    expect(screen.getByText(/add 5 for member …0099/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\d{17,20}/);
    expect(api.getMemberNames).toHaveBeenCalledWith(GUILD, [MEMBER, '800000000000000099']);
  });

  it('keeps a name that is already in the text, and finds ids in the actor too', () => {
    expect(withNames('add 1 for Alice', new Map())).toBe('add 1 for Alice');
    expect(withNames(`released ${MEMBER}`, new Map([[MEMBER, 'Bob']]))).toBe('released Bob');
    expect(idsInEntries([{ actor: `x ${MEMBER}`, detail: `y ${MEMBER} z 900000000000000011` }])).toEqual([
      MEMBER,
      '900000000000000011',
    ]);
  });

  it('narrows by kind of change through the server, and "Show 50 more" appends the next page', async () => {
    mockOverview();
    api.getMemberNames.mockResolvedValue({ names: {} });
    api.getAuditLog.mockImplementation(async (_g, { action, before } = {}) => {
      if (action === 'module:starboard') {
        return { ...first, hasMore: false, entries: [entry(8, 'module:starboard', 'settings saved')] };
      }
      if (before === 8) return { ...first, hasMore: false, entries: [entry(7, 'settings:server', 'saved')] };
      return first;
    });
    renderAtGuild(<AuditLog />, GUILD);
    await screen.findByText('2 shown, newest first.');
    // the filter lists the kinds with their counts
    const select = screen.getByLabelText('Show');
    expect(within(select).getByRole('option', { name: 'All changes (5)' })).toBeTruthy();
    expect(within(select).getByRole('option', { name: 'Starboard (2)' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Show 50 more' }));
    await screen.findByText('3 shown, newest first.');
    expect(api.getAuditLog).toHaveBeenLastCalledWith(GUILD, { action: '', before: 8 });
    expect(screen.queryByRole('button', { name: 'Show 50 more' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Server settings' })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'module:starboard' } });
    await screen.findByText('1 shown, newest first.');
    expect(api.getAuditLog).toHaveBeenLastCalledWith(GUILD, { action: 'module:starboard' });
    expect(screen.queryByRole('heading', { name: 'Server settings' })).toBeNull();
  });

  it('puts the page under "Members & moderation", like the sidebar group', async () => {
    mockOverview();
    api.getAuditLog.mockResolvedValue({ ...first, hasMore: false, entries: [entry(8, 'module:starboard')] });
    renderAtGuild(<AuditLog />, GUILD);
    const crumbs = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    const link = within(crumbs).getByRole('link', { name: 'Members & moderation' });
    expect(link.getAttribute('href')).toBe(`/guilds/${GUILD}/moderation`);
  });
});

describe('SetupCallout', () => {
  it('names the environment variables to the bot owner only', async () => {
    api.getAccount.mockResolvedValue({ operator: false });
    const { unmount } = render(
      <SetupCallout what="Twitch alerts" keys="Twitch API keys" vars={['TWITCH_CLIENT_ID']} />
    );
    await waitFor(() => expect(api.getAccount).toHaveBeenCalled());
    expect(screen.getByText(/the bot owner needs to add Twitch API keys/)).toBeTruthy();
    expect(screen.queryByText('TWITCH_CLIENT_ID')).toBeNull();
    unmount();
    resetOperatorCache();
    api.getAccount.mockResolvedValue({ operator: true });
    render(<SetupCallout what="Twitch alerts" keys="Twitch API keys" vars={['TWITCH_CLIENT_ID']} />);
    expect(await screen.findByText('TWITCH_CLIENT_ID')).toBeTruthy();
  });
});

describe('Health: module adoption uses the overview icons', () => {
  it('draws an icon from the icon set instead of the emoji', async () => {
    api.getHealth.mockResolvedValue({
      ready: true,
      botTag: 'Sylo',
      version: '5.2.0',
      guildCount: 1,
      memberReach: 10,
      uptime: '1h',
      gatewayPing: 40,
      pingHistory: [],
      stats: { warningsTotal: 0, warningsWeek: 0 },
      modules: [{ name: 'Starboard', icon: '⭐', iconName: 'star', guilds: 2 }],
      lastError: null,
      errors: [],
      db: {
        size: '1 MB',
        wal: null,
        intervalHours: 0,
        retention: 3,
        postgres: false,
        offsite: null,
        backups: [],
      },
    });
    render(<Health />);
    const heading = await screen.findByRole('heading', { name: 'Starboard' });
    expect(heading.textContent).not.toContain('⭐');
    expect(heading.querySelector('svg')).toBeTruthy();
  });
});
