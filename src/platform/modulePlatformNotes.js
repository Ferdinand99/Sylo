// What a module page should tell you about the platform of the server you are looking at.
// Discord is the baseline every page is written for, so it has no notes; Fluxer gets a
// short explanation wherever its behaviour differs. Capabilities come from capabilities.js,
// the same table the bot code consults, so the dashboard and the bot never disagree.
import { config } from '../config.js';
import { CAPABILITIES } from './capabilities.js';
import { platformOfGuild } from './platformOf.js';
import { fluxerEndpoints } from './instance.js';

/** @type {Record<string, (ctx: { prefix: string }) => string>} */
const FLUXER_NOTES = {
  automod: () =>
    "Fluxer has no native AutoMod rules, so Sylo's own scanner does all the filtering here (words, invites, links, mentions, caps, spam and so on). The native-enforcement settings do not apply on this server.",
  'temp-voice': () =>
    'Fluxer bots cannot move members between voice channels. When someone joins a hub, Sylo creates their channel and sends them a DM with a link to join it; a channel nobody joins within two minutes is removed.',
  verification: () =>
    'Fluxer has no buttons yet, so the verify panel works through a reaction: members react to the message to start verifying.',
  giveaways: () =>
    'Fluxer has no buttons yet: members enter a giveaway by reacting to its message instead of pressing a button.',
  roles: () =>
    'Role menus show their buttons and dropdown options as reactions, with a short legend in the message. Members react to get or drop a role.',
  tickets: () =>
    'DM tickets work as on Discord. Any button or dropdown in a ticket message is shown as reactions on Fluxer.',
  'custom-commands': ({ prefix }) =>
    `Fluxer has no slash commands, so a custom command runs from chat as ${prefix}name (extra text fills {args}). The prefix is set with COMMAND_PREFIX. Nothing is registered with Fluxer.`,
};

/**
 * @param {'discord' | 'fluxer'} platform
 * @param {string} moduleId
 * @returns {string | null}
 */
export function modulePlatformNote(platform, moduleId) {
  if (platform !== 'fluxer') return null;
  return FLUXER_NOTES[moduleId]?.({ prefix: config.commandPrefix }) ?? null;
}

/**
 * What the dashboard needs to know about a guild's platform.
 * @param {any} guild
 * @returns {{ platform: 'discord' | 'fluxer', capabilities: Record<string, boolean>, notes: Record<string, string>, commandPrefix: string, webAppUrl: string }}
 */
export function platformInfo(guild) {
  const platform = platformOfGuild(guild);
  const notes = {};
  for (const id of Object.keys(FLUXER_NOTES)) {
    const note = modulePlatformNote(platform, id);
    if (note) notes[id] = note;
  }
  return {
    platform,
    capabilities: { ...CAPABILITIES[platform] },
    notes,
    // How a command is written in help text, and where a message link points.
    commandPrefix: platform === 'fluxer' ? config.commandPrefix : '/',
    webAppUrl: platform === 'fluxer' ? fluxerEndpoints().webapp : 'https://discord.com',
  };
}
