// Events: `/event create` (or the dashboard) posts an embed with Join / Maybe / Leave buttons, keeps
// the sign-up lists and counts up to date, gives an optional participant role while someone is
// signed up, sends a reminder before the start, and closes the event (removing the role) when it
// is over. Everything that has to survive a restart lives in the database; one slow `every()` tick
// finds the reminders and endings that are due, so a restart simply picks them up again.
//
// config shape: { channel, reminderMinutes, staffRoles, dmReminders, timeZone }
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } from 'discord.js';
import { allClientsReady, clientOfGuild, guildByKey, guildKey } from '../platform/platformOf.js';
import { registerComponent } from '../bot/lib/components.js';
import { getGuildModule, isModuleEnabled } from '../db/modules.js';
import {
  END_GRACE_MS,
  claimEventReminder,
  claimEventState,
  createEvent as insertEvent,
  deleteEvent,
  dueEndEvents,
  dueReminderEvents,
  eventParticipantCount,
  eventParticipantIds,
  eventStatusCount,
  getEvent,
  getEventParticipant,
  holdsEventRoleElsewhere,
  removeEventParticipant,
  scheduledEventCount,
  setEventMessage,
  setEventParticipant,
  updateEventRow,
} from '../db/events.js';
import { LIMITS as CEILINGS, checkLimit } from '../lib/limits.js';
import { log } from '../lib/log.js';
import { idList } from '../web/lib/idList.js';
import { every, after } from './schedule.js';
import { canonicalTimeZone, formatInZone, localToUtc } from './lib/eventTime.js';

/** Setting limits, served to the dashboard (modules/limits.js). */
export const LIMITS = {
  title: { maxLength: 100 },
  description: { maxLength: 2000 },
  location: { maxLength: 200 },
  imageUrl: { maxLength: 500 },
  capacity: { min: 1, max: 500 },
  // 0 turns the reminder off; anything else is clamped into this range
  reminderMinutes: { min: 5, max: 1440 },
  staffRoles: { maxItems: 25 },
};

export { END_GRACE_MS };
const ACCENT = 0x5865f2;
const GREY = 0x4f545c;
const RED = 0xed4245;
/** Names listed in each sign-up field; the count always covers everyone. */
const LIST_SHOWN = 25;
/** A burst of clicks produces one message edit per this long. */
const REFRESH_MS = 3000;
const TICK_MS = 30_000;
const DEFAULT_REMINDER = 60;

const text = (v, max) =>
  String(v ?? '')
    .trim()
    .slice(0, max);

/** 0 = off, otherwise a whole number of minutes inside the limits. Unreadable input is off. */
export function clampReminder(v) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(LIMITS.reminderMinutes.min, Math.min(n, LIMITS.reminderMinutes.max));
}

/** Server-wide settings. `timeZone` is the zone slash commands read times in (empty = UTC). */
export function normaliseEventsConfig(raw = {}) {
  return {
    channel: /^\d{17,20}$/.test(raw.channel ?? '') ? raw.channel : '',
    reminderMinutes:
      raw.reminderMinutes === undefined ? DEFAULT_REMINDER : clampReminder(raw.reminderMinutes),
    staffRoles: idList(raw.staffRoles, LIMITS.staffRoles.maxItems),
    dmReminders: Boolean(raw.dmReminders),
    timeZone: canonicalTimeZone(raw.timeZone) ?? '',
  };
}

/**
 * The text fields of an event, cut or clamped to the limits. Whether they make a valid event (a
 * title, a future start) is parseEventInput's job. An image must be an https URL that fits; a
 * longer one is dropped rather than cut, since a cut link points nowhere.
 */
export function normaliseEventFields(raw = {}) {
  const img = text(raw.imageUrl, Number.MAX_SAFE_INTEGER);
  let imageUrl = '';
  if (/^https:\/\/\S+$/i.test(img) && img.length <= LIMITS.imageUrl.maxLength) {
    try {
      new URL(img);
      imageUrl = img;
    } catch {
      imageUrl = '';
    }
  }
  const cap = Math.floor(Number(raw.capacity));
  return {
    title: text(raw.title, LIMITS.title.maxLength),
    description: text(raw.description, LIMITS.description.maxLength),
    location: text(raw.location, LIMITS.location.maxLength),
    imageUrl,
    // Empty, 0 or unreadable = no limit
    capacity: Number.isFinite(cap) && cap >= 1 ? Math.min(cap, LIMITS.capacity.max) : null,
    reminderMinutes: clampReminder(raw.reminderMinutes),
  };
}

const fail = (error) => ({ ok: false, error });

/**
 * Check what a person typed for an event and turn it into what is stored. Times are wall-clock
 * strings ("2026-11-05 19:00") read in `timeZone`, so the slash command and the dashboard share
 * one rule.
 * @param {object} raw  title, description, location, imageUrl, capacity, reminderMinutes, timeZone, start, end
 * @param {{ defaults?: { timeZone?: string, reminderMinutes?: number }, now?: number, existing?: object|null }} [opts]
 *   `existing`: the stored event being edited; an unchanged start may be in the past.
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 */
export function parseEventInput(raw = {}, { defaults = {}, now = Date.now(), existing = null } = {}) {
  const f = normaliseEventFields(raw);
  if (!f.title) return fail('Give the event a title.');
  if (raw.imageUrl && String(raw.imageUrl).trim() && !f.imageUrl) {
    return fail(`The image must be an https link of at most ${LIMITS.imageUrl.maxLength} characters.`);
  }

  const zoneText = String(raw.timeZone ?? '').trim();
  let timeZone = existing?.time_zone ?? (defaults.timeZone || 'UTC');
  if (zoneText) {
    timeZone = canonicalTimeZone(zoneText);
    if (!timeZone)
      return fail(`Unknown time zone "${zoneText.slice(0, 40)}". Use a name such as Europe/Oslo.`);
  }

  const startText = String(raw.start ?? '').trim();
  if (!startText) return fail('Give the event a start time.');
  const startAt = localToUtc(startText, timeZone);
  if (startAt == null) {
    return fail(
      `Could not read the start time. Write it as YYYY-MM-DD HH:mm in ${timeZone}, e.g. 2026-11-05 19:00.`
    );
  }
  if (startAt <= now && !(existing && existing.start_at === startAt)) {
    return fail('The start time must be in the future.');
  }

  let endAt = null;
  const endText = String(raw.end ?? '').trim();
  if (endText) {
    endAt = localToUtc(endText, timeZone);
    if (endAt == null) {
      return fail(`Could not read the end time. Write it as YYYY-MM-DD HH:mm in ${timeZone}.`);
    }
    if (endAt <= startAt) return fail('The end time must be after the start time.');
    if (endAt <= now && !(existing && existing.end_at === endAt))
      return fail('The end time must be in the future.');
  }

  const given =
    raw.reminderMinutes !== undefined && raw.reminderMinutes !== null && raw.reminderMinutes !== '';
  const reminderMinutes = given ? f.reminderMinutes : clampReminder(defaults.reminderMinutes);

  return { ok: true, value: { ...f, reminderMinutes, timeZone, startAt, endAt } };
}

/** An event created or moved inside its reminder window gets no reminder: it would fire at once. */
function reminderAlreadySent(startAt, reminderMinutes, now) {
  return reminderMinutes > 0 && startAt - reminderMinutes * 60_000 <= now;
}

// --- who may manage events --------------------------------------------------------------------

const hasPermission = (permissions, name) => {
  try {
    return Boolean(permissions?.has?.(name));
  } catch {
    return false; // a permission name this platform does not know
  }
};

/**
 * Staff = Manage Events (or Manage Server / Administrator, who can already use the dashboard), or
 * one of the staff roles set on the module's page.
 * @param {{ roles?: { cache?: { has(id: string): boolean } } } | null} member
 * @param {any} permissions  the member's permissions in the guild
 * @param {{ staffRoles?: string[] }} cfg
 */
export function canManageEvents(member, permissions, cfg = {}) {
  if (['ManageEvents', 'ManageGuild', 'Administrator'].some((p) => hasPermission(permissions, p)))
    return true;
  const roles = Array.isArray(cfg.staffRoles) ? cfg.staffRoles : [];
  return roles.some((id) => member?.roles?.cache?.has?.(id));
}

// --- the posted message -----------------------------------------------------------------------

const mentions = (ids, shown = LIST_SHOWN) =>
  ids.length === 0
    ? '—'
    : ids
        .slice(0, shown)
        .map((id) => `<@${id}>`)
        .join(' ') + (ids.length > shown ? ` +${ids.length - shown} more` : '');

/**
 * The message for an event in its current state.
 * @param {object} ev  a stored event (db/events.js)
 * @param {{ joined?: string[], maybe?: string[] }} [people]  everyone signed up, in sign-up order
 */
export function buildEventPayload(ev, { joined = [], maybe = [] } = {}) {
  const start = Math.floor(ev.start_at / 1000);
  const open = ev.state === 'scheduled';
  const lines = [];
  if (ev.description) lines.push(ev.description, '');
  lines.push(`🕒 **When:** <t:${start}:F> · <t:${start}:R>`);
  if (ev.end_at) lines.push(`🏁 **Ends:** <t:${Math.floor(ev.end_at / 1000)}:F>`);
  lines.push(`🌍 **Set in:** ${formatInZone(ev.start_at, ev.time_zone)} (${ev.time_zone})`);
  if (ev.location) lines.push(`📍 **Where:** ${ev.location}`);
  if (ev.host_id) lines.push(`👤 **Host:** <@${ev.host_id}>`); // gone after the host used /forget
  if (ev.role_id) lines.push(`🎭 **Role:** <@&${ev.role_id}> while you are signed up`);

  const icon = open ? '📅' : ev.state === 'cancelled' ? '❌' : '🏁';
  const suffix = open ? '' : ev.state === 'cancelled' ? ' (cancelled)' : ' (ended)';
  const going = ev.capacity ? `${joined.length}/${ev.capacity}` : String(joined.length);
  const embed = new EmbedBuilder()
    .setColor(open ? ACCENT : ev.state === 'cancelled' ? RED : GREY)
    .setTitle(`${icon} ${ev.title}${suffix}`)
    .setDescription(lines.join('\n'))
    .addFields(
      { name: `✅ Going (${going})`, value: mentions(joined), inline: true },
      { name: `❔ Maybe (${maybe.length})`, value: mentions(maybe), inline: true }
    )
    .setFooter({ text: `Event #${ev.id}` });
  if (ev.image_url) embed.setImage(ev.image_url);

  const payload = { embeds: [embed], components: [], allowedMentions: { parse: [] } };
  if (open) {
    payload.components = [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`evt:join:${ev.id}`)
          .setStyle(ButtonStyle.Success)
          .setLabel('✅ Join'),
        new ButtonBuilder()
          .setCustomId(`evt:maybe:${ev.id}`)
          .setStyle(ButtonStyle.Secondary)
          .setLabel('❔ Maybe'),
        new ButtonBuilder()
          .setCustomId(`evt:leave:${ev.id}`)
          .setStyle(ButtonStyle.Danger)
          .setLabel('❌ Leave')
      ),
    ];
  }
  return payload;
}

async function channelOf(guild, channelId) {
  return guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
}

async function people(id) {
  return { joined: await eventParticipantIds(id, 'join'), maybe: await eventParticipantIds(id, 'maybe') };
}

const pendingRefresh = new Map();

/** Edit the posted message to match the stored event. Quiet when the message is gone. */
export async function refreshEventMessage(id) {
  pendingRefresh.get(id)?.cancel();
  pendingRefresh.delete(id);
  const ev = await getEvent(id);
  const guild = ev && guildByKey(ev.guild_id);
  if (!guild || !ev.message_id) return false;
  const channel = await channelOf(guild, ev.channel_id);
  if (!channel?.isTextBased?.()) return false;
  const msg = await channel.messages.fetch(ev.message_id).catch(() => null);
  if (!msg) return false;
  await msg
    .edit(buildEventPayload(ev, await people(id)))
    .catch((err) => log.warn('events', `edit #${id} failed:`, err.message));
  return true;
}

/** Queue a trailing refresh: a burst of clicks yields one edit. */
function scheduleRefresh(id) {
  if (pendingRefresh.has(id)) return;
  const handle = after('events', REFRESH_MS, () => {
    pendingRefresh.delete(id);
    return refreshEventMessage(id).catch((err) => log.error('events', 'refresh failed:', err.message));
  });
  pendingRefresh.set(id, handle);
}

// --- the participant role ---------------------------------------------------------------------

/** Can Sylo hand this role out? Needs Manage Roles and a role below its own highest one. */
export function roleGrantable(guild, role) {
  const me = guild.members?.me;
  return Boolean(
    role &&
    !role.managed &&
    role.editable !== false &&
    me?.permissions?.has('ManageRoles') &&
    me.roles.highest.comparePositionTo(role) > 0
  );
}

async function memberOf(guild, userId) {
  return guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
}

async function setRole(guild, member, roleId, give, reason) {
  const role = guild.roles.cache.get(roleId);
  if (!member || !roleGrantable(guild, role)) return false;
  const has = member.roles.cache.has(roleId);
  if (give === has) return true;
  try {
    if (give) await member.roles.add(role, reason);
    else await member.roles.remove(role, reason);
    return true;
  } catch (err) {
    log.warn('events', `could not ${give ? 'give' : 'remove'} the role for ${member.id}:`, err.message);
    return false;
  }
}

async function stripRole(ev, guild) {
  if (!ev.role_id) return;
  for (const uid of await eventParticipantIds(ev.id, 'join')) {
    if (await holdsEventRoleElsewhere(ev.guild_id, ev.role_id, uid, ev.id)) continue;
    await setRole(guild, await memberOf(guild, uid), ev.role_id, false, `Event "${ev.title}" is over`);
  }
}

// --- create, edit, cancel ---------------------------------------------------------------------

/**
 * Post a new event. The caller has checked who may do this and, for a participant role, that the
 * person may hand that role out (web/middleware/roleGrants.js).
 * @param {{ guild: any, hostId: string, channelId: string, roleId?: string|null, input: object }} args
 *   `input` is the `value` of a successful parseEventInput().
 * @returns {Promise<{ ok: true, id: number } | { ok: false, error: string }>}
 * @throws {import('../lib/limits.js').LimitError} past the per-server ceiling
 */
export async function createEvent({ guild, hostId, channelId, roleId = null, input }) {
  const guildId = guildKey(guild);
  checkLimit(await scheduledEventCount(guildId), CEILINGS.events, 'upcoming events');

  const channel = await channelOf(guild, channelId);
  if (!channel?.isTextBased?.()) return fail('Pick a text channel for the event.');
  if (roleId && !roleGrantable(guild, guild.roles.cache.get(roleId))) {
    return fail(
      'Sylo cannot hand out that role. It needs Manage Roles and its own role must sit above the participant role.'
    );
  }

  const now = Date.now();
  const { id } = await insertEvent({
    guildId,
    channelId,
    title: input.title,
    description: input.description,
    location: input.location,
    imageUrl: input.imageUrl,
    startAt: input.startAt,
    endAt: input.endAt,
    timeZone: input.timeZone,
    capacity: input.capacity,
    roleId,
    reminderMinutes: input.reminderMinutes,
    reminderSent: reminderAlreadySent(input.startAt, input.reminderMinutes, now),
    hostId,
    createdAt: now,
  });
  try {
    const ev = await getEvent(id);
    const message = await channel.send(buildEventPayload(ev));
    await setEventMessage(id, message.id);
  } catch (err) {
    await deleteEvent(id);
    log.warn('events', `could not post event in ${channelId}:`, err.message);
    return fail(
      'Sylo could not post in that channel. It needs View Channel, Send Messages and Embed Links there.'
    );
  }
  return { ok: true, id };
}

/**
 * Change the editable fields of a scheduled event and update the posted message. The channel,
 * message and participant role stay as they were.
 * @returns {Promise<{ ok: true } | { ok: false, error: string, status?: number }>}
 */
export async function updateEvent(id, guildId, raw, { defaults = {}, now = Date.now() } = {}) {
  const ev = await getEvent(id);
  if (!ev || ev.guild_id !== guildId) return { ...fail('No such event.'), status: 404 };
  if (ev.state !== 'scheduled') return fail('Only upcoming events can be edited.');
  const parsed = parseEventInput(raw, { defaults, now, existing: ev });
  if (!parsed.ok) return parsed;
  const v = parsed.value;
  const timingChanged = v.startAt !== ev.start_at || v.reminderMinutes !== ev.reminder_minutes;
  await updateEventRow(id, {
    ...v,
    reminderSent: timingChanged ? reminderAlreadySent(v.startAt, v.reminderMinutes, now) : ev.reminder_sent,
  });
  await refreshEventMessage(id);
  return { ok: true };
}

/** Close an event: mark it, take the participant role back from everyone and show the final state. */
async function closeEvent(id, state) {
  if (!(await claimEventState(id, state))) return false;
  const ev = await getEvent(id);
  const guild = guildByKey(ev.guild_id);
  if (guild) {
    await stripRole(ev, guild).catch((err) =>
      log.error('events', `role cleanup for #${id} failed:`, err.message)
    );
    await refreshEventMessage(id).catch(() => {});
  }
  return true;
}

/**
 * Cancel an upcoming event.
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function cancelEvent(id, guildId) {
  const ev = await getEvent(id);
  if (!ev || ev.guild_id !== guildId) return fail('No such event.');
  if (ev.state !== 'scheduled') return fail('That event is already over.');
  if (!(await closeEvent(id, 'cancelled'))) return fail('That event is already over.');
  const guild = guildByKey(ev.guild_id);
  const channel = guild && (await channelOf(guild, ev.channel_id));
  if (channel?.isTextBased?.()) {
    await channel
      .send({
        content: `❌ **${ev.title}** has been cancelled.${ev.role_id ? ` <@&${ev.role_id}>` : ''}`,
        allowedMentions: { parse: [], roles: ev.role_id ? [ev.role_id] : [] },
      })
      .catch(() => {});
  }
  return { ok: true };
}

// --- the buttons ------------------------------------------------------------------------------

const eph = (interaction, content) =>
  interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });

/** One click at a time per event, so the capacity check and the write cannot interleave. */
const chains = new Map();
async function withLock(id, fn) {
  const previous = chains.get(id) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.catch(() => {});
  chains.set(id, tail);
  try {
    return await run;
  } finally {
    if (chains.get(id) === tail) chains.delete(id);
  }
}

/** The Join / Maybe / Leave logic. Returns the reply to show the member. */
async function applyChoice(ev, guild, member, userId, choice) {
  const existing = await getEventParticipant(ev.id, userId);
  const roleOk = async (give) => {
    if (!ev.role_id || !member) return true;
    // Taking the role back must not strip it from someone going to another event that uses it
    if (!give && (await holdsEventRoleElsewhere(ev.guild_id, ev.role_id, userId, ev.id))) return true;
    return setRole(guild, member, ev.role_id, give, `Event "${ev.title}"`);
  };

  if (choice === 'leave') {
    if (!existing) return "You're not signed up for this event.";
    await removeEventParticipant(ev.id, userId);
    await roleOk(false);
    return `You left **${ev.title}**.`;
  }

  if (existing?.status === choice) {
    return choice === 'join' ? `You're already going to **${ev.title}**.` : `You're already marked as maybe.`;
  }
  if (!existing && (await eventParticipantCount(ev.id)) >= CEILINGS.eventParticipants) {
    return `**${ev.title}** has reached its limit of ${CEILINGS.eventParticipants} sign-ups.`;
  }
  if (choice === 'join' && ev.capacity && (await eventStatusCount(ev.id, 'join')) >= ev.capacity) {
    return `Sorry, **${ev.title}** is full (${ev.capacity}/${ev.capacity}). You can still press Maybe.`;
  }

  await setEventParticipant(ev.id, userId, choice);
  if (choice === 'join') {
    const given = await roleOk(true);
    return ev.role_id && !given
      ? `You're going to **${ev.title}**. Sylo could not give you the event role.`
      : `You're going to **${ev.title}**.`;
  }
  await roleOk(false);
  return `Marked as maybe for **${ev.title}**.`;
}

async function handleChoice(interaction, choice, id) {
  const ev = await getEvent(id);
  if (!ev || ev.guild_id !== interaction.guildId) return eph(interaction, 'This event no longer exists.');
  if (ev.state !== 'scheduled') {
    return eph(interaction, ev.state === 'cancelled' ? 'This event was cancelled.' : 'This event is over.');
  }
  if (!(await isModuleEnabled(interaction.guildId, 'events'))) {
    return eph(interaction, 'Events are disabled in this server.');
  }
  const guild = interaction.guild ?? guildByKey(ev.guild_id);
  const reply = await withLock(id, () =>
    applyChoice(ev, guild, interaction.member, interaction.user.id, choice)
  );
  scheduleRefresh(id);
  return eph(interaction, reply);
}

registerComponent('events', 'evt:', (interaction) => {
  const [, choice, id] = interaction.customId.split(':');
  if (!['join', 'maybe', 'leave'].includes(choice) || !/^\d+$/.test(id ?? '')) return undefined;
  return handleChoice(interaction, choice, Number(id));
});

// --- reminders and endings --------------------------------------------------------------------

async function sendReminder(ev) {
  const guild = guildByKey(ev.guild_id);
  if (!guild || !(await isModuleEnabled(ev.guild_id, 'events'))) return;
  const start = Math.floor(ev.start_at / 1000);
  const channel = await channelOf(guild, ev.channel_id);
  if (channel?.isTextBased?.()) {
    await channel
      .send({
        content:
          `⏰ **${ev.title}** starts <t:${start}:R> (<t:${start}:t>)${ev.location ? ` · 📍 ${ev.location}` : ''}.` +
          `${ev.role_id ? ` <@&${ev.role_id}>` : ''}`,
        allowedMentions: { parse: [], roles: ev.role_id ? [ev.role_id] : [] },
      })
      .catch((err) => log.warn('events', `reminder for #${ev.id} not posted:`, err.message));
  }
  const cfg = normaliseEventsConfig((await getGuildModule(ev.guild_id, 'events')).config);
  if (!cfg.dmReminders) return;
  const client = clientOfGuild(guild);
  for (const uid of await eventParticipantIds(ev.id, 'join')) {
    // A member with DMs closed (or who left the server) is skipped without a trace.
    const user = await client.users.fetch(uid).catch(() => null);
    await user
      ?.send(`⏰ **${ev.title}** in ${guild.name} starts <t:${start}:R> (<t:${start}:f>).`)
      .catch(() => {});
  }
}

export async function tick(now = Date.now()) {
  if (!allClientsReady()) return;
  for (const ev of await dueReminderEvents(now)) {
    if (!(await claimEventReminder(ev.id))) continue;
    // A bot that was down past the start does not announce a start that already happened.
    if (ev.start_at <= now) continue;
    await sendReminder(ev).catch((err) => log.error('events', `reminder for #${ev.id} failed:`, err.message));
  }
  for (const ev of await dueEndEvents(now)) {
    await closeEvent(ev.id, 'ended').catch((err) =>
      log.error('events', `ending #${ev.id} failed:`, err.message)
    );
  }
}

every('events', TICK_MS, () => tick());
