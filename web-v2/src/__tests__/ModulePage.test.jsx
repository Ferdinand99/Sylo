import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate, useParams } from 'react-router-dom';
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

describe('ModulePage status bar edge cases', () => {
  it('blocked module: switch disabled, intent warning, no off notice, not plain "On"', async () => {
    const card = {
      id: 'auto-threads',
      name: 'Auto threads',
      enabled: true,
      hasToggle: true,
      missingIntents: ['MessageContent'],
      status: 'blocked',
    };
    getOverview.mockResolvedValue(overview(true, [card]));
    renderPage();

    const toggle = await screen.findByRole('switch', { name: 'Auto threads' });
    expect(toggle.disabled).toBe(true);
    expect(screen.getByText(/Needs the MessageContent intent/)).toBeTruthy();
    expect(screen.getByText('Blocked')).toBeTruthy();
    expect(screen.queryByText('On')).toBeNull();
    expect(screen.queryByText(OFF_NOTICE)).toBeNull();
  });

  it('a blocked module that is also off shows no "turn it on" notice', async () => {
    const card = {
      id: 'auto-threads',
      name: 'Auto threads',
      enabled: false,
      hasToggle: true,
      missingIntents: ['MessageContent'],
      status: 'blocked',
    };
    getOverview.mockResolvedValue(overview(false, [card]));
    renderPage();

    expect(await screen.findByText(/Needs the MessageContent intent/)).toBeTruthy();
    expect(screen.queryByText(OFF_NOTICE)).toBeNull();
  });

  it('shows no bar for a card without a toggle', async () => {
    const card = {
      id: 'auto-threads',
      name: 'Auto threads',
      enabled: true,
      hasToggle: false,
      missingIntents: [],
    };
    getOverview.mockResolvedValue(overview(true, [card]));
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Auto threads form' })).toBeTruthy();
    await waitFor(() => expect(getOverview).toHaveBeenCalled());
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('sends one save for a second click while the first is in flight', async () => {
    getOverview.mockResolvedValue(overview(false));
    let finish;
    setModuleEnabled.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    renderPage();
    const toggle = await screen.findByRole('switch', { name: 'Auto threads' });

    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('switch', { name: 'Auto threads' }));
    finish({});

    await waitFor(() => expect(screen.getByTestId('shared').textContent).toBe('on'));
    expect(setModuleEnabled).toHaveBeenCalledTimes(1);
  });

  it('announces the off notice in a polite live region', async () => {
    getOverview.mockResolvedValue(overview(false));
    renderPage();

    const notice = await screen.findByText(OFF_NOTICE);
    expect(notice.parentElement.getAttribute('aria-live')).toBe('polite');
  });

  it('shows no bar after a server switch until the new server overview has loaded', async () => {
    const OTHER = '222222222222222222';
    let loadOther;
    getOverview.mockImplementation((id) =>
      id === GUILD
        ? Promise.resolve(overview(false))
        : new Promise((resolve) => (loadOther = () => resolve(overview(true))))
    );
    setModuleEnabled.mockResolvedValue({});

    function ByRoute({ children }) {
      const { guildId } = useParams();
      return <OverviewProvider guildId={guildId}>{children}</OverviewProvider>;
    }
    function Switcher() {
      const navigate = useNavigate();
      return <button onClick={() => navigate(`/guilds/${OTHER}/m/auto-threads`)}>switch server</button>;
    }
    render(
      <MemoryRouter initialEntries={[`/guilds/${GUILD}/m/auto-threads`]}>
        <Switcher />
        <Routes>
          <Route
            path="guilds/:guildId/m/:moduleId"
            element={
              <ByRoute>
                <ModulePage />
              </ByRoute>
            }
          />
        </Routes>
      </MemoryRouter>
    );
    expect((await screen.findByRole('switch', { name: 'Auto threads' })).getAttribute('aria-checked')).toBe(
      'false'
    );

    fireEvent.click(screen.getByText('switch server'));

    // The first server's "off" must not show under the second server while its data loads.
    await waitFor(() => expect(getOverview).toHaveBeenCalledWith(OTHER));
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByText(OFF_NOTICE)).toBeNull();

    loadOther();
    const toggle = await screen.findByRole('switch', { name: 'Auto threads' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(setModuleEnabled).not.toHaveBeenCalled();
  });
});
