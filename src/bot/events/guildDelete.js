// Sylo was removed from (or left) a guild — drop everything stored for it.
import { guildKey } from '../../platform/platformOf.js';
import { Events } from 'discord.js';
import { purgeGuild } from '../../db/purge.js';
import { log } from '../../lib/log.js';

export const name = Events.GuildDelete;

/** @param {import('discord.js').Guild} guild */
export async function execute(guild) {
  // GuildDelete also fires during a Discord outage; don't wipe data then.
  if (guild.available === false) return;
  try {
    await purgeGuild(guildKey(guild));
    log.info('bot', `Left guild ${guildKey(guild)} (${guild.name ?? 'unknown'}) — purged stored data`);
  } catch (err) {
    log.error('bot', `Failed to purge data for guild ${guildKey(guild)}:`, err.message);
  }
}
