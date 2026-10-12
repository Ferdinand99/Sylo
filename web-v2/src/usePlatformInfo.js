import { getPlatformInfo } from './api.js';
import { useApiData } from './useApiData.js';
import { DISCORD } from './platformContext.jsx';

// What the server's platform can and cannot do, and the per-module notes for it. Until it
// loads (or if it fails) a Discord server is assumed: the pages are written for Discord.
export function usePlatformInfo(guildId) {
  const { data, loading } = useApiData(() => getPlatformInfo(guildId), [guildId]);
  // `loading` lets a page wait for the answer on first load rather than flash Discord wording.
  return { info: data ?? DISCORD, loading: loading && !data };
}
