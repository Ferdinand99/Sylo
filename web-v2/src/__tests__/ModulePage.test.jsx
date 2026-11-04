import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ModulePage from '../pages/ModulePage.jsx';
import { OverviewProvider, useOverview } from '../OverviewContext.jsx';
import { subscribe } from '../notify.js';

vi.mock('../api.js', () => ({
  ApiError: class ApiError extends Error {},
  getOverview: vi.fn(),
  getPlatformInfo: vi.fn(),
  setModuleEnabled: vi.fn(),
}));
// A stand-in settings form: the shell is under test, not a module's form.
vi.mock('../moduleForms/index.js', () => ({
  MODULE_FORMS: { 'auto-threads': () => <h2>Auto threads form</h2> },
}));
const { getOverview, getPlatformInfo, setModuleEnabled } = await import('../api.js');

const GUILD = '123456789012345678';

const platform = (extra = {}) => ({
  platform: 'discord',
  capabilities: { nativeAutomod: true },
  notes: {},
  commandPrefix: '/',
  webAppUrl: 'https://discord.com',
  ...extra,
});

const overview = (enabled, cards) => ({
  groups: [
    {
      id: 'g',
      cards: cards ?? [
        { id: 'auto-threads', name: 'Auto threads', enabled, hasToggle: true, missingIntents: [] },
        { id: 'sticky', name: 'Sticky messages', enabled: true, hasToggle: true, missingIntents: [] },
      ],
    },
  ],
});

// Stands in for the sidebar: reads the same shared overview state.
function SharedState() {
  const { data } = useOverview();
  const card = data?.groups.flatMap((g) => g.cards).find((c) => c.id === 'auto-threads');
  return <output data-testid="shared">{card ? (card.enabled ? 'on' : 'off') : 'none'}</output>;
}

function renderPage(moduleId = 'auto-threads') {
  return render(
    <MemoryRouter initialEntries={[`/guilds/${GUILD}/m/${moduleId}`]}>
      <OverviewProvider guildId={GUILD}>
        <SharedState />
        <Routes>
          <Route path="guilds/:guildId/m/:moduleId" element={<ModulePage />} />
        </Routes>
      </OverviewProvider>
    </MemoryRouter>
  );
}

const OFF_NOTICE = 'This module is off. Turn it on for these settings to take effect.';

beforeEach(() => {
  vi.resetAllMocks();
  getPlatformInfo.mockResolvedValue(platform());
});

describe('ModulePage status bar', () => {
  it('shows an on module with its switch on and no off notice', async () => {
    getOverview.mockResolvedValue(overview(true));
    renderPage();

    const toggle = await screen.findByRole('switch', { name: 'Auto threads' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('On')).toBeTruthy();
    expect(screen.queryByText(OFF_NOTICE)).toBeNull();
    expect(screen.getByRole('heading', { name: 'Auto threads form' })).toBeTruthy();
  });

  it('shows an off module with its switch off and the off notice', async () => {
    getOverview.mockResolvedValue(overview(false));
    renderPage();

    const toggle = await screen.findByRole('switch', { name: 'Auto threads' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('Off')).toBeTruthy();
    expect(screen.getByText(OFF_NOTICE)).toBeTruthy();
  });

  it('turns the module on, updating the shared state and dropping the notice', async () => {
    getOverview.mockResolvedValue(overview(false));
    setModuleEnabled.mockResolvedValue({});
    renderPage();
    const toggle = await screen.findByRole('switch', { name: 'Auto threads' });
    expect(screen.getByTestId('shared').textContent).toBe('off');

    fireEvent.click(toggle);

    await waitFor(() => expect(screen.getByTestId('shared').textContent).toBe('on'));
    expect(setModuleEnabled).toHaveBeenCalledWith(GUILD, 'auto-threads', true);
    expect(screen.getByRole('switch', { name: 'Auto threads' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByText(OFF_NOTICE)).toBeNull();
  });

  it('turns the module off', async () => {
    getOverview.mockResolvedValue(overview(true));
    setModuleEnabled.mockResolvedValue({});
    renderPage();

    fireEvent.click(await screen.findByRole('switch', { name: 'Auto threads' }));

    await waitFor(() => expect(screen.getByTestId('shared').textContent).toBe('off'));
    expect(setModuleEnabled).toHaveBeenCalledWith(GUILD, 'auto-threads', false);
    expect(screen.getByText(OFF_NOTICE)).toBeTruthy();
  });

  it('flips back and shows the error when the save fails', async () => {
    getOverview.mockResolvedValue(overview(false));
    setModuleEnabled.mockRejectedValue(new Error('Could not save'));
    const toasts = [];
    const unsubscribe = subscribe((t) => toasts.push(t));
    renderPage();

    fireEvent.click(await screen.findByRole('switch', { name: 'Auto threads' }));

    await waitFor(() => expect(toasts).toEqual([{ message: 'Could not save', kind: 'error' }]));
    unsubscribe();
    expect(screen.getByTestId('shared').textContent).toBe('off');
    expect(screen.getByRole('switch', { name: 'Auto threads' }).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText(OFF_NOTICE)).toBeTruthy();
  });

  it('shows no bar when the module has no card in the overview', async () => {
    getOverview.mockResolvedValue(
      overview(true, [
        { id: 'sticky', name: 'Sticky messages', enabled: true, hasToggle: true, missingIntents: [] },
      ])
    );
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Auto threads form' })).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('shared').textContent).toBe('none'));
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByText(OFF_NOTICE)).toBeNull();
  });

  it('shows no bar, and does not crash, while the overview has not loaded', async () => {
    getOverview.mockReturnValue(new Promise(() => {}));
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Auto threads form' })).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByText(OFF_NOTICE)).toBeNull();
  });

  it('keeps the platform note under the bar', async () => {
    getOverview.mockResolvedValue(overview(false));
    getPlatformInfo.mockResolvedValue(
      platform({ platform: 'fluxer', notes: { 'auto-threads': 'Threads work differently here.' } })
    );
    renderPage();

    expect(await screen.findByText('Threads work differently here.')).toBeTruthy();
    expect(screen.getByText('Fluxer')).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Auto threads' })).toBeTruthy();
  });
});
