import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Suggestions from '../moduleForms/Suggestions.jsx';
import { resetModuleLimits } from '../components/useModuleLimits.js';
import { renderAtGuild } from './routerHarness.jsx';

vi.mock('../api.js', () => ({
  ApiError: class ApiError extends Error {},
  getModuleConfig: vi.fn(),
  saveModuleConfig: vi.fn(),
  getModuleLimits: vi.fn(),
  getSuggestions: vi.fn(),
  decideSuggestion: vi.fn(),
  deleteSuggestion: vi.fn(),
}));
vi.mock('../components/ConfirmDialog.jsx', () => ({ confirmDialog: vi.fn().mockResolvedValue(true) }));
const { getModuleConfig, getModuleLimits, getSuggestions, decideSuggestion, deleteSuggestion } =
  await import('../api.js');
const { confirmDialog } = await import('../components/ConfirmDialog.jsx');

const GUILD = '123456789012345678';
const CHANNEL = '555555555555555555';

// What GET /api/v2/modules/limits answers for the suggestions module (src/modules/suggestions.js, LIMITS).
const limits = {
  suggestions: {
    title: { maxLength: 100 },
    text: { maxLength: 1000 },
    reason: { maxLength: 500 },
    cooldownSeconds: { min: 0, max: 3600 },
    staffRoles: { maxItems: 25 },
  },
  _embed: {},
};

const item = (over = {}) => ({
  id: 70,
  number: 7,
  title: 'Movie night',
  text: 'Add a movie night on Fridays',
  status: 'open',
  reason: '',
  up: 3,
  down: 1,
  anonymous: false,
  authorId: '111111111111111111',
  author: 'Alice',
  decidedBy: null,
  decidedAt: null,
  createdAt: Date.UTC(2030, 0, 5),
  channelId: CHANNEL,
  ...over,
});

const config = {
  channel: '',
  logChannel: '',
  anonymous: false,
  dmAuthor: true,
  messagesToSuggestions: false,
  cooldownSeconds: 60,
  staffRoles: [],
};

const load = (suggestions) =>
  getModuleConfig.mockResolvedValue({
    config,
    channels: [{ id: CHANNEL, name: 'ideas' }],
    roles: [],
    suggestions,
  });

beforeEach(() => {
  vi.resetAllMocks();
  confirmDialog.mockResolvedValue(true);
  resetModuleLimits();
  getModuleLimits.mockResolvedValue(limits);
  load([
    item(),
    item({
      id: 69,
      number: 6,
      title: '',
      text: 'Older',
      status: 'approved',
      anonymous: true,
      up: 0,
      down: 0,
    }),
  ]);
  getSuggestions.mockResolvedValue({ suggestions: [item()] });
});

describe('Suggestions form', () => {
  it('lists suggestions with votes, status and author; an anonymous one is marked as hidden from members', async () => {
    renderAtGuild(<Suggestions />, GUILD);
    expect(await screen.findByRole('heading', { name: 'Suggestions' })).toBeTruthy();
    expect(screen.getByText(/#7 · Movie night/)).toBeTruthy();
    expect(screen.getByText('Add a movie night on Fridays')).toBeTruthy();
    expect(screen.getByText(/👍 3 · 👎 1/)).toBeTruthy();
    expect(screen.getByText(/by Alice$/)).toBeTruthy();
    expect(screen.getByText(/by Alice \(hidden from members\)/)).toBeTruthy();
    expect(screen.getByText('✅ Approved')).toBeTruthy();
    expect(getModuleConfig).toHaveBeenCalledWith(GUILD, 'suggestions');
  });

  it('the settings take their limits from the server', async () => {
    renderAtGuild(<Suggestions />, GUILD);
    const cooldown = await screen.findByLabelText(/Cooldown/);
    await waitFor(() => expect(cooldown.max).toBe('3600'));
    expect(cooldown.min).toBe('0');
    expect(cooldown.value).toBe('60');
    expect(screen.getByLabelText(/DM the author/).checked).toBe(true);
    expect(screen.getByLabelText(/Anonymous suggestions/).checked).toBe(false);
    expect(screen.getByLabelText(/Turn messages in the channel into suggestions/).checked).toBe(false);
  });

  it('changing the filter and the order asks the server again', async () => {
    renderAtGuild(<Suggestions />, GUILD);
    await screen.findByText(/#7 · Movie night/);
    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'open' } });
    await waitFor(() => expect(getSuggestions).toHaveBeenCalledWith(GUILD, { status: 'open', sort: 'new' }));
    fireEvent.change(screen.getByLabelText('Order'), { target: { value: 'top' } });
    await waitFor(() => expect(getSuggestions).toHaveBeenCalledWith(GUILD, { status: 'open', sort: 'top' }));
    await waitFor(() => expect(screen.queryByText(/#6/)).toBeNull());
  });

  it('approves with a reason through the same call the command uses, then reloads the list', async () => {
    decideSuggestion.mockResolvedValue({ suggestion: item({ status: 'approved' }) });
    getSuggestions.mockResolvedValue({ suggestions: [item({ status: 'approved', reason: 'Planned' })] });
    renderAtGuild(<Suggestions />, GUILD);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Approve' }))[0]);
    const reason = screen.getByLabelText(/Reason/);
    await waitFor(() => expect(reason.maxLength).toBe(500));
    fireEvent.change(reason, { target: { value: 'Planned' } });
    fireEvent.click(within(reason.closest('form')).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(decideSuggestion).toHaveBeenCalledWith(GUILD, 7, 'approve', 'Planned'));
    expect(await screen.findByText('Reason: Planned')).toBeTruthy();
    expect(screen.queryByLabelText(/Reason/)).toBeNull();
  });

  it('offers all four decisions', async () => {
    renderAtGuild(<Suggestions />, GUILD);
    await screen.findByText(/#7 · Movie night/);
    const labels = ['Approve', 'Deny', 'Implemented', 'Considering', 'Delete'];
    for (const name of labels) expect(screen.getAllByRole('button', { name }).length).toBe(2);
    fireEvent.click(screen.getAllByRole('button', { name: 'Deny' })[0]);
    const form = screen.getByLabelText(/Reason/).closest('form');
    fireEvent.click(within(form).getByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(decideSuggestion).toHaveBeenCalledWith(GUILD, 7, 'deny', ''));
  });

  it('deletes after confirming', async () => {
    deleteSuggestion.mockResolvedValue({ ok: true });
    getSuggestions.mockResolvedValue({ suggestions: [] });
    renderAtGuild(<Suggestions />, GUILD);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Delete' }))[0]);
    await waitFor(() => expect(deleteSuggestion).toHaveBeenCalledWith(GUILD, 7));
    expect(confirmDialog).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Nothing here yet.')).toBeTruthy();
  });

  it('does nothing when the confirmation is declined', async () => {
    confirmDialog.mockResolvedValue(false);
    renderAtGuild(<Suggestions />, GUILD);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Delete' }))[0]);
    await waitFor(() => expect(confirmDialog).toHaveBeenCalled());
    expect(deleteSuggestion).not.toHaveBeenCalled();
  });
});
