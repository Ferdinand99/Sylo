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
  uploadShopItemImage: vi.fn(),
  deleteShopItemImage: vi.fn(),
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
  collectibleChannelId: '',
  collectionPublic: false,
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
  rarities: [
    { key: 'common', label: 'Common' },
    { key: 'uncommon', label: 'Uncommon' },
    { key: 'rare', label: 'Rare' },
    { key: 'epic', label: 'Epic' },
    { key: 'legendary', label: 'Legendary' },
  ],
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

describe('Economy settings: collectibles', () => {
  it('has the announcement channel and the collection switch (off by default), and saves them', async () => {
    api.saveModuleConfig.mockResolvedValue({
      config: { ...config, collectibleChannelId: '555555555555555552', collectionPublic: true },
    });
    renderAtGuild(<Economy />, GUILD);
    const show = await screen.findByLabelText('Members can show their collection');
    expect(show.checked).toBe(false);
    expect(screen.getByText(/Off \(the default\)/)).toBeTruthy();
    fireEvent.click(show);
    fireEvent.change(screen.getByLabelText(/Channel for collectible announcements/), {
      target: { value: '555555555555555552' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.saveModuleConfig).toHaveBeenCalledWith(
        GUILD,
        'economy',
        expect.objectContaining({ collectibleChannelId: '555555555555555552', collectionPublic: true })
      )
    );
  });
});

describe('Economy: collectibles on the Shop tab', () => {
  const badge = (over = {}) =>
    item({
      id: 3,
      name: 'Founder badge',
      type: 'collectible',
      rarity: 'epic',
      announce: true,
      imagePath: '/c/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.webp',
      ...over,
    });
  const png = () => new File([new Uint8Array([1, 2, 3])], 'badge.png', { type: 'image/png' });

  it('lists a collectible with its picture, rarity and announce switch, and warns when it has no picture', async () => {
    api.getShopItems.mockResolvedValue(
      shopData([badge(), badge({ id: 4, name: 'Bare', imagePath: null, rarity: null, announce: false })])
    );
    await openTab('Shop');
    const row = (await screen.findByRole('heading', { name: /^Founder badge/, level: 3 })).closest('.v2-row');
    expect(row.querySelector('img').getAttribute('src')).toBe('/c/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.webp');
    expect(row.textContent).toContain('Collectible (a picture, no role)');
    expect(row.textContent).toContain('Epic');
    expect(row.textContent).toContain('announced');
    const bare = screen.getByRole('heading', { name: /^Bare/, level: 3 }).closest('.v2-row');
    expect(bare.querySelector('img')).toBeNull();
    expect(bare.textContent).toContain('needs a picture');
  });

  it('adds a collectible: the fields go first, then the picture goes up to the new item', async () => {
    api.createShopItem.mockResolvedValue({ items: [badge()], id: 3 });
    api.uploadShopItemImage.mockResolvedValue({ items: [badge()] });
    await openTab('Shop');
    fireEvent.click(await screen.findByRole('button', { name: 'Add an item' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Founder badge' } });
    expect(screen.queryByLabelText('Picture')).toBeNull();
    fireEvent.change(screen.getByLabelText('What it is'), { target: { value: 'collectible' } });
    expect(screen.queryByLabelText('Role')).toBeNull();
    const rarity = screen.getByLabelText(/Rarity/);
    expect([...rarity.options].map((o) => o.textContent)).toEqual([
      '— none —',
      'Common',
      'Uncommon',
      'Rare',
      'Epic',
      'Legendary',
    ]);
    fireEvent.change(rarity, { target: { value: 'epic' } });
    fireEvent.click(screen.getByLabelText('Announce purchases'));
    const file = png();
    const input = screen.getByLabelText('Picture');
    expect(input.accept).toBe('image/png,image/jpeg,image/webp');
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Save item' }));
    await waitFor(() => expect(api.uploadShopItemImage).toHaveBeenCalledWith(GUILD, 3, file));
    expect(api.createShopItem).toHaveBeenCalledWith(
      GUILD,
      expect.objectContaining({ type: 'collectible', rarity: 'epic', announce: true, roleId: '' })
    );
    expect(api.createShopItem.mock.invocationCallOrder[0]).toBeLessThan(
      api.uploadShopItemImage.mock.invocationCallOrder[0]
    );
    expect(notify).toHaveBeenCalledWith('Item added.', 'info');
  });

  it('keeps the item and the form when the picture is refused, so it can be tried again', async () => {
    api.createShopItem.mockResolvedValue({ items: [badge({ imagePath: null })], id: 3 });
    api.uploadShopItemImage.mockRejectedValueOnce(new Error('Use a PNG, JPEG or WebP image.'));
    await openTab('Shop');
    fireEvent.click(await screen.findByRole('button', { name: 'Add an item' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Founder badge' } });
    fireEvent.change(screen.getByLabelText('What it is'), { target: { value: 'collectible' } });
    fireEvent.change(screen.getByLabelText('Picture'), { target: { files: [png()] } });
    fireEvent.click(screen.getByRole('button', { name: 'Save item' }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith('Use a PNG, JPEG or WebP image.'));
    expect(
      screen.getByRole('heading', { name: 'Edit item' }),
      'the form is now an edit of the new item'
    ).toBeTruthy();
    // the file input is emptied too, so it does not still show the refused file
    expect(screen.getByLabelText('Picture').files.length).toBe(0);
    // a second try updates the item that now exists, and uploads again
    api.updateShopItem.mockResolvedValue({ items: [badge()] });
    api.uploadShopItemImage.mockResolvedValue({ items: [badge()] });
    const again = png();
    fireEvent.change(screen.getByLabelText('Picture'), { target: { files: [again] } });
    fireEvent.click(screen.getByRole('button', { name: 'Save item' }));
    await waitFor(() => expect(api.uploadShopItemImage).toHaveBeenLastCalledWith(GUILD, 3, again));
    expect(api.createShopItem).toHaveBeenCalledTimes(1);
  });

  it('refuses a picture over 2 MB before anything is sent', async () => {
    await openTab('Shop');
    fireEvent.click(await screen.findByRole('button', { name: 'Add an item' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Big' } });
    fireEvent.change(screen.getByLabelText('What it is'), { target: { value: 'collectible' } });
    const big = new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Picture'), { target: { files: [big] } });
    fireEvent.click(screen.getByRole('button', { name: 'Save item' }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith('The picture is larger than 2 MB.'));
    expect(api.createShopItem).not.toHaveBeenCalled();
    expect(api.uploadShopItemImage).not.toHaveBeenCalled();
  });

  it('edits a collectible and removes its picture after a confirmation', async () => {
    api.getShopItems.mockResolvedValue(shopData([badge()]));
    api.deleteShopItemImage.mockResolvedValue({ items: [badge({ imagePath: null })] });
    await openTab('Shop');
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText(/Rarity/).value).toBe('epic');
    expect(screen.getByLabelText('Announce purchases').checked).toBe(true);
    expect(screen.getByAltText('The current picture').getAttribute('src')).toBe(
      '/c/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.webp'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove picture' }));
    await waitFor(() => expect(api.deleteShopItemImage).toHaveBeenCalledWith(GUILD, 3));
    expect(confirmDialog).toHaveBeenCalledWith(expect.objectContaining({ confirmLabel: 'Remove picture' }));
    await waitFor(() => expect(screen.queryByAltText('The current picture')).toBeNull());
  });

  it('a type that is not a collectible sends no rarity and no announce switch', async () => {
    api.createShopItem.mockResolvedValue({ items: [item()], id: 1 });
    await openTab('Shop');
    fireEvent.click(await screen.findByRole('button', { name: 'Add an item' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Plain' } });
    fireEvent.change(screen.getByLabelText('What it is'), { target: { value: 'collectible' } });
    fireEvent.change(screen.getByLabelText(/Rarity/), { target: { value: 'rare' } });
    fireEvent.change(screen.getByLabelText('What it is'), { target: { value: 'custom' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save item' }));
    await waitFor(() =>
      expect(api.createShopItem).toHaveBeenCalledWith(
        GUILD,
        expect.objectContaining({ type: 'custom', rarity: '', announce: false })
      )
    );
    expect(api.uploadShopItemImage).not.toHaveBeenCalled();
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
    expect(await screen.findByRole('heading', { name: 'Items (2 / 100)' })).toBeTruthy();
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

  it('shows the item counter and the collectible picture quota with the server limits', async () => {
    api.getShopItems.mockResolvedValue({
      ...shopData([item()]),
      maxItems: 100,
      pictures: { count: 3, bytes: 5 * 1024 * 1024, maxCount: 200, maxBytes: 25 * 1024 * 1024 },
    });
    await openTab('Shop');
    expect(await screen.findByRole('heading', { name: 'Items (1 / 100)' })).toBeTruthy();
    expect(screen.getByTestId('shop-pictures').textContent).toBe(
      'Collectible pictures: 3 / 200 · 5 MB / 25 MB'
    );
  });

  it('an empty shop says what it gives and has one start button, not a second one under the list', async () => {
    api.getShopItems.mockResolvedValue(shopData([]));
    await openTab('Shop');
    const start = await screen.findByRole('button', { name: 'Add your first item' });
    expect(start.className).toContain('v2-btn-primary');
    expect(screen.queryByRole('button', { name: 'Add an item' })).toBeNull();
    fireEvent.click(start);
    expect(await screen.findByRole('heading', { name: 'New item' })).toBeTruthy();
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

    // The less common actions are in each row's "⋯" menu, so the row keeps its buttons on one line.
    const choose = async (row, name) => {
      fireEvent.click(await screen.findByRole('button', { name: `More actions for ${row}` }));
      fireEvent.click(await screen.findByRole('menuitem', { name }));
    };
    await choose('Renamed', 'Pause');
    await waitFor(() => expect(api.setShopItemEnabled).toHaveBeenCalledWith(GUILD, 1, false));

    await choose('Renamed', 'Move down');
    await waitFor(() => expect(api.reorderShopItems).toHaveBeenCalledWith(GUILD, [2, 1]));

    await choose('Renamed', 'Delete');
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
      invRow({ id: 10, itemName: 'Lapsed', itemType: 'temp_role', roleId: ROLE, status: 'expired' }),
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
    // a temporary role that ran out is shown as expired and cannot be revoked or refunded
    const lapsed = rowOf('Lapsed');
    expect(lapsed.textContent).toContain('expired');
    expect(within(lapsed).queryByRole('button', { name: 'Revoke' })).toBeNull();
    expect(within(lapsed).queryByRole('button', { name: 'Refund' })).toBeNull();
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
    fireEvent.change(screen.getByLabelText('Member'), { target: { value: ALICE } });
    fireEvent.mouseDown(await screen.findByRole('option', { name: `Use the member id ${ALICE}` }));
    await waitFor(() =>
      expect(api.getShopActivity).toHaveBeenLastCalledWith(GUILD, { userId: ALICE, itemId: '1', page: 1 })
    );
  });

  it('pages and says when nothing matches', async () => {
    api.getShopActivity.mockResolvedValue(activity([], { total: 0 }));
    await openTab('Activity');
    // no filter set: the page is empty, not "no match"
    expect(
      await screen.findByText(/No purchases yet\. Purchases made with \/buy or in the web shop/)
    ).toBeTruthy();
    api.getShopActivity.mockResolvedValue(activity([invRow()], { pages: 3, total: 60 }));
    fireEvent.change(screen.getByLabelText('Member'), { target: { value: ALICE } });
    fireEvent.mouseDown(await screen.findByRole('option', { name: `Use the member id ${ALICE}` }));
    expect(await screen.findByText('Page 1 of 3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(api.getShopActivity).toHaveBeenLastCalledWith(GUILD, { userId: ALICE, itemId: '', page: 2 })
    );
    api.getShopActivity.mockResolvedValue(activity([], { total: 0 }));
    fireEvent.click(screen.getByRole('button', { name: /Clear the member filter/ }));
    fireEvent.change(screen.getByLabelText('Item'), { target: { value: '1' } });
    expect(await screen.findByText('No purchases match.')).toBeTruthy();
  });
});
