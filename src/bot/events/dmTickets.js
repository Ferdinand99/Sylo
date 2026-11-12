// DM → ticket bridge. A DM to the bot opens (or appends to) a ticket, unless the member is answering
// a DM questionnaire (bot/lib/dmQuestionnaire.js), which takes their DMs first. When the
// user shares several ticket-enabled servers and has no open ticket, the bot
// asks which server with a select menu.
import { guildKey, guildByKey, platformOfClient } from '../../platform/platformOf.js';
import { config } from '../../config.js';
import { Events, StringSelectMenuBuilder, ActionRowBuilder } from 'discord.js';
import { ticketGuildsForUser, ingestUserDM } from '../../modules/tickets.js';
import { getOpenTicket } from '../../db/tickets.js';
import { registerComponent } from '../lib/components.js';
import { handleQuestionnaireMessage, looksLikeQuestionnairePrompt } from '../lib/dmQuestionnaire.js';
import { lateAnswerWindowMs } from '../../modules/applications.js';
import { log } from '../../lib/log.js';
import { sweepMap } from '../../lib/sweepMap.js';

const SELECT_ID = 'ticket-guild';
const pending = new Map(); // userId -> { content, attachments, at }
const PENDING_TTL = 10 * 60 * 1000;
sweepMap(pending, (p, now) => now - p.at > PENDING_TTL);

function stash(userId, payload) {
  pending.set(userId, { ...payload, at: Date.now() });
}
function takeStash(userId) {
  const p = pending.get(userId);
  pending.delete(userId);
  if (!p || Date.now() - p.at > PENDING_TTL) return null;
  return p;
}

// How far back a question of a questionnaire still counts as "the one this answer is for".
const STALE_PROMPT_MS = 30 * 60 * 1000;

/**
 * Sessions of a DM questionnaire live in memory, so after a restart a member's next answer finds
 * none. If the message just before this one is Sylo's own question (or preview), this is a late
 * answer: say so instead of sending personal answers to staff as a modmail ticket. Best effort: a
 * channel whose history cannot be read gets the normal ticket path.
 * @returns {Promise<boolean>} true when the message was dealt with
 */
async function lateQuestionnaireAnswer(message) {
  try {
    const recent = await message.channel?.messages?.fetch?.({ limit: 5, before: message.id });
    // The newest message of Sylo's own, whatever order the platform returns them in.
    const mine = [...(recent?.values?.() ?? [])]
      .filter((m) => m.author?.id === message.client?.user?.id)
      .sort((a, b) => (b.createdTimestamp ?? 0) - (a.createdTimestamp ?? 0))[0];
    if (!mine || !looksLikeQuestionnairePrompt(mine.content)) return false;
    // An application form may allow hours to answer, so the window is the longest of the member's servers.
    const window = await lateAnswerWindowMs(message.client, message.author?.id, STALE_PROMPT_MS);
    if (Date.now() - (mine.createdTimestamp ?? Date.now()) > window) return false;
  } catch {
    return false;
  }
  // The command is named for the platform the DM arrived on (Fluxer has no slash commands).
  const prefix = platformOfClient(message.client) === 'fluxer' ? config.commandPrefix : '/';
  await message
    .reply(
      `That looks like an answer to a questionnaire that has ended (it timed out, or Sylo restarted), so I did not send it to staff. Start it again from the server, for example with ${prefix}intro create. For an application, use ${prefix}apply start.`
    )
    .catch(() => {});
  return true;
}

async function handleDM(message) {
  const payload = {
    content: message.content ?? '',
    attachments: [...message.attachments.values()].map((a) => a.url),
  };
  if (!payload.content && payload.attachments.length === 0) return;

  // Only the servers on the platform this DM arrived on: a user id means nothing on the other one.
  const guilds = await ticketGuildsForUser(message.author, message.client);
  if (guilds.length === 0) {
    await message
      .reply("I'm not set up to take messages for any server you're in right now.")
      .catch(() => {});
    return;
  }

  // If there's exactly one open ticket already, keep the conversation there.
  const openFlags = await Promise.all(guilds.map((g) => getOpenTicket(guildKey(g), message.author.id)));
  const openGuilds = guilds.filter((g, i) => openFlags[i]);
  if (openGuilds.length === 1) {
    await ingestUserDM(openGuilds[0], message.author, payload);
    await message.react('✅').catch(() => {});
    return;
  }
  if (openGuilds.length === 0 && guilds.length === 1) {
    await ingestUserDM(guilds[0], message.author, payload);
    await message.react('✅').catch(() => {});
    return;
  }

  // Ambiguous — ask which server.
  stash(message.author.id, payload);
  const menu = new StringSelectMenuBuilder()
    .setCustomId(SELECT_ID)
    .setPlaceholder('Which server is this about?')
    .addOptions(
      (openGuilds.length ? openGuilds : guilds)
        .slice(0, 25)
        .map((g) => ({ label: g.name.slice(0, 100), value: guildKey(g) }))
    );
  await message
    .reply({
      content: 'You can reach staff in more than one server. Pick one:',
      components: [new ActionRowBuilder().addComponents(menu)],
    })
    .catch(() => {});
}

async function handleSelect(interaction) {
  const picked = guildByKey(interaction.values[0]);
  // Still one the member may open a ticket in (a member there, tickets on): the menu could be old.
  const allowed = picked
    ? await ticketGuildsForUser(interaction.user, interaction.client ?? picked.client)
    : [];
  const guild = allowed.find((g) => guildKey(g) === guildKey(picked));
  const payload = takeStash(interaction.user.id);
  if (!guild || !payload) {
    await interaction
      .update({ content: 'That request expired — send your message again.', components: [] })
      .catch(() => {});
    return;
  }
  const ticket = await ingestUserDM(guild, interaction.user, payload);
  await interaction
    .update({
      content: `Opened ticket #${ticket.id} for **${guild.name}**. Just keep replying here.`,
      components: [],
    })
    .catch(() => {});
}

registerComponent('tickets', SELECT_ID, handleSelect);

/** @param {import('discord.js').Client} client */
export function register(client, { isCommand = () => false } = {}) {
  client.on(Events.MessageCreate, async (message) => {
    try {
      if (message.guild || message.author?.bot) return;
      if (message.partial) {
        try {
          await message.fetch();
        } catch {
          return;
        }
      }
      // A member in the middle of a DM questionnaire (Introductions, later applications) is answering
      // it: this message is an answer, and must never open or extend a modmail ticket. This comes
      // before the command check, so an answer that starts with the Fluxer prefix is still an answer.
      if (await handleQuestionnaireMessage(message)) return;
      // `!help` in a DM is a command for the router (Fluxer), not a ticket message.
      if (await isCommand(message)) return;
      if (await lateQuestionnaireAnswer(message)) return;
      await handleDM(message);
    } catch (err) {
      log.error('tickets', 'DM handler failed:', err);
    }
  });
}
