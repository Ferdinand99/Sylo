import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Health from '../pages/Health.jsx';

vi.mock('../components/ConfirmDialog.jsx', () => ({ confirmDialog: vi.fn().mockResolvedValue(false) }));

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
const { getHealth, restoreBackup } = await import('../api.js');
const { confirmDialog } = await import('../components/ConfirmDialog.jsx');

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

describe('Health: stat tiles', () => {
  beforeEach(() => vi.clearAllMocks());

  it('names the lower tiles noun first, in sentence case', async () => {
    getHealth.mockResolvedValue({
      ...health(),
      stats: { warningsTotal: 0, warningsWeek: 0, composedTotal: 4, cachedLookups: 9 },
    });
    render(<Health />);
    expect(await screen.findByText('Composed messages')).toBeTruthy();
    expect(screen.getByText('Game stats cached')).toBeTruthy();
  });
});

describe('Health: gateway ping card', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the ping, and the graph only once there are two samples to draw', async () => {
    getHealth.mockResolvedValue({ ...health(), pingHistory: [38] });
    const first = render(<Health />);
    expect(await screen.findByText('40 ms')).toBeTruthy();
    expect(first.container.querySelector('.v2-ping-graph')).toBeNull();
    first.unmount();

    getHealth.mockResolvedValue({ ...health(), pingHistory: [38, 52, 40] });
    const second = render(<Health />);
    await screen.findByText('40 ms');
    expect(second.container.querySelector('.v2-ping-graph svg')).not.toBeNull();
  });
});

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

describe('Health: restoring an uploaded Postgres dump', () => {
  beforeEach(() => vi.clearAllMocks());

  const pgHealth = (db = {}) => ({
    ...health(),
    db: {
      ...health().db,
      postgres: true,
      roleRisks: [],
      roleDocsUrl: 'https://example.test/docs/postgres.md#least-privilege-database-role',
      ...db,
    },
    backups: [
      { name: 'sylo-imported-20261116.dump', size: '1 MB', ago: '1m ago' },
      { name: 'sylo-20261116.dump', size: '1 MB', ago: '2m ago' },
    ],
  });
  const restoreButtons = () => screen.getAllByRole('button', { name: 'Restore' });
  const dialogBody = (call) => render(<div>{confirmDialog.mock.calls[call][0].body}</div>);

  it('says the dump runs with the database role rights before an imported dump is restored', async () => {
    getHealth.mockResolvedValue(pgHealth({ roleRisks: ['SUPERUSER'] }));
    render(<Health />);
    await screen.findByText('sylo-imported-20261116.dump');
    fireEvent.click(restoreButtons()[0]);
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(1));
    const { container } = dialogBody(0);
    expect(container.textContent).toMatch(/This file was uploaded/);
    expect(container.textContent).toMatch(/runs that SQL with the rights of the database role/);
    // short and plain; the full list of rights is folded away, and the way out is not offered in the dialog
    expect(container.textContent).toMatch(/This role is a superuser\./);
    expect(container.querySelector('details')?.textContent).toMatch(/SUPERUSER/);
    expect(container.querySelector('a')).toBeNull();
  });

  it('shows the uploaded-file warning as a warning callout, not as plain text', async () => {
    getHealth.mockResolvedValue(pgHealth({ roleRisks: ['CREATEDB', 'CREATEROLE'] }));
    render(<Health />);
    await screen.findByText('sylo-imported-20261116.dump');
    fireEvent.click(restoreButtons()[0]);
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(1));
    const { container } = dialogBody(0);
    const callout = container.querySelector('.v2-callout.is-warning');
    expect(callout?.textContent).toMatch(/This file was uploaded/);
    expect(callout?.textContent).toMatch(/This role has more rights than it needs\./);
    expect(callout?.textContent).toMatch(/Rights: CREATEDB, CREATEROLE/);
  });

  it.each([
    [0, 'sylo-imported-20261116.dump', true],
    [1, 'sylo-20261116.dump', false],
  ])(
    'restore button %i sends the name, with acknowledgeSql %s only for an uploaded dump',
    async (index, name, ack) => {
      getHealth.mockResolvedValue(pgHealth());
      restoreBackup.mockResolvedValue({ ok: true });
      confirmDialog.mockResolvedValue(true);
      render(<Health />);
      await screen.findByText(name);
      fireEvent.click(restoreButtons()[index]);
      await waitFor(() => expect(restoreBackup).toHaveBeenCalledTimes(1));
      expect(restoreBackup).toHaveBeenLastCalledWith(name, { acknowledgeSql: ack });
      confirmDialog.mockResolvedValue(false);
    }
  );

  it('does not add that warning for a backup Sylo made itself', async () => {
    getHealth.mockResolvedValue(pgHealth());
    render(<Health />);
    await screen.findByText('sylo-20261116.dump');
    fireEvent.click(restoreButtons()[1]);
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(1));
    expect(dialogBody(0).container.textContent).not.toMatch(/This file was uploaded/);
  });

  it('shows a note on the page when the role is stronger than needed, and not otherwise', async () => {
    getHealth.mockResolvedValue(pgHealth({ roleRisks: ['SUPERUSER', 'CREATEDB'] }));
    const first = render(<Health />);
    const title = await screen.findByText(/more rights than Sylo needs/i);
    // a warning callout, the first thing in its section (before the database summary and the buttons)
    const callout = title.closest('.v2-callout');
    expect(callout?.classList.contains('is-warning')).toBe(true);
    const section = callout.parentElement;
    expect(section.querySelector('h2').textContent).toMatch(/Database/);
    expect(section.children[1]).toBe(callout);
    expect(callout.textContent).toMatch(/The role Sylo connects as is a superuser\./);
    expect(callout.querySelector('details')?.textContent).toMatch(/Rights: SUPERUSER, CREATEDB/);
    expect(callout.querySelector('a')?.getAttribute('href')).toMatch(/least-privilege-database-role/);
    first.unmount();

    getHealth.mockResolvedValue(pgHealth());
    render(<Health />);
    await screen.findByText('Dev-log channel');
    expect(screen.queryByText(/more rights than Sylo needs/i)).toBeNull();
  });
});
