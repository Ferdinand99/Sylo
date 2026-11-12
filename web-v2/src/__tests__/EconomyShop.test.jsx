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
  getShopItems: vi.fn(),
  createShopItem: vi.fn(),
  updateShopItem: vi.fn(),
  setShopItemEnabled: vi.fn(),
  reorderShopItems: vi.fn(),
  deleteShopItem: vi.fn(),
  grantShopItem: vi.fn(),
  actOnInventoryRow: vi.fn(),
  getShopActivity: vi.fn(),
}));
vi.mock('../notify.js', () => ({ notify: vi.fn() }));
vi.mock('../components/ConfirmDialog.jsx', () => ({ confirmDialog: vi.fn().mockResolvedValue(true) }));
const api = await import('../api.js');
const { confirmDialog } = await import('../components/ConfirmDialog.jsx');
const { notify } = await import('../notify.js');

const GUILD = '123456789012345678';
const ALICE = '111111111111111111';
const ROLE = '555555555555555551';

const limits = {
  economy: {
    currencyName: { maxLength: 20 },
    itemName: { maxLength: 60 },
    itemDescription: { maxLength: 300 },
    itemEmoji: { maxLength: 64 },
    itemPrice: { min: 1, max: 1_000_000_000 },
    itemStock: { min: 0, max: 1_000_000 },
    itemDurationHours: { min: 1, max: 8760 },
    itemPerMemberLimit: { min: 1, max: 1000 },
    reason: { maxLength: 200 },
    amount: { min: 0, max: 1_000_000_000 },
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
  webShop: false,
  shopChannelId: '',
};

const item = (over = {}) => ({
  id: 1,
  name: 'Shout-out',
  description: 'On stream',
  emoji: '',
  type: 'custom',
  roleId: null,
  durationHours: null,
  price: 100,
  stock: 5,
  sold: 2,
  left: 3,
  requiredRoles: [],
  perMemberLimit: null,
  enabled: true,
  sortOrder: 0,
  purchases: 2,
  revenue: 200,
  ...over,
});
const shopData = (items) => ({
  items,
  roles: [{ id: ROLE, name: 'Millionaire' }],
  channels: [],
  maxItems: 100,
});
const person = (id, name) => ({ id, name, inServer: true });
const invRow = (over = {}) => ({
  id: 7,
  userId: ALICE,
  member: person(ALICE, 'Alice'),
  itemId: 1,
  itemName: 'Shout-out',
  itemType: 'custom',
  itemRemoved: false,
  roleId: null,
  pricePaid: 100,
  source: 'purchase',
  status: 'active',
  expiresAt: null,
  fulfilledAt: null,
  fulfilledBy: null,
  note: '',
  createdAt: Date.UTC(2030, 0, 5, 12, 0),
  ...over,
});
const detail = (inventory) => ({
  member: person(ALICE, 'Alice'),
  account: { cash: 100, bank: 0, total: 100, dailyStreak: 0, hasAccount: true },
  transactionCount: 0,
  transactions: [],
  inventory,
});

beforeEach(() => {
  vi.resetAllMocks();
  confirmDialog.mockResolvedValue(true);
  resetModuleLimits();
  api.getModuleLimits.mockResolvedValue(limits);
  api.getModuleConfig.mockResolvedValue({
    config,
    channels: [{ id: '555555555555555552', name: 'shop-orders' }],
    roles: [],
    maxBalance: 1_000_000_000,
    messageLengthChecked: true,
  });
  api.getEconomyMembers.mockResolvedValue({
    search: false,
    sort: 'total',
    dir: 'desc',
    page: 1,
    pages: 1,
    total: 1,
    rows: [
      {
        userId: ALICE,
        member: person(ALICE, 'Alice'),
        cash: 100,
        bank: 0,
        total: 100,
        dailyStreak: 0,
        hasAccount: true,
      },
    ],
  });
  api.getShopItems.mockResolvedValue(shopData([item()]));
});

const openTab = async (name) => {
  renderAtGuild(<Economy />, GUILD);
  await screen.findByRole('heading', { name: 'Economy' });
  fireEvent.click(screen.getByRole('tab', { name }));
};

describe('Economy settings: the shop', () => {
  it('has the web shop switch (off by default) and the channel for custom items, and saves them', async () => {
    api.saveModuleConfig.mockResolvedValue({
      config: { ...config, webShop: true, shopChannelId: '555555555555555552' },
    });
    renderAtGuild(<Economy />, GUILD);
    const web = await screen.findByLabelText('Web shop page');
    expect(web.checked).toBe(false);
    expect(screen.getByText(/Nobody else can see it. Off by default./)).toBeTruthy();
    fireEvent.click(web);
    fireEvent.change(screen.getByLabelText(/Channel for custom items/), {
      target: { value: '555555555555555552' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.saveModuleConfig).toHaveBeenCalledWith(
        GUILD,
        'economy',
        expect.objectContaining({ webShop: true, shopChannelId: '555555555555555552' })
      )
    );
  });
});

describe('Economy: the Shop tab', () => {
  it('lists the items with price, kind, stock, sales and revenue', async () => {
    api.getShopItems.mockResolvedValue(
      shopData([
        item(),
        item({
          id: 2,
          name: 'Millionaire',
          type: 'temp_role',
          roleId: ROLE,
          durationHours: 168,
          price: 5000,
          stock: null,
          left: null,
          enabled: false,
          purchases: 0,
          revenue: 0,
        }),
      ])
    );
    await openTab('Shop');
    expect(await screen.findByRole('heading', { name: 'Items (2)' })).toBeTruthy();
    const first = screen.getByText('Shout-out').closest('.v2-row-main');
    expect(first.textContent).toContain('Custom item (staff fulfil it)');
    expect(first.textContent).toContain('3 of 5 left');
    expect(first.textContent).toContain('2 sold');
    expect(first.textContent).toContain('🪙 200 coins earned');
    const second = screen.getByRole('heading', { name: /^Millionaire/, level: 3 }).closest('.v2-row-main');
    expect(second.textContent).toContain('paused');
    expect(second.textContent).toContain('168 h');
    expect(second.textContent).toContain('Millionaire'); // the role name
    expect(second.textContent).toContain('unlimited stock');
  });

  it('adds an item with the limits from the server and sends every field', async () => {
    api.createShopItem.mockResolvedValue({ items: [item({ id: 9, name: 'New' })], id: 9 });
    await openTab('Shop');
    fireEvent.click(await screen.findByRole('button', { name: 'Add an item' }));
    const name = screen.getByLabelText('Name');
    await waitFor(() => expect(name.maxLength).toBe(60));
    expect(screen.getByLabelText('Price').max).toBe('1000000000');
    fireEvent.change(name, { target: { value: 'New' } });
    fireEvent.change(screen.getByLabelText('What it is'), { target: { value: 'temp_role' } });
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: ROLE } });
    fireEvent.change(screen.getByLabelText('For how many hours'), { target: { value: '48' } });
    fireEvent.change(screen.getByLabelText('Price'), { target: { value: '250' } });
    fireEvent.change(screen.getByLabelText(/Stock/), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText(/Most per member/), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save item' }));
    await waitFor(() =>
      expect(api.createShopItem).toHaveBeenCalledWith(
        GUILD,
        expect.objectContaining({
          name: 'New',
          type: 'temp_role',
          roleId: ROLE,
          durationHours: '48',
          price: '250',
          stock: '10',
          perMemberLimit: '2',
          enabled: true,
        })
      )
    );
    expect(notify).toHaveBeenCalledWith('Item added.', 'info');
  });

  it('shows the server refusal and keeps the form open', async () => {
    api.createShopItem.mockRejectedValue(new Error('Give the item a name.'));
    await openTab('Shop');
    fireEvent.click(await screen.findByRole('button', { name: 'Add an item' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save item' }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith('Give the item a name.'));
    expect(screen.getByRole('button', { name: 'Save item' })).toBeTruthy();
  });

  it('edits an item, pauses it, reorders and deletes after a confirmation', async () => {
    api.getShopItems.mockResolvedValue(shopData([item(), item({ id: 2, name: 'Second' })]));
    api.updateShopItem.mockResolvedValue({
      items: [item({ name: 'Renamed' }), item({ id: 2, name: 'Second' })],
    });
    api.setShopItemEnabled.mockResolvedValue({
      items: [item({ name: 'Renamed', enabled: false }), item({ id: 2, name: 'Second' })],
    });
    api.reorderShopItems.mockResolvedValue({
      items: [item({ id: 2, name: 'Second' }), item({ name: 'Renamed', enabled: false })],
    });
    api.deleteShopItem.mockResolvedValue({ items: [item({ id: 2, name: 'Second' })] });
    await openTab('Shop');
    const [editFirst] = await screen.findAllByRole('button', { name: 'Edit' });
    fireEvent.click(editFirst);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save item' }));
    await waitFor(() =>
      expect(api.updateShopItem).toHaveBeenCalledWith(
        GUILD,
        1,
        expect.objectContaining({ name: 'Renamed', price: 100, stock: 5 })
      )
    );

    fireEvent.click((await screen.findAllByRole('button', { name: 'Pause' }))[0]);
    await waitFor(() => expect(api.setShopItemEnabled).toHaveBeenCalledWith(GUILD, 1, false));

    fireEvent.click(screen.getByRole('button', { name: 'Move Renamed down' }));
    await waitFor(() => expect(api.reorderShopItems).toHaveBeenCalledWith(GUILD, [2, 1]));

    fireEvent.click((await screen.findAllByRole('button', { name: 'Delete' }))[0]);
    await waitFor(() => expect(api.deleteShopItem).toHaveBeenCalled());
    expect(confirmDialog).toHaveBeenCalledWith(expect.objectContaining({ confirmLabel: 'Delete item' }));
  });
});

describe('Economy: a member inventory', () => {
  const openInventory = async (inventory) => {
    api.getEconomyMember.mockResolvedValue(detail(inventory));
    await openTab('Members');
    fireEvent.click((await screen.findAllByRole('button', { name: 'Manage' }))[0]);
    await screen.findByRole('heading', { name: 'Alice', level: 2 });
    fireEvent.click(screen.getByRole('tab', { name: 'Inventory' }));
    await screen.findByRole('heading', { name: 'Inventory' });
  };

  it('shows what the member owns: status, price paid, time left, waiting for staff, item removed', async () => {
    await openInventory([
      invRow(),
      invRow({
        id: 8,
        itemName: 'Millionaire',
        itemType: 'temp_role',
        roleId: ROLE,
        expiresAt: Date.UTC(2030, 1, 1),
        source: 'grant',
        pricePaid: 0,
      }),
      invRow({ id: 9, itemName: 'Old', status: 'refunded', itemRemoved: true }),
    ]);
    const rowOf = (name) => screen.getByRole('heading', { name, level: 3 }).closest('.v2-row');
    const shout = rowOf('Shout-out');
    expect(shout.textContent).toContain('active');
    expect(shout.textContent).toContain('paid 100');
    expect(shout.textContent).toContain('waiting for staff');
    const temp = rowOf('Millionaire');
    expect(temp.textContent).toContain('given for free');
    expect(temp.textContent).toContain('until');
    const old = rowOf(/^Old/);
    expect(old.textContent).toContain('item removed');
    expect(old.textContent).toContain('refunded');
    // an ended row has no revoke or refund
    expect(within(old).queryByRole('button', { name: 'Refund' })).toBeNull();
    expect(within(old).queryByRole('button', { name: 'Revoke' })).toBeNull();
  });

  it('gives an item for free with a reason', async () => {
    const given = [invRow({ source: 'grant', pricePaid: 0 })];
    api.grantShopItem.mockResolvedValue({ inventory: given });
    await openInventory([]);
    expect(screen.getByText('Nothing here yet.')).toBeTruthy();
    api.getEconomyMember.mockResolvedValue(detail(given)); // the panel looks again after the change
    fireEvent.change(await screen.findByLabelText('Give an item for free'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText(/Reason or note/), { target: { value: 'event prize' } });
    fireEvent.click(screen.getByRole('button', { name: 'Give item' }));
    await waitFor(() =>
      expect(api.grantShopItem).toHaveBeenCalledWith(GUILD, ALICE, { itemId: 1, reason: 'event prize' })
    );
    expect(await screen.findByText(/given for free/)).toBeTruthy();
    expect(notify).toHaveBeenCalledWith('Item given.', 'info');
  });

  it('revokes and refunds after a confirmation, and says what a refund does', async () => {
    api.actOnInventoryRow.mockResolvedValue({ inventory: [invRow({ status: 'refunded' })], refunded: true });
    await openInventory([invRow()]);
    fireEvent.click(screen.getByRole('button', { name: 'Refund' }));
    await waitFor(() =>
      expect(api.actOnInventoryRow).toHaveBeenCalledWith(GUILD, ALICE, 7, 'refund', { reason: '' })
    );
    expect(confirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Refund Shout-out?', body: expect.stringContaining('🪙 100 back') })
    );
  });

  it('revokes without money moving', async () => {
    api.actOnInventoryRow.mockResolvedValue({ inventory: [invRow({ status: 'revoked' })] });
    await openInventory([invRow()]);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() =>
      expect(api.actOnInventoryRow).toHaveBeenCalledWith(GUILD, ALICE, 7, 'revoke', { reason: '' })
    );
    expect(confirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Revoke Shout-out?', body: expect.stringContaining('No money moves') })
    );
  });

  it('keeps the row when the confirmation is declined, and shows a warning from the server', async () => {
    api.actOnInventoryRow.mockResolvedValue({
      inventory: [invRow({ status: 'revoked' })],
      warning: 'Sylo could not take the role away.',
    });
    await openInventory([invRow()]);
    confirmDialog.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalled());
    expect(api.actOnInventoryRow).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith('Sylo could not take the role away.'));
  });

  it('marks a custom item fulfilled with a note, and reopens it', async () => {
    const done = [invRow({ fulfilledAt: 1, fulfilledBy: person('9', 'Staffer') })];
    api.actOnInventoryRow.mockResolvedValue({ inventory: done });
    await openInventory([invRow()]);
    api.getEconomyMember.mockResolvedValue(detail(done)); // the panel looks again after the change
    fireEvent.change(screen.getByLabelText(/Reason or note/), { target: { value: 'done on stream' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mark fulfilled' }));
    await waitFor(() =>
      expect(api.actOnInventoryRow).toHaveBeenCalledWith(GUILD, ALICE, 7, 'fulfil', {
        fulfilled: true,
        note: 'done on stream',
      })
    );
    expect(await screen.findByText(/fulfilled by Staffer/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reopen' })).toBeTruthy();
  });
});

describe('Economy: the Activity tab', () => {
  const activity = (rows, over = {}) => ({ page: 1, pages: 1, total: rows.length, rows, ...over });

  it('lists purchases and filters by item and by member', async () => {
    api.getShopActivity.mockResolvedValue(
      activity([
        invRow(),
        invRow({
          id: 8,
          member: person('222222222222222222', 'Bob'),
          userId: '222222222222222222',
          itemName: 'Other',
        }),
      ])
    );
    await openTab('Activity');
    expect(await screen.findByRole('heading', { name: 'Purchases (2)' })).toBeTruthy();
    expect(screen.getByText('Alice bought Shout-out')).toBeTruthy();
    expect(api.getShopActivity).toHaveBeenCalledWith(GUILD, { userId: '', itemId: '', page: 1 });
    fireEvent.change(screen.getByLabelText('Item'), { target: { value: '1' } });
    await waitFor(() =>
      expect(api.getShopActivity).toHaveBeenLastCalledWith(GUILD, { userId: '', itemId: '1', page: 1 })
    );
    fireEvent.change(screen.getByLabelText('Member ID'), { target: { value: ALICE } });
    await waitFor(() =>
      expect(api.getShopActivity).toHaveBeenLastCalledWith(GUILD, { userId: ALICE, itemId: '1', page: 1 })
    );
  });

  it('pages and says when nothing matches', async () => {
    api.getShopActivity.mockResolvedValue(activity([], { total: 0 }));
    await openTab('Activity');
    expect(await screen.findByText('No purchases match.')).toBeTruthy();
    api.getShopActivity.mockResolvedValue(activity([invRow()], { pages: 3, total: 60 }));
    fireEvent.change(screen.getByLabelText('Member ID'), { target: { value: 'x' } });
    expect(await screen.findByText('Page 1 of 3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(api.getShopActivity).toHaveBeenLastCalledWith(GUILD, { userId: 'x', itemId: '', page: 2 })
    );
  });
});
