// Discord side of src/bot/lib/adminSnapshot.js: a member's roles change, or the server changes
// owner, and the signed-in person's list of servers they run follows.
import { Events } from 'discord.js';
import { guildKey } from '../../platform/platformOf.js';
import { syncAdminSnapshot, syncNewOwner } from '../lib/adminSnapshot.js';

/** @param {import('discord.js').Client} client */
export function register(client) {
  client.on(Events.GuildMemberUpdate, (_old, member) => {
    if (member?.guild) void syncAdminSnapshot('discord', guildKey(member.guild), member.guild, member);
  });
  client.on(Events.GuildUpdate, (before, after) => {
    if (!after || before?.ownerId === after.ownerId) return;
    void syncNewOwner('discord', guildKey(after), after.ownerId);
    // The old owner may or may not still run it: decide from their member data when cached.
    const previous = before?.ownerId ? after.members.cache.get(before.ownerId) : null;
    if (previous) void syncAdminSnapshot('discord', guildKey(after), after, previous);
  });
}
