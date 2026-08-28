// Push slash command definitions to Discord via the REST API.
// If config.discordGuildId is set, commands are registered for that single
// guild (instant — ideal for development). Otherwise they are registered
// globally (propagation can take up to ~1 hour).
import { REST, Routes } from 'discord.js';
import { config } from '../config.js';

/**
 * @param {import('discord.js').Collection<string, { data: import('discord.js').SlashCommandBuilder }>} commands
 * @returns {Promise<number>} the number of commands registered
 */
export async function registerCommands(commands) {
  const body = [...commands.values()].map((c) => c.data.toJSON());
  const rest = new REST({ version: '10' }).setToken(config.discordToken);

  const route = config.discordGuildId
    ? Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId)
    : Routes.applicationCommands(config.discordClientId);

  await rest.put(route, { body });

  const scope = config.discordGuildId ? `guild ${config.discordGuildId}` : 'globally';
  console.log(`[bot] Registered ${body.length} slash command(s) ${scope}`);
  return body.length;
}
