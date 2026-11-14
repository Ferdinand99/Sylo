import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MemberPicker, { parseMemberIds } from '../components/MemberPicker.jsx';
import ModerationHub from '../pages/ModerationHub.jsx';
import MemberData from '../pages/MemberData.jsx';
import Leveling, { shortMinutes } from '../moduleForms/Leveling.jsx';
import InviteTracker from '../moduleForms/InviteTracker.jsx';
import AutoReact from '../moduleForms/AutoReact.jsx';
import { resetModuleLimits } from '../components/useModuleLimits.js';
import { resetMemberNames } from '../memberNames.js';
import { renderAtGuild } from './routerHarness.jsx';

vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getModuleConfig: vi.fn(),
  saveModuleConfig: vi.fn(),
  getModuleLimits: vi.fn(),
  searchMembers: vi.fn(),
  getMemberNames: vi.fn(),
  getModeration: vi.fn(),
  warnMember: vi.fn(),
  clearMemberWarnings: vi.fn(),
  setCaseDeleted: vi.fn(),
  editCaseReason: vi.fn(),
  getPlatformInfo: vi.fn(),
  getMemberData: vi.fn(),
  setInviteBonus: vi.fn(),
  apiFetch: vi.fn(),
}));
vi.mock('../notify.js', () => ({ notify: vi.fn() }));
vi.mock('../components/ConfirmDialog.jsx', () => ({ confirmDialog: vi.fn().mockResolvedValue(true) }));
const api = await import('../api.js');
const { confirmDialog } = await import('../components/ConfirmDialog.jsx');

const GUILD = '123456789012345678';
const MARA = '300000000000000041';
const MARLIN = '300000000000000042';
const THIRD = '300000000000000043';

beforeEach(() => {
  vi.resetAllMocks();
  resetModuleLimits();
  resetMemberNames();
  confirmDialog.mockResolvedValue(true);
  api.getModuleLimits.mockResolvedValue({ _embed: {} });
  api.searchMembers.mockResolvedValue({ members: [] });
  api.getMemberNames.mockResolvedValue({ names: {} });
  api.getPlatformInfo.mockResolvedValue({ platform: 'discord', capabilities: {} });
});

const pickByPaste = async (field, id) => {
  fireEvent.change(field, { target: { value: id } });
  fireEvent.mouseDown(await screen.findByRole('option', { name: `Use the member id ${id}` }));
};

describe('parseMemberIds', () => {
  it('reads bare ids and mentions, in order and once each', () => {
    expect(parseMemberIds(MARA)).toEqual([MARA]);
    expect(parseMemberIds(`<@${MARA}>`)).toEqual([MARA]);
    expect(parseMemberIds(`<@!${MARA}>`)).toEqual([MARA]);
    expect(parseMemberIds(`${MARA}, <@${MARLIN}> ${MARA}\n${THIRD}`)).toEqual([MARA, MARLIN, THIRD]);
  });

  it('says nothing for a name or for an id with words around it', () => {
    expect(parseMemberIds('')).toEqual([]);
    expect(parseMemberIds('mara')).toEqual([]);
    expect(parseMemberIds(`mara ${MARA}`)).toEqual([]);
    expect(parseMemberIds('12345')).toEqual([]);
  });
});

describe('MemberPicker, single', () => {
  const Host = ({ changes }) => {
    const [id, setId] = useState('');
    return (
      <MemberPicker
        id="m"
        label="Member"
        value={id}
        onChange={(v) => {
          changes.push(v);
          setId(v);
        }}
      />
    );
  };
  const inGuild = (ui) =>
    render(
      <MemberRouter>
        <Routes>
          <Route path="/guilds/:guildId" element={ui} />
        </Routes>
      </MemberRouter>
    );
  const MemberRouter = ({ children }) => (
    <MemoryRouter initialEntries={[`/guilds/${GUILD}`]}>{children}</MemoryRouter>
  );

  it('takes a pasted <@id> mention as the member', async () => {
    const changes = [];
    inGuild(<Host changes={changes} />);
    const field = screen.getByLabelText('Member');
    fireEvent.change(field, { target: { value: `<@${MARA}>` } });
    expect(api.searchMembers).not.toHaveBeenCalled();
    fireEvent.mouseDown(await screen.findByRole('option', { name: `Use the member id ${MARA}` }));
    expect(changes).toEqual([MARA]);
  });

  it('names what the clear button clears', async () => {
    api.searchMembers.mockResolvedValue({ members: [{ id: MARA, name: 'Mara', username: 'mara' }] });
    function Named() {
      const [id, setId] = useState(MARA);
      return <MemberPicker id="m" value={id} onChange={setId} clearLabel="Choose another member" />;
    }
    inGuild(<Named />);
    expect(screen.getByRole('button', { name: /Choose another member/ })).toBeTruthy();
  });
});

describe('MemberPicker, several members', () => {
  function Host({ changes, max }) {
    const [ids, setIds] = useState([]);
    return (
      <MemoryRouter initialEntries={[`/guilds/${GUILD}`]}>
        <Routes>
          <Route
            path="/guilds/:guildId"
            element={
              <MemberPicker
                multiple
                id="m"
                label="Members"
                max={max}
                value={ids}
                onChange={(v) => {
                  changes.push(v);
                  setIds(v);
                }}
              />
            }
          />
        </Routes>
      </MemoryRouter>
    );
  }

  it('adds members as chips in the order they are picked, and removes one by its button', async () => {
    api.searchMembers.mockResolvedValue({
      members: [
        { id: MARA, name: 'Mara', username: 'mara' },
        { id: MARLIN, name: 'Marlin', username: 'marlin' },
      ],
    });
    const changes = [];
    render(<Host changes={changes} />);
    const field = screen.getByLabelText('Members');
    fireEvent.change(field, { target: { value: 'mar' } });
    fireEvent.mouseDown(await screen.findByRole('option', { name: /Marlin/ }));
    expect(changes.at(-1)).toEqual([MARLIN]);
    // the field stays for the next member, and the one already chosen is no longer offered
    fireEvent.change(screen.getByLabelText('Members'), { target: { value: 'mar' } });
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['@Mara mara']);
    fireEvent.mouseDown(options[0]);
    expect(changes.at(-1)).toEqual([MARLIN, MARA]);
    const chips = within(screen.getByRole('list', { name: 'Chosen members' })).getAllByRole('listitem');
    expect(chips.map((c) => c.textContent)).toEqual(['@Marlin×', '@Mara×']);

    fireEvent.click(screen.getByRole('button', { name: 'Remove Marlin' }));
    expect(changes.at(-1)).toEqual([MARA]);
    expect(screen.queryByRole('button', { name: 'Remove Marlin' })).toBeNull();
  });

  it('adds several pasted ids and mentions in one go, skipping ones already there', async () => {
    const changes = [];
    render(<Host changes={changes} />);
    fireEvent.change(screen.getByLabelText('Members'), { target: { value: `${MARA}, <@${MARLIN}> ${THIRD}` } });
    fireEvent.mouseDown(await screen.findByRole('option', { name: 'Add 3 members' }));
    expect(changes.at(-1)).toEqual([MARA, MARLIN, THIRD]);
    fireEvent.change(screen.getByLabelText('Members'), { target: { value: `${MARA} ${MARLIN}` } });
    expect(screen.queryByRole('option')).toBeNull();
  });

  it('takes the last chip back on Backspace in an empty field, and stops at max', async () => {
    const changes = [];
    render(<Host changes={changes} max={2} />);
    const field = screen.getByLabelText('Members');
    await pickByPaste(field, MARA);
    await pickByPaste(screen.getByLabelText('Members'), MARLIN);
    expect(changes.at(-1)).toEqual([MARA, MARLIN]);
    const full = screen.getByLabelText('Members');
    expect(full.disabled).toBe(true);
    expect(full.placeholder).toBe('At most 2 members');
    fireEvent.click(screen.getByRole('button', { name: 'Remove member …0042' }));
    fireEvent.keyDown(screen.getByLabelText('Members'), { key: 'Backspace' });
    expect(changes.at(-1)).toEqual([]);
  });
});

describe('Moderation: warn a member', () => {
  const kase = (over = {}) => ({
    caseNumber: 4,
    user: 'Alice',
    action: 'warn',
    active: true,
    reason: 'Spam',
    detail: null,
    moderator: 'Bob',
    at: Date.UTC(2030, 0, 5),
    ago: '1d ago',
    ...over,
  });
  const moderation = (cases = [kase()]) => ({
    cases,
    caseTotal: cases.length,
    bans: [],
    bansTotal: 0,
    banLimit: 50,
    bansError: null,
    tempBans: [],
    channelLocks: [],
    lockdownActive: false,
  });
  const renderHub = () => renderAtGuild(<ModerationHub />, GUILD);

  it('keeps Warn disabled until a member is picked, then sends that member id', async () => {
    api.getModeration.mockResolvedValue(moderation());
    api.warnMember.mockResolvedValue({ warnings: 2, dmDelivered: true });
    renderHub();
    const field = await screen.findByLabelText('Member');
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'Spamming' } });
    expect(screen.getByRole('button', { name: 'Warn' }).disabled).toBe(true);
    await pickByPaste(field, MARA);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Warn' }).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Warn' }));
    await waitFor(() => expect(api.warnMember).toHaveBeenCalledWith(GUILD, MARA, 'Spamming'));
  });

  it('shows "Clear their warnings" only once a member is picked, and asks before clearing', async () => {
    api.getModeration.mockResolvedValue(moderation());
    api.clearMemberWarnings.mockResolvedValue({ removed: 1 });
    renderHub();
    const field = await screen.findByLabelText('Member');
    expect(screen.queryByRole('button', { name: 'Clear their warnings' })).toBeNull();
    // a pasted mention picks the member too
    fireEvent.change(field, { target: { value: `<@${MARA}>` } });
    fireEvent.mouseDown(await screen.findByRole('option', { name: `Use the member id ${MARA}` }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear their warnings' }));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalled());
    await waitFor(() => expect(api.clearMemberWarnings).toHaveBeenCalledWith(GUILD, MARA));
  });

  it('gives a case Edit reason and a menu with Delete, and the menu runs the delete', async () => {
    api.getModeration.mockResolvedValue(moderation());
    api.setCaseDeleted.mockResolvedValue({});
    renderHub();
    expect(await screen.findByRole('button', { name: 'Edit reason' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More actions for case #4' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    await waitFor(() => expect(api.setCaseDeleted).toHaveBeenCalledWith(GUILD, 4, true));
  });

  it('puts Restore in the menu of a deleted case', async () => {
    api.getModeration.mockResolvedValue(moderation([kase({ active: false })]));
    renderHub();
    fireEvent.click(await screen.findByRole('button', { name: 'More actions for case #4' }));
    expect(screen.getByRole('menuitem', { name: 'Restore' })).toBeTruthy();
  });

  it('wraps the hub tabs below 600 px through its own class', async () => {
    api.getModeration.mockResolvedValue(moderation());
    renderHub();
    const tabs = (await screen.findAllByRole('tablist'))[0];
    expect(tabs.classList.contains('v2-hub-tabs-wrap')).toBe(true);
  });
});

describe('Member data', () => {
  const lookup = {
    lookup: {
      profile: { id: MARA, tag: 'mara', avatar: null },
      data: { total: 0, items: [] },
    },
  };
  function renderAt(search = '') {
    return render(
      <MemoryRouter initialEntries={[`/guilds/${GUILD}/member-data${search}`]}>
        <Routes>
          <Route path="/guilds/:guildId/member-data" element={<MemberData />} />
          <Route path="/guilds/:guildId/moderation" element={<p>moderation page</p>} />
        </Routes>
      </MemoryRouter>
    );
  }

  it('looks the picked member up by id', async () => {
    api.getMemberData.mockResolvedValue({ lookup: null });
    renderAt();
    await pickByPaste(await screen.findByLabelText('Member'), MARA);
    await waitFor(() => expect(api.getMemberData).toHaveBeenLastCalledWith(GUILD, MARA));
  });

  it('shows the member of an older link that carries an @mention', async () => {
    api.getMemberData.mockResolvedValue(lookup);
    renderAt(`?user=${encodeURIComponent(`<@${MARA}>`)}`);
    expect((await screen.findByLabelText('Member')).textContent).toContain('@member …0041');
  });

  it('files itself under the sidebar group in the breadcrumb', async () => {
    api.getMemberData.mockResolvedValue({ lookup: null });
    renderAt();
    const crumb = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    const link = within(crumb).getByRole('link', { name: 'Members & moderation' });
    expect(link.getAttribute('href')).toBe(`/guilds/${GUILD}/moderation`);
    expect(within(crumb).queryByText('Settings')).toBeNull();
  });
});

describe('Leveling: set XP', () => {
  const rows = [
    { rank: 1, name: 'Mara', level: 3, xp: 400, voiceXp: 150, voiceMinutes: 150, messages: 1 },
    { rank: 2, name: 'Marlin', level: 2, xp: 200, voiceXp: 0, voiceMinutes: 0, messages: 12 },
  ];
  beforeEach(() => {
    api.getModuleConfig.mockResolvedValue({
      config: {
        announce: 'off',
        announceChannel: '',
        announceMessage: '',
        cooldownSeconds: 60,
        stackRewards: true,
        rewards: [],
        removeRewardsOnXpLoss: false,
        xpRate: 1,
        voiceXpEnabled: false,
        voiceXpPerMin: 5,
        voiceAfkExcluded: true,
        multipliers: [],
        noXpRolesMode: 'allow',
        noXpRoles: [],
        noXpChannelsMode: 'allow',
        noXpChannels: [],
      },
      announceModes: ['channel', 'off'],
      channels: [],
      roles: [],
      xpRates: [0.5, 1, 1.5],
      board: { total: 2, rows },
    });
    api.apiFetch.mockResolvedValue({});
  });

  it('sends the picked member id and the XP, and the button waits for both', async () => {
    renderAtGuild(<Leveling />, GUILD);
    const update = await screen.findByRole('button', { name: 'Update' });
    expect(update.disabled).toBe(true);
    await pickByPaste(screen.getByLabelText('Member'), MARA);
    expect(screen.getByRole('button', { name: 'Update' }).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('New XP total'), { target: { value: '500' } });
    expect(screen.getByRole('button', { name: 'Update' }).disabled).toBe(false);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    });
    expect(api.apiFetch).toHaveBeenCalledTimes(1);
    const [path, init] = api.apiFetch.mock.calls[0];
    expect(path).toBe(`/api/v2/guilds/${GUILD}/modules/leveling/xp`);
    expect(JSON.parse(init.body)).toEqual({ userId: MARA, xp: 500 });
  });

  it('has a jump list to its sections, with a target for each', async () => {
    const { container } = renderAtGuild(<Leveling />, GUILD);
    const nav = await screen.findByRole('navigation', { name: 'On this page' });
    const pills = within(nav).getAllByRole('button');
    expect(pills.map((p) => p.textContent)).toEqual([
      'Leveling up',
      'Role rewards',
      'XP rate',
      'Voice',
      'Multipliers',
      'XP by role',
      'XP by channel',
      'Leaderboard',
      'Set XP',
      'Danger zone',
    ]);
    for (const id of ['lvl-up', 'lvl-rewards', 'lvl-rate', 'lvl-voice', 'lvl-multipliers', 'lvl-by-role', 'lvl-by-channel', 'lvl-board', 'lvl-set-xp', 'lvl-danger']) {
      expect(container.querySelector(`#${id}`), id).not.toBeNull();
    }
  });

  it('says "1 message" and writes the voice time as hours and minutes', async () => {
    renderAtGuild(<Leveling />, GUILD);
    expect(await screen.findByText(/1 message(?!s)/)).toBeTruthy();
    expect(screen.getByText(/12 messages/)).toBeTruthy();
    expect(screen.getByText(/150 voice XP \(2h 30m\)/)).toBeTruthy();
    expect(shortMinutes(45)).toBe('45m');
    expect(shortMinutes(180)).toBe('3h');
    expect(shortMinutes(150)).toBe('2h 30m');
  });
});

describe('Invite tracker: adjust bonus invites', () => {
  it('sends the picked member id, and the button waits for a member', async () => {
    api.getModuleConfig.mockResolvedValue({
      config: { graceHours: 6, joinLogChannelId: '' },
      channels: [],
      board: { canReadInvites: true, total: 0, rows: [] },
    });
    api.setInviteBonus.mockResolvedValue({ board: { canReadInvites: true, total: 0, rows: [] } });
    renderAtGuild(<InviteTracker />, GUILD);
    expect((await screen.findByRole('button', { name: 'Set bonus' })).disabled).toBe(true);
    await pickByPaste(screen.getByLabelText('Member'), MARA);
    fireEvent.change(screen.getByLabelText('Bonus invites'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set bonus' }));
    await waitFor(() => expect(api.setInviteBonus).toHaveBeenCalledWith(GUILD, MARA, 3));
  });
});

describe('Auto-react: target users', () => {
  const config = (users) => ({
    config: {
      cooldownSeconds: 5,
      logChannelId: '',
      rules: [{ targetUsers: users, targetRoles: [], channelId: '', emojis: ['🧟'], mode: 'always', chance: 50 }],
    },
    channels: [],
    roles: [{ id: '900000000000000001', name: 'Infected' }],
    modes: ['always', 'random'],
    roleActions: ['add', 'remove'],
  });

  it('round-trips an existing id list in order, and saves the ids as one text', async () => {
    api.getModuleConfig.mockResolvedValue(config([MARLIN, MARA]));
    api.getMemberNames.mockResolvedValue({ names: { [MARLIN]: 'Marlin', [MARA]: 'Mara' } });
    api.saveModuleConfig.mockImplementation(async (_g, _id, body) => ({ config: body }));
    renderAtGuild(<AutoReact />, GUILD);
    const list = await screen.findByRole('list', { name: 'Chosen members' });
    await waitFor(() =>
      expect(within(list).getAllByRole('listitem').map((c) => c.textContent)).toEqual(['@Marlin×', '@Mara×'])
    );
    // nothing was touched, so there is nothing to save
    expect(screen.getByRole('button', { name: 'Save' }).disabled).toBe(true);

    await pickByPaste(screen.getByLabelText(/Target users/), THIRD);
    const save = screen.getByRole('button', { name: 'Save' });
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(api.saveModuleConfig).toHaveBeenCalledTimes(1));
    const [, , body] = api.saveModuleConfig.mock.calls[0];
    expect(body.rules[0].targetUsersText).toBe(`${MARLIN} ${MARA} ${THIRD}`);
  });

  it('removes a member from the rule with the chip button', async () => {
    api.getModuleConfig.mockResolvedValue(config([MARA, MARLIN]));
    api.getMemberNames.mockResolvedValue({ names: { [MARA]: 'Mara', [MARLIN]: 'Marlin' } });
    api.saveModuleConfig.mockImplementation(async (_g, _id, body) => ({ config: body }));
    renderAtGuild(<AutoReact />, GUILD);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Mara' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.saveModuleConfig).toHaveBeenCalledTimes(1));
    expect(api.saveModuleConfig.mock.calls[0][2].rules[0].targetUsersText).toBe(MARLIN);
  });

  it('warns about a rule with neither users nor a role, and names a rule after its target', async () => {
    api.getModuleConfig.mockResolvedValue(config([]));
    renderAtGuild(<AutoReact />, GUILD);
    expect(await screen.findByText(/will be removed when you save/)).toBeTruthy();
    expect(document.querySelector('.v2-rule-title').textContent).toBe('🧟');
    fireEvent.change(screen.getByLabelText(/Target role/), { target: { value: '900000000000000001' } });
    expect(document.querySelector('.v2-rule-title').textContent).toBe('@Infected → 🧟');
    expect(screen.queryByText(/will be removed when you save/)).toBeNull();
  });
});
