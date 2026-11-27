// Feeds the server mirror (src/mirror/): every change to a Discord server's channels, roles, emoji, stickers
// and its name or icon is passed to the engine, which queues work only when that server is the source of a
// running mirror. Also runs the engine's timer and, once at start, puts work that a restart interrupted
// back in the queue. Nothing here writes to Discord: the mirror only reads it.
import { Events } from 'discord.js';
import { guildKeyOf } from '../../platform/platformOf.js';
import { log } from '../../lib/log.js';
import { every } from '../../modules/schedule.js';
import { mirror } from '../../mirror/index.js';

/** How often the engine looks for pairs with work to do. */
const TICK_MS = 3000;

/** @param {import('discord.js').Client} client */
export function register(client) {
  const note = (entity, change) => {
    const key = guildKeyOf(entity);
    if (!key) return;
    mirror
      .noteSourceChange(key, change)
      .catch((err) => log.error('mirror', `could not queue a ${change.kind} change:`, err));
  };
  const positionChanged = (a, b) => a.rawPosition !== b.rawPosition || a.parentId !== b.parentId;

  client.on(Events.ChannelCreate, (ch) =>
    note(ch, { kind: 'channel', op: 'sync', id: ch.id, reorder: 'channels' })
  );
  client.on(Events.ChannelUpdate, (oldCh, newCh) =>
    note(newCh, {
      kind: 'channel',
      op: 'sync',
      id: newCh.id,
      ...(positionChanged(oldCh, newCh) ? { reorder: 'channels' } : {}),
    })
  );
  client.on(Events.ChannelDelete, (ch) => note(ch, { kind: 'channel', op: 'delete', id: ch.id }));

  client.on(Events.GuildRoleCreate, (role) =>
    note(role, { kind: 'role', op: 'sync', id: role.id, reorder: 'roles' })
  );
  client.on(Events.GuildRoleUpdate, (oldRole, newRole) =>
    note(newRole, {
      kind: 'role',
      op: 'sync',
      id: newRole.id,
      ...(oldRole.rawPosition !== newRole.rawPosition ? { reorder: 'roles' } : {}),
    })
  );
  client.on(Events.GuildRoleDelete, (role) => note(role, { kind: 'role', op: 'delete', id: role.id }));

  client.on(Events.GuildEmojiCreate, (e) => note(e, { kind: 'emoji', op: 'sync', id: e.id }));
  client.on(Events.GuildEmojiUpdate, (_old, e) => note(e, { kind: 'emoji', op: 'sync', id: e.id }));
  client.on(Events.GuildEmojiDelete, (e) => note(e, { kind: 'emoji', op: 'delete', id: e.id }));

  client.on(Events.GuildStickerCreate, (s) => note(s, { kind: 'sticker', op: 'sync', id: s.id }));
  client.on(Events.GuildStickerUpdate, (_old, s) => note(s, { kind: 'sticker', op: 'sync', id: s.id }));
  client.on(Events.GuildStickerDelete, (s) => note(s, { kind: 'sticker', op: 'delete', id: s.id }));

  client.on(Events.GuildUpdate, (oldGuild, newGuild) => {
    if (
      oldGuild.name === newGuild.name &&
      oldGuild.icon === newGuild.icon &&
      oldGuild.banner === newGuild.banner
    )
      return;
    note(newGuild, { kind: 'guild', op: 'sync', id: 'identity' });
  });

  // Work that was running when the process last stopped waits in the queue again.
  client.once(Events.ClientReady, () => {
    mirror.resumeAfterRestart().catch((err) => log.error('mirror', 'could not resume the queue:', err));
  });
  every('mirror', TICK_MS, () => mirror.tick());
}
