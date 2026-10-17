// The "Add new server" links: one per platform Sylo runs on.

// Discord: scopes + a permission set that covers every module: moderation
// (kick/ban/timeout), roles, channels & webhooks, reactions, invites, audit log,
// nickname management, voice moves for temp channels, and Manage Server (invite tracking
// reads the invite list; native AutoMod rules need it).
const DISCORD_SCOPES = 'bot applications.commands';
const DISCORD_PERMISSIONS = [0, 1, 2, 4, 5, 6, 7, 10, 11, 13, 14, 15, 16, 20, 24, 27, 28, 29, 40]
  .reduce((acc, bit) => acc | (1n << BigInt(bit)), 0n)
  .toString();

// Fluxer has no slash commands, so only the bot scope; the permission value is the set
// Sylo needs there (Fluxer's permission bits match Discord's).
const FLUXER_SCOPES = 'bot';
const FLUXER_PERMISSIONS = '1100469103831';

/**
 * @param {{ discordClientId?: string | null, fluxerClientId?: string | null, fluxerWeb?: string }} opts
 *   `fluxerWeb` is the web app origin of the Fluxer instance (where its authorize page lives).
 * @returns {Array<{ platform: 'discord' | 'fluxer', label: string, url: string }>}
 */
export function buildBotInvites({ discordClientId, fluxerClientId, fluxerWeb } = {}) {
  const invites = [];
  if (discordClientId) {
    const params = new URLSearchParams({
      client_id: discordClientId,
      scope: DISCORD_SCOPES,
      permissions: DISCORD_PERMISSIONS,
    });
    invites.push({
      platform: 'discord',
      label: 'Discord',
      url: `https://discord.com/oauth2/authorize?${params}`,
    });
  }
  if (fluxerClientId) {
    const params = new URLSearchParams({
      client_id: fluxerClientId,
      scope: FLUXER_SCOPES,
      permissions: FLUXER_PERMISSIONS,
    });
    invites.push({ platform: 'fluxer', label: 'Fluxer', url: `${fluxerWeb}/oauth2/authorize?${params}` });
  }
  return invites;
}
