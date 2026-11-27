import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TicketsInbox from '../pages/TicketsInbox.jsx';
import TicketView from '../pages/TicketView.jsx';
import AppealsReview from '../pages/AppealsReview.jsx';
import { AccessProvider } from '../access.jsx';

vi.mock('../api.js', () => ({
  ApiError: class ApiError extends Error {},
  getTickets: vi.fn(),
  getTicket: vi.fn(),
  pollTicket: vi.fn(),
  replyToTicket: vi.fn(),
  closeTicket: vi.fn(),
  ticketTranscriptUrl: (g, id) => `/api/v2/guilds/${g}/tickets/${id}/transcript`,
  getAppealsReview: vi.fn(),
  decideAppeal: vi.fn(),
  getGuildAccess: vi.fn(),
}));
vi.mock('../notify.js', () => ({ notify: vi.fn() }));
vi.mock('../components/ConfirmDialog.jsx', () => ({ confirmDialog: vi.fn().mockResolvedValue(true) }));
const api = await import('../api.js');
const { notify } = await import('../notify.js');

const GUILD = '123456789012345678';
const USER_ID = '800000000000000006';

function renderAt(path, pattern, element) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={pattern} element={element} />
      </Routes>
    </MemoryRouter>
  );
}

const ticket = (over = {}) => ({
  ticket: {
    id: 12,
    user: 'Mira',
    userId: USER_ID,
    status: 'open',
    openedAt: Date.UTC(2030, 0, 5),
    openedAgo: '2h ago',
    ...over,
  },
  messages: [],
  lastId: 0,
});

beforeEach(() => {
  vi.resetAllMocks();
  api.pollTicket.mockResolvedValue({ messages: [], status: 'open' });
});

describe('TicketsInbox', () => {
  it('links to the ticket settings, like Appeals links to its settings', async () => {
    api.getTickets.mockResolvedValue({ open: [], closed: [] });
    renderAt(`/guilds/${GUILD}/tickets`, 'guilds/:guildId/tickets', <TicketsInbox />);
    const link = await screen.findByRole('link', { name: /settings/i });
    expect(link.getAttribute('href')).toBe(`/guilds/${GUILD}/m/tickets`);
  });

  it('has no link to the ticket settings for Inbox access: that page is locked for them', async () => {
    api.getGuildAccess.mockResolvedValue({ level: 'inbox' });
    api.getTickets.mockResolvedValue({ open: [], closed: [] });
    renderAt(
      `/guilds/${GUILD}/tickets`,
      'guilds/:guildId/tickets',
      <AccessProvider guildId={GUILD} hint="inbox">
        <TicketsInbox />
      </AccessProvider>
    );
    await screen.findByRole('heading', { name: 'Tickets' });
    await waitFor(() => expect(api.getGuildAccess).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: /settings/i })).toBeNull();
  });
});

describe('TicketView', () => {
  const view = () =>
    renderAt(`/guilds/${GUILD}/tickets/12`, 'guilds/:guildId/tickets/:ticketId', <TicketView />);

  it('shows the name and the status first, with the ticket list as the parent in a breadcrumb', async () => {
    api.getTicket.mockResolvedValue(ticket());
    view();
    const title = await screen.findByRole('heading', { level: 1 });
    expect(title.textContent).toMatch(/Ticket #12/);
    expect(title.textContent).toMatch(/Mira/);
    expect(title.textContent).toMatch(/Open/);
    const crumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(crumb.querySelector('a').getAttribute('href')).toBe(`/guilds/${GUILD}/tickets`);
    expect(crumb.querySelector('[aria-current="page"]').textContent).toBe('#12');
    expect(screen.queryByText('← Tickets')).toBeNull();
  });

  it('keeps the raw user ID out of the header text; Copy user ID is in the "⋯" menu', async () => {
    const writeText = vi.fn().mockResolvedValue();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    api.getTicket.mockResolvedValue(ticket());
    view();
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByText(new RegExp(USER_ID))).toBeNull();
    expect(screen.queryByRole('button', { name: /Copy/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /More actions for ticket #12/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy user ID' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(USER_ID));
    await waitFor(() => expect(notify).toHaveBeenCalledWith('User ID copied.', 'info'));
  });

  it('does not show an unresolved name (the raw ID) as the member name', async () => {
    api.getTicket.mockResolvedValue(ticket({ user: USER_ID }));
    view();
    const title = await screen.findByRole('heading', { level: 1 });
    expect(title.textContent).not.toContain(USER_ID);
  });

  it('says Closed for a closed ticket', async () => {
    api.getTicket.mockResolvedValue(ticket({ status: 'closed' }));
    view();
    const title = await screen.findByRole('heading', { level: 1 });
    await waitFor(() => expect(title.textContent).toMatch(/Closed/));
  });
});

describe('AppealsReview', () => {
  it('Deny is a danger outline button, like Deny on an application', async () => {
    api.getAppealsReview.mockResolvedValue({
      moduleEnabled: true,
      configured: true,
      open: 1,
      appeals: [
        {
          id: 1,
          user: 'Kai',
          status: 'open',
          at: Date.UTC(2030, 0, 5),
          ago: '1h ago',
          banReason: 'spam',
          answers: [{ q: 'Why?', a: 'Sorry' }],
        },
      ],
    });
    renderAt(`/guilds/${GUILD}/appeals`, 'guilds/:guildId/appeals', <AppealsReview />);
    const deny = await screen.findByRole('button', { name: 'Deny' });
    expect(deny.className).toContain('v2-btn-danger-ghost');
    expect(screen.getByRole('link', { name: /Appeal settings/ }).getAttribute('href')).toBe(
      `/guilds/${GUILD}/m/appeals`
    );
  });

  it('has no link to the appeal settings for Inbox access, and tells them who can set it up', async () => {
    api.getGuildAccess.mockResolvedValue({ level: 'inbox' });
    api.getAppealsReview.mockResolvedValue({
      moduleEnabled: true,
      configured: false,
      open: 0,
      appeals: [],
    });
    renderAt(
      `/guilds/${GUILD}/appeals`,
      'guilds/:guildId/appeals',
      <AccessProvider guildId={GUILD} hint="inbox">
        <AppealsReview />
      </AccessProvider>
    );
    await screen.findByText(/No appeal questions are set up yet/);
    await waitFor(() => expect(api.getGuildAccess).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: /Appeal settings/ })).toBeNull();
    expect(screen.getByText(/Ask a server admin to set it up\./)).toBeTruthy();
  });
});
