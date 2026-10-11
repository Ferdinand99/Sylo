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
// `moveMembers`: moving a member between voice channels from the bot.
export const CAPABILITIES = {
  discord: { components: true, nativeAutomod: true, threads: true, moveMembers: true },
  fluxer: { components: false, nativeAutomod: false, threads: false, moveMembers: false },
};

export const supports = (platform, feature) => Boolean(CAPABILITIES[platform]?.[feature]);
