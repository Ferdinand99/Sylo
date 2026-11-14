// JSON API for the Events page of the dashboard: the module's settings, and create / edit / cancel
// for the events themselves. Shares its rules with /event (modules/events.js).
//
// Mounted at /guilds/:guildId AFTER the admin guard in v2Api.js, so req.guild is set, the caller
// manages this server and the state-changing calls have passed the CSRF check.
import { accessRouter } from '../middleware/access.js';
import { actingUserId, currentUser } from '../middleware/auth.js';
import { checkRoleGrants } from '../middleware/roleGrants.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { assignableRoles } from '../lib/guildContext.js';
import { guildTextChannels } from '../lib/discord.js';
import { canPostInChannel } from '../lib/modlogChannel.js';
import { recordAudit } from '../../db/audit.js';
import { getGuildModule, setGuildModule } from '../../db/modules.js';
import { eventStatusCount, getEventInGuild, pastEvents, upcomingEvents } from '../../db/events.js';
import {
  cancelEvent,
  createEvent,
  normaliseEventsConfig,
  parseEventInput,
  refreshEventPosts,
  updateEvent,
} from '../../modules/events.js';
import { utcToLocalInput } from '../../modules/lib/eventTime.js';
import { eventAudience, eventPagePath, eventPagesOn } from '../../modules/lib/eventPage.js';
import { log } from '../../lib/log.js';

/** How many finished or cancelled events the page lists. */
const PAST_SHOWN = 15;

const router = accessRouter('/guilds/:guildId', { mergeParams: true });

const actor = (req) => (currentUser(req)?.open ? 'Dashboard' : `${currentUser(req).name} (dashboard)`);
const fail = (res, message, status = 400) => res.status(status).json({ error: message });

async function eventsView(guild) {
  const channels = guildTextChannels(guild);
  const rows = [...(await upcomingEvents(guild.id)), ...(await pastEvents(guild.id, PAST_SHOWN))];
  // The page exists only while the setting is on and the event's channel has an audience: the path
  // is given for those, with `pageAudience` ('public': anyone with the link; 'private': signed-in
  // members who can see the channel). `pageHidden` says that the setting is on but the channel has
  // no page: it is age-restricted, or Sylo cannot see it.
  const pagesOn = eventPagesOn(await getGuildModule(guild.id, 'events'));
  const audienceOf = new Map(rows.map((ev) => [ev.id, pagesOn ? eventAudience(guild, ev) : 'none']));
  return Promise.all(
    rows.map(async (ev) => ({
      id: ev.id,
      title: ev.title,
      description: ev.description,
      location: ev.location,
      imageUrl: ev.image_url,
      startAt: ev.start_at,
      endAt: ev.end_at,
      // The times as the creator set them, ready for a datetime-local input
      start: utcToLocalInput(ev.start_at, ev.time_zone),
      end: ev.end_at ? utcToLocalInput(ev.end_at, ev.time_zone) : '',
      timeZone: ev.time_zone,
      capacity: ev.capacity,
      roleId: ev.role_id,
      reminderMinutes: ev.reminder_minutes,
      channelId: ev.channel_id,
      channel: channels.find((c) => c.id === ev.channel_id)?.name ?? ev.channel_id,
      state: ev.state,
      joined: await eventStatusCount(ev.id, 'join'),
      maybe: await eventStatusCount(ev.id, 'maybe'),
      pagePath: audienceOf.get(ev.id) === 'none' ? null : eventPagePath(ev.public_token),
      pageAudience: audienceOf.get(ev.id) === 'none' ? null : audienceOf.get(ev.id),
      pageHidden: pagesOn && audienceOf.get(ev.id) === 'none',
    }))
  );
}

const settingsOf = async (guildId) => normaliseEventsConfig((await getGuildModule(guildId, 'events')).config);

router.get(
  '/modules/events/config',
  asyncHandler(async (req, res) => {
    res.json({
      config: await settingsOf(req.guild.id),
      channels: guildTextChannels(req.guild),
      roles: assignableRoles(req.guild),
      events: await eventsView(req.guild),
    });
  })
);

router.post(
  '/modules/events/config',
  asyncHandler(async (req, res) => {
    const prev = await settingsOf(req.guild.id);
    const config = normaliseEventsConfig(req.body);
    await setGuildModule(req.guild.id, 'events', { config });
    const pagesChanged = prev.publicPages !== config.publicPages;
    await recordAudit(req.guild.id, {
      actor: actor(req),
      action: 'module:events',
      detail: pagesChanged
        ? `settings saved (event pages ${config.publicPages ? 'on' : 'off'})`
        : 'settings saved',
    });
    // The posts of the events gain or lose their page link. In the background: it is one edit per
    // event and the answer to the form does not wait for them.
    if (pagesChanged) {
      refreshEventPosts(req.guild.id).catch((err) =>
        log.warn('events', 'could not update the event posts:', err.message)
      );
    }
    // The list on the page shows each event's link, which this setting changes: send it again.
    res.json({ config, events: await eventsView(req.guild) });
  })
);

router.post(
  '/modules/events/events',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const mod = await getGuildModule(guild.id, 'events');
    if (!mod.enabled) return fail(res, 'Turn the Events module on first.');
    const cfg = normaliseEventsConfig(mod.config);

    const parsed = parseEventInput(req.body, {
      defaults: { timeZone: cfg.timeZone, reminderMinutes: cfg.reminderMinutes },
    });
    if (!parsed.ok) return fail(res, parsed.error);

    const channelId = String(req.body.channelId || cfg.channel || '');
    if (!guildTextChannels(guild).some((c) => c.id === channelId)) return fail(res, 'Pick a text channel.');
    if (!canPostInChannel(guild, channelId)) {
      return fail(
        res,
        'Sylo cannot post in that channel. It needs View Channel, Send Messages and Embed Links.'
      );
    }

    const roleId = String(req.body.roleId || '');
    if (roleId) {
      if (!assignableRoles(guild).some((r) => r.id === roleId))
        return fail(res, 'Pick a role from the list.');
      await checkRoleGrants([roleId]); // throws a RoleGrantError (403) for a role the person may not hand out
    }

    const created = await createEvent({
      guild,
      hostId: actingUserId(req, guild.id, String(guild.ownerId ?? '0')),
      channelId,
      roleId: roleId || null,
      input: parsed.value,
    });
    if (!created.ok) return fail(res, created.error);
    await recordAudit(guild.id, {
      actor: actor(req),
      action: 'module:events',
      detail: `created #${created.id}`,
    });
    res.json({ events: await eventsView(guild) });
  })
);

router.post(
  '/modules/events/events/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const cfg = await settingsOf(req.guild.id);
    const result = await updateEvent(id, req.guild.id, req.body, {
      defaults: { timeZone: cfg.timeZone, reminderMinutes: cfg.reminderMinutes },
    });
    if (!result.ok) return fail(res, result.error, result.status ?? 400);
    await recordAudit(req.guild.id, { actor: actor(req), action: 'module:events', detail: `edited #${id}` });
    res.json({ events: await eventsView(req.guild) });
  })
);

router.post(
  '/modules/events/events/:id/cancel',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!(await getEventInGuild(id, req.guild.id))) return fail(res, 'No such event.', 404);
    const result = await cancelEvent(id, req.guild.id);
    if (!result.ok) return fail(res, result.error);
    await recordAudit(req.guild.id, {
      actor: actor(req),
      action: 'module:events',
      detail: `cancelled #${id}`,
    });
    res.json({ events: await eventsView(req.guild) });
  })
);

export default router;
