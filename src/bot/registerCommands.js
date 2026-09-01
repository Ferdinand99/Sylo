// Push slash command definitions to Discord via the REST API.
// If config.discordGuildIds is non-empty, commands are registered for each of
// those guilds (instant — ideal for development) and any leftover GLOBAL
// commands are cleared so they don't show up twice. Otherwise commands are
// registered globally (propagation can take up to ~1 hour).
import { REST, Routes } from 'discord.js';
import { config } from '../config.js';
import { log } from '../lib/log.js';

/**
 * @param {import('discord.js').Collection<string, { data: import('discord.js').SlashCommandBuilder }>} commands
 * @returns {Promise<number>} the number of commands registered
 */
export async function registerCommands(commands) {
  const body = [...commands.values()].map((c) => c.data.toJSON());
  const rest = new REST({ version: '10' }).setToken(config.discordToken);
  const clientId = config.discordClientId;

  if (config.discordGuildIds.length) {
    for (const guildId of config.discordGuildIds) {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
      log.info('bot', `Registered ${body.length} slash command(s) to guild ${guildId}`);
    }
    // Guild-scoped registration is a dev convenience; wipe any global commands
    // so users don't see each command duplicated in the picker.
    try {
      const global = await rest.get(Routes.applicationCommands(clientId));
      if (Array.isArray(global) && global.length > 0) {
        await rest.put(Routes.applicationCommands(clientId), { body: [] });
        log.info('bot', `Cleared ${global.length} stale global command(s)`);
      }
    } catch (err) {
      log.warn('bot', 'Could not clear global commands:', err.message);
    }
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body });
    log.info('bot', `Registered ${body.length} slash command(s) globally`);
  }

  return body.length;
}
