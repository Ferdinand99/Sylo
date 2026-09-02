// Ticket / modmail helpers. Users DM the bot; staff reply from the dashboard.
// The bot relays messages both ways. Staff replies are anonymous ("Staff").
import { EmbedBuilder, AttachmentBuilder } from 'discord.js';
import { config } from '../config.js';
import { runtime } from '../runtime.js';
import { isModuleEnabled, getGuildModule } from '../db/modules.js';
import {
  getOpenTicket,
  getTicket,
  createTicket,
  addTicketMessage,
  closeTicket,
  ticketMessages,
} from '../db/tickets.js';

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
  const guild = runtime.client?.guilds.cache.get(ticket.guild_id);
  const user = await runtime.client?.users.fetch(ticket.user_id).catch(() => null);
  const userLabel = user ? user.tag : ticket.user_id;
  const rows = ticketMessages(ticket.id);

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
  const guild = runtime.client?.guilds.cache.get(ticket.guild_id);
  const user = await runtime.client?.users.fetch(ticket.user_id).catch(() => null);
  const userLabel = user ? user.tag : ticket.user_id;
  const rows = ticketMessages(ticket.id);

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

/** Guilds where the tickets module is enabled and the user is a member. */
export async function ticketGuildsForUser(user) {
  const out = [];
  for (const guild of runtime.client.guilds.cache.values()) {
    if (!isModuleEnabled(guild.id, 'tickets')) continue;
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (member) out.push(guild);
  }
  return out;
}

async function notifyStaff(guild, text) {
  const cfg = getGuildModule(guild.id, 'tickets').config;
  if (!cfg.notifyChannel) return;
  const ch =
    guild.channels.cache.get(cfg.notifyChannel) ??
    (await guild.channels.fetch(cfg.notifyChannel).catch(() => null));
  if (!ch?.isTextBased()) return;
  const me = guild.members.me;
  if (me && !ch.permissionsFor(me)?.has(['ViewChannel', 'SendMessages'])) return;
  await ch.send({ content: text, allowedMentions: { parse: [] } }).catch(() => {});
}

/**
 * Record an inbound DM into the user's open ticket for `guild`, creating the
 * ticket (and sending the greeting + staff notification) if it's new.
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').User} user
 * @param {{ content: string, attachments: string[] }} payload
 */
export async function ingestUserDM(guild, user, payload) {
  const cfg = getGuildModule(guild.id, 'tickets').config;
  let ticket = getOpenTicket(guild.id, user.id);
  const isNew = !ticket;
  if (!ticket) ticket = createTicket(guild.id, user.id);

  addTicketMessage(ticket.id, {
    authorId: user.id,
    authorKind: 'user',
    content: payload.content ?? '',
    attachments: payload.attachments ?? [],
  });

  const link = config.dashboardUrl
    ? `\n<${config.dashboardUrl}/guilds/${guild.id}/tickets/${ticket.id}>`
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
    await notifyStaff(guild, `🎫 New ticket #${ticket.id} from **${user.tag}** (\`${user.id}\`)${link}`);
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
  const guild = runtime.client.guilds.cache.get(ticket.guild_id);
  const user = await runtime.client.users.fetch(ticket.user_id).catch(() => null);
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
  addTicketMessage(ticket.id, { authorId: staffUserId, authorKind: 'staff', content, delivered });
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
  const guild = runtime.client?.guilds.cache.get(ticket.guild_id);
  const cfg = getGuildModule(ticket.guild_id, 'tickets').config;
  const user = await runtime.client?.users.fetch(ticket.user_id).catch(() => null);

  const text = (closingMessage ?? '').trim();

  // Record the closing message + close now, so the transcript includes them.
  if (text) {
    addTicketMessage(ticket.id, {
      authorId: staffUserId,
      authorKind: 'staff',
      content: text,
      delivered: true,
    });
  }
  closeTicket(ticket.id, staffUserId);
  addTicketMessage(ticket.id, {
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
    const transcript = await buildTextTranscript(getTicket(ticket.id) ?? ticket);
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
