// JSON API for the Economy page of the dashboard: the module's settings, the member list (every
// member with an account, paged and sortable, plus a name search), one member's balances and last
// 50 ledger rows, the staff changes (add, remove, set, reset a member) and the danger-zone reset of
// the whole server. Every change goes through the money API (modules/lib/economy.js), so it is in
// the ledger with who made it; the rules live in modules/economy.js.
//
// Mounted at /guilds/:guildId AFTER the admin guard in v2Api.js, so req.guild is set, the caller
// manages this server and the state-changing calls have passed the CSRF check.
import { Router } from 'express';
import { actingUserId, currentUser } from '../middleware/auth.js';
import { platformActionLimit } from '../middleware/rateLimit.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { config as appConfig } from '../../config.js';
import { platformOfGuild } from '../../platform/platformOf.js';
import { assignableRoles } from '../lib/guildContext.js';
import { guildTextChannels, resolveUserTags } from '../lib/discord.js';
import { recordAudit } from '../../db/audit.js';
import { getGuildModule, setGuildModule } from '../../db/modules.js';
import { ACCOUNT_SORTS, getAccount, listTransactions, transactionCount } from '../../db/economy.js';
import { clientOfGuild } from '../../platform/platformOf.js';
import {
  LIMITS,
  MAX_BALANCE,
  economySettings,
  formatMoney,
  memberPage,
  normaliseEconomyConfig,
  normaliseReason,
  refusalText,
  resetEconomy,
  staffAdjust,
} from '../../modules/economy.js';

const router = Router({ mergeParams: true });

/** Rows per page of the member list, and rows of one member's ledger shown. */
const PAGE_SIZE = 25;
const LEDGER_SHOWN = 50;
/** How many members a name search returns at most. */
const SEARCH_SHOWN = 10;
/** The staff actions the page offers; the same four as /eco. */
const ACTIONS = ['add', 'remove', 'set', 'reset-user'];

/**
 * A staff change posts to the log channel, which is a platform call, so it counts against the
 * stricter limit for dashboard actions that post (10 a minute per server and person). Without a log
 * channel nothing is posted and the ordinary limits are enough. Checked synchronously: the
 * limiter either calls next() or answers 429 at once.
 * @returns {boolean} false when it already answered 429
 */
function withinPostLimit(req, res, config) {
  if (!config.logChannelId) return true;
  let allowed = false;
  platformActionLimit(req, res, () => {
    allowed = true;
  });
  return allowed;
}

const actor = (req) => (currentUser(req)?.open ? 'Dashboard' : `${currentUser(req).name} (dashboard)`);
const fail = (res, message, status = 400) => res.status(status).json({ error: message });
const isId = (v) => /^\d{17,20}$/.test(String(v ?? ''));

/** The member behind an id as the page shows it: a name when we know one, and whether they are still here. */
function personOf(guild, tags, userId) {
  if (!userId) return null;
  const member = guild.members?.cache?.get?.(userId);
  return {
    id: userId,
    name: member?.displayName ?? tags.get(userId) ?? userId,
    inServer: Boolean(member),
  };
}

const tagsFor = (guild, ids) => resolveUserTags(clientOfGuild(guild), ids, { guild, maxFetch: 30 });

const accountView = (row) => ({
  cash: Number(row?.cash ?? 0),
  bank: Number(row?.bank ?? 0),
  total: Number(row?.cash ?? 0) + Number(row?.bank ?? 0),
  dailyStreak: Number(row?.daily_streak ?? 0),
  hasAccount: Boolean(row),
});

/** One member: balances and the newest ledger rows, with the names of the other people on them. */
async function memberDetail(guild, userId) {
  const row = await getAccount(guild.id, userId);
  const ledger = await listTransactions(guild.id, userId, LEDGER_SHOWN);
  const tags = await tagsFor(guild, [userId, ...ledger.flatMap((t) => [t.counterparty_id, t.actor_id])]);
  return {
    member: personOf(guild, tags, userId),
    account: accountView(row),
    transactionCount: await transactionCount(guild.id, userId),
    transactions: ledger.map((t) => ({
      id: Number(t.id),
      kind: t.kind,
      amount: Number(t.amount),
      cashAfter: Number(t.cash_after),
      bankAfter: Number(t.bank_after),
      counterparty: personOf(guild, tags, t.counterparty_id),
      actor: personOf(guild, tags, t.actor_id),
      reason: t.reason,
      createdAt: Number(t.created_at),
    })),
  };
}

router.get(
  '/modules/economy/config',
  asyncHandler(async (req, res) => {
    const { config: cfg } = await getGuildModule(req.guild.id, 'economy');
    res.json({
      config: normaliseEconomyConfig(cfg),
      channels: guildTextChannels(req.guild),
      roles: assignableRoles(req.guild),
      maxBalance: MAX_BALANCE,
      // Discord sends no message text without the Message Content intent, so the minimum length
      // cannot be applied there. The form says so.
      messageLengthChecked: appConfig.intentMessageContent || platformOfGuild(req.guild) === 'fluxer',
    });
  })
);

router.post(
  '/modules/economy/config',
  asyncHandler(async (req, res) => {
    const config = normaliseEconomyConfig(req.body);
    await setGuildModule(req.guild.id, 'economy', { config });
    await recordAudit(req.guild.id, {
      actor: actor(req),
      action: 'module:economy',
      detail: 'settings saved',
    });
    res.json({ config });
  })
);

// The member list. Without `q`: a page of the members who have an account, sorted by `sort`
// (total, cash or bank) in `dir` (desc or asc). With `q`: members of the server by name (the ones
// Sylo has cached) or one pasted id, with their balances, which are zero for a member without an
// account (staff can still give them money, which opens one).
router.get(
  '/modules/economy/members',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const q = String(req.query.q ?? '')
      .trim()
      .toLowerCase()
      .slice(0, 100);
    const sort = ACCOUNT_SORTS.includes(req.query.sort) ? req.query.sort : 'total';
    const dir = req.query.dir === 'asc' ? 'asc' : 'desc';

    if (q) {
      const found = [];
      if (isId(q)) {
        const m = guild.members.cache.get(q) ?? (await guild.members.fetch(q).catch(() => null));
        if (m) found.push(m);
      } else {
        for (const m of guild.members.cache.values()) {
          if (m.user?.bot) continue;
          const names = [m.displayName, m.user?.username, m.user?.tag].map((v) =>
            String(v ?? '').toLowerCase()
          );
          if (names.some((n) => n.includes(q))) found.push(m);
          if (found.length >= SEARCH_SHOWN) break;
        }
      }
      const rows = await Promise.all(
        found.map(async (m) => ({ userId: m.id, ...accountView(await getAccount(guild.id, m.id)) }))
      );
      const tags = await tagsFor(
        guild,
        rows.map((r) => r.userId)
      );
      return res.json({
        search: true,
        rows: rows.map((r) => ({ ...r, member: personOf(guild, tags, r.userId) })),
        page: 1,
        pages: 1,
        total: rows.length,
      });
    }

    const out = await memberPage(guild.id, { sort, dir, page: Number(req.query.page), perPage: PAGE_SIZE });
    const tags = await tagsFor(
      guild,
      out.rows.map((r) => r.userId)
    );
    return res.json({
      search: false,
      sort,
      dir,
      page: out.page,
      pages: out.pages,
      total: out.total,
      rows: out.rows.map((r) => ({ ...r, hasAccount: true, member: personOf(guild, tags, r.userId) })),
    });
  })
);

router.get(
  '/modules/economy/members/:userId',
  asyncHandler(async (req, res) => {
    if (!isId(req.params.userId)) return fail(res, 'Pick a member.');
    res.json(await memberDetail(req.guild, req.params.userId));
  })
);

// One staff change to one member: add, remove, set (cash) or reset-user, with a reason. The same
// four as /eco; resolves to the member's new state so the page can refresh in one round trip.
router.post(
  '/modules/economy/members/:userId/adjust',
  asyncHandler(async (req, res) => {
    const guild = req.guild;
    const userId = req.params.userId;
    if (!isId(userId)) return fail(res, 'Pick a member.');
    const { enabled, config } = await economySettings(guild.id);
    if (!enabled) return fail(res, 'Turn the Economy module on first.');

    const action = String(req.body?.action ?? '');
    if (!ACTIONS.includes(action)) return fail(res, 'Pick what to do.');
    const amount = Number(req.body?.amount);
    if (action !== 'reset-user') {
      const min = action === 'set' ? LIMITS.amount.min : 1;
      if (!Number.isSafeInteger(amount) || amount < min || amount > LIMITS.amount.max) {
        return fail(res, `Enter a whole number from ${min} to ${LIMITS.amount.max.toLocaleString('en-US')}.`);
      }
    }
    const member = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
    if (member?.user?.bot) return fail(res, 'Bots do not have an account.');
    // Members, and people who left but still have an account (so staff can clean up after them).
    // Never a new account for someone who is not in the server.
    if (!member && !(await getAccount(guild.id, userId))) {
      return fail(res, 'That person is not in this server and has no account.');
    }
    if (!withinPostLimit(req, res, config)) return undefined;

    const by = actingUserId(req, guild.id, null);
    const out = await staffAdjust({
      guildId: guild.id,
      actorId: by,
      userId,
      action,
      amount: action === 'reset-user' ? 0 : amount,
      reason: normaliseReason(req.body?.reason),
      config,
      guild,
    });
    if (!out.ok) return fail(res, refusalText(out, config));

    await recordAudit(guild.id, {
      actor: actor(req),
      action: 'economy:adjust',
      detail: action === 'reset-user' ? `reset-user for ${userId}` : `${action} ${amount} for ${userId}`,
    });
    res.json({
      applied: out.applied,
      clamped: Boolean(out.clamped),
      summary: `Now ${formatMoney(out.account.cash, config)} in cash and ${formatMoney(out.account.bank, config)} in the bank.`,
      ...(await memberDetail(guild, userId)),
    });
  })
);

// Danger zone: every account of this server goes back to a new start (cash = the starting
// balance, empty bank, no streak or cooldowns), and the ledger gets one `reset` row per account,
// so what each member had stays visible. Needs the typed word, as the page asks for it.
router.post(
  '/modules/economy/reset',
  asyncHandler(async (req, res) => {
    if (req.body?.confirm !== 'RESET') return fail(res, 'Type RESET to confirm.');
    const { config } = await economySettings(req.guild.id);
    if (!withinPostLimit(req, res, config)) return undefined;
    const out = await resetEconomy({
      guildId: req.guild.id,
      actorId: actingUserId(req, req.guild.id, null),
      config,
      guild: req.guild,
    });
    await recordAudit(req.guild.id, {
      actor: actor(req),
      action: 'economy:reset',
      detail: `reset ${out.accounts} account(s)`,
    });
    res.json({ ok: true, accounts: out.accounts });
  })
);

export default router;
