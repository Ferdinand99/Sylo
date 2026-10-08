// V2 JSON API for the staff pages that used to exist only in V1: the ticket
// inbox, ban-appeal review, per-command limits, and the moderation hub (cases,
// bans, channel locks, warnings). Same functions and rules as V1's
// guilds.js / guildTickets.js, answering with JSON instead of redirects.
//
// Two routers, because they sit behind different guards:
//   ticketsRouter  mounted at /guilds/:guildId/tickets BEFORE the admin guard in
//                  v2Api.js — staff-role holders may use tickets without being
//                  server admins (same rule as V1, see ticketAccess.js).
//   staffRouter    mounted at /guilds/:guildId AFTER the admin guard.
import { Router } from 'express';
import { PermissionFlagsBits, EmbedBuilder, ChannelType } from 'discord.js';
import { runtime } from '../../runtime.js';
import { currentUser } from '../middleware/auth.js';
import { ticketAccessState } from '../middleware/ticketAccess.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { getGuild } from '../lib/guildContext.js';
import { guildTextChannels, resolveUserTags } from '../lib/discord.js';
import { timeAgo } from '../lib/format.js';
import { getGuildModule } from '../../db/modules.js';
import { recordAudit } from '../../db/audit.js';
import { getTicket, listTickets, ticketMessages, markStaffSeen } from '../../db/tickets.js';
import { relayStaffReply, closeTicketWithNotice, buildTranscript } from '../../modules/tickets.js';
import { listAppeals, getAppeal } from '../../db/appeals.js';
import { normaliseAppealsConfig, decideAndNotify } from '../../modules/appeals.js';
import { getCommandOverrides, setCommandOverride } from '../../db/commandOverrides.js';
import {
  listGuildCases,
  getCase,
  editCaseReason,
  setCaseActive,
  addWarning,
  clearWarnings,
} from '../../db/modCases.js';
import { notifyTarget, MOD_COLOR } from '../../bot/lib/moderation.js';
import { postModLog } from '../../bot/lib/modlog.js';
import { applyWarnThresholds } from '../../modules/moderation.js';
import {
  guildChannelLocks,
  lockdownChannelLocks,
  isChannelLocked,
  clearChannelLock,
} from '../../db/channelLocks.js';
import { guildTempBans, clearTempBan } from '../../db/tempBans.js';
import { lockChannel, unlockChannel, lockPreflight } from '../../bot/lib/channelLock.js';
import { formatDuration } from '../../bot/lib/duration.js';

const BAN_DISPLAY_LIMIT = 200;
const WEB_MODERATOR = 'web';

const webModeratorId = (req) => currentUser(req)?.id ?? WEB_MODERATOR;
const moderatorDisplayName = (req) =>
  currentUser(req)?.open ? 'Dashboard' : `${currentUser(req).name} (dashboard)`;

const fail = (res, message, status = 400) => res.status(status).json({ error: message });

// Mirrors guilds.js's / v2Api.js's own private parseUserId() — a raw
// snowflake or an `<@id>`/`<@!id>` mention, as pasted straight out of Discord.
function parseUserId(raw) {
  const m = String(raw ?? '')
    .trim()
    .match(/^<@!?(\d{17,20})>$|^(\d{17,20})$/);
  return m ? m[1] || m[2] : null;
}

function loadGuildJson(req, res, next) {
  req.guild = getGuild(req);
  if (!req.guild) return fail(res, 'Unknown or unavailable server', 404);
  next();
}

// --- Tickets -----------------------------------------------------------------

export const ticketsRouter = Router({ mergeParams: true });

ticketsRouter.use(loadGuildJson);
ticketsRouter.use(async (req, res, next) => {
  const state = await ticketAccessState(req);
  if (state === 'ok') return next();
  if (state === 'login') return fail(res, 'Not signed in', 401);
  fail(res, 'You need Manage Server, or a configured staff role, to view tickets here.', 403);
});

const shapeTicketMessage = (m, ticketUserTag) => ({
  id: m.id,
  kind: m.author_kind,
  who: m.author_kind === 'user' ? ticketUserTag : m.author_kind === 'staff' ? 'Staff' : 'System',
  content: m.content,
  attachments: m.attachments,
  delivered: m.delivered === 1,
  ago: timeAgo(m.created_at),
});

async function ticketInGuild(req) {
  const ticket = await getTicket(Number(req.params.ticketId));
  return ticket && ticket.guild_id === req.guild.id ? ticket : null;
}

ticketsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const open = await listTickets(req.guild.id, 'open', 100);
    const closed = await listTickets(req.guild.id, 'closed', 25);
    const tags = await resolveUserTags(
      runtime.client,
      [...open, ...closed].map((t) => t.user_id)
    );
    const shape = (t) => ({
      id: t.id,
      user: tags.get(t.user_id) ?? t.user_id,
      userId: t.user_id,
      preview: t.preview,
      previewKind: t.previewKind,
      ago: timeAgo(t.last_at),
      unread: t.status === 'open' && t.last_at > t.staff_seen_at,
    });
    res.json({ open: open.map(shape), closed: closed.map(shape) });
  })
);

ticketsRouter.get(
  '/:ticketId',
  asyncHandler(async (req, res) => {
    const ticket = await ticketInGuild(req);
    if (!ticket) return fail(res, 'Ticket not found', 404);
    await markStaffSeen(ticket.id);
    const rows = await ticketMessages(ticket.id);
    const tags = await resolveUserTags(runtime.client, [ticket.user_id, ...rows.map((r) => r.author_id)]);
    const userTag = tags.get(ticket.user_id) ?? 'User';
    res.json({
      ticket: {
        id: ticket.id,
        status: ticket.status,
        user: tags.get(ticket.user_id) ?? ticket.user_id,
        userId: ticket.user_id,
        openedAgo: timeAgo(ticket.created_at),
      },
      messages: rows.map((m) => shapeTicketMessage(m, userTag)),
      lastId: rows.length ? rows[rows.length - 1].id : 0,
    });
  })
);

// New messages since `after` — the page polls this while a ticket is open.
ticketsRouter.get(
  '/:ticketId/messages',
  asyncHandler(async (req, res) => {
    const ticket = await ticketInGuild(req);
    if (!ticket) return fail(res, 'Ticket not found', 404);
    const rows = await ticketMessages(ticket.id, Number(req.query.after) || 0);
    await markStaffSeen(ticket.id);
    res.json({ status: ticket.status, messages: rows.map((m) => shapeTicketMessage(m, 'User')) });
  })
);

ticketsRouter.get(
  '/:ticketId/transcript',
  asyncHandler(async (req, res) => {
    const ticket = await ticketInGuild(req);
    if (!ticket) return res.status(404).type('text/plain').send('Not found');
    const { filename, html } = await buildTranscript(ticket);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.type('html').send(html);
  })
);

ticketsRouter.post(
  '/:ticketId/reply',
  asyncHandler(async (req, res) => {
    const ticket = await ticketInGuild(req);
    if (!ticket) return fail(res, 'Ticket not found', 404);
    if (ticket.status !== 'open') return fail(res, 'This ticket is closed.', 409);
    const content = String(req.body.content ?? '')
      .trim()
      .slice(0, 2000);
    if (!content) return fail(res, 'Write a reply first.');
    const { delivered } = await relayStaffReply(ticket, currentUser(req)?.id ?? 'web', content);
    res.json({ ok: true, delivered });
  })
);

ticketsRouter.post(
  '/:ticketId/close',
  asyncHandler(async (req, res) => {
    const ticket = await ticketInGuild(req);
    if (!ticket) return fail(res, 'Ticket not found', 404);
    if (ticket.status === 'open') {
      const closingMessage = String(req.body.content ?? '')
        .trim()
        .slice(0, 2000);
      await closeTicketWithNotice(ticket, currentUser(req)?.id ?? 'web', closingMessage);
    }
    res.json({ ok: true });
  })
);

// --- Everything else: behind the server-admin guard -----------------------------

export const staffRouter = Router({ mergeParams: true });

// Ban appeals ---------------------------------------------------------------------

staffRouter.get(
  '/appeals',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const rows = await listAppeals(guild.id, 100);
    const cfg = normaliseAppealsConfig((await getGuildModule(guild.id, 'appeals')).config);
    const appeals = rows.map((a) => ({
      id: a.id,
      user: a.user_tag || a.user_id,
      userId: a.user_id,
      banReason: a.ban_reason || '—',
      answers: a.answers,
      status: a.status,
      decidedBy: a.decided_by,
      decisionReason: a.decision_reason,
      ago: timeAgo(a.created_at),
      decidedAgo: a.decided_at ? timeAgo(a.decided_at) : null,
    }));
    res.json({
      appeals,
      open: appeals.filter((a) => a.status === 'open').length,
      moduleEnabled: (await getGuildModule(guild.id, 'appeals')).enabled,
      configured: cfg.questions.length > 0,
    });
  })
);

staffRouter.post(
  '/appeals/:id/decide',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const appeal = await getAppeal(guild.id, req.params.id);
    if (!appeal || appeal.status !== 'open') return fail(res, 'This appeal has already been decided.', 409);

    const decision =
      req.body.decision === 'accept' ? 'accepted' : req.body.decision === 'deny' ? 'denied' : null;
    if (!decision) return fail(res, 'Choose accept or deny.');
    const reason =
      String(req.body.reason ?? '')
        .trim()
        .slice(0, 1000) || 'No reason given';

    const result = await decideAndNotify(guild, appeal, {
      status: decision,
      decidedBy: moderatorDisplayName(req),
      reason,
    });
    if (!result.recorded) return fail(res, 'This appeal has already been decided.', 409);

    await recordAudit(guild.id, {
      actor: moderatorDisplayName(req),
      action: `appeal:${decision}`,
      detail: `#${appeal.id} ${appeal.user_tag || appeal.user_id}${decision === 'accepted' && !result.unbanned ? ' (unban manually)' : ''}`,
    });
    res.json({
      ok: true,
      status: decision,
      dmDelivered: Boolean(result.dmDelivered),
      unbanned: Boolean(result.unbanned),
    });
  })
);

// Command limits --------------------------------------------------------------------

staffRouter.get(
  '/commands',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const overrides = await getCommandOverrides(guild.id);
    const commands = [...(runtime.client?.commands?.values() ?? [])]
      .map(({ data }) => {
        const ov = overrides.get(data.name);
        return {
          name: data.name,
          description: data.description,
          enabled: ov ? ov.enabled : true,
          allowedChannels: ov?.allowedChannels ?? [],
          allowedRoles: ov?.allowedRoles ?? [],
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    const roles = [...guild.roles.cache.values()]
      .filter((r) => r.id !== guild.id)
      .sort((a, b) => b.position - a.position)
      .map((r) => ({ id: r.id, name: r.name }));
    res.json({ commands, channels: guildTextChannels(guild), roles });
  })
);

staffRouter.post(
  '/commands/:command',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const command = req.params.command;
    if (!runtime.client?.commands?.has(command)) return fail(res, 'Unknown command', 404);
    const toIds = (v) =>
      (Array.isArray(v) ? v : v == null ? [] : String(v).split(/[\s,]+/))
        .map((s) => String(s).trim())
        .filter((s) => /^\d{17,20}$/.test(s));
    const enabled = Boolean(req.body.enabled);
    const allowedChannels = toIds(req.body.channels);
    const allowedRoles = toIds(req.body.roles);
    await setCommandOverride(guild.id, command, { enabled, allowedChannels, allowedRoles });
    await recordAudit(guild.id, {
      actor: moderatorDisplayName(req),
      action: `command:/${command}`,
      detail: enabled ? 'updated limits' : 'disabled',
    });
    res.json({ ok: true, command: { name: command, enabled, allowedChannels, allowedRoles } });
  })
);

// Moderation hub ----------------------------------------------------------------------

staffRouter.get(
  '/moderation',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const { rows: caseRows, total: caseTotal } = await listGuildCases(guild.id, 200);
    const tags = await resolveUserTags(
      runtime.client,
      caseRows.flatMap((c) => [c.user_id, c.moderator_id]).filter((id) => /^\d+$/.test(id))
    );
    const modLabels = { web: 'Dashboard', automod: 'AutoMod', auto: 'auto-threshold', '': 'system' };
    const cases = caseRows.map((c) => ({
      caseNumber: c.case_number,
      action: c.action,
      active: c.active === 1,
      user: tags.get(c.user_id) ?? c.user_id,
      userId: c.user_id,
      moderator:
        c.moderator_id === WEB_MODERATOR
          ? 'Dashboard'
          : (modLabels[c.moderator_id] ?? tags.get(c.moderator_id) ?? c.moderator_id),
      reason: c.reason,
      detail: c.detail,
      ago: timeAgo(c.created_at),
    }));

    let bans = [];
    let bansError = null;
    let bansTotal = 0;
    if (guild.members.me?.permissions.has(PermissionFlagsBits.BanMembers)) {
      try {
        const fetched = await guild.bans.fetch();
        bansTotal = fetched.size;
        bans = [...fetched.values()].slice(0, BAN_DISPLAY_LIMIT).map((b) => ({
          id: b.user.id,
          tag: b.user.tag,
          reason: b.reason ?? '—',
        }));
      } catch (err) {
        bansError = err.message;
      }
    } else {
      bansError = 'The bot is missing the "Ban Members" permission in this server.';
    }

    const channelLocks = (await guildChannelLocks(guild.id)).map((r) => ({
      channelId: r.channel_id,
      name: guild.channels.cache.get(r.channel_id)?.name ?? null,
      lockedBy: r.locked_by,
      lockdown: r.lockdown === 1,
      ago: timeAgo(r.locked_at),
    }));
    const tbRows = await guildTempBans(guild.id);
    const tbTags = await resolveUserTags(
      runtime.client,
      tbRows.map((r) => r.user_id)
    );
    const now = Date.now();
    const tempBans = tbRows.map((r) => ({
      userId: r.user_id,
      tag: tbTags.get(r.user_id) ?? r.user_id,
      reason: r.reason,
      remaining: r.unban_at > now ? formatDuration(r.unban_at - now) : 'any moment now',
    }));

    res.json({
      cases,
      caseTotal,
      bans,
      bansTotal,
      bansError,
      banLimit: BAN_DISPLAY_LIMIT,
      channelLocks,
      tempBans,
      lockdownActive: channelLocks.some((l) => l.lockdown),
    });
  })
);

staffRouter.post(
  '/moderation/unban',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const userId = parseUserId(req.body.userId);
    if (!userId) return fail(res, 'That is not a user ID or mention.');
    if (!guild.members.me?.permissions.has(PermissionFlagsBits.BanMembers)) {
      return fail(res, 'The bot is missing the "Ban Members" permission in this server.', 403);
    }
    const existing = await guild.bans.fetch(userId).catch(() => null);
    if (!existing) {
      await clearTempBan(guild.id, userId); // stale timer for an already-lifted ban
      return fail(res, 'That user is not banned.', 404);
    }
    await guild.bans.remove(userId, `${moderatorDisplayName(req)}: unbanned via dashboard`);
    await clearTempBan(guild.id, userId);
    const embed = new EmbedBuilder()
      .setColor(MOD_COLOR)
      .setTitle('Ban removed')
      .setDescription(`${existing.user.tag} (\`${existing.user.id}\`)`)
      .addFields({ name: 'Moderator', value: moderatorDisplayName(req) })
      .setTimestamp(Date.now());
    await postModLog(guild, embed);
    res.json({ ok: true });
  })
);

staffRouter.post(
  '/moderation/lock-all',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const moderatorTag = moderatorDisplayName(req);
    let locked = 0;
    for (const channel of guild.channels.cache.values()) {
      if (channel.type !== ChannelType.GuildText) continue;
      if ((await isChannelLocked(guild.id, channel.id)) || lockPreflight(channel)) continue;
      try {
        await lockChannel(channel, { moderatorTag, lockdown: true });
        locked += 1;
      } catch {
        /* skip a channel we can't edit */
      }
    }
    await recordAudit(guild.id, {
      actor: moderatorTag,
      action: 'moderation:lockdown',
      detail: `locked ${locked} channel(s)`,
    });
    const embed = new EmbedBuilder()
      .setColor(MOD_COLOR)
      .setTitle('🔒 Server lockdown started')
      .addFields(
        { name: 'Channels locked', value: String(locked) },
        { name: 'Moderator', value: moderatorTag }
      )
      .setTimestamp(Date.now());
    await postModLog(guild, embed);
    res.json({ ok: true, locked });
  })
);

staffRouter.post(
  '/moderation/unlock-all',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const moderatorTag = moderatorDisplayName(req);
    let unlocked = 0;
    for (const row of await lockdownChannelLocks(guild.id)) {
      const channel = guild.channels.cache.get(row.channel_id);
      if (!channel) {
        await clearChannelLock(guild.id, row.channel_id);
        continue;
      }
      try {
        await unlockChannel(channel, { moderatorTag });
        unlocked += 1;
      } catch {
        /* skip */
      }
    }
    await recordAudit(guild.id, {
      actor: moderatorTag,
      action: 'moderation:lockdown',
      detail: `unlocked ${unlocked} channel(s)`,
    });
    const embed = new EmbedBuilder()
      .setColor(MOD_COLOR)
      .setTitle('🔓 Server lockdown ended')
      .addFields(
        { name: 'Channels unlocked', value: String(unlocked) },
        { name: 'Moderator', value: moderatorTag }
      )
      .setTimestamp(Date.now());
    await postModLog(guild, embed);
    res.json({ ok: true, unlocked });
  })
);

staffRouter.post(
  '/moderation/unlock-channel',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const channelId = String(req.body.channelId ?? '');
    if (!/^\d{17,20}$/.test(channelId) || !(await isChannelLocked(guild.id, channelId))) {
      return fail(res, 'That channel is not locked.', 404);
    }
    const moderatorTag = moderatorDisplayName(req);
    const channel = guild.channels.cache.get(channelId);
    if (!channel) {
      await clearChannelLock(guild.id, channelId);
      return res.json({ ok: true });
    }
    if (lockPreflight(channel))
      return fail(res, 'The bot cannot edit that channel (missing permissions).', 403);
    await unlockChannel(channel, { moderatorTag });
    await recordAudit(guild.id, {
      actor: moderatorTag,
      action: 'moderation:unlock',
      detail: `#${channel.name}`,
    });
    const embed = new EmbedBuilder()
      .setColor(MOD_COLOR)
      .setTitle('Channel unlocked')
      .addFields({ name: 'Channel', value: `#${channel.name}` }, { name: 'Moderator', value: moderatorTag })
      .setTimestamp(Date.now());
    await postModLog(guild, embed);
    res.json({ ok: true });
  })
);

staffRouter.post(
  '/moderation/warn',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const userId = parseUserId(req.body.userId);
    const reason = String(req.body.reason ?? '')
      .trim()
      .slice(0, 400);
    if (!userId || reason === '') return fail(res, 'Enter a user ID or mention and a reason.');

    const user = await runtime.client.users.fetch(userId).catch(() => null);
    if (!user) return fail(res, 'No such user.', 404);
    if (user.bot) return fail(res, 'Bots cannot be warned.');

    const { id, count } = await addWarning({
      guildId: guild.id,
      userId: user.id,
      moderatorId: webModeratorId(req),
      reason,
    });
    const dmed = await notifyTarget(user, {
      guildName: guild.name,
      action: 'warned',
      reason,
      extra: `This is warning #${count}.`,
    });
    const embed = new EmbedBuilder()
      .setColor(MOD_COLOR)
      .setTitle('Member warned')
      .setThumbnail(user.displayAvatarURL())
      .addFields(
        { name: 'User', value: `${user.tag} (\`${user.id}\`)` },
        { name: 'Moderator', value: moderatorDisplayName(req) },
        { name: 'Reason', value: reason },
        { name: 'Warning ID', value: `#${id}` },
        { name: 'Total warnings', value: String(count) },
        { name: 'Notified', value: dmed ? 'Yes (DM sent)' : 'No (DMs closed)' }
      )
      .setTimestamp(Date.now());
    const logged = await postModLog(guild, embed);
    await applyWarnThresholds(guild, user, count, moderatorDisplayName(req));
    res.json({ ok: true, warnings: count, dmDelivered: Boolean(dmed), logged: Boolean(logged) });
  })
);

staffRouter.post(
  '/moderation/warnings/clear',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const userId = parseUserId(req.body.userId);
    if (!userId) return fail(res, 'That is not a user ID or mention.');
    const n = await clearWarnings(guild.id, userId);
    if (n === 0) return fail(res, 'That member has no warnings.', 404);
    const target = await runtime.client.users.fetch(userId).catch(() => null);
    const embed = new EmbedBuilder()
      .setColor(MOD_COLOR)
      .setTitle('Warnings cleared')
      .addFields(
        { name: 'User', value: target ? `${target.tag} (\`${userId}\`)` : `\`${userId}\`` },
        { name: 'Removed', value: `${n} warning${n === 1 ? '' : 's'}` },
        { name: 'Moderator', value: moderatorDisplayName(req) }
      )
      .setTimestamp(Date.now());
    await postModLog(guild, embed);
    await recordAudit(guild.id, {
      actor: moderatorDisplayName(req),
      action: 'moderation:warn-clear',
      detail: `${n} for ${userId}`,
    });
    res.json({ ok: true, removed: n });
  })
);

staffRouter.post(
  '/moderation/cases/:n/reason',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const n = Number(req.params.n);
    const reason = String(req.body.reason ?? '')
      .trim()
      .slice(0, 1000);
    if (!Number.isInteger(n) || n < 1 || reason === '' || !(await getCase(guild.id, n))) {
      return fail(res, 'Case not found, or the reason is empty.', 404);
    }
    await editCaseReason(guild.id, n, reason);
    await recordAudit(guild.id, {
      actor: moderatorDisplayName(req),
      action: 'moderation:case-reason',
      detail: `#${n}`,
    });
    res.json({ ok: true });
  })
);

// Soft-delete or restore one case.
staffRouter.post(
  '/moderation/cases/:n/:op',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    if (req.params.op !== 'delete' && req.params.op !== 'restore') return fail(res, 'Unknown action.', 404);
    const n = Number(req.params.n);
    const active = req.params.op === 'restore';
    const existing = Number.isInteger(n) ? await getCase(guild.id, n) : null;
    if (!existing) return fail(res, 'Case not found.', 404);
    await setCaseActive(guild.id, n, active);

    const target = await runtime.client.users.fetch(existing.user_id).catch(() => null);
    const embed = new EmbedBuilder()
      .setColor(MOD_COLOR)
      .setTitle(active ? `Case #${n} restored` : `Case #${n} deleted`)
      .addFields(
        {
          name: 'User',
          value: target ? `${target.tag} (\`${existing.user_id}\`)` : `\`${existing.user_id}\``,
        },
        { name: 'Original reason', value: existing.reason || '—' },
        { name: active ? 'Restored by' : 'Deleted by', value: moderatorDisplayName(req) }
      )
      .setTimestamp(Date.now());
    await postModLog(guild, embed);
    await recordAudit(guild.id, {
      actor: moderatorDisplayName(req),
      action: `moderation:case-${req.params.op}`,
      detail: `#${n}`,
    });
    res.json({ ok: true, active });
  })
);
