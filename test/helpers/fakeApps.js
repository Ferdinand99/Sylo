// A fake server for the Applications tests: the Introductions fake (one text channel that keeps its
// messages, roles, members) plus the channels an application goes to, a bot that has a highest role and
// may manage roles, members whose role changes can be made to fail, and the DM side of the questionnaire.
import { runtime } from '../../src/runtime.js';
import { handleQuestionnaireMessage } from '../../src/bot/lib/dmQuestionnaire.js';
import { GID, ME, ROLE, dropFakeClient, fakeChannel, fakeIntroGuild, fakeMember } from './fakeIntro.js';

export { GID, ME, ROLE, dropFakeClient };

export const CH = {
  pending: '100000000000000601',
  accepted: '100000000000000602',
  denied: '100000000000000603',
  panel: '100000000000000604',
};

/** Roles the forms hand out, above the ones of the intro fake; the bot's highest role is 100. */
export const APP_ROLE = {
  waiting: '100000000000000811',
  member: '100000000000000812',
  tourist: '100000000000000813',
  sorry: '100000000000000814',
  chosenA: '100000000000000815',
  chosenB: '100000000000000816',
  tooHigh: '100000000000000817',
  manager: '100000000000000818',
  ping: '100000000000000819',
};

export const STAFF = '700000000000000001';
export const U = '700000000000000010';
export const U2 = '700000000000000011';

export function fakeAppsGuild() {
  const env = fakeIntroGuild();
  const { guild, client } = env;
  const channels = {};
  for (const [name, id] of Object.entries(CH)) {
    channels[name] = fakeChannel(id, name);
    guild.channels.cache.set(id, channels[name]);
  }
  const addRole = (id, name, position, extra = {}) =>
    guild.roles.cache.set(id, { id, name, position, color: 0, managed: false, ...extra });
  addRole(APP_ROLE.waiting, 'Waiting', 5);
  addRole(APP_ROLE.member, 'Member', 6);
  addRole(APP_ROLE.tourist, 'Tourist', 4);
  addRole(APP_ROLE.sorry, 'Sorry', 3);
  addRole(APP_ROLE.chosenA, 'Red team', 7);
  addRole(APP_ROLE.chosenB, 'Blue team', 8);
  addRole(APP_ROLE.tooHigh, 'Boss', 200);
  addRole(APP_ROLE.manager, 'Reviewer', 9);
  addRole(APP_ROLE.ping, 'Reviewers', 9);
  guild.members.me = {
    id: ME,
    permissions: { has: () => true },
    roles: { highest: { comparePositionTo: (r) => 100 - (r.position ?? 0) } },
  };
  client.users = {
    fetch: async (id) => {
      const found = guild.members.cache.get(id);
      if (!found) throw new Error('Unknown User');
      return found.user;
    },
  };
  return { ...env, channels };
}

/**
 * A member of the fake server. Their role changes land in `roles.cache`; `member.failRoles` (a Set of
 * role ids) makes a change of that role fail, `member.roleLog` records every change.
 */
export function appMember(
  env,
  id,
  { roleIds = [], username = `user${id.slice(-4)}`, joinedDaysAgo = 400, accountDaysAgo = 900 } = {}
) {
  const member = fakeMember(env.guild, id, {
    username,
    roleIds,
    joinedAt: Date.now() - joinedDaysAgo * 86_400_000,
  });
  member.user.createdTimestamp = Date.now() - accountDaysAgo * 86_400_000;
  member.failRoles = new Set();
  member.roleLog = [];
  const change = (kind) => async (roleId) => {
    member.roleLog.push(`${kind}:${roleId}`);
    if (member.failRoles.has(roleId))
      throw Object.assign(new Error('Missing Permissions'), { status: 403, code: 50013 });
    if (kind === 'add') member.roles.cache.set(roleId, env.guild.roles.cache.get(roleId));
    else member.roles.cache.delete(roleId);
  };
  member.roles.add = change('add');
  member.roles.remove = change('remove');
  member.permissions = { has: () => false };
  return member;
}

/** The member's DM: everything Sylo sent them, and a way to write as them. */
export function dmFor(env, member) {
  const sent = member.user.dms;
  const channel = { send: async (payload) => sent.push(payload) && { channel, edit: async () => {} } };
  member.user.send = async (payload) => sent.push(payload) && { channel, edit: async () => {} };
  const say = (content) =>
    handleQuestionnaireMessage({ author: member.user, content, client: env.client, channel });
  return { sent, channel, say };
}

/** A press on a component (a button, or a choice in a menu) by `member` in the server. */
export function pressAs(env, customId, member, { values, permissions } = {}) {
  const log = { replies: [], followUps: [], updates: [], edits: [], deferred: 0 };
  const interaction = {
    customId,
    values,
    user: member.user,
    member,
    memberPermissions: permissions ?? member.permissions,
    guild: env.guild,
    guildId: GID,
    client: env.client,
    isRepliable: () => true,
    deferUpdate: async () => {
      log.deferred += 1;
    },
    deferReply: async () => {
      log.deferred += 1;
    },
    reply: async (payload) => log.replies.push(payload),
    editReply: async (payload) => log.replies.push(payload),
    followUp: async (payload) => log.followUps.push(payload),
    update: async (payload) => log.updates.push(payload),
    message: { edit: async (payload) => log.edits.push(payload) },
  };
  return { interaction, log };
}

/** A slash command call (`/apply start`, `/application deny` ...). */
export function commandAs(env, member, subcommand, options = {}, permissions) {
  const replies = [];
  return {
    replies,
    guild: env.guild,
    guildId: GID,
    user: member.user,
    member,
    memberPermissions: permissions ?? member.permissions,
    options: {
      getSubcommand: () => subcommand,
      getString: (name) => options[name] ?? null,
      getInteger: (name) => options[name] ?? null,
    },
    deferReply: async () => {},
    reply: async (payload) => replies.push(payload),
    editReply: async (payload) => replies.push(payload),
  };
}

/** Manage Server for a staff member. */
export const manageServer = { has: (p) => p === 'ManageGuild' };

export { runtime };
