import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Shop from '../pages/Shop.jsx';
import { renderAtGuild } from './routerHarness.jsx';

vi.mock('../api.js', () => {
  class ApiError extends Error {
    constructor(message, { status, notAuthenticated = false } = {}) {
      super(message);
      this.status = status;
      this.notAuthenticated = notAuthenticated;
    }
  }
  return { ApiError, getWebShop: vi.fn(), buyWebShopItem: vi.fn() };
});
vi.mock('../notify.js', () => ({ notify: vi.fn() }));
vi.mock('../components/ConfirmDialog.jsx', () => ({ confirmDialog: vi.fn().mockResolvedValue(true) }));
const api = await import('../api.js');
const { confirmDialog } = await import('../components/ConfirmDialog.jsx');
const { notify } = await import('../notify.js');

const GUILD = '123456789012345678';
const currency = { name: 'coins', emoji: '🪙' };

const item = (over = {}) => ({
  id: 1,
  name: 'Shout-out',
  description: 'On stream',
  emoji: '🎤',
  type: 'custom',
  price: 100,
  version: 1700000000000,
  durationHours: null,
  left: 3,
  requiredRoles: [],
  meetsRequirements: true,
  canBuy: true,
  problem: null,
  ...over,
});
const view = (over = {}) => ({
  guild: { name: 'Hedgerow', id: GUILD },
  currency,
  balance: { cash: 500, bank: 40, total: 540 },
  items: [item()],
  inventory: [],
  ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  confirmDialog.mockResolvedValue(true);
  api.getWebShop.mockResolvedValue(view());
});

describe('the web shop page: collectibles', () => {
  it('shows a collectible with its picture and rarity, and the member collection with copies and removed items', async () => {
    api.getWebShop.mockResolvedValue(
      view({
        items: [
          item({
            id: 5,
            name: 'Founder badge',
            type: 'collectible',
            emoji: '🎖️',
            imagePath: '/c/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.webp',
            rarityLabel: 'Epic',
            left: 2,
          }),
        ],
        collection: [
          {
            itemId: 5,
            name: 'Founder badge',
            emoji: '🎖️',
            imagePath: '/c/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.webp',
            rarity: 'epic',
            rarityLabel: 'Epic',
            count: 2,
            removed: false,
            since: 1700000000000,
          },
          {
            itemId: 6,
            name: 'Old stamp',
            emoji: '',
            imagePath: null,
            rarity: null,
            rarityLabel: null,
            count: 1,
            removed: true,
            since: 1700000000000,
          },
        ],
      })
    );
    renderAtGuild(<Shop />, GUILD);
    const row = (await screen.findByRole('heading', { name: /^🎖️ Founder badge$/, level: 3 })).closest(
      '.v2-row'
    );
    expect(row.querySelector('img').getAttribute('src')).toBe('/c/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.webp');
    expect(row.textContent).toContain('A collectible');
    expect(row.textContent).toContain('Epic');
    expect(row.textContent).toContain('2 left');
    const section = screen.getByRole('heading', { name: 'Collection' }).closest('.v2-group');
    expect(within(section).getByRole('heading', { name: /Founder badge ×2/ })).toBeTruthy();
    expect(section.querySelectorAll('img').length).toBe(1);
    expect(section.textContent).toContain('Item removed');
  });

  it('has no Collection section for a member without collectibles, or from a server that sends none', async () => {
    api.getWebShop.mockResolvedValue(view({ collection: [] }));
    const { unmount } = renderAtGuild(<Shop />, GUILD);
    await screen.findByRole('heading', { name: /Shout-out/, level: 3 });
    expect(screen.queryByRole('heading', { name: 'Collection' })).toBeNull();
    unmount();
    api.getWebShop.mockResolvedValue(view());
    renderAtGuild(<Shop />, GUILD);
    await screen.findByRole('heading', { name: /Shout-out/, level: 3 });
    expect(screen.queryByRole('heading', { name: 'Collection' })).toBeNull();
  });
});

describe('the web shop page', () => {
  it('shows the balance, the items with price, kind, stock and what blocks a purchase, and what the member owns', async () => {
    api.getWebShop.mockResolvedValue(
      view({
        items: [
          item(),
          item({
            id: 2,
            name: 'Millionaire',
            emoji: '',
            type: 'temp_role',
            durationHours: 168,
            price: 5000,
            left: null,
            canBuy: false,
            problem: 'Not enough cash.',
          }),
          item({
            id: 3,
            name: 'VIP',
            emoji: '',
            type: 'role',
            price: 50,
            left: 0,
            canBuy: false,
            requiredRoles: [{ id: '1', name: 'Supporter' }],
            problem: 'You need one of these roles to buy that: @Supporter.',
          }),
        ],
        inventory: [
          {
            id: 5,
            name: 'Old thing',
            type: 'custom',
            expiresAt: null,
            fulfilledAt: null,
            waiting: true,
            createdAt: Date.UTC(2030, 0, 5),
          },
        ],
      })
    );
    renderAtGuild(<Shop />, GUILD);
    expect(await screen.findByRole('heading', { name: 'Shop of Hedgerow' })).toBeTruthy();
    expect(screen.getByText(/Cash 🪙 500 coins/)).toBeTruthy();
    expect(screen.getByText(/Bank 🪙 40 coins/)).toBeTruthy();
    const first = screen.getByText('🎤 Shout-out').closest('.v2-row-main');
    expect(first.textContent).toContain('On stream');
    expect(first.textContent).toContain('🪙 100 coins');
    expect(first.textContent).toContain('Staff take care of it');
    expect(first.textContent).toContain('3 left');
    const dear = screen.getByText('Millionaire').closest('.v2-row');
    expect(dear.textContent).toContain('A role for 168 hours');
    expect(dear.textContent).toContain('Not enough cash.');
    expect(dear.querySelector('button').disabled).toBe(true);
    const vip = screen.getByText('VIP').closest('.v2-row');
    expect(vip.textContent).toContain('Sold out');
    expect(vip.textContent).toContain('Needs one of: Supporter');
    expect(vip.querySelector('button').disabled).toBe(true);
    expect(screen.getByText('Old thing').closest('.v2-row-main').textContent).toContain('Waiting for staff');
  });

  it('buys after a confirmation and shows the new balance and inventory from the server', async () => {
    api.buyWebShopItem.mockResolvedValue({
      ok: true,
      bought: { name: 'Shout-out' },
      view: view({
        balance: { cash: 400, bank: 40, total: 440 },
        items: [item({ left: 2 })],
        inventory: [
          {
            id: 9,
            name: 'Shout-out',
            type: 'custom',
            expiresAt: null,
            fulfilledAt: null,
            waiting: true,
            createdAt: Date.UTC(2030, 0, 6),
          },
        ],
      }),
    });
    renderAtGuild(<Shop />, GUILD);
    fireEvent.click(await screen.findByRole('button', { name: 'Buy' }));
    await waitFor(() => expect(api.buyWebShopItem).toHaveBeenCalledWith(GUILD, 1, 100, 1700000000000));
    expect(confirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Buy 🎤 Shout-out?',
        confirmLabel: 'Buy for 100',
        body: expect.stringContaining('You have 🪙 500 coins'),
      })
    );
    expect(await screen.findByText(/Cash 🪙 400 coins/)).toBeTruthy();
    expect(screen.getByText('2 left')).toBeTruthy();
    expect(notify).toHaveBeenCalledWith('You bought Shout-out.', 'info');
  });

  it('does nothing when the confirmation is declined', async () => {
    confirmDialog.mockResolvedValue(false);
    renderAtGuild(<Shop />, GUILD);
    fireEvent.click(await screen.findByRole('button', { name: 'Buy' }));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalled());
    expect(api.buyWebShopItem).not.toHaveBeenCalled();
  });

  it('shows the server answer when a purchase is refused, and looks at the shop again', async () => {
    api.buyWebShopItem.mockRejectedValue(new Error('That item is sold out.'));
    renderAtGuild(<Shop />, GUILD);
    fireEvent.click(await screen.findByRole('button', { name: 'Buy' }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith('That item is sold out.'));
    await waitFor(() => expect(api.getWebShop.mock.calls.length).toBeGreaterThan(1));
  });

  it('shows the one "Nothing here" page for every refusal, and a sign-in link when the session ended', async () => {
    api.getWebShop.mockRejectedValue(new api.ApiError('Not found', { status: 404 }));
    const { unmount } = renderAtGuild(<Shop />, GUILD);
    expect(await screen.findByText('Nothing here')).toBeTruthy();
    expect(screen.queryByText(/not a member|switched off/i)).toBeNull();
    unmount();

    api.getWebShop.mockRejectedValue(
      new api.ApiError('Not signed in', { status: 401, notAuthenticated: true })
    );
    renderAtGuild(<Shop />, GUILD);
    expect(await screen.findByRole('link', { name: 'sign in again' })).toBeTruthy();
  });

  it('says the shop is empty and that nothing is owned yet', async () => {
    api.getWebShop.mockResolvedValue(view({ items: [], inventory: [] }));
    renderAtGuild(<Shop />, GUILD);
    expect(await screen.findByText('The shop is empty.')).toBeTruthy();
    expect(screen.getByText('Nothing yet.')).toBeTruthy();
  });
});
