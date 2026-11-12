import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Economy from '../moduleForms/Economy.jsx';
import { resetModuleLimits } from '../components/useModuleLimits.js';
import { renderAtGuild } from './routerHarness.jsx';

vi.mock('../api.js', () => ({
  ApiError: class ApiError extends Error {},
  getModuleConfig: vi.fn(),
  saveModuleConfig: vi.fn(),
  getModuleLimits: vi.fn(),
  getEconomyMembers: vi.fn(),
  getEconomyMember: vi.fn(),
  adjustEconomyMember: vi.fn(),
  resetEconomy: vi.fn(),
}));
vi.mock('../notify.js', () => ({ notify: vi.fn() }));
vi.mock('../components/ConfirmDialog.jsx', () => ({ confirmDialog: vi.fn().mockResolvedValue(true) }));
const {
  getModuleConfig,
  saveModuleConfig,
  getModuleLimits,
  getEconomyMembers,
  getEconomyMember,
  adjustEconomyMember,
  resetEconomy,
} = await import('../api.js');
const { confirmDialog } = await import('../components/ConfirmDialog.jsx');
const { notify } = await import('../notify.js');

const GUILD = '123456789012345678';
const ALICE = '111111111111111111';
const BOB = '222222222222222222';

// What GET /api/v2/modules/limits answers for the economy module (src/modules/lib/economyConfig.js, LIMITS).
const limits = {
  economy: {
    currencyName: { maxLength: 20 },
    currencyEmoji: { maxLength: 64 },
    messageMin: { min: 1, max: 1000 },
    messageMax: { min: 1, max: 1000 },
    payTaxPercent: { min: 0, max: 50 },
    robChancePercent: { min: 1, max: 99 },
    amount: { min: 0, max: 1_000_000_000 },
    reason: { maxLength: 200 },
  },
  _embed: {},
};

const config = {
  currencyName: 'coins',
  currencyEmoji: '🪙',
  messageEnabled: true,
  messageMin: 5,
  messageMax: 15,
  messageCooldownSeconds: 60,
  messageMinLength: 3,
  ignoredChannels: [],
  ignoredRoles: [],
  voiceEnabled: false,
  voiceAmount: 10,
  dailyBase: 100,
  dailyStreakBonus: 10,
  workMin: 50,
  workMax: 150,
  workCooldownMinutes: 60,
  bankEnabled: true,
  payEnabled: true,
  payTaxPercent: 0,
  robEnabled: false,
  robChancePercent: 40,
  robMinPercent: 10,
  robMaxPercent: 30,
  robFinePercent: 10,
  robFineMin: 25,
  robCooldownHours: 4,
  robVictimMinCash: 100,
  robNewMemberHours: 24,
  robProtectionMinutes: 60,
  startingBalance: 0,
  publicLeaderboard: true,
  logChannelId: '',
};

const person = (id, name, inServer = true) => ({ id, name, inServer });
const row = (id, name, cash, bank) => ({
  userId: id,
  member: person(id, name),
  cash,
  bank,
  total: cash + bank,
  dailyStreak: 0,
  hasAccount: true,
});
const page = (rows, over = {}) => ({
  search: false,
  sort: 'total',
  dir: 'desc',
  page: 1,
  pages: 1,
  total: rows.length,
  rows,
  ...over,
});
const detail = (over = {}) => ({
  member: person(ALICE, 'Alice'),
  account: { cash: 100, bank: 50, total: 150, dailyStreak: 3, hasAccount: true },
  transactionCount: 2,
  transactions: [
    {
      id: 2,
      kind: 'staff_add',
      amount: 50,
      cashAfter: 100,
      bankAfter: 50,
      counterparty: null,
      actor: person(BOB, 'Bob'),
      reason: 'prize',
      createdAt: Date.UTC(2030, 0, 5, 12, 30),
    },
    {
      id: 1,
      kind: 'pay_in',
      amount: 100,
      cashAfter: 50,
      bankAfter: 50,
      counterparty: person(BOB, 'Bob'),
      actor: null,
      reason: '',
      createdAt: Date.UTC(2030, 0, 4, 12, 30),
    },
  ],
  ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  confirmDialog.mockResolvedValue(true);
  resetModuleLimits();
  getModuleLimits.mockResolvedValue(limits);
  getModuleConfig.mockResolvedValue({
    config,
    channels: [{ id: '555555555555555551', name: 'staff-log' }],
    roles: [{ id: '666666666666666661', name: 'Muted' }],
    maxBalance: 1_000_000_000,
    messageLengthChecked: true,
  });
  getEconomyMembers.mockResolvedValue(page([row(ALICE, 'Alice', 100, 50), row(BOB, 'Bob', 30, 0)]));
  getEconomyMember.mockResolvedValue(detail());
});

const openMembers = async () => {
  renderAtGuild(<Economy />, GUILD);
  await screen.findByRole('heading', { name: 'Economy' });
  fireEvent.click(screen.getByRole('tab', { name: 'Members' }));
};

describe('Economy settings', () => {
  it('shows every setting with its default and reads the limits from the server', async () => {
    renderAtGuild(<Economy />, GUILD);
    expect(await screen.findByRole('heading', { name: 'Economy' })).toBeTruthy();
    expect(screen.getByLabelText('Name').value).toBe('coins');
    expect(screen.getByLabelText('Emoji').value).toBe('🪙');
    expect(screen.getByLabelText('Starting balance').value).toBe('0');
    expect(screen.getByLabelText('Daily reward').value).toBe('100');
    expect(screen.getByLabelText('Work pays at most').value).toBe('150');
    expect(screen.getByLabelText('Payment tax').value).toBe('0');
    await waitFor(() => expect(screen.getByLabelText('Name').maxLength).toBe(20));
    expect(screen.getByLabelText('Chance to succeed').max).toBe('99');
    expect(screen.getByLabelText('Payment tax').max).toBe('50');
  });

  it('says so when the host cannot apply the shortest-message rule (no Message Content intent), and not otherwise', async () => {
    const { unmount } = renderAtGuild(<Economy />, GUILD);
    await screen.findByLabelText('Shortest message that counts');
    expect(screen.queryByText('The shortest-message rule is not applied')).toBeNull();
    unmount();

    getModuleConfig.mockResolvedValue({
      config,
      channels: [],
      roles: [],
      maxBalance: 1_000_000_000,
      messageLengthChecked: false,
    });
    renderAtGuild(<Economy />, GUILD);
    expect(await screen.findByText('The shortest-message rule is not applied')).toBeTruthy();
    expect(screen.getByText(/does not have the Message Content intent/)).toBeTruthy();
  });

  it('warns that robbing is off by default and has it unchecked', async () => {
    renderAtGuild(<Economy />, GUILD);
    expect(await screen.findByText('Robbing is off by default')).toBeTruthy();
    expect(screen.getByLabelText('Members can rob each other').checked).toBe(false);
    expect(screen.getByLabelText('Members earn money by being in voice').checked).toBe(false);
    expect(screen.getByLabelText('The bank is on').checked).toBe(true);
  });

  it('saves the changed settings through the standard config call', async () => {
    saveModuleConfig.mockResolvedValue({ config: { ...config, currencyName: 'gold', robEnabled: true } });
    renderAtGuild(<Economy />, GUILD);
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'gold' } });
    fireEvent.click(screen.getByLabelText('Members can rob each other'));
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(saveModuleConfig).toHaveBeenCalledWith(
        GUILD,
        'economy',
        expect.objectContaining({ currencyName: 'gold', robEnabled: true, dailyBase: 100 })
      )
    );
  });

  it('resets the whole economy only after the typed confirmation', async () => {
    resetEconomy.mockResolvedValue({ ok: true, accounts: 12 });
    renderAtGuild(<Economy />, GUILD);
    fireEvent.click(await screen.findByRole('button', { name: /Reset the whole economy/ }));
    await waitFor(() => expect(resetEconomy).toHaveBeenCalledWith(GUILD, 'RESET'));
    expect(confirmDialog).toHaveBeenCalledWith(expect.objectContaining({ typeToConfirm: 'RESET' }));
    expect(notify).toHaveBeenCalledWith('The economy was reset: 12 account(s).', 'info');

    resetEconomy.mockClear();
    confirmDialog.mockResolvedValue(false);
    fireEvent.click(screen.getByRole('button', { name: /Reset the whole economy/ }));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(2));
    expect(resetEconomy).not.toHaveBeenCalled();
  });
});

describe('Economy members', () => {
  it('lists the members with an account, sorted by total, with cash and bank', async () => {
    await openMembers();
    expect(await screen.findByRole('heading', { name: 'Members with an account (2)' })).toBeTruthy();
    const alice = screen.getByText('Alice').closest('.v2-row-main');
    expect(alice.textContent).toContain('Total 🪙 150 coins');
    expect(alice.textContent).toContain('cash 100');
    expect(alice.textContent).toContain('bank 50');
    expect(getEconomyMembers).toHaveBeenCalledWith(GUILD, { q: '', sort: 'total', dir: 'desc', page: 1 });
  });

  it('sorts by cash or bank, in either direction, and starts again from page 1', async () => {
    await openMembers();
    await screen.findByText('Alice');
    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'bank' } });
    await waitFor(() =>
      expect(getEconomyMembers).toHaveBeenLastCalledWith(GUILD, { q: '', sort: 'bank', dir: 'desc', page: 1 })
    );
    fireEvent.change(screen.getByLabelText('Order'), { target: { value: 'asc' } });
    await waitFor(() =>
      expect(getEconomyMembers).toHaveBeenLastCalledWith(GUILD, { q: '', sort: 'bank', dir: 'asc', page: 1 })
    );
  });

  it('pages through the list', async () => {
    getEconomyMembers.mockResolvedValue(
      page([row(ALICE, 'Alice', 100, 50)], { page: 1, pages: 3, total: 60 })
    );
    await openMembers();
    await screen.findByText('Page 1 of 3');
    expect(screen.getByRole('button', { name: 'Previous' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(getEconomyMembers).toHaveBeenLastCalledWith(GUILD, {
        q: '',
        sort: 'total',
        dir: 'desc',
        page: 2,
      })
    );
  });

  it('searches by name', async () => {
    await openMembers();
    await screen.findByText('Alice');
    getEconomyMembers.mockResolvedValue(
      page([{ ...row(BOB, 'Bob', 0, 0), hasAccount: false }], { search: true, total: 1 })
    );
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'bo' } });
    await waitFor(() =>
      expect(getEconomyMembers).toHaveBeenLastCalledWith(GUILD, {
        q: 'bo',
        sort: 'total',
        dir: 'desc',
        page: 1,
      })
    );
    expect(await screen.findByText(/no account yet/)).toBeTruthy();
    expect(screen.queryByText('Alice')).toBeNull();
  });

  it('opens a member with the balances and the ledger', async () => {
    await openMembers();
    fireEvent.click((await screen.findAllByRole('button', { name: 'Manage' }))[0]);
    expect(await screen.findByRole('heading', { name: 'Latest transactions' })).toBeTruthy();
    expect(getEconomyMember).toHaveBeenCalledWith(GUILD, ALICE);
    expect(screen.getByText('Staff added')).toBeTruthy();
    expect(screen.getByText('Payment received')).toBeTruthy();
    const ledger = screen.getByText('Staff added').closest('.v2-row-main');
    expect(ledger.textContent).toContain('+50');
    expect(ledger.textContent).toContain('cash 100 · bank 50 after');
    expect(ledger.textContent).toContain('by Bob');
    expect(ledger.textContent).toContain('prize');
    expect(screen.getByText('Payment received').closest('.v2-row-main').textContent).toContain('with Bob');
    expect(screen.getByText(/3 day streak/)).toBeTruthy();
  });

  it('adds, removes and sets money with a reason through the one adjust call', async () => {
    adjustEconomyMember.mockResolvedValue({
      ...detail(),
      summary: 'Now 🪙 150 coins in cash and 🪙 50 coins in the bank.',
    });
    await openMembers();
    fireEvent.click((await screen.findAllByRole('button', { name: 'Manage' }))[0]);
    await screen.findByRole('heading', { name: 'Latest transactions' });

    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '50' } });
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'prize' } });
    await waitFor(() => expect(screen.getByLabelText(/Reason/).maxLength).toBe(200));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(adjustEconomyMember).toHaveBeenCalledWith(GUILD, ALICE, {
        action: 'add',
        amount: 50,
        reason: 'prize',
      })
    );
    expect(notify).toHaveBeenCalledWith('Now 🪙 150 coins in cash and 🪙 50 coins in the bank.', 'info');
    // the list is fetched again after a change
    await waitFor(() => expect(getEconomyMembers.mock.calls.length).toBeGreaterThan(1));

    fireEvent.change(screen.getByLabelText('Change'), { target: { value: 'remove' } });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(adjustEconomyMember).toHaveBeenLastCalledWith(GUILD, ALICE, {
        action: 'remove',
        amount: 10,
        reason: '',
      })
    );

    fireEvent.change(screen.getByLabelText('Change'), { target: { value: 'set' } });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(adjustEconomyMember).toHaveBeenLastCalledWith(GUILD, ALICE, {
        action: 'set',
        amount: 0,
        reason: '',
      })
    );
  });

  it('resets one member after a confirmation, without an amount', async () => {
    adjustEconomyMember.mockResolvedValue({
      ...detail(),
      summary: 'Now 🪙 0 coins in cash and 🪙 0 coins in the bank.',
    });
    await openMembers();
    fireEvent.click((await screen.findAllByRole('button', { name: 'Manage' }))[0]);
    await screen.findByRole('heading', { name: 'Latest transactions' });
    fireEvent.change(screen.getByLabelText('Change'), { target: { value: 'reset-user' } });
    expect(screen.queryByLabelText('Amount')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(adjustEconomyMember).toHaveBeenCalledWith(GUILD, ALICE, {
        action: 'reset-user',
        amount: 0,
        reason: '',
      })
    );
    expect(confirmDialog).toHaveBeenCalledWith(expect.objectContaining({ title: 'Reset Alice?' }));
  });

  it('keeps the form and tells why when the server refuses a change', async () => {
    adjustEconomyMember.mockRejectedValue(new Error('That member does not have that much.'));
    await openMembers();
    fireEvent.click((await screen.findAllByRole('button', { name: 'Manage' }))[0]);
    await screen.findByRole('heading', { name: 'Latest transactions' });
    fireEvent.change(screen.getByLabelText('Change'), { target: { value: 'remove' } });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '999' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith('That member does not have that much.'));
    expect(screen.getByLabelText('Amount').value).toBe('999');
  });

  it('keeps the Apply button off until an amount is typed', async () => {
    await openMembers();
    fireEvent.click((await screen.findAllByRole('button', { name: 'Manage' }))[0]);
    await screen.findByRole('heading', { name: 'Latest transactions' });
    expect(screen.getByRole('button', { name: 'Apply' }).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '5' } });
    expect(screen.getByRole('button', { name: 'Apply' }).disabled).toBe(false);
  });

  it('shows a member who has no account yet, and one who left the server', async () => {
    getEconomyMember.mockResolvedValue(
      detail({
        member: person(ALICE, 'Alice', false),
        account: { cash: 0, bank: 0, total: 0, dailyStreak: 0, hasAccount: false },
        transactionCount: 0,
        transactions: [],
      })
    );
    await openMembers();
    fireEvent.click((await screen.findAllByRole('button', { name: 'Manage' }))[0]);
    const heading = await screen.findByRole('heading', { name: 'Alice', level: 2 });
    const panel = heading.closest('.v2-group');
    expect(within(panel).getByText(/No account yet/)).toBeTruthy();
    expect(within(panel).getByText(/Not in the server/)).toBeTruthy();
    expect(within(panel).getByText('No transactions in the last 180 days.')).toBeTruthy();
  });
});
