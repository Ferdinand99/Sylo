import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Events from '../moduleForms/Events.jsx';
import { resetModuleLimits } from '../components/useModuleLimits.js';
import { renderAtGuild } from './routerHarness.jsx';

vi.mock('../api.js', () => ({
  ApiError: class ApiError extends Error {},
  getModuleConfig: vi.fn(),
  saveModuleConfig: vi.fn(),
  getModuleLimits: vi.fn(),
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  cancelEvent: vi.fn(),
}));
vi.mock('../components/ConfirmDialog.jsx', () => ({ confirmDialog: vi.fn().mockResolvedValue(true) }));
const { getModuleConfig, saveModuleConfig, getModuleLimits, createEvent, updateEvent, cancelEvent } =
  await import('../api.js');
const { confirmDialog } = await import('../components/ConfirmDialog.jsx');

const GUILD = '123456789012345678';
const CHANNEL = '555555555555555555';
const ROLE = '666666666666666666';

// What GET /api/v2/modules/limits answers for the events module (src/modules/events.js, LIMITS).
const limits = {
  events: {
    title: { maxLength: 100 },
    description: { maxLength: 2000 },
    location: { maxLength: 200 },
    imageUrl: { maxLength: 500 },
    capacity: { min: 1, max: 500 },
    reminderMinutes: { min: 5, max: 1440 },
    staffRoles: { maxItems: 25 },
  },
  _embed: {},
};

const event = (over = {}) => ({
  id: 7,
  title: 'Game night',
  description: '',
  location: 'Voice 1',
  imageUrl: '',
  startAt: Date.UTC(2030, 0, 5, 18, 0),
  endAt: null,
  start: '2030-01-05T19:00',
  end: '',
  timeZone: 'Europe/Oslo',
  capacity: 10,
  roleId: null,
  reminderMinutes: 60,
  channelId: CHANNEL,
  channel: 'general',
  state: 'scheduled',
  joined: 3,
  maybe: 1,
  pagePath: null,
  pageHidden: false,
  ...over,
});

const load = (events) =>
  getModuleConfig.mockResolvedValue({
    config: {
      channel: '',
      reminderMinutes: 60,
      staffRoles: [],
      dmReminders: false,
      timeZone: '',
      publicPages: false,
    },
    channels: [{ id: CHANNEL, name: 'general' }],
    roles: [{ id: ROLE, name: 'Going' }],
    events,
  });

beforeEach(() => {
  vi.resetAllMocks();
  confirmDialog.mockResolvedValue(true);
  resetModuleLimits();
  getModuleLimits.mockResolvedValue(limits);
  load([event(), event({ id: 6, title: 'Old one', state: 'ended' })]);
});

describe('Events form', () => {
  it('lists upcoming and past events with their sign-up counts', async () => {
    renderAtGuild(<Events />, GUILD);
    expect(await screen.findByRole('heading', { name: 'Events' })).toBeTruthy();
    expect(screen.getByText(/#7 · Game night/)).toBeTruthy();
    expect(screen.getByText(/2030-01-05 19:00 Europe\/Oslo · #general · ✅ 3\/10 · ❔ 1/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Upcoming events (1)' })).toBeTruthy();
    expect(screen.getByText(/#6 · Old one/)).toBeTruthy();
    expect(screen.getByText(/ended · ✅ 3/)).toBeTruthy();
    expect(getModuleConfig).toHaveBeenCalledWith(GUILD, 'events');
  });

  it('the new-event form takes its limits from the server and defaults to the browser time zone', async () => {
    renderAtGuild(<Events />, GUILD);
    fireEvent.click(await screen.findByRole('button', { name: '+ New event' }));
    const title = screen.getByLabelText('Title');
    await waitFor(() => expect(title.maxLength).toBe(100));
    expect(screen.getByLabelText(/Description/).maxLength).toBe(2000);
    expect(screen.getByLabelText(/Where/).maxLength).toBe(200);
    expect(screen.getByLabelText(/Image/).maxLength).toBe(500);
    const capacity = screen.getByLabelText(/Capacity/);
    expect(capacity.min).toBe('1');
    expect(capacity.max).toBe('500');
    expect(screen.getByLabelText('Time zone').value).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    // reminder choices stay inside the server's range
    const options = [...screen.getByLabelText('Reminder').querySelectorAll('option')].map((o) => o.value);
    expect(options[0]).toBe('0');
    expect(options).toContain('1440');
    expect(options).not.toContain('2');
  });

  it('posts the new event with the typed times, zone, channel and role, then shows the answer', async () => {
    createEvent.mockResolvedValue({ events: [event({ id: 8, title: 'Quiz' }), event()] });
    renderAtGuild(<Events />, GUILD);
    fireEvent.click(await screen.findByRole('button', { name: '+ New event' }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Quiz' } });
    fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2030-02-01T20:00' } });
    fireEvent.change(screen.getByLabelText('Time zone'), { target: { value: 'Europe/Oslo' } });
    fireEvent.change(screen.getByLabelText('Post in'), { target: { value: CHANNEL } });
    fireEvent.change(screen.getByLabelText(/Participant role/), { target: { value: ROLE } });
    fireEvent.change(screen.getByLabelText(/Capacity/), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Post event' }));

    await waitFor(() => expect(createEvent).toHaveBeenCalledTimes(1));
    const [guild, body] = createEvent.mock.calls[0];
    expect(guild).toBe(GUILD);
    expect(body).toMatchObject({
      title: 'Quiz',
      start: '2030-02-01T20:00',
      timeZone: 'Europe/Oslo',
      channelId: CHANNEL,
      roleId: ROLE,
      capacity: 12,
      reminderMinutes: 60,
    });
    expect(await screen.findByText(/#8 · Quiz/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Post event' })).toBeNull();
  });

  it('an empty capacity is sent as "no limit"', async () => {
    createEvent.mockResolvedValue({ events: [event()] });
    renderAtGuild(<Events />, GUILD);
    fireEvent.click(await screen.findByRole('button', { name: '+ New event' }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'No cap' } });
    fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2030-02-01T20:00' } });
    fireEvent.change(screen.getByLabelText('Post in'), { target: { value: CHANNEL } });
    fireEvent.click(screen.getByRole('button', { name: 'Post event' }));
    await waitFor(() => expect(createEvent).toHaveBeenCalled());
    expect(createEvent.mock.calls[0][1].capacity).toBeNull();
  });

  it('edits an event in place with its stored values and no channel or role pickers', async () => {
    updateEvent.mockResolvedValue({ events: [event({ title: 'Renamed' })] });
    renderAtGuild(<Events />, GUILD);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('Title').value).toBe('Game night');
    expect(screen.getByLabelText('Starts').value).toBe('2030-01-05T19:00');
    expect(screen.getByLabelText('Time zone').value).toBe('Europe/Oslo');
    expect(screen.queryByLabelText('Post in')).toBeNull();
    expect(screen.queryByLabelText(/Participant role/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save event' }));
    await waitFor(() => expect(updateEvent).toHaveBeenCalledTimes(1));
    expect(updateEvent.mock.calls[0].slice(0, 2)).toEqual([GUILD, 7]);
    expect(updateEvent.mock.calls[0][2]).toMatchObject({
      title: 'Renamed',
      capacity: 10,
      start: '2030-01-05T19:00',
    });
    expect(await screen.findByText(/#7 · Renamed/)).toBeTruthy();
  });

  it('cancels an event after confirming', async () => {
    cancelEvent.mockResolvedValue({ events: [event({ state: 'cancelled' })] });
    renderAtGuild(<Events />, GUILD);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel event' }));
    await waitFor(() => expect(cancelEvent).toHaveBeenCalledWith(GUILD, 7));
    expect(confirmDialog).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/cancelled · ✅ 3/)).toBeTruthy();
  });
});

describe('Events public pages', () => {
  it('has an Event pages switch, off by default, that is saved with the other settings', async () => {
    saveModuleConfig.mockImplementation(async (_guild, _id, body) => ({ config: body }));
    renderAtGuild(<Events />, GUILD);
    const box = await screen.findByLabelText('Event pages');
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    fireEvent.click(screen.getAllByRole('button', { name: /Save/ })[0]);
    await waitFor(() =>
      expect(saveModuleConfig).toHaveBeenCalledWith(
        GUILD,
        'events',
        expect.objectContaining({ publicPages: true })
      )
    );
  });

  it('shows the links at once after saving the switch, and drops them when it is turned off', async () => {
    const path = '/events/0123456789abcdef0123456789abcdef';
    saveModuleConfig
      .mockImplementationOnce(async (_guild, _id, body) => ({
        config: body,
        events: [event({ pagePath: path })],
      }))
      .mockImplementationOnce(async (_guild, _id, body) => ({ config: body, events: [event()] }));
    renderAtGuild(<Events />, GUILD);
    fireEvent.click(await screen.findByLabelText('Event pages'));
    fireEvent.click(screen.getAllByRole('button', { name: /Save/ })[0]);
    const link = await screen.findByRole('link', { name: 'Public page' });
    expect(link.getAttribute('href')).toBe(`${window.location.origin}${path}`);

    fireEvent.click(screen.getByLabelText('Event pages'));
    fireEvent.click(screen.getAllByRole('button', { name: /Save/ })[0]);
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Public page' })).toBeNull());
  });

  it('says what the page shows and what it never shows', async () => {
    renderAtGuild(<Events />, GUILD);
    await screen.findByLabelText('Event pages');
    expect(screen.getByText(/no names, no host and no roles/i)).toBeTruthy();
    expect(screen.getByText(/without signing in/i)).toBeTruthy();
    expect(screen.getByText(/only people who sign in with Discord or Fluxer/i)).toBeTruthy();
    expect(screen.getByText(/age-restricted channel has no page/i)).toBeTruthy();
  });

  it('links each event to its page, and gives no link while pages are off', async () => {
    load([
      event({ pagePath: '/events/0123456789abcdef0123456789abcdef' }),
      event({
        id: 6,
        title: 'Old one',
        state: 'ended',
        pagePath: '/events/fedcba9876543210fedcba9876543210',
      }),
    ]);
    renderAtGuild(<Events />, GUILD);
    const links = await screen.findAllByRole('link', { name: 'Public page' });
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      `${window.location.origin}/events/0123456789abcdef0123456789abcdef`,
      `${window.location.origin}/events/fedcba9876543210fedcba9876543210`,
    ]);
  });

  it('shows no link when the event has no page', async () => {
    renderAtGuild(<Events />, GUILD);
    await screen.findByText(/#7 · Game night/);
    expect(screen.queryByRole('link', { name: 'Public page' })).toBeNull();
    expect(screen.queryByText(/not public/i)).toBeNull();
  });

  it('explains why an event in an age-restricted channel has no page', async () => {
    load([event({ pageHidden: true })]);
    renderAtGuild(<Events />, GUILD);
    expect(
      await screen.findByText(
        /No page: #general is age-restricted, Sylo cannot see it, or the dashboard has no login/
      )
    ).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Public page' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Members-only page' })).toBeNull();
  });

  it('links an event in a private channel to its members-only page, and says who can open it', async () => {
    load([
      event({ pagePath: '/events/0123456789abcdef0123456789abcdef', pageAudience: 'private' }),
      event({
        id: 6,
        title: 'Open one',
        pagePath: '/events/fedcba9876543210fedcba9876543210',
        pageAudience: 'public',
      }),
    ]);
    renderAtGuild(<Events />, GUILD);
    const members = await screen.findByRole('link', { name: 'Members-only page' });
    expect(members.getAttribute('href')).toBe(
      `${window.location.origin}/events/0123456789abcdef0123456789abcdef`
    );
    expect(screen.getByText(/opens for people who sign in and can see #general/)).toBeTruthy();
    const open = screen.getByRole('link', { name: 'Public page' });
    expect(open.getAttribute('href')).toBe(
      `${window.location.origin}/events/fedcba9876543210fedcba9876543210`
    );
  });
});
