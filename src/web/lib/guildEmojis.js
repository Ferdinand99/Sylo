// The server's custom emojis, for the reaction-role emoji picker. Shared by the classic
// route (GET /guilds/:id/emojis) and the new dashboard's (GET /api/v2/guilds/:id/emojis).

/**
 * @param {{ emojis?: { cache?: Map<string, any> } }} guild
 * @returns {{ name: string, display: string, url: string }[]}
 */
export function guildCustomEmojis(guild) {
  return [...(guild.emojis?.cache?.values() ?? [])].map((e) => ({
    name: e.name,
    display: e.toString(),
    url: e.imageURL?.({ size: 32 }) ?? '',
  }));
}
