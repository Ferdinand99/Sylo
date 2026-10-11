// Ticket / modmail helpers. Users DM the bot; staff reply in Discord or the dashboard.
// The bot relays messages both ways. Staff replies are anonymous ("Administracja").
import { EmbedBuilder, AttachmentBuilder } from 'discord.js';
import {
  withDMTicketLock,
  syncDMTicketChannel,
  archiveDMTicketChannel,
  deleteDMTicketChannel,
} from './dmTicketChannels.js';
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
  'Dziękujemy za kontakt z administracją serwera {server}. Twoja wiadomość dotarła — moderator wkrótce odpowie w tym czacie.';
export const DEFAULT_CLOSE = 'Zgłoszenie zostało zamknięte. Aby otworzyć nowe, wyślij kolejną wiadomość.';

// Translate previously saved built-in defaults, leaving administrator-written
// greetings, closing messages and conversation content untouched.
const LEGACY_GREETING =
  'Thanks for contacting the staff of {server}. Your message has been received — a moderator will reply here shortly.';
const LEGACY_CLOSE = 'This ticket has been closed. Send another message any time to open a new one.';
const ticketNotice = (value, fallback) => {
  const text = String(value || '').trim();
  const legacy = fallback === DEFAULT_GREETING ? LEGACY_GREETING : LEGACY_CLOSE;
  if (!text || text === legacy) return fallback;
  return value;
};
const fill = (t, guild) => String(t || '').replaceAll('{server}', guild?.name ?? 'serwer');
const transcriptContent = (message) =>
  message.author_kind === 'system' && message.content === 'Ticket closed by staff.'
    ? 'Zgłoszenie zamknięte przez administrację.'
    : message.content;

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
  const rows = await ticketMessages(ticket.id);

  const header = [
    `Zgłoszenie #${ticket.id} — ${guild?.name ?? ticket.guild_id}`,
    `Użytkownik: ${userLabel} (${ticket.user_id})`,
    `Otwarto: ${fmtTs(ticket.created_at)}`,
    ticket.closed_at ? `Zamknięto: ${fmtTs(ticket.closed_at)}` : null,
    `Wiadomości: ${rows.length}`,
    '─'.repeat(48),
    '',
  ].filter((l) => l != null);

  const body = rows.map((m) => {
    const who = m.author_kind === 'user' ? userLabel : m.author_kind === 'staff' ? 'Administracja' : 'System';
    const lines = [`[${fmtTs(m.created_at)}] ${who}:`];
    if (m.content)
      lines.push(
        ...transcriptContent(m)
          .split('\n')
          .map((l) => `    ${l}`)
      );
    for (const a of m.attachments) lines.push(`    [załącznik] ${a}`);
    return lines.join('\n');
  });

  return {
    filename: `ticket-${ticket.id}-transcript.txt`,
    text: header.join('\n') + body.join('\n\n') + '\n',
  };
}

/**
 * Render a self-contained HTML transcript of a ticket. Staff messages are shown
 * as "Administracja" (matching what the member saw).
 * @param {object} ticket
 * @returns {Promise<{ filename: string, html: string }>}
 */
export async function buildTranscript(ticket) {
  const guild = runtime.client?.guilds.cache.get(ticket.guild_id);
  const user = await runtime.client?.users.fetch(ticket.user_id).catch(() => null);
  const userLabel = user ? user.tag : ticket.user_id;
  const rows = await ticketMessages(ticket.id);

  const bubbles = rows
    .map((m) => {
      const who =
        m.author_kind === 'user'
          ? escHtml(userLabel)
          : m.author_kind === 'staff'
            ? 'Administracja'
            : 'System';
      const atts = m.attachments.length
        ? `<div class="atts">${m.attachments.map((a) => `<a href="${escHtml(a)}">${escHtml(a)}</a>`).join('<br>')}</div>`
        : '';
      const content = escHtml(transcriptContent(m)).replace(/\n/g, '<br>');
      return `<div class="msg ${m.author_kind}"><div class="meta">${who} · ${fmtTs(m.created_at)}</div><div class="content">${content}${atts}</div></div>`;
    })
    .join('\n');

  const html = `<!doctype html><html lang="pl"><head><meta charset="utf-8">
<title>Zgłoszenie #${ticket.id} — ${escHtml(guild?.name ?? '')}</title>
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
<h1>Zgłoszenie #${ticket.id}</h1>
<div class="hdr">Serwer: ${escHtml(guild?.name ?? ticket.guild_id)}<br>
Użytkownik: ${escHtml(userLabel)} (${ticket.user_id})<br>
Otwarto: ${fmtTs(ticket.created_at)}${ticket.closed_at ? `<br>Zamknięto: ${fmtTs(ticket.closed_at)}` : ''}<br>
Wiadomości: ${rows.length}</div>
${bubbles}
</body></html>`;

  return { filename: `ticket-${ticket.id}-transcript.html`, html };
}

/** Public DM support destinations, including for former or banned members. */
export async function ticketGuildsForDM() {
  const out = [];
  for (const guild of runtime.client.guilds.cache.values()) {
    if (!(await isModuleEnabled(guild.id, 'tickets'))) continue;
    out.push(guild);
  }
  return out;
}

const ALERT_MESSAGE_MAX = 1000;

async function notifyStaff(guild, text, embed) {
  const cfg = (await getGuildModule(guild.id, 'tickets')).config;
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
  return withDMTicketLock(guild.id, user.id, () => ingestUserDMUnlocked(guild, user, payload));
}
async function ingestUserDMUnlocked(guild, user, payload) {
  const cfg = (await getGuildModule(guild.id, 'tickets')).config;
  let ticket = await getOpenTicket(guild.id, user.id);
  const isNew = !ticket;
  if (!ticket) ticket = await createTicket(guild.id, user.id);

  await addTicketMessage(ticket.id, {
    authorId: user.id,
    authorKind: 'user',
    content: payload.content ?? '',
    attachments: payload.attachments ?? [],
  });

  const workspace = await syncDMTicketChannel(guild, ticket, user);
  const link = `\n<#${workspace.id}>`;
  if (isNew) {
    await user
      .send({
        embeds: [
          new EmbedBuilder()
            .setColor(TICKET_COLOR)
            .setTitle(`Zgłoszenie #${ticket.id} — ${guild.name}`)
            .setDescription(fill(ticketNotice(cfg.greeting, DEFAULT_GREETING), guild)),
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
      `🎫 Nowe zgłoszenie #${ticket.id} od **${user.tag}** (\`${user.id}\`)${link}`,
      alertEmbed
    );
  } else {
    await notifyStaff(guild, `💬 Nowa wiadomość w zgłoszeniu #${ticket.id} od **${user.tag}**${link}`);
  }
  return ticket;
}

/**
 * DM an anonymous staff reply to the ticket user and record it.
 * @returns {Promise<{ delivered: boolean }>}
 */
export async function relayStaffReply(ticket, staffUserId, content, attachments = []) {
  const guild = runtime.client.guilds.cache.get(ticket.guild_id);
  const user = await runtime.client.users.fetch(ticket.user_id).catch(() => null);
  let delivered = Boolean(user);
  if (user) {
    try {
      const text = [content, ...attachments].filter(Boolean).join('\n');
      for (let i = 0; i < text.length; i += 4000) {
        await user.send({
          embeds: [
            new EmbedBuilder()
              .setColor(TICKET_COLOR)
              .setAuthor({ name: `Odpowiedź administracji · ${guild?.name ?? 'serwer'}` })
              .setDescription(text.slice(i, i + 4000)),
          ],
          allowedMentions: { parse: [] },
        });
      }
    } catch {
      delivered = false;
    }
  }
  await addTicketMessage(ticket.id, {
    authorId: staffUserId,
    authorKind: 'staff',
    content,
    attachments,
    delivered,
  });
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
  return withDMTicketLock(ticket.guild_id, ticket.user_id, async () => {
    const current = await getTicket(ticket.id);
    if (!current) throw new Error('Zgłoszenie już nie istnieje.');
    if (current.status === 'closed') {
      await deleteDMTicketChannel(current);
      return;
    }
    await closeTicketUnlocked(current, staffUserId, closingMessage);
  });
}
async function closeTicketUnlocked(ticket, staffUserId, closingMessage) {
  const guild = runtime.client?.guilds.cache.get(ticket.guild_id);
  const cfg = (await getGuildModule(ticket.guild_id, 'tickets')).config;
  const user = await runtime.client?.users.fetch(ticket.user_id).catch(() => null);

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
  await archiveDMTicketChannel(ticket, staffUserId);
  await closeTicket(ticket.id, staffUserId);
  await addTicketMessage(ticket.id, {
    authorId: staffUserId,
    authorKind: 'system',
    content: 'Zgłoszenie zamknięte przez administrację.',
  });

  if (user) {
    const embed = new EmbedBuilder().setColor(0x8b95a1);
    if (text) {
      embed.setAuthor({ name: `Odpowiedź administracji · ${guild?.name ?? 'serwer'}` }).setDescription(text);
      embed.setFooter({
        text: 'Zgłoszenie zostało zamknięte. Aby otworzyć nowe, wyślij kolejną wiadomość. Dołączono zapis rozmowy.',
      });
    } else {
      embed.setDescription(
        `${fill(ticketNotice(cfg.closeMessage, DEFAULT_CLOSE), guild)}\n\nDołączono zapis tej rozmowy.`
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
  await deleteDMTicketChannel(ticket);
}
