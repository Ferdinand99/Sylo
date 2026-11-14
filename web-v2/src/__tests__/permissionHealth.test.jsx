// The permission and role-hierarchy health check in the dashboard: the wording of the notes under a
// picker, the "Needs attention" items (one per module), a module page's list, and the shared read.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HealthProvider } from '../HealthContext.jsx';
import PickerHealth from '../components/PickerHealth.jsx';
import ChipPicker from '../components/ChipPicker.jsx';
import ModuleHealth from '../components/ModuleHealth.jsx';
import Overview from '../pages/Overview.jsx';
import { attentionItems } from '../overviewModel.js';
import { channelWarning, healthItems, moduleChecks, pickerWarnings, roleWarning } from '../healthModel.js';
import { renderAtGuild } from './routerHarness.jsx';

vi.mock('../api.js', () => ({
  ApiError: class ApiError extends Error {},
  getGuildHealth: vi.fn(),
  setModuleEnabled: vi.fn(),
  setModulesEnabledBulk: vi.fn(),
  getAccount: vi.fn(),
}));
vi.mock('../notify.js', () => ({ notify: vi.fn() }));
vi.mock('../moduleForms/index.js', () => ({ v2Href: (card, guildId) => `/guilds/${guildId}/m/${card.id}` }));
vi.mock('../OverviewContext.jsx', () => ({ useOverview: vi.fn() }));
const { getGuildHealth } = await import('../api.js');
const { useOverview } = await import('../OverviewContext.jsx');

const GUILD = '123456789012345678';
const HIGH = '222222222222222222';
const MANAGED = '222222222222222223';
const CH = '111111111111111111';

const check = (over = {}) => ({
  module: 'verification',
  moduleName: 'Verification',
  severity: 'error',
  code: 'role-above',
  kind: 'role-hierarchy',
  message: "Sylo can't give Verified: Sylo's role is not above it.",
  fix: "In the server's role settings, move Sylo's role above Verified.",
  href: `/v2/guilds/${GUILD}/m/verification`,
  targetId: HIGH,
  ...over,
});

const health = (over = {}) => ({
  available: true,
  summary: { errors: 1, warnings: 0 },
  checks: [check()],
  targets: {
    roles: { blockedAll: null, blocked: { [HIGH]: 'above', [MANAGED]: 'managed' } },
    channels: { blocked: { [CH]: ['Send Messages', 'Embed Links'] } },
  },
  ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
});

describe('the notes under a picker', () => {
  it('says why Sylo cannot give a role, and what to do', () => {
    expect(roleWarning(health(), HIGH)).toBe(
      "Sylo can't give this role: move Sylo's role above it in the server's role settings."
    );
    expect(roleWarning(health(), MANAGED)).toMatch(/managed by an integration/);
    expect(roleWarning(health(), '999999999999999999')).toBeNull();
  });

  it('says what Sylo lacks in a channel', () => {
    expect(channelWarning(health(), CH)).toBe(
      "Sylo can't post in this channel: it is missing Send Messages, Embed Links."
    );
    expect(channelWarning(health(), '999999999999999999')).toBeNull();
  });

  it('warns for every role when Sylo lacks Manage Roles', () => {
    const h = health({
      targets: {
        roles: { blockedAll: "Sylo can't give roles: it is missing Manage Roles.", blocked: {} },
        channels: { blocked: {} },
      },
    });
    expect(roleWarning(h, '999999999999999999')).toMatch(/Manage Roles/);
  });

  it('names each failing pick of a multi-select', () => {
    const items = [
      { id: HIGH, name: 'Verified' },
      { id: MANAGED, name: 'Booster' },
      { id: '5', name: 'Fine' },
    ];
    const out = pickerWarnings(health(), 'role', [HIGH, '5', MANAGED], items);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(/^Verified: Sylo can't give this role/);
    expect(out[1]).toMatch(/^Booster: /);
  });

  it('shows nothing without an answer (an older server, a failed call, no bot in the server)', () => {
    expect(roleWarning(null, HIGH)).toBeNull();
    expect(roleWarning({ available: false, checks: [], targets: null }, HIGH)).toBeNull();
    expect(channelWarning(undefined, CH)).toBeNull();
  });
});

describe('Needs attention', () => {
  it('has one item per module, errors first, with every problem and its fix', () => {
    const h = health({
      checks: [
        check(),
        check({
          code: 'missing-channel-permission',
          message: 'The verification channel (#welcome): Sylo is missing Embed Links.',
          fix: 'Allow Embed Links.',
          targetId: CH,
        }),
        check({
          module: 'logging',
          moduleName: 'Server logging',
          severity: 'warning',
          message: 'Sylo cannot ping Alerts.',
          fix: 'Make it mentionable.',
        }),
      ],
    });
    const items = healthItems(h, GUILD);
    expect(items.map((i) => [i.key, i.severity])).toEqual([
      ['health-verification', 'error'],
      ['health-logging', 'warning'],
    ]);
    expect(items[0].title).toBe("Verification: Sylo can't do everything it needs");
    expect(items[0].detail).toMatch(/And 1 more\.$/);
    expect(items[0].href).toBe(`/guilds/${GUILD}/m/verification`);
    expect(items[0].lines).toHaveLength(2);
    expect(items[1].lines).toHaveLength(1);
  });

  it('adds the items to the attention list, but not for a module that was switched off since', () => {
    const cards = [
      { id: 'verification', name: 'Verification', hasToggle: true, enabled: true, status: 'on' },
      { id: 'logging', name: 'Server logging', hasToggle: true, enabled: false, status: 'off' },
    ];
    const data = {
      groups: [{ title: 'x', cards }],
      attention: {
        health: health({ checks: [check(), check({ module: 'logging', moduleName: 'Server logging' })] }),
      },
    };
    const items = attentionItems(data, GUILD);
    expect(items.map((i) => i.key)).toEqual(['health-verification']);
    expect(items[0].kind).toBe('health');
  });

  it('works with an overview from an older server that has no health', () => {
    expect(attentionItems({ groups: [], attention: { problems: [], waiting: {} } }, GUILD)).toEqual([]);
  });

  it('shows the module with its problems and a Fix link', () => {
    useOverview.mockReturnValue({
      data: {
        guild: { name: 'Hedgerow', icon: null, memberCount: 12 },
        groups: [
          {
            title: 'Moderation',
            cards: [
              {
                id: 'verification',
                name: 'Verification',
                description: 'Gate',
                hasToggle: true,
                enabled: true,
                status: 'on',
                missingIntents: [],
                lines: [],
                summaryParts: ['On'],
              },
            ],
          },
        ],
        attention: {
          platform: 'discord',
          health: health({
            checks: [
              check(),
              check({
                code: 'missing-channel-permission',
                message: 'The verification channel (#welcome): Sylo is missing Embed Links.',
                fix: 'Allow Embed Links.',
              }),
            ],
          }),
        },
        openTickets: 0,
        openAppeals: 0,
      },
      dataGuildId: GUILD,
      error: null,
      setData: vi.fn(),
    });
    renderAtGuild(<Overview />, GUILD);
    expect(screen.getByText("Verification: Sylo can't do everything it needs")).toBeTruthy();
    expect(screen.getByText(/Sylo's role is not above it\./)).toBeTruthy();
    expect(screen.getByText(/The verification channel \(#welcome\)/)).toBeTruthy();
    expect(
      screen.getByRole('link', { name: /^Fix Verification: Sylo can't do everything it needs/ })
    ).toBeTruthy();
  });
});

describe('the shared read', () => {
  it('shows the picker note once the health has loaded, before anything is saved', async () => {
    getGuildHealth.mockResolvedValue(health());
    render(
      <HealthProvider guildId={GUILD}>
        <PickerHealth kind="role" value={HIGH} />
        <PickerHealth kind="role" value="999999999999999999" />
      </HealthProvider>
    );
    expect(await screen.findAllByRole('note')).toHaveLength(1);
    expect(screen.getByRole('note').textContent).toMatch(/move Sylo's role above it/);
    expect(getGuildHealth).toHaveBeenCalledWith(GUILD, { refresh: false });
  });

  it('shows no note while the health is unknown or the call fails', async () => {
    getGuildHealth.mockRejectedValue(new Error('down'));
    render(
      <HealthProvider guildId={GUILD}>
        <PickerHealth kind="channel" value={CH} />
      </HealthProvider>
    );
    await waitFor(() => expect(getGuildHealth).toHaveBeenCalled());
    expect(screen.queryByRole('note')).toBeNull();
    // and with no provider at all
    render(<PickerHealth kind="channel" value={CH} />);
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('warns under a role chip picker only where it is asked to', async () => {
    getGuildHealth.mockResolvedValue(health());
    const items = [{ id: HIGH, name: 'Verified' }];
    render(
      <HealthProvider guildId={GUILD}>
        <ChipPicker kind="role" items={items} value={[HIGH]} onChange={() => {}} health="role" />
        <ChipPicker kind="role" items={items} value={[HIGH]} onChange={() => {}} />
      </HealthProvider>
    );
    await waitFor(() => expect(screen.getAllByRole('note')).toHaveLength(1));
    expect(screen.getByRole('note').textContent).toMatch(/Verified: Sylo can't give this role/);
  });

  it('lists the problems of a module at the top of its page, and "Check again" asks for a fresh look', async () => {
    getGuildHealth.mockResolvedValue(health());
    render(
      <HealthProvider guildId={GUILD}>
        <ModuleHealth moduleId="verification" />
        <ModuleHealth moduleId="logging" />
      </HealthProvider>
    );
    expect(await screen.findByText("Sylo can't do everything this module needs")).toBeTruthy();
    expect(screen.getAllByText("Sylo can't do everything this module needs")).toHaveLength(1);
    expect(moduleChecks(health(), 'logging')).toEqual([]);
    getGuildHealth.mockResolvedValue(health({ checks: [], summary: { errors: 0, warnings: 0 } }));
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(getGuildHealth).toHaveBeenLastCalledWith(GUILD, { refresh: true }));
    await waitFor(() => expect(screen.queryByText("Sylo can't do everything this module needs")).toBeNull());
  });
});
