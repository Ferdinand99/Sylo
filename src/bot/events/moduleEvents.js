// Bridges Discord gateway events to the module dispatch layer. Each listener
// forwards (eventName, guildId, payload) to dispatch(), which calls every
// enabled module's handler for that guild.
import { Events } from 'discord.js';
import { dispatch } from '../../modules/dispatch.js';
import '../../modules/index.js'; // side-effect: registers module handlers

/** @param {import('discord.js').Client} client */
export function register(client) {
  client.on(Events.GuildMemberAdd, (member) => dispatch('guildMemberAdd', member.guild?.id, member));
  client.on(Events.GuildMemberRemove, (member) => dispatch('guildMemberRemove', member.guild?.id, member));
  client.on(Events.GuildMemberUpdate, (oldM, newM) =>
    dispatch('guildMemberUpdate', newM.guild?.id, { old: oldM, new: newM })
  );

  client.on(Events.GuildBanAdd, (ban) => dispatch('guildBanAdd', ban.guild?.id, ban));
  client.on(Events.GuildBanRemove, (ban) => dispatch('guildBanRemove', ban.guild?.id, ban));

  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    const guildId = newState.guild?.id ?? oldState.guild?.id;
    dispatch('voiceStateUpdate', guildId, { old: oldState, new: newState });
  });

  client.on(Events.MessageDelete, (message) => {
    if (message.guildId) dispatch('messageDelete', message.guildId, message);
  });
  client.on(Events.MessageBulkDelete, (messages, channel) => {
    if (channel?.guildId) dispatch('messageDeleteBulk', channel.guildId, { messages, channel });
  });
  client.on(Events.MessageUpdate, (oldMsg, newMsg) => {
    if (newMsg.guildId) dispatch('messageUpdate', newMsg.guildId, { old: oldMsg, new: newMsg });
  });
  client.on(Events.MessageCreate, (message) => {
    if (!message.guildId) return;
    // `messageCreateAny` also carries bot / app / webhook messages — only the
    // sticky module opts into those. `messageCreate` stays human-only.
    dispatch('messageCreateAny', message.guildId, message);
    if (!message.author?.bot) dispatch('messageCreate', message.guildId, message);
  });

  client.on(Events.GuildRoleCreate, (role) => dispatch('roleCreate', role.guild?.id, role));
  client.on(Events.GuildRoleDelete, (role) => dispatch('roleDelete', role.guild?.id, role));

  client.on(Events.InviteCreate, (invite) => dispatch('inviteCreate', invite.guild?.id, invite));
  client.on(Events.InviteDelete, (invite) => dispatch('inviteDelete', invite.guild?.id, invite));
  client.on(Events.GuildCreate, (guild) => dispatch('guildCreate', guild.id, guild));

  client.on(Events.ChannelCreate, (channel) => {
    if (channel.guildId) dispatch('channelCreate', channel.guildId, channel);
  });
  client.on(Events.ChannelDelete, (channel) => {
    if (channel.guildId) dispatch('channelDelete', channel.guildId, channel);
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
    const guildId = reaction.message.guildId ?? reaction.message.guild?.id;
    if (guildId) dispatch(event, guildId, { reaction, user });
  };
  client.on(Events.MessageReactionAdd, forwardReaction('reactionAdd'));
  client.on(Events.MessageReactionRemove, forwardReaction('reactionRemove'));
}
