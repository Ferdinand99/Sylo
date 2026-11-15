import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Account from '../pages/Account.jsx';

vi.mock('../api.js', () => ({
  getAccount: vi.fn(),
  deleteAccount: vi.fn(),
  disconnectAccount: vi.fn(),
  revokeDevice: vi.fn(),
}));
vi.mock('../notify.js', () => ({ notify: vi.fn() }));
vi.mock('../components/ConfirmDialog.jsx', () => ({ confirmDialog: vi.fn().mockResolvedValue(true) }));
const api = await import('../api.js');

const DRAFT = 'sylo-apply-draft:123456789012345678:700000000000000010:7';

describe('deleting the account', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    api.getAccount.mockResolvedValue({
      open: false,
      platforms: [
        { platform: 'discord', label: 'Discord', connected: true, username: 'ferdi', canDisconnect: false },
      ],
      devices: [],
    });
  });

  it('clears the unsent application drafts of this browser', async () => {
    api.deleteAccount.mockResolvedValue({});
    const assign = vi.fn();
    const real = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...real, assign } });
    window.localStorage.setItem(DRAFT, '{"version":1,"answers":{"q":"half an answer"}}');
    window.localStorage.setItem('something-else', 'stays');
    try {
      render(<Account />);
      fireEvent.click(await screen.findByRole('button', { name: 'Delete account' }));
      await waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
      expect(window.localStorage.getItem(DRAFT)).toBeNull();
      expect(window.localStorage.getItem('something-else')).toBe('stays');
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: real });
    }
  });

  it('keeps the drafts when the deletion failed (the account is still there)', async () => {
    api.deleteAccount.mockRejectedValue(new Error('nope'));
    window.localStorage.setItem(DRAFT, '{"version":1,"answers":{}}');
    render(<Account />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete account' }));
    await waitFor(() => expect(api.deleteAccount).toHaveBeenCalled());
    expect(window.localStorage.getItem(DRAFT)).not.toBeNull();
  });
});
