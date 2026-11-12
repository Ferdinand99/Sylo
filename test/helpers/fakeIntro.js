// A small fake server for the Introductions tests: one text channel that keeps its messages, a
// few roles, and members with roles, registered as the Discord client of the runtime so that
// guildByKey() finds the server.
import { PermissionsBitField } from 'discord.js';
import { runtime } from '../../src/runtime.js';

/** The error discord.js throws for a message or channel that does not exist. */
export const unknownMessage = () => Object.assign(new Error('Unknown Message'), { status: 404, code: 10008 });
/** An error that says nothing about the message: a server error. */
export const serverError = () => Object.assign(new Error('Internal Server Error'), { status: 500 });
/** A permission error. */
export const missingAccess = () => Object.assign(new Error('Missing Access'), { status: 403, code: 50001 });

export const GID = '900000000000000321';
export const INTRO_CH = '100000000000000501';
export const OTHER_CH = '100000000000000502';
export const ME = '555555555555550001';

export const ROLE = {
  everyone: GID,
  norway: '100000000000000801',
  sweden: '100000000000000802',
  adult: '100000000000000803',
  gamer: '100000000000000804',
  mod: '100000000000000805',
  bot: '100000000000000806',
};

const role = (id, name, position, extra = {}) => ({ id, name, position, color: 0, managed: false, ...extra });

/** Messages of one channel; `fetch` rejects for an unknown id, like discord.js does. */
function fakeChannel(id, name, { canSend = true } = {}) {
  const store = new Map();
  let n = 0;
  const log = { sent: [], edits: [], deleted: [] };
  // Set `channel.failWith` to make edit and delete by id fail with that error.
  const wrap = (payload) => {
    const message = {
      id: `${id.slice(0, 6)}${String(++n).padStart(12, '0')}`,
      channelId: id,
      payload,
      pinned: false,
      async edit(next) {
        message.payload = next;
        log.edits.push({ id: message.id, payload: next });
      },
      async delete() {
        store.delete(message.id);
        log.deleted.push(message.id);
      },
      async pin() {
        message.pinned = true;
      },
    };
    return message;
  };
  const channel = {
    id,
    name,
    log,
    store,
    isTextBased: () => true,
    permissionsFor: () => ({
      has: (needed) => {
        channel.asked = needed;
        return canSend;
      },
    }),
    send: async (payload) => {
      const message = wrap(payload);
      store.set(message.id, message);
      log.sent.push(payload);
      return message;
    },
    messages: {
      edit: async (messageId, payload) => {
        if (channel.failWith) throw channel.failWith;
        const found = store.get(messageId);
        if (!found) throw unknownMessage();
        await found.edit(payload);
      },
      delete: async (messageId) => {
        if (channel.failWith) throw channel.failWith;
        const found = store.get(messageId);
        if (!found) throw unknownMessage();
        await found.delete();
      },
      fetch: async (messageId) => {
        const found = store.get(messageId);
        if (!found) throw new Error('Unknown Message');
        return found;
      },
    },
  };
  return channel;
}

/** A member of the fake server. `roles` are role ids. */
export function fakeMember(
  guild,
  id,
  { username = `user${id.slice(-4)}`, roleIds = [], joinedAt = 1_700_000_000_000 } = {}
) {
  const roles = new Map([[GID, guild.roles.cache.get(GID)]]);
  for (const r of roleIds) roles.set(r, guild.roles.cache.get(r));
  const user = {
    id,
    username,
    globalName: null,
    send: async (payload) => user.dms.push(payload),
    dms: [],
    displayAvatarURL: () => `https://cdn.example/${id}.png`,
  };
  const member = {
    id,
    user,
    displayName: username,
    joinedTimestamp: joinedAt,
    roles: { cache: roles },
    displayAvatarURL: () => `https://cdn.example/${id}.png`,
  };
  guild.members.cache.set(id, member);
  return member;
}

/** The fake server, registered as the Discord client. `canSend` false: Sylo may not post in the channel. */
export function fakeIntroGuild({ canSend = true } = {}) {
  const channel = fakeChannel(INTRO_CH, 'introductions', { canSend });
  const other = fakeChannel(OTHER_CH, 'general');
  const channels = new Map([
    [INTRO_CH, channel],
    [OTHER_CH, other],
  ]);
  const guild = {
    id: GID,
    name: 'Hedgerow HQ',
    channels: { cache: channels, fetch: async (id) => channels.get(id) ?? null },
    roles: {
      cache: new Map([
        [GID, role(GID, '@everyone', 0)],
        [ROLE.norway, role(ROLE.norway, 'Norway', 3)],
        [ROLE.sweden, role(ROLE.sweden, 'Sweden', 2)],
        [ROLE.adult, role(ROLE.adult, '18+', 4)],
        [ROLE.gamer, role(ROLE.gamer, 'Gamer', 6, { color: 0x2ecc71 })],
        [ROLE.mod, role(ROLE.mod, 'Moderator', 9, { color: 0xe74c3c })],
        [ROLE.bot, role(ROLE.bot, 'Sylo', 10, { managed: true })],
      ]),
    },
    members: {
      cache: new Map(),
      me: { id: ME, permissions: new PermissionsBitField(PermissionsBitField.All) },
      fetch: async (id) => {
        const found = guild.members.cache.get(id);
        if (!found) throw new Error('Unknown Member');
        return found;
      },
    },
  };
  const client = {
    guilds: { cache: new Map([[GID, guild]]) },
    isReady: () => true,
    user: { id: ME },
  };
  guild.client = client;
  runtime.client = client;
  return { guild, client, channel, other };
}

/** Run `fn` with the fake server registered, and unregister it afterwards. */
export function dropFakeClient() {
  runtime.client = null;
}
