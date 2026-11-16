// Discord permissions -> Fluxer permissions, bit by bit.
//
// Fluxer's permission flags were laid out like Discord's, so most bits are the same number. A few Discord
// permissions have no Fluxer counterpart (application commands, threads, events, soundboard, polls ...):
// those bits are dropped, and the report says which ones were dropped where. Two Fluxer permissions have no
// Discord counterpart (UpdateRtcRegion, ViewChannelMembers): a mirror never touches them, so a role or a
// channel that already holds them on the Fluxer side keeps them (see keepFluxerOnly).
//
// The table is data: test/mirrorPermissions.test.js checks every row against discord.js's and the Fluxer
// SDK's own flag tables, so a renamed or renumbered permission fails a test instead of silently mapping wrong.

/**
 * One row per Discord permission bit that exists: its Discord name, its bit, the Fluxer name it becomes
 * (null when Fluxer has no such permission) and a short label for the report.
 * @type {ReadonlyArray<{ bit: number, discord: string, fluxer: string | null, label: string }>}
 */
export const PERMISSION_TABLE = Object.freeze(
  [
    [0, 'CreateInstantInvite', 'CreateInstantInvite', 'Create Invite'],
    [1, 'KickMembers', 'KickMembers', 'Kick Members'],
    [2, 'BanMembers', 'BanMembers', 'Ban Members'],
    [3, 'Administrator', 'Administrator', 'Administrator'],
    [4, 'ManageChannels', 'ManageChannels', 'Manage Channels'],
    [5, 'ManageGuild', 'ManageGuild', 'Manage Server'],
    [6, 'AddReactions', 'AddReactions', 'Add Reactions'],
    [7, 'ViewAuditLog', 'ViewAuditLog', 'View Audit Log'],
    [8, 'PrioritySpeaker', 'PrioritySpeaker', 'Priority Speaker'],
    [9, 'Stream', 'Stream', 'Video'],
    [10, 'ViewChannel', 'ViewChannel', 'View Channel'],
    [11, 'SendMessages', 'SendMessages', 'Send Messages'],
    [12, 'SendTTSMessages', 'SendTtsMessages', 'Send Text-to-Speech Messages'],
    [13, 'ManageMessages', 'ManageMessages', 'Manage Messages'],
    [14, 'EmbedLinks', 'EmbedLinks', 'Embed Links'],
    [15, 'AttachFiles', 'AttachFiles', 'Attach Files'],
    [16, 'ReadMessageHistory', 'ReadMessageHistory', 'Read Message History'],
    [17, 'MentionEveryone', 'MentionEveryone', 'Mention Everyone'],
    [18, 'UseExternalEmojis', 'UseExternalEmojis', 'Use External Emoji'],
    [19, 'ViewGuildInsights', null, 'View Server Insights'],
    [20, 'Connect', 'Connect', 'Connect'],
    [21, 'Speak', 'Speak', 'Speak'],
    [22, 'MuteMembers', 'MuteMembers', 'Mute Members'],
    [23, 'DeafenMembers', 'DeafenMembers', 'Deafen Members'],
    [24, 'MoveMembers', 'MoveMembers', 'Move Members'],
    [25, 'UseVAD', 'UseVad', 'Use Voice Activity'],
    [26, 'ChangeNickname', 'ChangeNickname', 'Change Nickname'],
    [27, 'ManageNicknames', 'ManageNicknames', 'Manage Nicknames'],
    [28, 'ManageRoles', 'ManageRoles', 'Manage Roles'],
    [29, 'ManageWebhooks', 'ManageWebhooks', 'Manage Webhooks'],
    [30, 'ManageGuildExpressions', 'ManageExpressions', 'Manage Expressions'],
    [31, 'UseApplicationCommands', null, 'Use Application Commands'],
    [32, 'RequestToSpeak', null, 'Request to Speak'],
    [33, 'ManageEvents', null, 'Manage Events'],
    [34, 'ManageThreads', null, 'Manage Threads'],
    [35, 'CreatePublicThreads', null, 'Create Public Threads'],
    [36, 'CreatePrivateThreads', null, 'Create Private Threads'],
    [37, 'UseExternalStickers', 'UseExternalStickers', 'Use External Stickers'],
    [38, 'SendMessagesInThreads', null, 'Send Messages in Threads'],
    [39, 'UseEmbeddedActivities', null, 'Use Activities'],
    [40, 'ModerateMembers', 'ModerateMembers', 'Timeout Members'],
    [41, 'ViewCreatorMonetizationAnalytics', null, 'View Creator Analytics'],
    [42, 'UseSoundboard', null, 'Use Soundboard'],
    [43, 'CreateGuildExpressions', 'CreateExpressions', 'Create Expressions'],
    [44, 'CreateEvents', null, 'Create Events'],
    [45, 'UseExternalSounds', null, 'Use External Sounds'],
    [46, 'SendVoiceMessages', null, 'Send Voice Messages'],
    [48, 'SetVoiceChannelStatus', null, 'Set Voice Channel Status'],
    [49, 'SendPolls', null, 'Create Polls'],
    [50, 'UseExternalApps', null, 'Use External Apps'],
    [51, 'PinMessages', 'PinMessages', 'Pin Messages'],
    [52, 'BypassSlowmode', 'BypassSlowmode', 'Bypass Slowmode'],
  ].map(([bit, discord, fluxer, label]) => Object.freeze({ bit, discord, fluxer, label }))
);

/** The Fluxer bit of each mapped Discord bit (Fluxer's bit numbers, from the SDK's flag table). */
const FLUXER_BIT = Object.freeze({
  CreateInstantInvite: 0,
  KickMembers: 1,
  BanMembers: 2,
  Administrator: 3,
  ManageChannels: 4,
  ManageGuild: 5,
  AddReactions: 6,
  ViewAuditLog: 7,
  PrioritySpeaker: 8,
  Stream: 9,
  ViewChannel: 10,
  SendMessages: 11,
  SendTtsMessages: 12,
  ManageMessages: 13,
  EmbedLinks: 14,
  AttachFiles: 15,
  ReadMessageHistory: 16,
  MentionEveryone: 17,
  UseExternalEmojis: 18,
  Connect: 20,
  Speak: 21,
  MuteMembers: 22,
  DeafenMembers: 23,
  MoveMembers: 24,
  UseVad: 25,
  ChangeNickname: 26,
  ManageNicknames: 27,
  ManageRoles: 28,
  ManageWebhooks: 29,
  ManageExpressions: 30,
  UseExternalStickers: 37,
  ModerateMembers: 40,
  CreateExpressions: 43,
  PinMessages: 51,
  BypassSlowmode: 52,
  UpdateRtcRegion: 53,
  ViewChannelMembers: 54,
});

/** Fluxer permissions Discord does not have: the mirror leaves these as they are on the Fluxer side. */
export const FLUXER_ONLY_BITS = (1n << 53n) | (1n << 54n);

const rowsByBit = new Map(PERMISSION_TABLE.map((r) => [r.bit, r]));

/** The Fluxer bit number for a Fluxer permission name of the table (for the tests). */
export const fluxerBitOf = (name) => FLUXER_BIT[name];

/**
 * Map a Discord permission bitfield to Fluxer's.
 * @param {bigint | number | string} discordBits
 * @returns {{ bits: bigint, dropped: string[], unknown: number[] }} `dropped`: the labels of the Discord
 *   permissions Fluxer has no equivalent for; `unknown`: bit numbers this table does not know (a newer Discord).
 */
export function mapPermissions(discordBits) {
  let rest = BigInt(discordBits ?? 0);
  let bits = 0n;
  const dropped = [];
  const unknown = [];
  for (let bit = 0; rest > 0n; bit += 1, rest >>= 1n) {
    if ((rest & 1n) === 0n) continue;
    const row = rowsByBit.get(bit);
    if (!row) unknown.push(bit);
    else if (row.fluxer === null) dropped.push(row.label);
    else bits |= 1n << BigInt(FLUXER_BIT[row.fluxer]);
  }
  return { bits, dropped, unknown };
}

/** The Fluxer-only bits of `existing` (what a role or overwrite already has there), to carry over. */
export const keepFluxerOnly = (existing) => BigInt(existing ?? 0) & FLUXER_ONLY_BITS;

/** Are the unmapped bits of a mapping result worth a line in the report? */
export const lostSomething = (m) => m.dropped.length > 0 || m.unknown.length > 0;

/** A readable list of what a mapping dropped, e.g. "Manage Events, Create Public Threads, bit 60". */
export const describeDropped = (m) =>
  [...m.dropped, ...m.unknown.map((b) => `unknown permission (bit ${b})`)].join(', ');
