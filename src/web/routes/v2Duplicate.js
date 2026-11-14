// "Duplicate" in the "⋯" menu of a list row: reminders, embed messages, reaction-role sets, custom commands
// and shop items. Each copy is made here from what is stored, never from what the page shows, and goes
// through the same writers and limits as creating one by hand (a ceiling reached answers 400 with the
// reason). A copy never starts doing anything on its own:
//   * a reminder is paused,
//   * an embed message and a reaction-role set are drafts (nothing is posted),
//   * a custom command gets a free name ending in "-copy",
//   * a shop item is paused and has no picture (a collectible's picture belongs to the original).
//
// Mounted at /guilds/:guildId AFTER the admin guard in v2Api.js, so req.guild is set, the caller manages
// this server, the CSRF check has passed and the role-grant guard knows who is saving.
import { Router } from 'express';
import { currentUser } from '../middleware/auth.js';
import { checkModuleGrants, checkRoleGrants } from '../middleware/roleGrants.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { assignableRoles } from '../lib/guildContext.js';
import { clientOfGuild } from '../../platform/platformOf.js';
import { log } from '../../lib/log.js';
import { LIMITS as CEILINGS, checkLimit } from '../../lib/limits.js';
import { recordAudit } from '../../db/audit.js';
import { getGuildModule, setGuildModule } from '../../db/modules.js';
import { createReminder, getScheduled, setScheduledEnabled } from '../../db/scheduledMessages.js';
import { createComposed, getComposed } from '../../db/composedMessages.js';
import { createItem, getItem, itemCount } from '../../db/economyShop.js';
import { LIMITS as ECONOMY_LIMITS, itemProblem, normaliseItem } from '../../modules/economy.js';
import { reactionMessagesFull, LIMITS as ROLES_LIMITS } from '../../modules/roles.js';
import { LIMITS as CC_LIMITS, NAME_RE, normaliseCustomCommands } from '../../modules/customCommands.js';
import { reservedCommandNames, syncGuildCustomCommands } from '../../bot/lib/customCommandSync.js';

const router = Router({ mergeParams: true });

// A copy is one write, but a script should not be able to fill a server with them in a loop.
const duplicateLimit = rateLimit({
  windowMs: 60_000,
  max: 30,
  message: 'Too many copies — wait a minute.',
});

const actor = (req) => (currentUser(req)?.open ? 'Dashboard' : `${currentUser(req).name} (dashboard)`);
const fail = (res, message, status = 400) => res.status(status).json({ error: message });
const isRowId = (v) => /^\d{1,15}$/.test(String(v ?? ''));

/** `name` with " (copy)" after it, the name cut so the whole fits in `max` characters. */
export function copyName(name, max = 100, suffix = ' (copy)') {
  const base = String(name ?? '').trim();
  return `${base.slice(0, Math.max(0, max - suffix.length))}${suffix}`;
}

/**
 * The first of `base-copy`, `base-copy2`, `base-copy3` … that is a valid command name, is not taken and is not
 * a built-in command. `base` is cut so the suffix always fits.
 */
export function freeCopyName(base, taken, max = CC_LIMITS['commands[].name'].maxLength) {
  for (let n = 1; n < 1000; n += 1) {
    const suffix = n === 1 ? '-copy' : `-copy${n}`;
    const name = `${base.slice(0, Math.max(1, max - suffix.length))}${suffix}`;
    if (NAME_RE.test(name) && !taken(name)) return name;
  }
  return null;
}

// --- reminders ---------------------------------------------------------------------------------

router.post(
  '/modules/reminders/:id/duplicate',
  duplicateLimit,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const src = Number.isInteger(id) ? await getScheduled(req.guild.id, id) : null;
    if (!src) return fail(res, 'No such reminder', 404);
    const name = copyName(src.name || 'Reminder');
    // createReminder checks the server's ceiling and throws the LimitError that answers 400.
    const copyId = await createReminder(req.guild.id, {
      name,
      channelId: src.channel_id,
      spec: src.spec,
      mode: src.mode,
      days: src.dayList,
      intervalMinutes: src.interval_minutes,
      startAt: src.start_at == null ? null : Number(src.start_at),
      endAt: src.end_at == null ? null : Number(src.end_at),
      runAt: src.run_at == null ? null : Number(src.run_at),
    });
    // Paused: a one-time reminder whose time has passed would otherwise be sent at once.
    await setScheduledEnabled(req.guild.id, copyId, false);
    await recordAudit(req.guild.id, {
      actor: actor(req),
      action: 'module:reminders',
      detail: `duplicated "${src.name}" (paused)`,
    });
    res.json({ ok: true, id: copyId, name });
  })
);

// --- embed messages ----------------------------------------------------------------------------

router.post(
  '/messages/:id/duplicate',
  duplicateLimit,
  asyncHandler(async (req, res) => {
    if (!isRowId(req.params.id)) return fail(res, 'Invalid id');
    const src = await getComposed(req.guild.id, Number(req.params.id));
    if (!src) return fail(res, 'Not found', 404);
    const name = copyName(src.name || 'Untitled embed');
    // No message id: the copy is a draft. createComposed checks the ceiling and the roles of its buttons.
    const copy = await createComposed(req.guild.id, {
      name,
      channelId: src.channel_id,
      messageId: null,
      spec: src.spec,
    });
    await recordAudit(req.guild.id, {
      actor: actor(req),
      action: 'messages:duplicate',
      detail: `duplicated "${src.name || 'Untitled embed'}" as a draft`,
    });
    res.json({ ok: true, id: copy.id, name });
  })
);

// --- reaction-role sets ----------------------------------------------------------------------

router.post(
  '/modules/roles/rr/:id/duplicate',
  duplicateLimit,
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const cfg = (await getGuildModule(guild.id, 'roles')).config;
    const list = Array.isArray(cfg.reactionMessages) ? cfg.reactionMessages : [];
    const src = list.find((x) => String(x.id) === String(req.params.id));
    if (!src) return fail(res, 'No such reaction-role set', 404);
    if (reactionMessagesFull(list.length)) {
      return fail(
        res,
        `This server already has the maximum of ${ROLES_LIMITS.reactionMessages.maxItems} reaction-role messages.`
      );
    }
    // A new id; the copy has no message, so it is a draft until it is published from its form.
    let id = String(Date.now());
    while (list.some((x) => String(x.id) === id)) id = String(Number(id) + 1);
    const copy = { ...structuredClone(src), id, messageId: '' };
    const next = { ...cfg, reactionMessages: [...list, copy] };
    await checkModuleGrants('roles', cfg, next);
    await setGuildModule(guild.id, 'roles', { config: next });
    await recordAudit(guild.id, {
      actor: actor(req),
      action: 'module:roles',
      detail: 'duplicated a reaction-role set as a draft',
    });
    res.json({ ok: true, id });
  })
);

// --- custom commands ---------------------------------------------------------------------------

router.post(
  '/modules/custom-commands/cmd/:id/duplicate',
  duplicateLimit,
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const stored = await getGuildModule(guild.id, 'custom-commands');
    const prev = normaliseCustomCommands(stored.config);
    const src = prev.commands.find((c) => c.id === String(req.params.id));
    if (!src) return fail(res, 'No such command', 404);
    const reserved = reservedCommandNames(clientOfGuild(guild));
    const name = freeCopyName(src.name, (n) => reserved.has(n) || prev.commands.some((c) => c.name === n));
    if (!name) return fail(res, 'Could not find a free name for the copy.');
    let id = String(Date.now());
    while (prev.commands.some((c) => c.id === id)) id = String(Number(id) + 1);
    const config = normaliseCustomCommands({
      commands: [...prev.commands, { ...structuredClone(src), id, name }],
    });
    if (!config.commands.some((c) => c.id === id)) {
      return fail(
        res,
        `This server already has the maximum of ${CC_LIMITS.commands.maxItems} custom commands.`
      );
    }
    await setGuildModule(guild.id, 'custom-commands', { enabled: true, config });
    await recordAudit(guild.id, {
      actor: actor(req),
      action: 'module:custom-commands',
      detail: `duplicated /${src.name} as /${name}`,
    });
    await syncGuildCustomCommands(guild).catch((err) =>
      log.error('custom-commands', 'sync after duplicate failed:', err.message)
    );
    res.json({ ok: true, id, name });
  })
);

// --- shop items --------------------------------------------------------------------------------

router.post(
  '/modules/economy/shop/items/:id/duplicate',
  duplicateLimit,
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    if (!isRowId(req.params.id)) return fail(res, 'Unknown item.', 404);
    const src = await getItem(guild.id, Number(req.params.id));
    if (!src) return fail(res, 'Unknown item.', 404);
    // From the stored item through the normaliser the item form uses: the copy is paused, sells nothing yet
    // (the sold count starts at zero) and has no picture.
    const item = normaliseItem({
      name: copyName(src.name, ECONOMY_LIMITS.itemName.maxLength),
      description: src.description,
      emoji: src.emoji,
      type: src.type,
      roleId: src.roleId,
      durationHours: src.durationMs == null ? null : Math.round(src.durationMs / 3_600_000),
      price: src.price,
      stock: src.stock,
      requiredRoles: src.requiredRoles,
      perMemberLimit: src.perMemberLimit,
      enabled: false,
      rarity: src.rarity,
      announce: src.announce,
    });
    const problem = itemProblem(item);
    if (problem) return fail(res, problem);
    if (item.roleId) {
      if (!assignableRoles(guild).some((r) => r.id === item.roleId)) {
        return fail(res, 'The role of this item is no longer one Sylo can hand out.');
      }
      checkRoleGrants([item.roleId]); // throws a RoleGrantError (403) for a role the person may not hand out
    }
    checkLimit(await itemCount(guild.id), CEILINGS.shopItems, 'shop items');
    const id = await createItem(guild.id, item);
    await recordAudit(guild.id, {
      actor: actor(req),
      action: 'economy:shop',
      detail: `duplicated item #${src.id} ${src.name} as #${id} (paused)`,
    });
    res.json({ ok: true, id, name: item.name, pictureCopied: false });
  })
);

export default router;
