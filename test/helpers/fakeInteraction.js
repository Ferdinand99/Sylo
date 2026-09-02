// Minimal stand-ins for discord.js interaction objects, for router/handler tests.

/** A message-component (button / select) interaction. */
export function fakeComponentInteraction(customId, opts = {}) {
  const state = { replied: false, deferred: false, replies: [] };
  return {
    customId,
    values: opts.values ?? [],
    isMessageComponent: () => true,
    isButton: () => !customId.includes('sel') && !customId.includes('roles'),
    isStringSelectMenu: () => customId.includes('sel') || customId.includes('roles'),
    isRepliable: () => opts.repliable !== false,
    get replied() {
      return state.replied;
    },
    get deferred() {
      return state.deferred;
    },
    async reply(payload) {
      state.replied = true;
      state.replies.push(payload);
    },
    _replies: state.replies,
  };
}

/** A chat-input (slash) interaction, for the command-override checks. */
export function fakeCommandInteraction({ guildId, commandName, channelId, isAdmin = false, roleIds = [] }) {
  return {
    commandName,
    channelId,
    inGuild: () => Boolean(guildId),
    guildId,
    memberPermissions: { has: () => isAdmin },
    member: { roles: { cache: new Map(roleIds.map((id) => [id, { id }])) } },
  };
}
