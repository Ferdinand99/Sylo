// Shared view-model for the per-guild control panel.
import { runtime } from '../../runtime.js';
import { MODULES, missingIntents } from '../../modules/registry.js';
import { getGuildModules } from '../../db/modules.js';
import { openTicketCount } from '../../db/tickets.js';
import { guildTextChannels } from './discord.js';

/** The guild from the URL, or null. */
export function getGuild(req) {
  return runtime.client?.guilds.cache.get(req.params.guildId) ?? null;
}

/** Roles a form can reasonably offer (excludes @everyone and managed roles). */
export function assignableRoles(guild) {
  return [...guild.roles.cache.values()]
    .filter((r) => r.id !== guild.id && !r.managed)
    .sort((a, b) => b.position - a.position)
    .map((r) => ({ id: r.id, name: r.name }));
}

/**
 * Base context every panel needs: guild summary, text channels, and the module
 * list with per-guild enabled state and intent readiness.
 * @param {import('discord.js').Guild} guild
 * @param {string} panel  active panel id (for nav highlighting)
 */
export function baseContext(guild, panel) {
  const enabledById = new Map(getGuildModules(guild.id).map((m) => [m.id, m.enabled]));
  const modules = MODULES.map((m) => ({
    id: m.id,
    name: m.name,
    description: m.description,
    icon: m.icon,
    configurable: m.configurable,
    enabled: enabledById.get(m.id) ?? false,
    missingIntents: missingIntents(m),
  }));

  return {
    guild: { id: guild.id, name: guild.name, icon: guild.iconURL({ size: 64 }), memberCount: guild.memberCount ?? 0 },
    channels: guildTextChannels(guild),
    modules,
    openTickets: openTicketCount(guild.id),
    panel,
    msg: null,
  };
}
