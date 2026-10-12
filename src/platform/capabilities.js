// What each chat platform can do natively. Everything marked false is bridged
// or skipped by Sylo itself.
//
// `components`: buttons / select menus. Fluxer announced bots will get
// "slash commands, modals, buttons and other components, and interactions in
// 2026" (https://fluxer.app/blog/roadmap-2026). Until the SDK ships them,
// components are rendered as reactions (outgoing.js / reactionBridge.js). Flip
// this to true once it does and the payload's `components` go to the platform
// untouched instead.
//
// `nativeAutomod`: server-side AutoModeration rules (automodSync.js); Fluxer has
// none, so only Sylo's in-process scanner enforces automod there.
// `threads`: thread channels and the thread permissions (SendMessagesInThreads,
// CreatePublicThreads, CreatePrivateThreads). Fluxer lists threads for 2026.
// `slashCommands`: registered application commands (/name). Fluxer has none yet, so a
// custom command is run from its `!name` chat form instead and nothing is synced.
// `moveMembers`: moving a member between voice channels from the bot. Fluxer has
// GuildMember.move(), but tested live on fluxer.opland.net (2026-10-12) it is
// unusable: for the community owner it fails with MISSING_PERMISSIONS, and for
// another member it "succeeds" while the client shows them in the new channel
// and the gateway reports a voice state with no channel — they are connected
// but invisible to everyone else and to Sylo. Temp voice channels therefore
// DM the member a join link instead. Re-test before flipping this to true.
export const CAPABILITIES = {
  discord: { components: true, nativeAutomod: true, threads: true, moveMembers: true, slashCommands: true },
  fluxer: {
    components: false,
    nativeAutomod: false,
    threads: false,
    moveMembers: false,
    slashCommands: false,
  },
};

export const supports = (platform, feature) => Boolean(CAPABILITIES[platform]?.[feature]);
