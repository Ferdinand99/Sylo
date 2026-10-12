// Shared view-model for the per-guild control panel.
import { guildByKey, keyedGuild, rawGuildId } from '../../platform/platformOf.js';
import { platformInfo } from '../../platform/modulePlatformNotes.js';
import { MODULES, missingIntents } from '../../modules/registry.js';
import { getGuildModules } from '../../db/modules.js';
import { openTicketCount } from '../../db/tickets.js';
import { countOpenAppeals } from '../../db/appeals.js';
import { guildTextChannels } from './discord.js';

/** The guild from the URL, or null. Its `.id` is the guild key ("fluxer:<id>" on Fluxer). */
export function getGuild(req) {
  return keyedGuild(guildByKey(req.params.guildId));
}

/** Roles a form can reasonably offer (excludes @everyone and managed roles). */
export function assignableRoles(guild) {
  return [...guild.roles.cache.values()]
    .filter((r) => r.id !== rawGuildId(guild) && !r.managed)
    .sort((a, b) => b.position - a.position)
    .map((r) => ({ id: r.id, name: r.name }));
}

/**
 * Base context every panel needs: guild summary, text channels, and the module
 * list with per-guild enabled state and intent readiness.
 * @param {import('discord.js').Guild} guild
 * @param {string} panel  active panel id (for nav highlighting)
 */
export async function baseContext(guild, panel) {
  const enabledById = new Map((await getGuildModules(guild.id)).map((m) => [m.id, m.enabled]));
  const { platform, capabilities } = platformInfo(guild);
  const modules = MODULES.map((m) => ({
    id: m.id,
    name: m.name,
    description: m.description,
    icon: m.icon,
    configurable: m.configurable,
    enabled: enabledById.get(m.id) ?? false,
    // Privileged intents are a Discord concept; Fluxer has none to switch on.
    missingIntents: platform === 'discord' ? missingIntents(m) : [],
  }));

  return {
    guild: {
      id: guild.id,
      name: guild.name,
      icon: guild.iconURL({ size: 64 }),
      memberCount: guild.memberCount ?? 0,
    },
    channels: guildTextChannels(guild),
    modules,
    openTickets: await openTicketCount(guild.id),
    openAppeals: await countOpenAppeals(guild.id),
    panel,
    platform,
    platformCaps: capabilities,
    msg: null,
  };
}
