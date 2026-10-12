import { getPlatformInfo } from './api.js';
import { useApiData } from './useApiData.js';

// What the server's platform can and cannot do, and the per-module notes for it. Until it
// loads (or if it fails) a Discord server is assumed: the pages are written for Discord.
const DISCORD = { platform: 'discord', capabilities: { nativeAutomod: true }, notes: {} };

export function usePlatformInfo(guildId) {
  const { data } = useApiData(() => getPlatformInfo(guildId), [guildId]);
  return data ?? DISCORD;
}
