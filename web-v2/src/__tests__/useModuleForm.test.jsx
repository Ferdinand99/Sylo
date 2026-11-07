import { act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useModuleForm } from '../components/useModuleForm.js';
import { renderAtGuild } from './routerHarness.jsx';

vi.mock('../api.js', () => ({
  getModuleConfig: vi.fn(),
  saveModuleConfig: vi.fn(),
}));
const { getModuleConfig, saveModuleConfig } = await import('../api.js');

const GUILD_A = '111111111111111111';
const GUILD_B = '222222222222222222';

// A form state that is not the API shape, so the test sees toForm/fromForm work.
const toForm = (config) => ({ greeting: config.greeting });
const fromForm = (form) => ({ greeting: form.greeting.trim() });

function Probe({ onRender }) {
  const m = useModuleForm('afk', { toForm, fromForm });
  onRender(m);
  return null;
}

function setup(guildId = GUILD_A) {
  let latest;
  const view = renderAtGuild(<Probe onRender={(m) => (latest = m)} />, guildId);
  return { ...view, m: () => latest };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('useModuleForm', () => {
  it('loads, goes dirty on an edit and saves fromForm(state)', async () => {
    getModuleConfig.mockResolvedValue({ config: { greeting: 'hello' } });
    saveModuleConfig.mockResolvedValue({ config: { greeting: 'hi there' } });
    const { m } = setup();

    expect(m().status).toBe('loading');
    await waitFor(() => expect(m().status).toBe('ready'));
    expect(getModuleConfig).toHaveBeenCalledWith(GUILD_A, 'afk');
    expect(m().form).toEqual({ greeting: 'hello' });
    expect(m().dirty).toBe(false);

    act(() => m().set({ greeting: '  hi there  ' }));
    expect(m().dirty).toBe(true);

    let ok;
    await act(async () => {
      ok = await m().save();
    });

    expect(ok).toBe(true);
    // The body is fromForm(state): trimmed, not the raw form text.
    expect(saveModuleConfig).toHaveBeenCalledTimes(1);
    expect(saveModuleConfig).toHaveBeenCalledWith(GUILD_A, 'afk', { greeting: 'hi there' });
    // The response config becomes the new baseline.
    expect(m().form).toEqual({ greeting: 'hi there' });
    expect(m().dirty).toBe(false);
  });

  it('refuses a save after the server changed, until the new server has loaded (loadedFor guard)', async () => {
    getModuleConfig.mockResolvedValueOnce({ config: { greeting: 'from A' } });
    const { m, router } = setup(GUILD_A);
    await waitFor(() => expect(m().status).toBe('ready'));
    act(() => m().set({ greeting: 'edited on A' }));
    expect(m().dirty).toBe(true);

    // Server B's config is slow. Until it arrives the hook still holds A's edited form.
    let resolveB;
    getModuleConfig.mockReturnValueOnce(new Promise((resolve) => (resolveB = resolve)));
    await act(async () => {
      await router.navigate(`/g/${GUILD_B}`);
    });
    await waitFor(() => expect(getModuleConfig).toHaveBeenCalledWith(GUILD_B, 'afk'));
    expect(m().guildId).toBe(GUILD_B);
    expect(m().form).toEqual({ greeting: 'edited on A' });
    expect(m().status).toBe('loading');

    let ok;
    await act(async () => {
      ok = await m().save();
    });
    expect(ok).toBe(false);
    expect(saveModuleConfig).not.toHaveBeenCalled();

    // Once B has loaded, saves go to B with B's form.
    saveModuleConfig.mockResolvedValue({ config: { greeting: 'from B' } });
    await act(async () => {
      resolveB({ config: { greeting: 'from B' } });
    });
    await waitFor(() => expect(m().status).toBe('ready'));
    expect(m().form).toEqual({ greeting: 'from B' });
    act(() => m().set({ greeting: 'edited on B' }));
    await act(async () => {
      ok = await m().save();
    });
    expect(ok).toBe(true);
    expect(saveModuleConfig).toHaveBeenCalledWith(GUILD_B, 'afk', { greeting: 'edited on B' });
  });

  it('reports a failed save and keeps the form dirty', async () => {
    getModuleConfig.mockResolvedValue({ config: { greeting: 'hello' } });
    saveModuleConfig.mockRejectedValue(new Error('boom'));
    const { m } = setup();
    await waitFor(() => expect(m().status).toBe('ready'));
    act(() => m().set({ greeting: 'changed' }));

    let ok;
    await act(async () => {
      ok = await m().save();
    });

    expect(ok).toBe(false);
    expect(m().dirty).toBe(true);
    expect(m().saving).toBe(false);
  });
});
