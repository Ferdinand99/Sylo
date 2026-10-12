// Bridges Fluxer gateway events to the module dispatch layer: the counterpart
// of events/moduleEvents.js for the Discord client. The event names match
// discord.js's, but several payloads do not (reactions arrive as one object, a
// role delete may carry no role, bulk deletes list ids), and every guild is
// keyed "fluxer:<id>". Voice states come from the tracker in platform/voiceStates.js.
import { dispatch as realDispatch } from '../modules/dispatch.js';
import { purgeGuild } from '../db/purge.js';
import { makePlatformGuildId } from '../lib/platformId.js';
import { fluxerReactionAdd } from '../platform/fluxerEvents.js';
import { log } from '../lib/log.js';

const keyOf = (rawGuildId) => (rawGuildId ? makePlatformGuildId('fluxer', rawGuildId) : null);

/**
 * @param {import('node:events').EventEmitter & { user?: any, channels?: any, users?: any }} client
 * @param {{ dispatch?: typeof realDispatch, purge?: typeof purgeGuild, isCommand?: (message: any) => boolean, voice?: { track: Function } }} [opts]
 */
export function registerFluxerModuleEvents(
  client,
  { dispatch = realDispatch, purge = purgeGuild, isCommand = () => false, voice } = {}
) {
  // Run a handler without letting a throw or rejection escape into the gateway.
  const on = (event, handler) =>
    client.on(event, async (...args) => {
      try {
        await handler(...args);
      } catch (err) {
        log.error('fluxer', `${event} handler failed:`, err);
      }
    });
  const send = (name, rawGuildId, payload) => {
    const key = keyOf(rawGuildId);
    return key ? dispatch(name, key, payload) : undefined;
  };

  on('guildMemberAdd', (member) => send('guildMemberAdd', member.guild?.id ?? member.guildId, member));
  on('guildMemberRemove', async (member) => {
    // The gateway sends only the user id for a member Sylo hadn't cached, so a
    // leave message would read "undefined" for the name.
    let full = member;
    if (member.user && !member.user.username) {
      const user = await client.users.fetch(member.id ?? member.user.id).catch(() => null);
      if (user) full = Object.create(member, { user: { value: user, enumerable: true } });
    }
    return send('guildMemberRemove', member.guild?.id ?? member.guildId, full);
  });
  on('guildMemberUpdate', (oldMember, newMember) =>
    send('guildMemberUpdate', newMember.guild?.id ?? newMember.guildId, {
      old: oldMember ?? newMember,
      new: newMember,
    })
  );

  on('guildBanAdd', (ban) => send('guildBanAdd', ban.guildId, ban));
  on('guildBanRemove', (ban) => send('guildBanRemove', ban.guildId, ban));

  // Voice states are tracked by us (members carry none); each change is a module event.
  voice?.track(client, (oldState, newState) =>
    send('voiceStateUpdate', newState.guildId, { old: oldState, new: newState })
  );

  on('messageDelete', (message) => send('messageDelete', message.guildId, message));
  on('messageDeleteBulk', ({ ids, channelId, guildId }) => {
    const channel = client.channels.get?.(channelId) ?? client.channels.cache?.get(channelId) ?? null;
    const messages = new Map(ids.map((id) => [id, { id, channelId, guildId, partial: true }]));
    return send('messageDeleteBulk', guildId, { messages, channel });
  });
  on('messageUpdate', (oldMessage, newMessage) =>
    send('messageUpdate', newMessage.guildId, { old: oldMessage, new: newMessage })
  );
  on('messageCreate', async (message) => {
    if (!message.guildId) return;
    // `messageCreateAny` also carries bot / app / webhook messages — only the
    // sticky module opts into those. `messageCreate` stays human-only.
    await send('messageCreateAny', message.guildId, message);
    // A command is not chat: AFK, leveling and counting never see one. It is still a
    // message a member posted, so the moderation modules (automod, honeypot) get it as
    // `commandMessageCreate`; otherwise `!afk <invite> @everyone` would walk past them.
    if (message.author?.bot) return;
    await send(isCommand(message) ? 'commandMessageCreate' : 'messageCreate', message.guildId, message);
  });

  on('guildRoleCreate', (role) => send('roleCreate', role.guildId, role));
  on('guildRoleDelete', (role, guildId, roleId) =>
    send('roleDelete', guildId, role ?? { id: roleId, guildId, name: null })
  );

  on('inviteCreate', (invite) => send('inviteCreate', invite.guildSnapshot?.id, invite));
  on('inviteDelete', (payload) => send('inviteDelete', payload.guildId, payload));
  on('guildCreate', (guild) => send('guildCreate', guild.id, guild));
  on('guildDelete', async (guild) => {
    // Also fires when a guild merely becomes unavailable; don't wipe data then.
    if (guild.available === false) return;
    const key = keyOf(guild.id);
    await purge(key);
    log.info('fluxer', `Left guild ${key} (${guild.name ?? 'unknown'}) — purged stored data`);
  });

  on('channelCreate', (channel) => send('channelCreate', channel.guildId, channel));
  on('channelDelete', (channel) => send('channelDelete', channel.guildId, channel));

  const forwardReaction = (name) => async (payload) => {
    const pair = await fluxerReactionAdd(client, payload); // null for Sylo's own reactions
    if (!pair) return;
    return send(name, pair.reaction.message.guildId, { reaction: pair.reaction, user: pair.user });
  };
  on('messageReactionAdd', forwardReaction('reactionAdd'));
  on('messageReactionRemove', forwardReaction('reactionRemove'));
}
