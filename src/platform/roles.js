// Creating guild roles across platforms. discord.js has guild.roles.create(); on Fluxer the guild
// object has createRole() (see channels.js for the same split on channels).

/**
 * Create a role that grants no permissions. A new role sits at the bottom of the list, below
 * Sylo's own role. Fluxer's createRole() takes no audit-log reason, so `reason` only goes to Discord.
 * @param {any} guild
 * @param {{ name: string, reason?: string }} opts
 */
export function createGuildRole(guild, { name, reason }) {
  return typeof guild.createRole === 'function'
    ? guild.createRole({ name, permissions: [] })
    : guild.roles.create({ name, permissions: [], mentionable: false, ...(reason ? { reason } : {}) });
}
