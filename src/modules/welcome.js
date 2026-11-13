// Welcome & leave module. config shape:
//   { joinChannel, joinMessage, leaveChannel, leaveMessage, dmMessage, useEmbed,
//     card, cardBackground, trigger, triggerRoleIds, triggerSince }
// Placeholders: {user} {user.tag} {user.name} {user.id} {server} {memberCount} {intro} {role}
//
// `trigger` says when the welcome (message, image and DM) goes out: 'join' (the default) when a
// member joins, or 'role' when they first get one of `triggerRoleIds`. In 'role' mode a member is
// welcomed once per server: the claim row in welcome_sent is written before the send, stays when the
// send fails (a missed welcome is better than a double one) and goes when the member leaves. Welcomes
// on joining claim the same row, so a member already welcomed is never welcomed again by a role.
// `triggerSince` maps each trigger role to the moment it started counting (set by the server).
import { guildKey, rawGuildId } from '../platform/platformOf.js';
import { EmbedBuilder, AttachmentBuilder, escapeMarkdown } from 'discord.js';
import { on } from './dispatch.js';
import { sendToChannel } from './lib/send.js';
import { guildEmbedColor } from '../db/guildSettings.js';
import { claimWelcome, clearWelcomeSent } from '../db/welcomeSent.js';
import { renderWelcomeCard, welcomeCardAvailable } from '../bot/lib/welcomeCard.js';
import { log } from '../lib/log.js';
import { introChannelMention } from './introductions.js';
import { idList } from '../web/lib/idList.js';

export const WELCOME_PLACEHOLDERS = [
  '{user}',
  '{user.tag}',
  '{user.name}',
  '{user.id}',
  '{server}',
  '{memberCount}',
  '{intro}',
  '{role}',
];

/** The two moments a welcome can go out. */
export const WELCOME_TRIGGERS = ['join', 'role'];

/** Setting limits, served to the dashboard (modules/limits.js). */
export const LIMITS = {
  joinMessage: { maxLength: 1500 },
  leaveMessage: { maxLength: 1500 },
  dmMessage: { maxLength: 1500 },
  cardBackground: { maxLength: 500 },
  triggerRoleIds: { maxItems: 10 },
};

const chan = (v) => (/^\d{17,20}$/.test(v ?? '') ? v : '');

/**
 * The roles of `ids` that can start a welcome in this server: they exist, are not @everyone and are
 * not managed (a bot's or an integration's role is not something a member "gets").
 * @param {any} guild  a guild, keyed or not (the @everyone role has the platform's own guild id)
 * @param {string[]} ids
 */
export function validTriggerRoleIds(guild, ids) {
  const everyone = guild ? rawGuildId(guild) : null;
  return ids.filter((id) => {
    const role = guild?.roles?.cache?.get(id);
    return Boolean(role) && id !== everyone && !role.managed;
  });
}

/**
 * The roles of `ids` that may start a welcome while the bot runs: everything except @everyone and a
 * role known to be managed. A role missing from the role cache still counts (the cache may lag); the
 * strict check of validTriggerRoleIds is for saving.
 * @param {any} guild
 * @param {string[]} ids
 */
export function usableTriggerRoleIds(guild, ids) {
  const everyone = guild ? rawGuildId(guild) : null;
  return ids.filter((id) => id !== everyone && guild?.roles?.cache?.get(id)?.managed !== true);
}

/** A `triggerSince` value as a clean { roleId: epochMs } map (ids only, finite times). */
function sinceMap(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, at] of Object.entries(raw)) {
    if (/^\d{17,20}$/.test(id) && Number.isFinite(at) && at > 0) out[id] = Math.floor(at);
  }
  return out;
}

/**
 * When each trigger role started counting. In 'join' mode there are none. In 'role' mode a role keeps
 * its time while it stays in the list of a config that already welcomed on roles, and gets `now` when it
 * is added or when the mode is switched on. A role that leaves the list loses its time.
 */
function stampSince(prev, trigger, roleIds, now) {
  if (trigger !== 'role') return {};
  const before = prev?.trigger === 'role' ? sinceMap(prev.triggerSince) : {};
  return Object.fromEntries(roleIds.map((id) => [id, before[id] ?? now]));
}

/**
 * Coerce a submitted welcome config into the canonical shape. Each message and channel is only
 * kept while its switch is on. `autoroleEnabled` is the switch only; the roles themselves live in
 * the roles module and are written by the route next to this config.
 *
 * `trigger` is 'join' unless it is exactly 'role'. `triggerRoleIds` is kept at most 10 long; give
 * the guild to also drop roles that do not exist, @everyone and managed roles. The roles are kept
 * while the trigger is 'join' too, so switching back and forth does not lose the choice.
 *
 * `triggerSince` is never taken from `raw`: the server sets it from the stored config `prev` (see
 * stampSince) at `now`.
 * @param {object} [raw]
 * @param {any} [guild]
 * @param {{ prev?: object, now?: number }} [opts]
 */
export function normaliseWelcomeConfig(raw = {}, guild = null, { prev = {}, now = Date.now() } = {}) {
  const trigger = raw.trigger === 'role' ? 'role' : 'join';
  const joinOn = Boolean(raw.joinEnabled);
  const dmOn = Boolean(raw.dmEnabled);
  const leaveOn = Boolean(raw.leaveEnabled);
  const cardBg = String(raw.cardBackground ?? '').trim();
  let triggerRoleIds = idList(raw.triggerRoleIds, 100);
  if (guild) triggerRoleIds = validTriggerRoleIds(guild, triggerRoleIds);
  triggerRoleIds = triggerRoleIds.slice(0, LIMITS.triggerRoleIds.maxItems);
  return {
    trigger,
    triggerRoleIds,
    triggerSince: stampSince(prev, trigger, triggerRoleIds, now),
    joinEnabled: joinOn,
    joinChannel: joinOn ? chan(raw.joinChannel) : '',
    joinMessage: joinOn ? String(raw.joinMessage ?? '').slice(0, LIMITS.joinMessage.maxLength) : '',
    leaveEnabled: leaveOn,
    leaveChannel: leaveOn ? chan(raw.leaveChannel) : '',
    leaveMessage: leaveOn ? String(raw.leaveMessage ?? '').slice(0, LIMITS.leaveMessage.maxLength) : '',
    dmEnabled: dmOn,
    dmMessage: dmOn ? String(raw.dmMessage ?? '').slice(0, LIMITS.dmMessage.maxLength) : '',
    useEmbed: Boolean(raw.useEmbed),
    card: Boolean(raw.card),
    cardBackground: /^https:\/\/\S+$/i.test(cardBg) ? cardBg.slice(0, LIMITS.cardBackground.maxLength) : '',
    autoroleEnabled: Boolean(raw.autoroleEnabled),
  };
}

/**
 * When a stored config welcomes members, and for which roles. A config saved before the setting
 * existed welcomes on join. The roles are not checked against the server here (see validTriggerRoleIds).
 * @param {object} [config]
 * @returns {{ trigger: 'join' | 'role', roleIds: string[], since: Record<string, number> }}
 */
export function welcomeTrigger(config = {}) {
  return {
    trigger: config?.trigger === 'role' ? 'role' : 'join',
    roleIds: idList(config?.triggerRoleIds, LIMITS.triggerRoleIds.maxItems),
    since: sinceMap(config?.triggerSince),
  };
}

/** Everything a name must not be able to do in a message: format it, or ping with it. */
const plainName = (name) => escapeMarkdown(String(name ?? '')).replaceAll('@', '@​');

const PLACEHOLDER = /\{(user\.tag|user\.name|user\.id|user|server|memberCount|intro|role)\}/g;

/**
 * Fill a template in one pass, so a name that itself looks like a placeholder (a role called
 * `{user}`) is shown as typed and not expanded again.
 *
 * `intro` is what {intro} stands for: a mention of the introductions channel while that module is on
 * and has a channel, else empty text (see introChannelMention). `role` is what {role} stands for: the
 * role that started a welcome in 'role' mode, else empty text.
 */
function fill(template, member, intro = '', role = '') {
  if (!template) return '';
  const values = {
    'user.tag': member.user.tag,
    'user.name': member.user.username,
    'user.id': member.id,
    user: `<@${member.id}>`,
    server: member.guild.name,
    memberCount: String(member.guild.memberCount),
    intro,
    role: plainName(role),
  };
  return template.replace(PLACEHOLDER, (_all, key) => values[key]);
}

/** Build the welcome-card attachment for a joining member, or null. */
async function buildCard(member, config) {
  if (!config.card || !welcomeCardAvailable) return null;
  // No point rendering a card the bot can't attach — the message still goes out.
  const channel = member.guild.channels.cache.get(config.joinChannel);
  const me = member.guild.members.me;
  if (channel && me && !channel.permissionsFor(me)?.has('AttachFiles')) {
    log.warn('module:welcome', `missing Attach Files in #${channel.name} — welcome image skipped`);
    return null;
  }
  try {
    const png = await renderWelcomeCard({
      name: member.user.globalName || member.user.username,
      avatarUrl: member.user.displayAvatarURL({ extension: 'png', size: 256 }),
      memberCount: member.guild.memberCount,
      accent: await guildEmbedColor(guildKey(member.guild)),
      backgroundUrl: config.cardBackground || undefined,
    });
    return png ? new AttachmentBuilder(png, { name: 'welcome.png' }) : null;
  } catch (err) {
    log.warn('module:welcome', 'welcome card render failed:', err.message);
    return null;
  }
}

async function payloadFor(text, member, useEmbed, card) {
  const files = card ? [card] : [];
  if (!useEmbed) {
    return { content: text, files, allowedMentions: { users: [member.id] } };
  }
  const embed = new EmbedBuilder()
    .setColor(await guildEmbedColor(guildKey(member.guild)))
    .setDescription(text)
    .setTimestamp(Date.now());
  // The card already shows the avatar — skip the thumbnail then.
  if (card) embed.setImage('attachment://welcome.png');
  else embed.setThumbnail(member.user.displayAvatarURL());
  return { embeds: [embed], files };
}

/** Whether a config has anything to send to a member who is welcomed. */
const hasWelcome = (config) => Boolean((config.joinChannel && config.joinMessage) || config.dmMessage);

/**
 * What a welcome does: the join message (with the card), then the DM. Both modes send the same.
 * @returns {Promise<{ channel: boolean | null, dm: boolean | null }>}  null for a part that is not configured
 */
async function sendWelcome(member, config, guildId, roleName = '') {
  const intro = await introChannelMention(guildId);
  const result = { channel: null, dm: null };
  if (config.joinChannel && config.joinMessage) {
    const card = await buildCard(member, config);
    result.channel = await sendToChannel(
      guildId,
      config.joinChannel,
      await payloadFor(fill(config.joinMessage, member, intro, roleName), member, config.useEmbed, card)
    );
  }
  if (config.dmMessage) {
    result.dm = await member
      .send({ content: fill(config.dmMessage, member, intro, roleName) })
      .then(() => true)
      .catch(() => false);
  }
  return result;
}

/** When the member joined, in epoch ms, or null when the platform does not say. */
function joinedMs(member) {
  const at = member?.joinedTimestamp ?? member?.joinedAt;
  const ms = at instanceof Date ? at.getTime() : Number(at);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** Send a welcome that is already claimed. Only ids are logged, never the message. */
async function deliver(member, config, guildId, roleName) {
  try {
    const result = await sendWelcome(member, config, guildId, roleName);
    if (result.channel === false) {
      log.warn(
        'module:welcome',
        `welcome for ${member.id} in ${guildId} could not be posted to channel ${config.joinChannel}`
      );
    }
    if (result.dm === false) {
      log.info('module:welcome', `welcome DM for ${member.id} in ${guildId} was not delivered`);
    }
  } catch (err) {
    log.warn('module:welcome', `welcome for ${member.id} in ${guildId} failed: ${err.message}`);
  }
}

const skipped = (guildId, userId, roleId, why) =>
  log.debug('module:welcome', `no welcome for ${userId} in ${guildId} (role ${roleId || 'none'}): ${why}`);

/**
 * Welcome a member in 'role' mode, once per server. The claim comes first, so two events at the same
 * moment cannot both send; it stays when the send fails, so a failure never turns into a second welcome.
 * A row from an earlier membership (older than the member's join time) is replaced by the claim.
 */
async function welcomeOnce(member, config, guildId, roleId, { onJoin = false } = {}) {
  if (!hasWelcome(config)) return false; // nothing to send, so nothing to use up
  const joinedAt = joinedMs(member) ?? (onJoin ? Date.now() : null);
  if (!(await claimWelcome(guildId, member.id, { joinedAt }))) {
    skipped(guildId, member.id, roleId, 'already welcomed');
    return false;
  }
  await deliver(member, config, guildId, roleNameOf(member.guild, roleId));
  return true;
}

/**
 * Welcome a joining member in 'join' mode, as before, but through the same claim, so that a member who was
 * welcomed here is not welcomed again when the server later switches to roles. A claim that cannot be made
 * (a database error) does not stop the welcome.
 */
async function welcomeOnJoin(member, config, guildId) {
  if (hasWelcome(config)) {
    let won = true;
    try {
      won = await claimWelcome(guildId, member.id, { joinedAt: joinedMs(member) ?? Date.now() });
    } catch (err) {
      log.warn('module:welcome', `could not claim the welcome of ${member.id} in ${guildId}: ${err.message}`);
    }
    if (!won) return skipped(guildId, member.id, '', 'already welcomed');
  }
  await sendWelcome(member, config, guildId);
}

/**
 * The role ids a member holds, or null when this member object does not say (a partial one).
 * Discord lists them in `roles.cache`; Fluxer's `roles.roleIds` also holds roles it has not cached.
 */
function heldRoleIds(member) {
  const roles = member?.roles;
  if (!roles || member.partial) return null;
  if (Array.isArray(roles.roleIds)) return new Set(roles.roleIds.map(String));
  if (roles.cache?.keys) return new Set([...roles.cache.keys()].map(String));
  return null;
}

const roleNameOf = (guild, id) => guild?.roles?.cache?.get(id)?.name ?? '';

on('welcome', 'guildMemberAdd', async (member, config, guildId) => {
  const { trigger, roleIds } = welcomeTrigger(config);
  if (trigger !== 'role') return welcomeOnJoin(member, config, guildId);
  // Joining sends nothing, unless they already hold a trigger role (an autorole, for example).
  const held = heldRoleIds(member);
  const id = held ? usableTriggerRoleIds(member.guild, roleIds).find((r) => held.has(r)) : null;
  if (id) await welcomeOnce(member, config, guildId, id, { onJoin: true });
});

// A role gain is a trigger role in the new member that the old one did not have.
//
// When the old member cannot be trusted (it is the member itself, a partial one, or there is none: a member
// Sylo had not seen yet) the gain is read from the clock instead: the member holds a trigger role, joined
// after that role started counting (`triggerSince`) and has not been welcomed. Whoever held the role when
// the mode was switched on joined before that, so they are never reached; a member whose join time is
// unknown is skipped.
on('welcome', 'guildMemberUpdate', async ({ old: before, new: after }, config, guildId) => {
  const { trigger, roleIds, since } = welcomeTrigger(config);
  if (trigger !== 'role' || !roleIds.length || !after?.id) return;
  const now = heldRoleIds(after);
  if (!now) return;
  const held = usableTriggerRoleIds(after.guild, roleIds).filter((id) => now.has(id));
  if (!held.length) return;

  const was = before && before !== after ? heldRoleIds(before) : null;
  if (was) {
    const gained = held.find((id) => !was.has(id));
    if (gained) await welcomeOnce(after, config, guildId, gained);
    return;
  }

  const joined = joinedMs(after);
  if (joined === null) return skipped(guildId, after.id, held[0], 'old roles and join time unknown');
  const id = held.find((r) => since[r] !== undefined && joined > since[r]);
  if (!id) return skipped(guildId, after.id, held[0], 'joined before the role started counting');
  await welcomeOnce(after, config, guildId, id);
});

on('welcome', 'guildMemberRemove', async (member, config, guildId) => {
  // A member who left can be welcomed again when they come back, as in join mode.
  const userId = member.id ?? member.user?.id;
  if (userId) {
    await clearWelcomeSent(guildId, userId).catch((err) =>
      log.warn('module:welcome', `could not clear the welcome record of ${userId}: ${err.message}`)
    );
  }
  if (!config.leaveChannel || !config.leaveMessage) return;
  const intro = await introChannelMention(guildId);
  return sendToChannel(
    guildId,
    config.leaveChannel,
    await payloadFor(fill(config.leaveMessage, member, intro), member, config.useEmbed, null)
  );
});
