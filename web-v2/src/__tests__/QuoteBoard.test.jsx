import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import QuoteBoard from '../moduleForms/QuoteBoard.jsx';
import { resetModuleLimits } from '../components/useModuleLimits.js';
import { renderAtGuild } from './routerHarness.jsx';

vi.mock('../api.js', () => ({
  ApiError: class ApiError extends Error {},
  getModuleConfig: vi.fn(),
  saveModuleConfig: vi.fn(),
  getModuleLimits: vi.fn(),
  getQuotes: vi.fn(),
  deleteQuote: vi.fn(),
}));
vi.mock('../notify.js', () => ({ notify: vi.fn() }));
vi.mock('../components/ConfirmDialog.jsx', () => ({ confirmDialog: vi.fn().mockResolvedValue(true) }));
const { getModuleConfig, saveModuleConfig, getModuleLimits, getQuotes, deleteQuote } =
  await import('../api.js');
const { confirmDialog } = await import('../components/ConfirmDialog.jsx');
const { notify } = await import('../notify.js');

const GUILD = '123456789012345678';
const ROLE_A = '555555555555555551';
const ROLE_B = '555555555555555552';

// What GET /api/v2/modules/limits answers for the quote-board module (src/modules/quoteBoard.js, LIMITS).
const limits = {
  'quote-board': {
    text: { maxLength: 2000 },
    query: { maxLength: 100 },
    saveRoles: { maxItems: 25 },
    staffRoles: { maxItems: 25 },
  },
  _embed: {},
};

const quote = (over = {}) => ({
  number: 2,
  authorId: '111111111111111111',
  author: 'Alice',
  text: 'I did not say that',
  attachments: 0,
  channelId: '222222222222222222',
  channel: 'general',
  messageAt: Date.UTC(2030, 0, 5, 12, 30),
  savedBy: '333333333333333333',
  savedAt: Date.UTC(2030, 0, 6),
  publicSource: true,
  url: 'https://discord.com/channels/1/2/3',
  ...over,
});

const config = { publicPage: false, saveMode: 'everyone', saveRoles: [], staffRoles: [] };
const roles = [
  { id: ROLE_A, name: 'Quoter' },
  { id: ROLE_B, name: 'Helper' },
];

beforeEach(() => {
  vi.resetAllMocks();
  confirmDialog.mockResolvedValue(true);
  resetModuleLimits();
  getModuleLimits.mockResolvedValue(limits);
  getModuleConfig.mockResolvedValue({
    config,
    roles,
    publicPath: `/quotes/${GUILD}`,
    total: 2,
    quotes: [
      quote(),
      quote({ number: 1, author: 'Bob', text: 'Second', attachments: 2, publicSource: false }),
    ],
  });
});

describe('QuoteBoard form', () => {
  it('lists the quotes with number, author, date, channel and attachments', async () => {
    renderAtGuild(<QuoteBoard />, GUILD);
    expect(await screen.findByRole('heading', { name: 'Quote board' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Quotes (2)' })).toBeTruthy();
    expect(screen.getByText('#2 · Alice')).toBeTruthy();
    expect(screen.getByText('I did not say that')).toBeTruthy();
    expect(screen.getAllByText(/2030-01-05 · #general/)).toHaveLength(2);
    expect(screen.getByText(/📎 2/)).toBeTruthy();
    expect(screen.getByText(/not on the public page/)).toBeTruthy();
    expect(getModuleConfig).toHaveBeenCalledWith(GUILD, 'quote-board');
    const links = screen.getAllByRole('link', { name: 'Open message' });
    expect(links[0].getAttribute('href')).toBe('https://discord.com/channels/1/2/3');
  });

  it('shows the settings and takes the search length from the server', async () => {
    renderAtGuild(<QuoteBoard />, GUILD);
    expect((await screen.findByLabelText('Public quote page')).checked).toBe(false);
    expect(screen.getByLabelText('Who may save quotes').value).toBe('everyone');
    expect(screen.queryByText('Roles that may save')).toBeNull();
    await waitFor(() => expect(screen.getByLabelText('Search').maxLength).toBe(100));
  });

  it('saves the public page switch and the save roles, and shows the link once saved', async () => {
    saveModuleConfig.mockImplementation(async (_guild, _id, body) => ({ config: body }));
    renderAtGuild(<QuoteBoard />, GUILD);
    expect(screen.queryByText(/Link:/)).toBeNull();
    fireEvent.click(await screen.findByLabelText('Public quote page'));
    fireEvent.change(screen.getByLabelText('Who may save quotes'), { target: { value: 'roles' } });
    expect(await screen.findByText('Roles that may save')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: /Save/ })[0]);
    await waitFor(() =>
      expect(saveModuleConfig).toHaveBeenCalledWith(GUILD, 'quote-board', {
        publicPage: true,
        saveMode: 'roles',
        saveRoles: [],
        staffRoles: [],
      })
    );
    const link = await screen.findByRole('link', { name: new RegExp(`/quotes/${GUILD}$`) });
    expect(link.getAttribute('href')).toBe(`${window.location.origin}/quotes/${GUILD}`);
  });

  it('shows the link when the page is already public', async () => {
    getModuleConfig.mockResolvedValue({
      config: { ...config, publicPage: true },
      roles,
      publicPath: `/quotes/${GUILD}`,
      total: 0,
      quotes: [],
    });
    renderAtGuild(<QuoteBoard />, GUILD);
    expect(await screen.findByRole('link', { name: new RegExp(`/quotes/${GUILD}$`) })).toBeTruthy();
    expect(screen.getByText('Nothing here yet.')).toBeTruthy();
  });

  it('typing in the search asks the server for the matching quotes', async () => {
    getQuotes.mockResolvedValue({ total: 2, quotes: [quote({ number: 1, author: 'Bob', text: 'Second' })] });
    renderAtGuild(<QuoteBoard />, GUILD);
    fireEvent.change(await screen.findByLabelText('Search'), { target: { value: 'sec' } });
    await waitFor(() => expect(getQuotes).toHaveBeenCalledWith(GUILD, { q: 'sec' }));
    expect(await screen.findByRole('heading', { name: 'Quotes (1 of 2)' })).toBeTruthy();
    expect(screen.queryByText('#2 · Alice')).toBeNull();
    expect(screen.getByText('#1 · Bob')).toBeTruthy();
  });

  it('removes a quote after confirming and reloads the list; a declined confirmation does nothing', async () => {
    deleteQuote.mockResolvedValue({ ok: true });
    getQuotes.mockResolvedValue({ total: 1, quotes: [quote({ number: 1, author: 'Bob', text: 'Second' })] });
    renderAtGuild(<QuoteBoard />, GUILD);
    confirmDialog.mockResolvedValueOnce(false);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Remove' }))[0]);
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(1));
    expect(deleteQuote).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]);
    await waitFor(() => expect(deleteQuote).toHaveBeenCalledWith(GUILD, 2));
    expect(confirmDialog).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Remove quote #2?' }));
    await waitFor(() => expect(screen.queryByText('#2 · Alice')).toBeNull());
    expect(screen.getByRole('heading', { name: 'Quotes (1)' })).toBeTruthy();
  });

  it('shows the server error when a remove fails', async () => {
    deleteQuote.mockRejectedValue(new Error('No such quote.'));
    renderAtGuild(<QuoteBoard />, GUILD);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Remove' }))[0]);
    await waitFor(() => expect(notify).toHaveBeenCalledWith('No such quote.'));
    expect(screen.getByText('#2 · Alice')).toBeTruthy();
  });
});
