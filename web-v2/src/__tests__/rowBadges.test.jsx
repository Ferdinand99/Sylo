import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Reminders from '../moduleForms/Reminders.jsx';
import ChannelCleanup from '../moduleForms/ChannelCleanup.jsx';
import GithubAlerts from '../moduleForms/GithubAlerts.jsx';
import Verification from '../moduleForms/Verification.jsx';
import Messages from '../pages/Messages.jsx';
import { resetModuleLimits } from '../components/useModuleLimits.js';
import { renderAtGuild } from './routerHarness.jsx';

vi.mock('../api.js', () => ({
  ApiError: class ApiError extends Error {},
  getModuleConfig: vi.fn(),
  saveModuleConfig: vi.fn(),
  getModuleLimits: vi.fn(),
  getReminders: vi.fn(),
  getCleanupSchedules: vi.fn(),
  getGithubWatches: vi.fn(),
  getComposedMessages: vi.fn(),
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
  createGithubWatch: vi.fn(),
  updateGithubWatch: vi.fn(),
  deleteGithubWatch: vi.fn(),
  toggleGithubWatch: vi.fn(),
  regenGithubSecret: vi.fn(),
  unpublishComposedMessage: vi.fn(),
  deleteComposedMessage: vi.fn(),
}));
vi.mock('../notify.js', () => ({ notify: vi.fn() }));
vi.mock('../components/ConfirmDialog.jsx', () => ({ confirmDialog: vi.fn().mockResolvedValue(true) }));
const api = await import('../api.js');

const GUILD = '123456789012345678';
const CHANNELS = [{ id: '222222222222222222', name: 'general' }];

beforeEach(() => {
  vi.resetAllMocks();
  resetModuleLimits();
  api.getModuleLimits.mockResolvedValue({ _embed: {} });
});

const pills = () => [...document.querySelectorAll('.v2-status-pill')].map((p) => p.textContent);

describe('Active / Paused badges', () => {
  it('shows one on each reminder', async () => {
    const base = {
      channelId: CHANNELS[0].id,
      mode: 'multiple',
      intervalMinutes: 60,
      days: [0, 1, 2, 3, 4, 5, 6],
    };
    api.getReminders.mockResolvedValue({
      channels: CHANNELS,
      schedulePresets: [[60, 'Every hour']],
      weekdays: [],
      allowPings: false,
      reminders: [
        { ...base, id: 1, name: 'Stretch', enabled: true },
        { ...base, id: 2, name: 'Water', enabled: false },
      ],
    });
    renderAtGuild(<Reminders />, GUILD);
    await screen.findByText(/Stretch/);
    expect(pills()).toEqual(['Active', 'Paused']);
  });

  it('shows one on each cleanup schedule', async () => {
    const base = { channelId: CHANNELS[0].id, days: [1], timeHhmm: '04:00', maxAgeHours: 24 };
    api.getCleanupSchedules.mockResolvedValue({
      channels: CHANNELS,
      schedules: [
        { ...base, id: 1, enabled: true },
        { ...base, id: 2, enabled: false },
      ],
    });
    renderAtGuild(<ChannelCleanup />, GUILD);
    await waitFor(() => expect(pills()).toHaveLength(2));
    expect(pills()).toEqual(['Active', 'Paused']);
  });

  it('shows one on each watched repo', async () => {
    const base = { channelId: CHANNELS[0].id, roleId: '', changelogPath: '', events: [] };
    api.getGithubWatches.mockResolvedValue({
      channels: CHANNELS,
      roles: [],
      eventTypes: [],
      dashboardUrlSet: true,
      watches: [
        { ...base, id: 1, repo: 'a/one', enabled: true },
        { ...base, id: 2, repo: 'a/two', enabled: false },
      ],
    });
    renderAtGuild(<GithubAlerts />, GUILD);
    await waitFor(() => expect(pills()).toHaveLength(2));
    expect(pills()).toEqual(['Active', 'Paused']);
  });
});

describe('Embed messages', () => {
  it('has an Edit link to the message editor on every row', async () => {
    api.getComposedMessages.mockResolvedValue({
      items: [{ id: 7, name: 'Rules', published: true, channel: 'general', when: 'today' }],
    });
    renderAtGuild(<Messages />, GUILD);
    const edit = await screen.findByRole('link', { name: 'Edit' });
    expect(edit.getAttribute('href')).toBe(`/guilds/${GUILD}/messages/7`);
  });
});

describe('Verification', () => {
  const load = (kickAfterMinutes) =>
    api.getModuleConfig.mockResolvedValue({
      config: {
        mode: 'button',
        verifiedRoleId: '',
        channelId: '',
        title: 't',
        message: 'm',
        successMessage: 's',
        logChannelId: '',
        kickAfterMinutes,
      },
      modes: ['button', 'captcha'],
      roles: [],
      channels: CHANNELS,
      turnstileEnabled: true,
    });

  it('reads the kick time out in words', async () => {
    load(1440);
    renderAtGuild(<Verification />, GUILD);
    expect(await screen.findByText(/That is 24 hours\./)).toBeTruthy();
  });

  it('says plainly that 0 means nobody is kicked', async () => {
    load(0);
    renderAtGuild(<Verification />, GUILD);
    expect(await screen.findByText(/0 means never: nobody is kicked/)).toBeTruthy();
  });
});
