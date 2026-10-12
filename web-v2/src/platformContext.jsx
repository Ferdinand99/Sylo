import { createContext, useContext } from 'react';

// The server's platform, provided once by the module page (see ModulePage.jsx). Forms read
// it to write commands the way the platform runs them (`/afk` on Discord, `!afk` on Fluxer)
// and to link to a message on the platform's own web app. The default is Discord.
export const DISCORD = {
  platform: 'discord',
  capabilities: { nativeAutomod: true },
  notes: {},
  commandPrefix: '/',
  webAppUrl: 'https://discord.com',
};

export const PlatformContext = createContext(DISCORD);

/** `cmd('/giveaway start')` -> `!giveaway start` on Fluxer, unchanged on Discord. */
export function useCmd() {
  const { commandPrefix } = useContext(PlatformContext);
  return (text) => (commandPrefix === '/' ? text : text.replace(/^\/(?=[a-z])/, commandPrefix));
}

/** Link to a message on the platform's web app; `guildId` is the dashboard's guild key. */
export function useMessageLink() {
  const { webAppUrl } = useContext(PlatformContext);
  return (guildId, channelId, messageId) =>
    `${webAppUrl}/channels/${guildId.replace(/^[a-z]+:/, '')}/${channelId}/${messageId}`;
}
