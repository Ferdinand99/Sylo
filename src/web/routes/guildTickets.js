// Tickets (modmail) dashboard: list, conversation view, reply, close.
import { Router } from 'express';
import { runtime } from '../../runtime.js';
import { getGuild, baseContext } from '../lib/guildContext.js';
import { requireTicketAccess } from '../middleware/ticketAccess.js';
import { currentUser } from '../middleware/auth.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { resolveUserTags } from '../lib/discord.js';
import { timeAgo } from '../lib/format.js';
import {
  getTicket,
  listTickets,
  ticketMessages,
  markStaffSeen,
} from '../../db/tickets.js';
import { relayStaffReply, closeTicketWithNotice, buildTranscript } from '../../modules/tickets.js';

const router = Router({ mergeParams: true });

router.use((req, res, next) => {
  req.guild = getGuild(req);
  if (!req.guild) return res.status(404).render('guild-missing', { guildId: req.params.guildId });
  next();
});
router.use(requireTicketAccess);

// List open + recently closed tickets.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const open = listTickets(req.guild.id, 'open', 100);
    const closed = listTickets(req.guild.id, 'closed', 25);
    const tags = await resolveUserTags(runtime.client, [...open, ...closed].map((t) => t.user_id));
    const shape = (t) => ({
      id: t.id,
      user: tags.get(t.user_id) ?? t.user_id,
      userId: t.user_id,
      preview: t.preview,
      previewKind: t.previewKind,
      ago: timeAgo(t.last_at),
      unread: t.status === 'open' && t.last_at > t.staff_seen_at,
    });
    res.render('guild-tickets', {
      ...baseContext(req.guild, 'tickets'),
      open: open.map(shape),
      closed: closed.map(shape),
    });
  })
);

// One ticket conversation.
router.get(
  '/:ticketId',
  asyncHandler(async (req, res) => {
    const ticket = getTicket(Number(req.params.ticketId));
    if (!ticket || ticket.guild_id !== req.guild.id) {
      return res.status(404).render('guild-missing', { guildId: req.guild.id });
    }
    markStaffSeen(ticket.id);
    const rows = ticketMessages(ticket.id);
    const tags = await resolveUserTags(runtime.client, [ticket.user_id, ...rows.map((r) => r.author_id)]);
    res.render('guild-ticket', {
      ...baseContext(req.guild, 'tickets'),
      ticket: {
        id: ticket.id,
        status: ticket.status,
        user: tags.get(ticket.user_id) ?? ticket.user_id,
        userId: ticket.user_id,
        openedAgo: timeAgo(ticket.created_at),
      },
      messages: rows.map((m) => ({
        id: m.id,
        kind: m.author_kind,
        who: m.author_kind === 'user' ? tags.get(ticket.user_id) ?? 'User' : m.author_kind === 'staff' ? 'Staff' : 'System',
        content: m.content,
        attachments: m.attachments,
        delivered: m.delivered === 1,
        ago: timeAgo(m.created_at),
      })),
      lastId: rows.length ? rows[rows.length - 1].id : 0,
      msg: typeof req.query.msg === 'string' ? req.query.msg : null,
    });
  })
);

// Download an HTML transcript.
router.get(
  '/:ticketId/transcript',
  asyncHandler(async (req, res) => {
    const ticket = getTicket(Number(req.params.ticketId));
    if (!ticket || ticket.guild_id !== req.guild.id) return res.status(404).send('Not found');
    const { filename, html } = await buildTranscript(ticket);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.type('html').send(html);
  })
);

// Poll for new messages since `after`.
router.get('/:ticketId/messages.json', (req, res) => {
  const ticket = getTicket(Number(req.params.ticketId));
  if (!ticket || ticket.guild_id !== req.guild.id) return res.status(404).json({ error: 'not found' });
  const after = Number(req.query.after) || 0;
  const rows = ticketMessages(ticket.id, after);
  markStaffSeen(ticket.id);
  res.json({
    status: ticket.status,
    messages: rows.map((m) => ({
      id: m.id,
      kind: m.author_kind,
      who: m.author_kind === 'staff' ? 'Staff' : m.author_kind === 'system' ? 'System' : 'User',
      content: m.content,
      attachments: m.attachments,
      delivered: m.delivered === 1,
    })),
  });
});

router.post(
  '/:ticketId/reply',
  asyncHandler(async (req, res) => {
    const ticket = getTicket(Number(req.params.ticketId));
    const back = `/guilds/${req.guild.id}/tickets/${req.params.ticketId}`;
    if (!ticket || ticket.guild_id !== req.guild.id) return res.redirect(`/guilds/${req.guild.id}/tickets`);
    if (ticket.status !== 'open') return res.redirect(`${back}?msg=closed`);

    const content = String(req.body.content ?? '').trim().slice(0, 2000);
    if (!content) return res.redirect(`${back}?msg=empty`);

    const staffId = currentUser(req)?.id ?? 'web';
    const { delivered } = await relayStaffReply(ticket, staffId, content);
    res.redirect(`${back}?msg=${delivered ? 'sent' : 'undelivered'}`);
  })
);

router.post(
  '/:ticketId/close',
  asyncHandler(async (req, res) => {
    const ticket = getTicket(Number(req.params.ticketId));
    if (ticket && ticket.guild_id === req.guild.id && ticket.status === 'open') {
      const closingMessage = String(req.body.content ?? '').trim().slice(0, 2000);
      await closeTicketWithNotice(ticket, currentUser(req)?.id ?? 'web', closingMessage);
    }
    res.redirect(`/guilds/${req.guild.id}/tickets`);
  })
);

export default router;
