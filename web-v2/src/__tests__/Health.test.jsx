import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Health from '../pages/Health.jsx';

vi.mock('../api.js', () => ({
  getHealth: vi.fn(),
  sendDevLogTest: vi.fn(),
  sendDevLogErrorTest: vi.fn(),
  createBackup: vi.fn(),
  deleteBackup: vi.fn(),
  restoreBackup: vi.fn(),
  importBackup: vi.fn(),
  backupDownloadUrl: vi.fn(),
  ApiError: class ApiError extends Error {},
}));
const { getHealth } = await import('../api.js');

function health(sessionSecret) {
  return {
    ready: true,
    botTag: 'Sylo#0001',
    version: '5.0.0',
    guildCount: 1,
    memberReach: 10,
    uptime: '1h',
    gatewayPing: 40,
    pingHistory: [],
    stats: { warningsTotal: 0, warningsWeek: 0 },
    modules: [],
    lastError: null,
    errors: [],
    botAudit: [],
    db: { size: '1 MB', wal: null, postgres: false, intervalHours: 24, retention: 7, offsite: null },
    backups: [],
    devLogConfigured: false,
    ...(sessionSecret ? { sessionSecret } : {}),
  };
}

describe('Health: session secret warning', () => {
  beforeEach(() => vi.clearAllMocks());

  it('warns when the secret only lives for this process', async () => {
    getHealth.mockResolvedValue(health('generated-ephemeral'));
    render(<Health />);
    expect(await screen.findByText(/could not save a session secret/i)).toBeTruthy();
  });

  it.each(['env', 'file', undefined])('shows no warning for %s', async (source) => {
    getHealth.mockResolvedValue(health(source));
    render(<Health />);
    await screen.findByText('Dev-log channel');
    expect(screen.queryByText(/session secret/i)).toBeNull();
  });
});
