// Discover and load every slash command module in ./commands.
// Each command module must export `data` (a SlashCommandBuilder) and
// `execute(interaction)`. Shared by the bot runtime and the standalone
// registration script.
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Collection } from 'discord.js';
import { log } from '../lib/log.js';

const commandsDir = join(dirname(fileURLToPath(import.meta.url)), 'commands');

/**
 * @returns {Promise<Collection<string, { data: import('discord.js').SlashCommandBuilder, execute: Function }>>}
 */
export async function loadCommands() {
  const commands = new Collection();
  const files = readdirSync(commandsDir).filter((f) => f.endsWith('.js') && !f.startsWith('_'));

  for (const file of files) {
    const mod = await import(pathToFileURL(join(commandsDir, file)).href);
    if (!mod.data || typeof mod.execute !== 'function') {
      log.warn('bot', `Skipping ${file}: missing "data" or "execute" export`);
      continue;
    }
    commands.set(mod.data.name, { data: mod.data, execute: mod.execute });
  }

  return commands;
}

/**
 * The message / user menu commands ("Save quote"): a command module lists them in an optional
 * `contextMenus` export of `{ data: ContextMenuCommandBuilder, execute }`. They are kept apart
 * from the slash commands (they have no options, no help entry and no chat form), but are
 * registered with them.
 * @returns {Promise<Collection<string, { data: import('discord.js').ContextMenuCommandBuilder, execute: Function }>>}
 */
export async function loadContextMenus() {
  const menus = new Collection();
  const files = readdirSync(commandsDir).filter((f) => f.endsWith('.js') && !f.startsWith('_'));

  for (const file of files) {
    const mod = await import(pathToFileURL(join(commandsDir, file)).href);
    for (const menu of mod.contextMenus ?? []) {
      if (!menu?.data?.name || typeof menu.execute !== 'function') {
        log.warn('bot', `Skipping a menu command in ${file}: missing "data" or "execute"`);
        continue;
      }
      menus.set(menu.data.name, { data: menu.data, execute: menu.execute });
    }
  }

  return menus;
}
