// Ticket / modmail helpers. Users DM the bot; staff reply from the dashboard.
// The bot relays messages both ways. Staff replies are anonymous ("Staff").
import { allGuilds, clientOfGuild, guildByKey, guildKey, platformOfClient } from '../platform/platformOf.js';
import { EmbedBuilder, AttachmentBuilder } from 'discord.js';
import { config } from '../config.js';
import { idList } from '../web/lib/idList.js';
import { clampRetentionDays } from './lib/retentionDays.js';
import { isModuleEnabled, getGuildModule } from '../db/modules.js';
import { notifyTicketActivity } from '../lib/push.js';
import { sweepMap } from '../lib/sweepMap.js';
import {
  openOrCreateTicket,
  getTicket,
  addTicketMessage,
  closeTicket,
  ticketMessages,
} from '../db/tickets.js';

/** Setting limits, served to the dashboard (modules/limits.js). */
export const LIMITS = {
  greeting: { maxLength: 1500 },
  closeMessage: { maxLength: 1500 },
  transcriptRetentionDays: { min: 0, max: 3650 },
};

/**
 * Coerce a submitted tickets config into the canonical shape. `staffRoles` is cleaned by the
 * caller (it needs the guild, to drop @everyone) and comes back as the plain id list.
 */
export function normaliseTicketsConfig(raw = {}) {
  return {
    greeting: String(raw.greeting ?? '').slice(0, LIMITS.greeting.maxLength),
    closeMessage: String(raw.closeMessage ?? '').slice(0, LIMITS.closeMessage.maxLength),
    notifyChannel: /^\d{17,20}$/.test(raw.notifyChannel ?? '') ? raw.notifyChannel : '',
    staffRoles: idList(raw.staffRoles),
    transcriptRetentionDays: clampRetentionDays(
      raw.transcriptRetentionDays,
      LIMITS.transcriptRetentionDays.max
    ),
    showMessageInAlert: Boolean(raw.showMessageInAlert),
  };
}

const TICKET_COLOR = 0x4aa3df;
export const DEFAULT_GREETING =
  'Thanks for contacting the staff of {server}. Your message has been received — a moderator will reply here shortly.';
export const DEFAULT_CLOSE = 'This ticket has been closed. Send another message any time to open a new one.';

const fill = (t, guild) => String(t || '').replaceAll('{server}', guild?.name ?? 'the server');

const escHtml = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Format timestamps in the host timezone (honours the TZ env var; falls back to
// UTC in a bare container). "sv-SE" gives an unambiguous YYYY-MM-DD HH:MM:SS.
const HOST_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const tsFmt = new Intl.DateTimeFormat('sv-SE', {
  timeZone: HOST_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
  timeZoneName: 'short',
});
const fmtTs = (ts) => tsFmt.format(new Date(ts));

/**
 * Plain-text transcript — readable when Discord previews the attachment inline.
 * @param {object} ticket
 * @returns {Promise<{ filename: string, text: string }>}
 */
export async function buildTextTranscript(ticket) {
  const guild = guildByKey(ticket.guild_id);
  const user = await clientOfGuild(guild)
    ?.users.fetch(ticket.user_id)
    .catch(() => null);
  const userLabel = user ? user.tag : ticket.user_id;
  const rows = await ticketMessages(ticket.id);

  const header = [
    `Ticket #${ticket.id} — ${guild?.name ?? ticket.guild_id}`,
    `Member:  ${userLabel} (${ticket.user_id})`,
    `Opened:  ${fmtTs(ticket.created_at)}`,
    ticket.closed_at ? `Closed:  ${fmtTs(ticket.closed_at)}` : null,
    `Messages: ${rows.length}`,
    '─'.repeat(48),
    '',
  ].filter((l) => l != null);

  const body = rows.map((m) => {
    const who = m.author_kind === 'user' ? userLabel : m.author_kind === 'staff' ? 'Staff' : 'System';
    const lines = [`[${fmtTs(m.created_at)}] ${who}:`];
    if (m.content) lines.push(...m.content.split('\n').map((l) => `    ${l}`));
    for (const a of m.attachments) lines.push(`    [attachment] ${a}`);
    return lines.join('\n');
  });

  return {
    filename: `ticket-${ticket.id}-transcript.txt`,
    text: header.join('\n') + body.join('\n\n') + '\n',
  };
}

/**
 * Render a self-contained HTML transcript of a ticket. Staff messages are shown
 * as "Staff" (matching what the member saw).
 * @param {object} ticket
 * @returns {Promise<{ filename: string, html: string }>}
 */
export async function buildTranscript(ticket) {
  const guild = guildByKey(ticket.guild_id);
  const user = await clientOfGuild(guild)
    ?.users.fetch(ticket.user_id)
    .catch(() => null);
  const userLabel = user ? user.tag : ticket.user_id;
  const rows = await ticketMessages(ticket.id);

  const bubbles = rows
    .map((m) => {
      const who =
        m.author_kind === 'user' ? escHtml(userLabel) : m.author_kind === 'staff' ? 'Staff' : 'System';
      const atts = m.attachments.length
        ? `<div class="atts">${m.attachments.map((a) => `<a href="${escHtml(a)}">${escHtml(a)}</a>`).join('<br>')}</div>`
        : '';
      const content = escHtml(m.content).replace(/\n/g, '<br>');
      return `<div class="msg ${m.author_kind}"><div class="meta">${who} · ${fmtTs(m.created_at)}</div><div class="content">${content}${atts}</div></div>`;
    })
    .join('\n');

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Ticket #${ticket.id} — ${escHtml(guild?.name ?? '')}</title>
<style>
 body{font:14px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;background:#0f1216;color:#e6e9ed;max-width:820px;margin:24px auto;padding:0 16px}
 h1{font-size:18px;margin:0 0 4px}
 .hdr{color:#8b95a1;border-bottom:1px solid #262d36;padding-bottom:12px;margin-bottom:16px;font-size:13px}
 .msg{margin:10px 0}.meta{font-size:12px;color:#8b95a1;margin-bottom:2px}
 .content{background:#171c22;border:1px solid #262d36;border-radius:8px;padding:8px 12px;white-space:pre-wrap;word-break:break-word}
 .msg.staff .content{background:rgba(74,163,223,.12);border-color:rgba(74,163,223,.3)}
 .msg.system{text-align:center;color:#8b95a1;font-size:12px}.msg.system .content{background:none;border:0;padding:2px}
 .atts{margin-top:6px;font-size:12px}a{color:#4aa3df}
</style></head><body>
<h1>Ticket #${ticket.id}</h1>
<div class="hdr">Server: ${escHtml(guild?.name ?? ticket.guild_id)}<br>
Member: ${escHtml(userLabel)} (${ticket.user_id})<br>
Opened: ${fmtTs(ticket.created_at)}${ticket.closed_at ? `<br>Closed: ${fmtTs(ticket.closed_at)}` : ''}<br>
Messages: ${rows.length}</div>
${bubbles}
</body></html>`;

  return { filename: `ticket-${ticket.id}-transcript.html`, html };
}

// --- Which ticket servers is a DM sender in? --------------------------------------------------
// Any account can DM the bot, so the lookup must cost little however many servers the instance
// has. Order of work: (1) members already in the cache cost nothing; (2) when the member cache of
// a server is known to be complete (GuildMembers intent on and every member cached) a miss is a
// definite "not a member"; (3) only the rest need a REST member fetch, and those are capped per
// DM, per minute for the whole bot, remembered when the member does not exist, and tried first
// where the user was found before. Without the GuildMembers intent the member caches are sparse,
// so step 3 is the only way to find a real sender: it still works, a few servers per DM, and a
// sender whose servers were not all checked is told to send the message again, which continues
// with the servers not yet checked.

/** Most REST member fetches one DM may cause. */
export const MEMBER_PROBES_PER_DM = 8;
/** Most REST member fetches all DMs together may cause per minute. */
export const MEMBER_PROBES_PER_MINUTE = 120;
/** A "not a member" answer is remembered this long. */
export const NOT_MEMBER_TTL_MS = 2 * 60_000;
/** The answer for one sender is reused this long (a per-user cooldown on the lookup). */
export const LOOKUP_REUSE_MS = 10_000;
const HINT_TTL_MS = 24 * 60 * 60_000;

/** `${userId}|${guildKey}` -> expiry of a "not a member" answer. @type {Map<string, number>} */
const notMember = new Map();
/** userId -> servers the user was found in lately; only decides the order of the fetches. */
const foundBefore = new Map();
/** `${platform}|${userId}` -> { at, result } (result is a promise while the lookup runs). */
const lookups = new Map();
let probeWindow = { start: 0, count: 0 };
sweepMap(notMember, (until, now) => until <= now);
sweepMap(foundBefore, (h, now) => now - h.at > HINT_TTL_MS);
sweepMap(lookups, (l, now) => now - l.at > LOOKUP_REUSE_MS);

/** Test hook: forget every remembered answer and the probe budget. */
export function _resetTicketLookup() {
  notMember.clear();
  foundBefore.clear();
  lookups.clear();
  probeWindow = { start: 0, count: 0 };
}

const cachedMember = (guild, userId) => {
  const m = guild.members.cache?.get(userId);
  return m && !m.partial ? m : null;
};

/** Is every member of the server in the cache, so that a miss means "not a member"? */
function memberCacheComplete(guild) {
  if (platformOfClient(guild.client) !== 'discord' || !config.intentGuildMembers) return false;
  return Number.isFinite(guild.memberCount) && (guild.members.cache?.size ?? 0) >= guild.memberCount;
}

/** Take one REST member fetch from the per-minute budget; false when it is used up. */
function takeProbe() {
  const now = Date.now();
  if (now - probeWindow.start >= 60_000) probeWindow = { start: now, count: 0 };
  if (probeWindow.count >= MEMBER_PROBES_PER_MINUTE) return false;
  probeWindow.count++;
  return true;
}

/** One REST member fetch. @returns {Promise<boolean | null>} true member, false not a member, null unknown */
async function probeMember(guild, userId) {
  try {
    // A platform may answer "no such member" with null instead of an error.
    if (await guild.members.fetch(userId)) return true;
    notMember.set(`${userId}|${guildKey(guild)}`, Date.now() + NOT_MEMBER_TTL_MS);
    return false;
  } catch (err) {
    if (err?.code === 10007 || err?.code === 10013 || err?.status === 404) {
      notMember.set(`${userId}|${guildKey(guild)}`, Date.now() + NOT_MEMBER_TTL_MS);
      return false;
    }
    return null; // a rate limit or a network error says nothing about membership
  }
}

async function findTicketGuilds(user, client) {
  const found = [];
  const toProbe = [];
  const now = Date.now();
  for (const guild of client ? [...client.guilds.cache.values()] : allGuilds()) {
    if (cachedMember(guild, user.id)) {
      if (await isModuleEnabled(guildKey(guild), 'tickets')) found.push(guild);
      continue;
    }
    if (memberCacheComplete(guild)) continue;
    if ((notMember.get(`${user.id}|${guildKey(guild)}`) ?? 0) > now) continue;
    toProbe.push(guild);
  }

  // Servers where this user was found before go first.
  const hint = foundBefore.get(user.id)?.guilds;
  if (hint) toProbe.sort((a, b) => Number(hint.has(guildKey(b))) - Number(hint.has(guildKey(a))));

  let probes = 0;
  let incomplete = false;
  for (const guild of toProbe) {
    if (!(await isModuleEnabled(guildKey(guild), 'tickets'))) continue;
    if (probes >= MEMBER_PROBES_PER_DM || !takeProbe()) {
      incomplete = true;
      break;
    }
    probes++;
    const isMember = await probeMember(guild, user.id);
    if (isMember) found.push(guild);
    else if (isMember === null) incomplete = true;
  }

  if (found.length) {
    foundBefore.set(user.id, { guilds: new Set(found.map(guildKey)), at: Date.now() });
  }
  return { guilds: found, incomplete };
}

/**
 * Guilds where the tickets module is enabled and the user is a member, and whether every
 * candidate server was checked (`incomplete` when the fetch caps cut the lookup short). Pass the
 * client the DM arrived on to look only at that platform's servers. The answer for one user is
 * reused for a few seconds, so a burst of DMs does the work once.
 * @returns {Promise<{ guilds: import('discord.js').Guild[], incomplete: boolean }>}
 */
export function lookupTicketGuilds(user, client) {
  const key = `${client ? platformOfClient(client) : 'all'}|${user.id}`;
  const recent = lookups.get(key);
  if (recent && Date.now() - recent.at < LOOKUP_REUSE_MS) return recent.result;
  const result = findTicketGuilds(user, client);
  lookups.set(key, { at: Date.now(), result });
  result.catch(() => lookups.delete(key));
  return result;
}

/**
 * Can this user open a ticket in this one server (tickets on, user a member)? Cheap: the member
 * cache, or the DM lookup that just ran, or at most one fetch from the shared budget.
 */
export async function canOpenTicketIn(user, guild) {
  if (!(await isModuleEnabled(guildKey(guild), 'tickets'))) return false;
  if (cachedMember(guild, user.id)) return true;
  const recent = lookups.get(`${platformOfClient(guild.client)}|${user.id}`);
  if (recent && Date.now() - recent.at < LOOKUP_REUSE_MS) {
    const { guilds } = await recent.result.catch(() => ({ guilds: [] }));
    if (guilds.some((g) => guildKey(g) === guildKey(guild))) return true;
  }
  if (memberCacheComplete(guild) || !takeProbe()) return false;
  return (await probeMember(guild, user.id)) === true;
}

const ALERT_MESSAGE_MAX = 1000;

async function notifyStaff(guild, text, embed) {
  const cfg = (await getGuildModule(guildKey(guild), 'tickets')).config;
  if (!cfg.notifyChannel) return;
  const ch =
    guild.channels.cache.get(cfg.notifyChannel) ??
    (await guild.channels.fetch(cfg.notifyChannel).catch(() => null));
  if (!ch?.isTextBased()) return;
  const me = guild.members.me;
  if (me && !ch.permissionsFor(me)?.has(['ViewChannel', 'SendMessages'])) return;
  const payload = { content: text, allowedMentions: { parse: [] } };
  if (embed) payload.embeds = [embed];
  await ch.send(payload).catch(() => {});
}

/**
 * Record an inbound DM into the user's open ticket for `guild`, creating the
 * ticket (and sending the greeting + staff notification) if it's new.
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').User} user
 * @param {{ content: string, attachments: string[] }} payload
 */
export async function ingestUserDM(guild, user, payload) {
  const cfg = (await getGuildModule(guildKey(guild), 'tickets')).config;
  const { ticket, created: isNew } = await openOrCreateTicket(guildKey(guild), user.id);

  await addTicketMessage(ticket.id, {
    authorId: user.id,
    authorKind: 'user',
    content: payload.content ?? '',
    attachments: payload.attachments ?? [],
  });
  // Staff devices with the Sylo app. Not awaited, and it never throws: a slow or failing push
  // must not hold up the member's DM.
  notifyTicketActivity({
    guild,
    ticketId: ticket.id,
    member: user.tag ?? user.username,
    content: payload.content ?? '',
    isNew,
  });

  const link = config.dashboardUrl
    ? `\n<${config.dashboardUrl}/v2/guilds/${guildKey(guild)}/tickets/${ticket.id}>`
    : '';
  if (isNew) {
    await user
      .send({
        embeds: [
          new EmbedBuilder()
            .setColor(TICKET_COLOR)
            .setTitle(`Ticket #${ticket.id} — ${guild.name}`)
            .setDescription(fill(cfg.greeting || DEFAULT_GREETING, guild)),
        ],
      })
      .catch(() => {});
    // Opt-in (issue #218) — staff otherwise only learn a ticket exists, not
    // what it's about, until someone opens the dashboard.
    const alertEmbed =
      cfg.showMessageInAlert && payload.content
        ? new EmbedBuilder()
            .setColor(TICKET_COLOR)
            .setDescription(
              payload.content.length > ALERT_MESSAGE_MAX
                ? `${payload.content.slice(0, ALERT_MESSAGE_MAX)}…`
                : payload.content
            )
        : null;
    await notifyStaff(
      guild,
      `🎫 New ticket #${ticket.id} from **${user.tag}** (\`${user.id}\`)${link}`,
      alertEmbed
    );
  } else {
    await notifyStaff(guild, `💬 New reply on ticket #${ticket.id} from **${user.tag}**${link}`);
  }
  return ticket;
}

/**
 * DM an anonymous staff reply to the ticket user and record it.
 * @returns {Promise<{ delivered: boolean }>}
 */
export async function relayStaffReply(ticket, staffUserId, content) {
  const guild = guildByKey(ticket.guild_id);
  const user = await clientOfGuild(guild)
    .users.fetch(ticket.user_id)
    .catch(() => null);
  let delivered = Boolean(user);
  if (user) {
    try {
      await user.send({
        embeds: [
          new EmbedBuilder()
            .setColor(TICKET_COLOR)
            .setAuthor({ name: `Staff reply · ${guild?.name ?? 'server'}` })
            .setDescription(content),
        ],
      });
    } catch {
      delivered = false;
    }
  }
  await addTicketMessage(ticket.id, { authorId: staffUserId, authorKind: 'staff', content, delivered });
  return { delivered };
}

/**
 * Close a ticket. If `closingMessage` is given it is DMed as the final staff
 * message; otherwise the configured close notice is sent.
 * @param {object} ticket
 * @param {string} staffUserId
 * @param {string} [closingMessage]
 */
export async function closeTicketWithNotice(ticket, staffUserId, closingMessage) {
  const guild = guildByKey(ticket.guild_id);
  const cfg = (await getGuildModule(ticket.guild_id, 'tickets')).config;
  const user = await clientOfGuild(guild)
    ?.users.fetch(ticket.user_id)
    .catch(() => null);

  const text = (closingMessage ?? '').trim();

  // Record the closing message + close now, so the transcript includes them.
  if (text) {
    await addTicketMessage(ticket.id, {
      authorId: staffUserId,
      authorKind: 'staff',
      content: text,
      delivered: true,
    });
  }
  await closeTicket(ticket.id, staffUserId);
  await addTicketMessage(ticket.id, {
    authorId: staffUserId,
    authorKind: 'system',
    content: 'Ticket closed by staff.',
  });

  if (user) {
    const embed = new EmbedBuilder().setColor(0x8b95a1);
    if (text) {
      embed.setAuthor({ name: `Staff reply · ${guild?.name ?? 'server'}` }).setDescription(text);
      embed.setFooter({
        text: 'This ticket is now closed. Message again to open a new one. A transcript is attached.',
      });
    } else {
      embed.setDescription(
        `${fill(cfg.closeMessage || DEFAULT_CLOSE, guild)}\n\nA transcript of this conversation is attached.`
      );
    }
    const transcript = await buildTextTranscript((await getTicket(ticket.id)) ?? ticket);
    try {
      await user.send({
        embeds: [embed],
        files: [new AttachmentBuilder(Buffer.from(transcript.text, 'utf8'), { name: transcript.filename })],
      });
    } catch {
      await user.send({ embeds: [embed] }).catch(() => {}); // retry without the file
    }
  }
}
