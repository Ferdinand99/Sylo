import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DISCORD, PlatformContext, useCmd } from '../platformContext.jsx';

const cmdWith = (commandPrefix) =>
  renderHook(() => useCmd(), {
    wrapper: ({ children }) => (
      <PlatformContext.Provider value={{ ...DISCORD, platform: 'fluxer', commandPrefix }}>
        {children}
      </PlatformContext.Provider>
    ),
  }).result.current;

describe('useCmd', () => {
  it('writes a slash command with the server prefix on Fluxer and leaves Discord alone', () => {
    expect(cmdWith('?')('/giveaway start')).toBe('?giveaway start');
    expect(cmdWith('/')('/giveaway start')).toBe('/giveaway start');
    expect(cmdWith('?')('plain text')).toBe('plain text');
  });

  it('takes a prefix with a dollar sign literally', () => {
    expect(cmdWith('$$')('/afk')).toBe('$$afk');
    expect(cmdWith('$&')('/afk')).toBe('$&afk');
    expect(cmdWith("$'")('/afk')).toBe("$'afk");
  });
});
