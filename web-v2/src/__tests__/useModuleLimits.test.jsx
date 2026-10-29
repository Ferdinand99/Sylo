import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { limitOf, resetModuleLimits, useModuleLimits } from '../components/useModuleLimits.js';

vi.mock('../api.js', () => ({ getModuleLimits: vi.fn() }));
const { getModuleLimits } = await import('../api.js');

const ALL = {
  sticky: { 'stickies[].content': { maxLength: 2000 }, stickies: { maxItems: 50 } },
  welcome: { joinMessage: { maxLength: 1500 } },
};

beforeEach(() => {
  vi.resetAllMocks();
  resetModuleLimits();
});

describe('useModuleLimits', () => {
  it('starts empty, then returns the limits of the asked module', async () => {
    getModuleLimits.mockResolvedValue(ALL);
    const { result } = renderHook(() => useModuleLimits('sticky'));

    expect(result.current).toEqual({});
    await waitFor(() => expect(result.current).toBe(ALL.sticky));
    expect(limitOf(result.current, 'stickies[].content').maxLength).toBe(2000);
  });

  it('fetches once per page load, however many forms ask', async () => {
    getModuleLimits.mockResolvedValue(ALL);
    const a = renderHook(() => useModuleLimits('sticky'));
    const b = renderHook(() => useModuleLimits('welcome'));
    await waitFor(() => expect(b.result.current).toBe(ALL.welcome));
    await waitFor(() => expect(a.result.current).toBe(ALL.sticky));

    // A form mounted later gets them at once, without another request.
    const c = renderHook(() => useModuleLimits('welcome'));
    expect(c.result.current).toBe(ALL.welcome);
    expect(getModuleLimits).toHaveBeenCalledTimes(1);
  });

  it('gives an unknown module no limits', async () => {
    getModuleLimits.mockResolvedValue(ALL);
    const { result } = renderHook(() => useModuleLimits('no-such-module'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toEqual({});
  });

  it('renders without limits when the request fails, and asks again on the next mount', async () => {
    getModuleLimits.mockRejectedValueOnce(new Error('offline'));
    const first = renderHook(() => useModuleLimits('sticky'));
    await waitFor(() => expect(getModuleLimits).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(first.result.current).toEqual({});

    getModuleLimits.mockResolvedValue(ALL);
    const second = renderHook(() => useModuleLimits('sticky'));
    await waitFor(() => expect(second.result.current).toBe(ALL.sticky));
    expect(getModuleLimits).toHaveBeenCalledTimes(2);
  });
});

describe('limitOf', () => {
  it('always returns an object, so .maxLength is safe to read', () => {
    expect(limitOf({ a: { maxLength: 5 } }, 'a').maxLength).toBe(5);
    expect(limitOf({ a: { maxLength: 5 } }, 'b').maxLength).toBeUndefined();
    expect(limitOf({}, 'a').maxLength).toBeUndefined();
    expect(limitOf(undefined, 'a').maxLength).toBeUndefined();
    expect(limitOf(null, 'a').min).toBeUndefined();
  });
});
