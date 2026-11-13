import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Reminders from '../moduleForms/Reminders.jsx';
import ChannelCleanup from '../moduleForms/ChannelCleanup.jsx';
import { serverTimeNote, msToWallClock } from '../serverTime.js';
import { describeTime } from '../formatTime.js';
import { resetModuleLimits } from '../components/useModuleLimits.js';
import { renderAtGuild } from './routerHarness.jsx';

vi.mock('../api.js', () => ({
  ApiError: class ApiError extends Error {},
  getModuleLimits: vi.fn(),
  getReminders: vi.fn(),
  getCleanupSchedules: vi.fn(),
  createReminder: vi.fn(),
  updateReminder: vi.fn(),
  deleteReminder: vi.fn(),
  toggleReminder: vi.fn(),
  testReminder: vi.fn(),
  setReminderPings: vi.fn(),
  createCleanupSchedule: vi.fn(),
  updateCleanupSchedule: vi.fn(),
  deleteCleanupSchedule: vi.fn(),
  toggleCleanupSchedule: vi.fn(),
}));
vi.mock('../notify.js', () => ({ notify: vi.fn() }));
const api = await import('../api.js');

const GUILD = '123456789012345678';
const CHANNELS = [{ id: '222222222222222222', name: 'general' }];
const WEEKDAYS = [
  [1, 'Mon'],
  [2, 'Tue'],
];

beforeEach(() => {
  vi.resetAllMocks();
  resetModuleLimits();
  api.getModuleLimits.mockResolvedValue({ _embed: {} });
});

describe('serverTimeNote', () => {
  it('names the zone, or says nothing when the server did not', () => {
    expect(serverTimeNote('Europe/Oslo')).toBe(' (server time: Europe/Oslo)');
    expect(serverTimeNote(undefined)).toBe('');
    expect(serverTimeNote(null)).toBe('');
    expect(serverTimeNote('  ')).toBe('');
  });
});

describe('server time next to schedules', () => {
  const cleanup = (timeZone) => ({
    channels: CHANNELS,
    weekdays: WEEKDAYS,
    timeZone,
    schedules: [
      { id: 1, channelId: CHANNELS[0].id, days: [1], timeHhmm: '04:00', maxAgeHours: 24, enabled: true },
    ],
  });

  it('shows the zone on a cleanup schedule', async () => {
    api.getCleanupSchedules.mockResolvedValue(cleanup('Europe/Oslo'));
    renderAtGuild(<ChannelCleanup />, GUILD);
    expect(await screen.findByText(/Mon at 04:00 \(server time: Europe\/Oslo\)/)).toBeTruthy();
  });

  it('shows nothing extra on a cleanup schedule when the server does not say', async () => {
    api.getCleanupSchedules.mockResolvedValue(cleanup(undefined));
    renderAtGuild(<ChannelCleanup />, GUILD);
    expect(await screen.findByText(/Mon at 04:00/)).toBeTruthy();
    expect(screen.queryByText(/server time:/)).toBeNull();
  });

  it('shows the zone on a reminder that runs on chosen weekdays', async () => {
    api.getReminders.mockResolvedValue({
      channels: CHANNELS,
      schedulePresets: [[60, 'Every hour']],
      weekdays: WEEKDAYS,
      allowPings: false,
      timeZone: 'Europe/Oslo',
      reminders: [
        {
          id: 1,
          name: 'Stretch',
          channelId: CHANNELS[0].id,
          mode: 'multiple',
          intervalMinutes: 60,
          days: [1],
          enabled: true,
        },
      ],
    });
    renderAtGuild(<Reminders />, GUILD);
    expect(await screen.findByText(/every hour · Mon \(server time: Europe\/Oslo\)/)).toBeTruthy();
  });
});

// Zones with no daylight saving, 25 hours apart: the browser cannot be in both, so one of them always
// differs from the zone this test runs in.
const BROWSER_ZONE = new Intl.DateTimeFormat().resolvedOptions().timeZone;
const SERVER_ZONE = BROWSER_ZONE === 'Pacific/Kiritimati' ? 'Pacific/Pago_Pago' : 'Pacific/Kiritimati';
const SERVER_OFFSET_HOURS = SERVER_ZONE === 'Pacific/Kiritimati' ? 14 : -11;

// 2026-11-13 23:30 UTC, written on the server's clock.
const INSTANT = Date.UTC(2026, 10, 13, 23, 30);
const START = Date.UTC(2026, 10, 14, 6, 0);
const END = Date.UTC(2026, 10, 20, 6, 0);
const wallText = (ms) => new Date(ms + SERVER_OFFSET_HOURS * 3_600_000).toISOString().slice(0, 16);
// What the server does with typed text: reads it as wall-clock time in its own zone.
const serverParses = (text) => Date.parse(`${text}:00Z`) - SERVER_OFFSET_HOURS * 3_600_000;

describe('msToWallClock', () => {
  it('writes an instant on the wall clock of the given zone', () => {
    expect(msToWallClock(INSTANT, 'Europe/Oslo')).toBe('2026-11-14T00:30');
    expect(msToWallClock(INSTANT, 'America/New_York')).toBe('2026-11-13T18:30');
    expect(msToWallClock(INSTANT, 'Pacific/Kiritimati')).toBe('2026-11-14T13:30');
    expect(msToWallClock(INSTANT, 'Pacific/Pago_Pago')).toBe('2026-11-13T12:30');
  });

  it('writes midnight as 00:00, not 24:00', () => {
    expect(msToWallClock(Date.UTC(2026, 10, 13, 23, 0), 'Europe/Oslo')).toBe('2026-11-14T00:00');
  });

  it('keeps the browser clock without a usable zone', () => {
    const d = new Date(INSTANT);
    const pad = (n) => String(n).padStart(2, '0');
    const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    expect(msToWallClock(INSTANT, undefined)).toBe(local);
    expect(msToWallClock(INSTANT, 'Not/AZone')).toBe(local);
  });

  it('is empty for no time', () => {
    expect(msToWallClock(null, 'Europe/Oslo')).toBe('');
  });
});

describe('reminder time inputs on the server clock', () => {
  const reminder = (extra) => ({
    id: 1,
    name: 'Stretch',
    channelId: CHANNELS[0].id,
    mode: 'multiple',
    intervalMinutes: 60,
    days: [0, 1, 2, 3, 4, 5, 6],
    enabled: true,
    spec: { content: 'hi' },
    startAt: null,
    endAt: null,
    runAt: null,
    ...extra,
  });
  const list = (reminders, timeZone) => ({
    channels: CHANNELS,
    schedulePresets: [[60, 'Every hour']],
    weekdays: WEEKDAYS,
    allowPings: false,
    timeZone,
    reminders,
  });
  const openEdit = async (name) => {
    await screen.findByText(name);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  };
  const timeInputs = () => [...document.querySelectorAll('input[type="datetime-local"]')];

  it('the server zone differs from the browser zone in this test', () => {
    expect(SERVER_ZONE).not.toBe(BROWSER_ZONE);
  });

  it('pre-fills send-once, start and end on the server clock', async () => {
    api.getReminders.mockResolvedValue(
      list([reminder({ mode: 'single', runAt: INSTANT, startAt: START, endAt: END })], SERVER_ZONE)
    );
    renderAtGuild(<Reminders />, GUILD);
    await openEdit('Stretch');
    expect(timeInputs().map((i) => i.value)).toEqual([wallText(INSTANT)]);
    fireEvent.click(screen.getByRole('button', { name: 'Multiple' }));
    expect(timeInputs().map((i) => i.value)).toEqual([wallText(START), wallText(END)]);
  });

  it('shows a one-time reminder on the server clock in the list', async () => {
    api.getReminders.mockResolvedValue(list([reminder({ mode: 'single', runAt: INSTANT })], SERVER_ZONE));
    renderAtGuild(<Reminders />, GUILD);
    const expected = describeTime(INSTANT, { timeZone: SERVER_ZONE }).text;
    expect(await screen.findByText(`once, ${expected} (server time: ${SERVER_ZONE})`)).toBeTruthy();
  });

  it('saving an edit without touching the times sends the same instants back', async () => {
    api.getReminders.mockResolvedValue(list([reminder({ startAt: START, endAt: END })], SERVER_ZONE));
    api.updateReminder.mockResolvedValue({});
    renderAtGuild(<Reminders />, GUILD);
    await openEdit('Stretch');
    fireEvent.click(screen.getByRole('button', { name: 'Save & close' }));
    await waitFor(() => expect(api.updateReminder).toHaveBeenCalled());
    const body = api.updateReminder.mock.calls[0][2];
    expect(serverParses(body.startAt)).toBe(START);
    expect(serverParses(body.endAt)).toBe(END);
  });

  it('a one-time reminder survives an edit unchanged too', async () => {
    api.getReminders.mockResolvedValue(list([reminder({ mode: 'single', runAt: INSTANT })], SERVER_ZONE));
    api.updateReminder.mockResolvedValue({});
    renderAtGuild(<Reminders />, GUILD);
    await openEdit('Stretch');
    fireEvent.click(screen.getByRole('button', { name: 'Save & close' }));
    await waitFor(() => expect(api.updateReminder).toHaveBeenCalled());
    expect(serverParses(api.updateReminder.mock.calls[0][2].runAt)).toBe(INSTANT);
  });

  it('without a zone from the server, keeps the browser clock', async () => {
    api.getReminders.mockResolvedValue(list([reminder({ mode: 'single', runAt: INSTANT })], undefined));
    renderAtGuild(<Reminders />, GUILD);
    await openEdit('Stretch');
    expect(timeInputs().map((i) => i.value)).toEqual([msToWallClock(INSTANT, undefined)]);
  });
});
