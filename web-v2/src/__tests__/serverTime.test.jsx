import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Reminders from '../moduleForms/Reminders.jsx';
import ChannelCleanup from '../moduleForms/ChannelCleanup.jsx';
import { serverTimeNote } from '../serverTime.js';
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
