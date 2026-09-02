// A fake discord.js Guild + Client rich enough for the dashboard route tests.
// Records everything the routes try to send so tests can assert on it.
import { ChannelType, PermissionsBitField } from 'discord.js';

export const GID = '900000000000000123';
export const MEMBER_ID = '900000000000009999';
export const ADMIN_ROLE = '900000000000000042';

// Snowflake-shaped ids — routes validate channel/role ids with /^\d{17,20}$/.
export const CH = {
  general: '100000000000000001',
  bots: '100000000000000002',
  announce: '100000000000000003',
  voice: '100000000000000004',
  category: '100000000000000005',
};
export const ROLE = {
  everyone: GID,
  member: '100000000000000700',
  admin: ADMIN_ROLE,
  bot: '100000000000000800',
};

/** Records of side effects the routes produced during a test. */
export function makeSink() {
  return { dms: [], messages: [], channelEdits: [], created: [], automodRules: [] };
}

/** Minimal guild.autoModerationRules manager backed by sink.automodRules. */
function fakeAutomodRules(sink) {
  const store = sink.automodRules;
  return {
    fetch: async () => new Map(store.map((r) => [r.id, r])),
    create: async (payload) => {
      const rule = { id: `am-${store.length + 1}`, ...payload };
      rule.edit = async (patch) => {
        Object.assign(rule, patch);
        return rule;
      };
      rule.delete = async () => {
        const i = store.indexOf(rule);
        if (i !== -1) store.splice(i, 1);
      };
      store.push(rule);
      return rule;
    },
  };
}

function fakeChannel(sink, { id, name, type, position }) {
  const overwrites = new Map();
  const chan = {
    id,
    name,
    type,
    rawPosition: position,
    position,
    guild: null, // set by fakeGuild()
    isTextBased: () =>
      type === ChannelType.GuildText ||
      type === ChannelType.GuildAnnouncement ||
      type === ChannelType.PublicThread,
    isVoiceBased: () => type === ChannelType.GuildVoice || type === ChannelType.GuildStageVoice,
    permissionsFor: () => new PermissionsBitField(PermissionsBitField.All),
    permissionOverwrites: {
      cache: overwrites,
      edit: async (role, opts, meta) =>
        sink.channelEdits.push({ channel: id, role: role?.id ?? role, opts, meta }),
      delete: async (role, reason) =>
        sink.channelEdits.push({ channel: id, delete: role?.id ?? role, reason }),
    },
    setRateLimitPerUser: async (n) => sink.channelEdits.push({ channel: id, slowmode: n }),
    send: async (payload) => {
      sink.messages.push({ channel: id, payload });
      return { id: 'msg-' + sink.messages.length, edit: async () => {}, delete: async () => {} };
    },
    messages: { fetch: async () => null },
  };
  return chan;
}

function fakeRole({ id, name, position, admin = false, managed = false }) {
  return {
    id,
    name,
    position,
    managed,
    permissions: new PermissionsBitField(admin ? PermissionsBitField.Flags.Administrator : 0n),
    comparePositionTo: (other) => position - (other?.position ?? 0),
    members: new Map(),
  };
}

/**
 * @param {object} [opts]
 * @param {ReturnType<typeof makeSink>} [opts.sink]
 * @returns {{ guild: object, client: object, sink: object }}
 */
export function fakeGuild(opts = {}) {
  const sink = opts.sink ?? makeSink();

  const channels = new Map(
    [
      { id: CH.general, name: 'general', type: ChannelType.GuildText, position: 0 },
      { id: CH.bots, name: 'bots', type: ChannelType.GuildText, position: 1 },
      { id: CH.announce, name: 'announcements', type: ChannelType.GuildAnnouncement, position: 2 },
      { id: CH.voice, name: 'Voice', type: ChannelType.GuildVoice, position: 3 },
      { id: CH.category, name: 'Category', type: ChannelType.GuildCategory, position: 4 },
    ].map((c) => [c.id, fakeChannel(sink, c)])
  );

  const roles = new Map(
    [
      fakeRole({ id: ROLE.everyone, name: '@everyone', position: 0 }),
      fakeRole({ id: ROLE.member, name: 'Member', position: 1 }),
      fakeRole({ id: ROLE.admin, name: 'Admins', position: 5, admin: true }),
      fakeRole({ id: ROLE.bot, name: 'Bots', position: 6, managed: true }),
    ].map((r) => [r.id, r])
  );

  const me = {
    id: 'bot-id',
    permissions: new PermissionsBitField(PermissionsBitField.All),
    roles: { highest: fakeRole({ id: 'botrole', name: 'Sylo', position: 50 }) },
  };

  const guild = {
    id: GID,
    name: 'Test Guild',
    memberCount: 42,
    ownerId: 'owner-id',
    iconURL: () => null,
    channels: {
      cache: channels,
      fetch: async (id) => channels.get(id) ?? null,
      create: async ({ name }) => {
        const c = fakeChannel(sink, {
          id: 'new-' + (sink.created.length + 1),
          name,
          type: ChannelType.GuildText,
          position: 99,
        });
        c.guild = guild;
        channels.set(c.id, c);
        sink.created.push({ name, id: c.id });
        return c;
      },
    },
    roles: { cache: roles, everyone: roles.get(GID) },
    members: {
      me,
      cache: new Map(),
      fetch: async (id) => ({
        id,
        user: { id, tag: `user-${String(id).slice(-4)}`, displayAvatarURL: () => null },
        roles: { cache: new Map(), highest: roles.get(ROLE.member) },
        manageable: true,
        moderatable: true,
        kickable: true,
        bannable: true,
        timeout: async () => {},
        kick: async () => {},
        setNickname: async () => {},
      }),
    },
    bans: {
      fetch: async (id) => {
        if (id) return null; // "not banned"
        return new Map(); // full list
      },
      create: async () => {},
      remove: async () => {},
    },
    emojis: { cache: new Map() },
    autoModerationRules: fakeAutomodRules(sink),
  };

  for (const c of channels.values()) c.guild = guild;

  const client = {
    user: { id: 'bot-id', tag: 'Sylo#0001', username: 'Sylo', displayAvatarURL: () => null },
    guilds: { cache: new Map([[GID, guild]]) },
    users: {
      cache: new Map(),
      fetch: async (id) => ({
        id,
        tag: `user-${String(id).slice(-4)}`,
        displayAvatarURL: () => null,
        send: async (payload) => sink.dms.push({ id, payload }),
      }),
    },
    // a couple of commands so /commands and overview command counts render
    commands: new Map([
      ['ping', { data: { name: 'ping', description: 'pong', toJSON: () => ({ name: 'ping' }) } }],
      ['ban', { data: { name: 'ban', description: 'ban a member', toJSON: () => ({ name: 'ban' }) } }],
    ]),
    ws: { ping: 42 },
    isReady: () => true,
  };

  return { guild, client, sink };
}
