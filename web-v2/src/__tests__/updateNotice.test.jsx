import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api.js', () => {
  class ApiError extends Error {
    constructor(message, { status, code } = {}) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return {
    ApiError,
    getUpdate: vi.fn(),
    approveUpdate: vi.fn(),
    getUpdateRun: vi.fn(),
    getAccount: vi.fn(),
  };
});
vi.mock('../components/ConfirmDialog.jsx', () => ({ confirmDialog: vi.fn().mockResolvedValue(true) }));

const api = await import('../api.js');
const { confirmDialog } = await import('../components/ConfirmDialog.jsx');
const { default: UpdateNotice } = await import('../components/UpdateNotice.jsx');
const { default: UpdateBadge } = await import('../components/UpdateBadge.jsx');
const { describeRun, describeWrenUpdate, readStoredRun, resetUpdateStatusCache, syloIsDown, writeStoredRun } =
  await import('../updateModel.js');
const { resetOperatorCache } = await import('../useOperator.js');

const status = (over = {}) => ({
  enabled: true,
  current: '5.2.0',
  latest: '5.3.0',
  available: true,
  checkedAt: '2026-11-16T10:00:00.000Z',
  checkFailed: false,
  releaseUrl: 'https://github.com/Ferdinand99/Sylo/releases/tag/v5.3.0',
  publishedAt: null,
  notes: {
    version: '5.3.0',
    date: '2026-11-20',
    url: null,
    sections: [
      {
        title: 'New',
        kind: 'features',
        items: [
          {
            scope: 'dashboard',
            text: 'The update notice, with [a good link](https://example.com/ok) and [a bad one](javascript:alert(1))',
            refs: [{ label: '#370', url: 'https://github.com/Ferdinand99/Sylo/issues/370' }],
          },
        ],
      },
    ],
  },
  notesText: null,
  command: 'docker compose pull && docker compose up -d',
  wren: null,
  ...over,
});

const wrenState = (over = {}) => ({
  configured: true,
  error: null,
  target: { name: 'sylo', server: 'docker-1', status: 'update', mode: 'approve', latestVersion: '5.3.0' },
  updateSeen: true,
  canApprove: true,
  whyNot: null,
  latestRun: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  resetUpdateStatusCache();
  resetOperatorCache();
  writeStoredRun(null);
  confirmDialog.mockResolvedValue(true);
});
afterEach(() => vi.useRealTimers());

describe('the words for a Wise Wren run', () => {
  it('names each state and whether it is going well', () => {
    expect(describeRun({ status: 'queued' }).tone).toBe('working');
    expect(describeRun({ status: 'succeeded' }).tone).toBe('success');
    for (const s of ['rolled_back', 'failed', 'rollback_failed', 'refused', 'cancelled', 'lapsed']) {
      expect(describeRun({ status: s }).tone, s).toBe('failure');
    }
    expect(describeRun({ status: 'rollback_failed' }).text).toMatch(/Wise Wren now/);
    const running = describeRun({
      status: 'running',
      steps: [
        { step: 'preflight', status: 'ok' },
        { step: 'stop', status: 'running' },
      ],
    });
    expect(running.step).toBe('Stopping Sylo');
    expect(describeRun({ status: 'running', steps: [{ step: 'newstep', status: 'running' }] }).step).toBe(
      'newstep'
    );
  });

  it('tells Sylo being down from Wise Wren saying no', () => {
    expect(syloIsDown(new TypeError('Failed to fetch'))).toBe(true);
    expect(syloIsDown({ status: 502 })).toBe(true);
    expect(syloIsDown({ status: 503, code: undefined })).toBe(true);
    expect(syloIsDown({ status: 502, code: 'wren_unreachable' })).toBe(false);
    expect(syloIsDown({ status: 404, code: 'wren_not_found' })).toBe(false);
  });

  it('keeps the run for this tab', () => {
    expect(readStoredRun()).toBeNull();
    writeStoredRun({ id: 12, from: '5.2.0' });
    expect(readStoredRun()).toEqual({ id: 12, from: '5.2.0' });
    sessionStorage.setItem('sylo:v2:updateRun', '{"id":"x"}');
    expect(readStoredRun()).toBeNull();
  });
});

describe('the words for what Wise Wren has an update for', () => {
  const target = { name: 'sylo', server: 'docker-1', latestVersion: null };
  const parts = (over) => ({ sylo: false, database: [], other: [], ...over });

  it('names the database container and says Sylo itself is current', () => {
    const d = describeWrenUpdate(target, parts({ database: ['sylo-postgres'] }));
    expect(d.text).toBe(
      'Wise Wren sees an update for the database container (sylo-postgres) on docker-1. Sylo itself is up to date.'
    );
    expect(d.button).toBe('Update the database');
    expect(d.syloCurrent).toBe(true);
  });

  it('names Sylo, or Sylo and the database, and keeps Update now', () => {
    expect(describeWrenUpdate(target, parts({ sylo: true })).text).toBe(
      'Wise Wren sees an update for Sylo ("sylo") on docker-1.'
    );
    const both = describeWrenUpdate(target, parts({ sylo: true, database: ['sylo-postgres'] }));
    expect(both.text).toBe(
      'Wise Wren sees updates for Sylo ("sylo") and the database container (sylo-postgres) on docker-1.'
    );
    expect(both.button).toBe('Update now');
    expect(both.syloCurrent).toBe(false);
  });

  it('handles other containers, and a key it cannot read', () => {
    const other = describeWrenUpdate(target, parts({ other: ['cache'] }));
    expect(other.text).toMatch(/for the container cache on docker-1\. Sylo itself is up to date\.$/);
    expect(other.button).toBe('Update containers');
    expect(describeWrenUpdate({ ...target, latestVersion: '5.3.0' }, null).text).toBe(
      'Wise Wren sees 5.3.0 for "sylo" on docker-1.'
    );
  });
});

describe('UpdateNotice', () => {
  it('says Sylo is up to date, with no command, and no Wise Wren section without it', async () => {
    api.getUpdate.mockResolvedValue(status({ available: false, latest: '5.2.0', notes: null }));
    render(<UpdateNotice />);
    expect(await screen.findByText(/Sylo 5\.2\.0 is up to date/)).toBeTruthy();
    expect(screen.queryByText(/docker compose pull/)).toBeNull();
    expect(screen.queryByText('Wise Wren')).toBeNull();
  });

  it('shows a new release with its notes, https links only, and the command to copy', async () => {
    api.getUpdate.mockResolvedValue(status());
    const { container } = render(<UpdateNotice />);
    expect(await screen.findByText(/Sylo 5\.3\.0 is available/)).toBeTruthy();
    expect(screen.getByText('docker compose pull && docker compose up -d')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Copy/ })).toBeTruthy();
    const links = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(links).toContain('https://example.com/ok');
    expect(links).toContain('https://github.com/Ferdinand99/Sylo/issues/370');
    expect(links.every((h) => h.startsWith('https://'))).toBe(true);
    expect(container.innerHTML).not.toMatch(/javascript:/);
    for (const a of container.querySelectorAll('a')) expect(a.getAttribute('rel')).toMatch(/noopener/);
    // Without Wise Wren, the page points at it.
    expect(screen.getByRole('link', { name: 'Wise Wren' }).getAttribute('href')).toBe(
      'https://github.com/Ferdinand99/Wise-Wren'
    );
    expect(screen.queryByRole('button', { name: 'Update now' })).toBeNull();
  });

  it('renders notes that are not markup as text, never HTML', async () => {
    api.getUpdate.mockResolvedValue(
      status({ notes: null, notesText: 'Fixed <img src=x onerror=alert(1)> things' })
    );
    const { container } = render(<UpdateNotice />);
    await screen.findByText(/is available/);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('says so when the check is off or could not be made', async () => {
    api.getUpdate.mockResolvedValue(status({ enabled: false, available: false, latest: null, notes: null }));
    const first = render(<UpdateNotice />);
    expect(await screen.findByText(/update check is off \(UPDATE_CHECK=off\)/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull();
    first.unmount();
    resetUpdateStatusCache();
    api.getUpdate.mockResolvedValue(
      status({ available: false, latest: null, checkFailed: true, notes: null })
    );
    render(<UpdateNotice />);
    expect(await screen.findByText(/could not be checked/)).toBeTruthy();
  });

  it('Check again asks the server to look again', async () => {
    api.getUpdate.mockResolvedValue(status({ available: false, latest: '5.2.0', notes: null }));
    render(<UpdateNotice />);
    fireEvent.click(await screen.findByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(api.getUpdate).toHaveBeenLastCalledWith({ refresh: true }));
  });

  it('renders nothing for a refused (non-operator) read and a quiet line for a failed one', async () => {
    api.getUpdate.mockRejectedValue(Object.assign(new api.ApiError('no', { status: 403 }), {}));
    const first = render(<UpdateNotice />);
    await waitFor(() => expect(api.getUpdate).toHaveBeenCalled());
    expect(first.container.textContent).toBe('');
    first.unmount();
    resetUpdateStatusCache();
    api.getUpdate.mockRejectedValue(new api.ApiError('down', { status: 500 }));
    render(<UpdateNotice />);
    expect(await screen.findByText(/Could not read the update status/)).toBeTruthy();
  });

  it('offers Update now with Wise Wren, asks first, and starts the run', async () => {
    api.getUpdate.mockResolvedValue(status({ wren: wrenState() }));
    api.approveUpdate.mockResolvedValue({ runId: 12, status: 'queued', from: '5.2.0' });
    api.getUpdateRun.mockResolvedValue({
      run: { id: 12, status: 'queued', finished: false, ok: false, steps: [] },
    });
    render(<UpdateNotice />);
    expect(await screen.findByText('Wise Wren sees 5.3.0 for "sylo" on docker-1.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Update now' }));
    await waitFor(() => expect(api.approveUpdate).toHaveBeenCalledTimes(1));
    expect(confirmDialog).toHaveBeenCalledTimes(1);
    expect(confirmDialog.mock.calls[0][0].title).toMatch(/Update Sylo to 5\.3\.0/);
    expect(await screen.findByText(/Waiting for the Wise Wren agent/)).toBeTruthy();
    expect(readStoredRun()).toEqual({ id: 12, from: '5.2.0' });
    expect(screen.queryByRole('button', { name: 'Update now' })).toBeNull();
  });

  it('says the update is for the database, not Sylo, and hints at the snapshot', async () => {
    const updates = { sylo: false, database: ['sylo-postgres'], other: [] };
    api.getUpdate.mockResolvedValue(
      status({
        current: '5.3.0',
        available: false,
        latest: '5.3.0',
        notes: null,
        wren: wrenState({
          target: { name: 'sylo', server: 'docker-1', status: 'update', updates, requireSnapshot: false },
        }),
      })
    );
    api.approveUpdate.mockResolvedValue({ runId: 12, status: 'queued', from: '5.3.0' });
    api.getUpdateRun.mockResolvedValue({
      run: { id: 12, status: 'queued', finished: false, ok: false, steps: [] },
    });
    render(<UpdateNotice />);
    expect(
      await screen.findByText(
        /for the database container \(sylo-postgres\) on docker-1\. Sylo itself is up to date\./
      )
    ).toBeTruthy();
    expect(screen.getByText(/Turn on "Require snapshot" in Wise Wren/)).toBeTruthy();
    expect(screen.queryByText("What's in this release")).toBeNull();
    expect(screen.queryByRole('button', { name: 'Update now' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Update the database' }));
    await waitFor(() => expect(api.approveUpdate).toHaveBeenCalledTimes(1));
    expect(confirmDialog.mock.calls[0][0].title).toBe('Update the database?');
    expect(confirmDialog.mock.calls[0][0].confirmLabel).toBe('Update the database');
  });

  it('shows no snapshot hint when Wise Wren requires one, or when the update is only Sylo', async () => {
    const dbOnly = { sylo: false, database: ['sylo-postgres'], other: [] };
    api.getUpdate.mockResolvedValue(
      status({
        wren: wrenState({
          target: {
            name: 'sylo',
            server: 'docker-1',
            status: 'update',
            updates: dbOnly,
            requireSnapshot: true,
          },
        }),
      })
    );
    const first = render(<UpdateNotice />);
    await screen.findByText(/database container/);
    expect(screen.queryByText(/Require snapshot/)).toBeNull();
    first.unmount();
    resetUpdateStatusCache();
    api.getUpdate.mockResolvedValue(
      status({
        wren: wrenState({
          target: {
            name: 'sylo',
            server: 'docker-1',
            status: 'update',
            updates: { sylo: true, database: [], other: [] },
            requireSnapshot: false,
          },
        }),
      })
    );
    render(<UpdateNotice />);
    await screen.findByText(/an update for Sylo \("sylo"\)/);
    expect(screen.queryByText(/Require snapshot/)).toBeNull();
  });

  it('does not start anything when the confirmation is declined', async () => {
    confirmDialog.mockResolvedValue(false);
    api.getUpdate.mockResolvedValue(status({ wren: wrenState() }));
    render(<UpdateNotice />);
    fireEvent.click(await screen.findByRole('button', { name: 'Update now' }));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalled());
    expect(api.approveUpdate).not.toHaveBeenCalled();
  });

  it('disables Update now and says why when Wise Wren would refuse; shows a refusal from the server', async () => {
    api.getUpdate.mockResolvedValue(
      status({ wren: wrenState({ canApprove: false, whyNot: 'Wise Wren only notifies for this target.' }) })
    );
    render(<UpdateNotice />);
    const button = await screen.findByRole('button', { name: 'Update now' });
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/only notifies/)).toBeTruthy();
  });

  it('lets the long explanations wrap, so the variable names are readable in full', async () => {
    const whyNot =
      'Update now needs a dashboard login. Set up a login, or set WISE_WREN_ALLOW_OPEN_MODE=true if you accept it.';
    api.getUpdate.mockResolvedValue(status({ wren: wrenState({ canApprove: false, whyNot }) }));
    const first = render(<UpdateNotice />);
    const hint = await screen.findByText(/WISE_WREN_ALLOW_OPEN_MODE=true/);
    expect(hint.classList.contains('is-wrap')).toBe(true);
    first.unmount();
    resetUpdateStatusCache();
    api.getUpdate.mockResolvedValue(status());
    render(<UpdateNotice />);
    const tip = await screen.findByText(/Set WISE_WREN_URL, WISE_WREN_TOKEN/);
    expect(tip.closest('p').classList.contains('is-wrap')).toBe(true);
  });

  it('tells the operator what to check when Wise Wren is not reachable, and offers Try again', async () => {
    api.getUpdate.mockResolvedValue(
      status({
        wren: wrenState({
          target: null,
          canApprove: false,
          error: { code: 'wren_unreachable', message: 'Wise Wren is not reachable.' },
        }),
      })
    );
    render(<UpdateNotice />);
    expect(await screen.findByText('Wise Wren is not reachable.')).toBeTruthy();
    expect(screen.getByText(/Check WISE_WREN_URL and that Wise Wren is running/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(api.getUpdate).toHaveBeenLastCalledWith({ refresh: true }));
  });

  it('shows what the server says when the approval fails', async () => {
    api.getUpdate.mockResolvedValue(status({ wren: wrenState() }));
    api.approveUpdate.mockRejectedValue(
      new api.ApiError('Wise Wren did not accept the token.', { status: 502, code: 'wren_unauthorized' })
    );
    render(<UpdateNotice />);
    fireEvent.click(await screen.findByRole('button', { name: 'Update now' }));
    expect(await screen.findByText(/did not accept the token/)).toBeTruthy();
    expect(readStoredRun()).toBeNull();
  });

  it('follows the update through the restart and shows the new version', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    writeStoredRun({ id: 12, from: '5.2.0' });
    api.getUpdate.mockResolvedValueOnce(
      status({ wren: wrenState({ latestRun: { id: 12, finished: false } }) })
    );
    api.getUpdateRun
      // Wise Wren is stopping Sylo...
      .mockResolvedValueOnce({
        run: {
          id: 12,
          status: 'running',
          finished: false,
          ok: false,
          steps: [{ step: 'stop', status: 'running' }],
        },
      })
      // ...Sylo is down: the request never gets an answer, and then a proxy error...
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new api.ApiError('Unexpected response (HTTP 502)', { status: 502 }))
      // ...and back, with the run finished.
      .mockResolvedValue({
        run: { id: 12, status: 'succeeded', finished: true, ok: true, steps: [] },
      });
    api.getUpdate.mockResolvedValue(
      status({ current: '5.3.0', available: false, latest: '5.3.0', notes: null, wren: wrenState() })
    );

    render(<UpdateNotice />);
    expect(await screen.findByText(/Now: Stopping Sylo/)).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(await screen.findByText(/Sylo is restarting/)).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(screen.getByText(/Sylo is restarting/)).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(await screen.findByText(/Sylo is now on 5\.3\.0/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
    expect(readStoredRun()).toBeNull();
    const calls = api.getUpdateRun.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(api.getUpdateRun.mock.calls.length).toBe(calls);
  });

  it('shows a failed run and stops asking', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    writeStoredRun({ id: 12, from: '5.2.0' });
    api.getUpdate.mockResolvedValue(status({ wren: wrenState() }));
    api.getUpdateRun.mockResolvedValue({
      run: { id: 12, status: 'rolled_back', finished: true, ok: false, steps: [] },
    });
    render(<UpdateNotice />);
    expect(await screen.findByText(/Wise Wren rolled back/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
    const calls = api.getUpdateRun.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(api.getUpdateRun.mock.calls.length).toBe(calls);
  });

  it('picks up an update that is already running in Wise Wren', async () => {
    api.getUpdate.mockResolvedValue(
      status({ wren: wrenState({ latestRun: { id: 31, status: 'running', finished: false } }) })
    );
    api.getUpdateRun.mockResolvedValue({
      run: { id: 31, status: 'running', finished: false, ok: false, steps: [] },
    });
    render(<UpdateNotice />);
    expect(await screen.findByText(/Wise Wren is updating Sylo/)).toBeTruthy();
    expect(api.getUpdateRun).toHaveBeenCalledWith(31);
  });
});

describe('UpdateBadge', () => {
  const inShell = (ui) => render(<MemoryRouter>{ui}</MemoryRouter>);

  it('shows a pill linking to the Health page for an operator when a release is out', async () => {
    api.getAccount.mockResolvedValue({ operator: true });
    api.getUpdate.mockResolvedValue(status());
    inShell(<UpdateBadge />);
    const pill = await screen.findByText('Update available');
    expect(pill.getAttribute('href')).toBe('/health#update');
    expect(pill.getAttribute('title')).toBe('Sylo 5.3.0 is available');
    expect(pill.getAttribute('aria-label')).toBe('Sylo 5.3.0 is available. Open Health');
  });

  it('asks nothing and shows nothing for someone who is not an operator', async () => {
    api.getAccount.mockResolvedValue({ operator: false });
    api.getUpdate.mockResolvedValue(status());
    const { container } = inShell(<UpdateBadge />);
    await waitFor(() => expect(api.getAccount).toHaveBeenCalled());
    await act(async () => {});
    expect(container.textContent).toBe('');
    expect(api.getUpdate).not.toHaveBeenCalled();
  });

  it('shows nothing when Sylo is up to date or the check failed', async () => {
    api.getAccount.mockResolvedValue({ operator: true });
    api.getUpdate.mockResolvedValue(status({ available: false }));
    const first = inShell(<UpdateBadge />);
    await waitFor(() => expect(api.getUpdate).toHaveBeenCalled());
    await act(async () => {});
    expect(first.container.textContent).toBe('');
    first.unmount();
    resetUpdateStatusCache();
    api.getUpdate.mockRejectedValue(new Error('x'));
    const second = inShell(<UpdateBadge />);
    await act(async () => {});
    expect(second.container.textContent).toBe('');
  });
});
