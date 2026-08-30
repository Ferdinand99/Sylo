// Sylo was removed from (or left) a guild — drop everything stored for it.
import { Events } from 'discord.js';
import { purgeGuild } from '../../db/purge.js';

export const name = Events.GuildDelete;

/** @param {import('discord.js').Guild} guild */
export function execute(guild) {
  // GuildDelete also fires during a Discord outage; don't wipe data then.
  if (guild.available === false) return;
  try {
    purgeGuild(guild.id);
    console.log(`[bot] Left guild ${guild.id} (${guild.name ?? 'unknown'}) — purged stored data`);
  } catch (err) {
    console.error(`[bot] Failed to purge data for guild ${guild.id}:`, err.message);
  }
}
