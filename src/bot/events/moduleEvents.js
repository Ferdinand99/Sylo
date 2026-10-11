// Bridges Discord gateway events to the module dispatch layer. Each listener
// forwards (eventName, guildId, payload) to dispatch(), which calls every
// enabled module's handler for that guild.
import { guildKey, guildKeyOf } from '../../platform/platformOf.js';
import { Events } from 'discord.js';
import { dispatch } from '../../modules/dispatch.js';
import '../../modules/index.js'; // side-effect: registers module handlers

/** @param {import('discord.js').Client} client */
export function register(client) {
  client.on(Events.GuildMemberAdd, (member) => dispatch('guildMemberAdd', guildKeyOf(member), member));
  client.on(Events.GuildMemberRemove, (member) => dispatch('guildMemberRemove', guildKeyOf(member), member));
  client.on(Events.GuildMemberUpdate, (oldM, newM) =>
    dispatch('guildMemberUpdate', guildKeyOf(newM), { old: oldM, new: newM })
  );

  client.on(Events.GuildBanAdd, (ban) => dispatch('guildBanAdd', guildKeyOf(ban), ban));
  client.on(Events.GuildBanRemove, (ban) => dispatch('guildBanRemove', guildKeyOf(ban), ban));

  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    const guildId = guildKeyOf(newState) ?? guildKeyOf(oldState);
    dispatch('voiceStateUpdate', guildId, { old: oldState, new: newState });
  });

  client.on(Events.MessageDelete, (message) => {
    if (guildKeyOf(message)) dispatch('messageDelete', guildKeyOf(message), message);
  });
  client.on(Events.MessageBulkDelete, (messages, channel) => {
    if (channel?.guildId) dispatch('messageDeleteBulk', guildKeyOf(channel), { messages, channel });
  });
  client.on(Events.MessageUpdate, (oldMsg, newMsg) => {
    if (guildKeyOf(newMsg)) dispatch('messageUpdate', guildKeyOf(newMsg), { old: oldMsg, new: newMsg });
  });
  client.on(Events.MessageCreate, (message) => {
    if (!guildKeyOf(message)) return;
    // `messageCreateAny` also carries bot / app / webhook messages — only the
    // sticky module opts into those. `messageCreate` stays human-only.
    dispatch('messageCreateAny', guildKeyOf(message), message);
    if (!message.author?.bot) dispatch('messageCreate', guildKeyOf(message), message);
  });

  client.on(Events.GuildRoleCreate, (role) => dispatch('roleCreate', guildKeyOf(role), role));
  client.on(Events.GuildRoleDelete, (role) => dispatch('roleDelete', guildKeyOf(role), role));

  client.on(Events.InviteCreate, (invite) => dispatch('inviteCreate', guildKeyOf(invite), invite));
  client.on(Events.InviteDelete, (invite) => dispatch('inviteDelete', guildKeyOf(invite), invite));
  client.on(Events.GuildCreate, (guild) => dispatch('guildCreate', guildKey(guild), guild));

  client.on(Events.ChannelCreate, (channel) => {
    if (guildKeyOf(channel)) dispatch('channelCreate', guildKeyOf(channel), channel);
  });
  client.on(Events.ChannelDelete, (channel) => {
    if (guildKeyOf(channel)) dispatch('channelDelete', guildKeyOf(channel), channel);
  });

  const forwardReaction = (event) => async (reaction, user) => {
    // A reaction on an uncached message arrives partial; guildId is null until
    // the message is fetched.
    try {
      if (reaction.partial) await reaction.fetch();
      if (reaction.message.partial) await reaction.message.fetch();
    } catch {
      return;
    }
    const guildId = guildKeyOf(reaction.message);
    if (guildId) dispatch(event, guildId, { reaction, user });
  };
  client.on(Events.MessageReactionAdd, forwardReaction('reactionAdd'));
  client.on(Events.MessageReactionRemove, forwardReaction('reactionRemove'));
}
