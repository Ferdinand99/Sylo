// Who a message mentions, on either platform. discord.js has
// `message.mentions.users` / `.roles` (Collections) and `.everyone`; Fluxer sets
// `message.mentions` to an array of users, with `mentionRoles` (ids) and
// `mentionEveryone` beside it.

/** Ids of the users a message mentions. */
export function mentionedUserIds(message) {
  const m = message?.mentions;
  if (Array.isArray(m)) return m.map((u) => u?.id ?? u).filter(Boolean);
  return m?.users ? [...m.users.keys()] : [];
}

/** Ids of the roles a message mentions. */
export function mentionedRoleIds(message) {
  if (Array.isArray(message?.mentionRoles)) return message.mentionRoles;
  return message?.mentions?.roles ? [...message.mentions.roles.keys()] : [];
}

/** Whether a message mentions @everyone / @here. */
export const mentionsEveryone = (message) => Boolean(message?.mentionEveryone ?? message?.mentions?.everyone);
