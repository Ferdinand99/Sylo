// The money API of the Economy module: the ONLY place a balance changes.
//
// Every call runs in one database transaction that updates the accounts and appends one ledger row
// (economy_transactions) per change, so a balance and its history never disagree. Code that wants
// to move money (the commands, the dashboard, part B's shop) calls a function here; nothing else
// writes to economy_accounts balances.
//
//   credit / debit / transfer / deposit / withdraw / setBalance / resetAccount / resetGuild
//   transact   the general form the others are built on: lock some accounts, look at them, decide
//              what to change. Use it when a rule has to be checked against the locked balances
//              (a cooldown, "the victim must hold at least X"), and to add to the same
//              transaction (`after`).
//
// Rules, enforced here and nowhere else:
//   - amounts are whole numbers; cash and bank never go below 0
//   - cash + bank never goes above MAX_BALANCE (a credit that would is cut to fit when it is
//     marked `clamp`, otherwise refused)
//   - one transaction per call; accounts are locked in a fixed order (by user id), so two payments
//     between the same members in opposite directions cannot deadlock
//   - concurrent calls on the same account never lose an update (SQLite: a transaction runs start to
//     end without returning to the event loop, so nothing interleaves; Postgres: the row lock; see
//     db/driver.js `transaction`, whose body is a generator for that reason)
//
// Ledger rows: `amount` is the change of cash + bank, signed. The exceptions are `deposit` and
// `withdraw`, where cash + bank does not change: their amount is the size of the move (positive).
// `cash_after` and `bank_after` are the balances right after that change.
//
// Every function resolves to `{ ok: true, ... }` or `{ ok: false, reason, ... }`. A refusal changes
// no balance and writes no ledger row. It never throws for a rule (only for a database failure).
import '../../db/economy.js';
import { isGeneratorFunction, prepare, transaction } from '../../db/driver.js';
import { getGuildModule } from '../../db/modules.js';
import { LIMITS, MAX_BALANCE, normaliseEconomyConfig } from './economyConfig.js';

/** The kinds of ledger row part A writes. Part B adds its own with {@link registerKind}. */
export const KINDS = new Set([
  'start', // a new account's starting balance
  'message',
  'voice',
  'daily',
  'work',
  'pay_out',
  'pay_in',
  'tax',
  'rob_win',
  'rob_loss',
  'rob_fine_out',
  'rob_fine_in',
  'deposit',
  'withdraw',
  'staff_add',
  'staff_remove',
  'staff_set',
  'reset',
  // part B: the shop and giveaways
  'purchase', // a member bought an item (negative amount)
  'refund', // money given back: a failed grant, a refunded purchase, a giveaway entry taken back
  'grant', // an item given for free (amount 0: only records that it happened)
  'revoke', // an item taken away by staff (amount 0)
  'giveaway_entry', // the entry fee of a giveaway (negative amount)
  'giveaway_prize', // a currency prize of a giveaway (positive amount)
]);

/** Add a ledger kind (part B: purchases, refunds, ...). */
export function registerKind(kind) {
  if (!/^[a-z][a-z_]{0,31}$/.test(kind)) throw new Error(`bad ledger kind "${kind}"`);
  KINDS.add(kind);
}

/** The account columns a plan may stamp (cooldowns and the streak). */
const STAMP_COLUMNS = new Set([
  'daily_streak',
  'last_daily_at',
  'last_work_at',
  'last_rob_at',
  'last_robbed_at',
  'last_message_earn_at',
]);

/** Thrown inside a transaction to roll it back with a reason; never leaves this file. */
class Refusal extends Error {
  constructor(reason, extra = {}) {
    super(reason);
    this.reason = reason;
    this.extra = extra;
  }
}

const isWhole = (n) => Number.isSafeInteger(n);

/** An account row as the plan sees it (a copy: changing it changes nothing). */
const view = (row) => ({
  cash: Number(row.cash),
  bank: Number(row.bank),
  total: Number(row.cash) + Number(row.bank),
  dailyStreak: Number(row.daily_streak),
  lastDailyAt: Number(row.last_daily_at),
  lastWorkAt: Number(row.last_work_at),
  lastRobAt: Number(row.last_rob_at),
  lastRobbedAt: Number(row.last_robbed_at),
  lastMessageEarnAt: Number(row.last_message_earn_at),
  createdAt: Number(row.created_at),
});

const LEDGER_INSERT = `
  INSERT INTO economy_transactions
    (guild_id, user_id, kind, amount, cash_after, bank_after, counterparty_id, actor_id, reason, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

/**
 * Create the missing accounts (with the starting balance, written to the ledger as `start`),
 * then take every row lock in user id order. Returns the accounts as the plan sees them.
 */
function* openAccounts(tx, guildId, userIds, config, now, create) {
  const given = [];
  // Insert the accounts that do not exist yet; the ones that got a starting balance are noted.
  const insertMissing = function* (ids) {
    for (const userId of ids) {
      // A member who ran /forget a short while ago has a cooldown tombstone: the new account keeps
      // their cooldowns and gets no starting balance again (see eraseMember in db/economy.js).
      const tomb = yield tx.get(
        'SELECT * FROM economy_cooldowns WHERE guild_id = ? AND user_id = ? AND expires_at > ?',
        guildId,
        userId,
        now
      );
      const start = tomb ? 0 : config.startingBalance;
      const { changes } = yield tx.run(
        `INSERT INTO economy_accounts
           (guild_id, user_id, cash, bank, last_daily_at, last_work_at, last_rob_at, created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)
         ON CONFLICT (guild_id, user_id) DO NOTHING`,
        guildId,
        userId,
        start,
        Number(tomb?.last_daily_at ?? 0),
        Number(tomb?.last_work_at ?? 0),
        Number(tomb?.last_rob_at ?? 0),
        now,
        now
      );
      if (changes === 1 && start > 0) given.push(userId);
    }
  };
  const accounts = new Map();
  // Lock the rows, then read them. A plain UPDATE takes the row lock on Postgres; on SQLite
  // BEGIN IMMEDIATE already holds the database. Done for every account before any is read, in
  // the same order everywhere.
  const lockAndRead = function* (ids) {
    for (const userId of ids) {
      yield tx.run(
        'UPDATE economy_accounts SET updated_at = updated_at WHERE guild_id = ? AND user_id = ?',
        guildId,
        userId
      );
    }
    for (const userId of ids) {
      const row = yield tx.get(
        'SELECT * FROM economy_accounts WHERE guild_id = ? AND user_id = ?',
        guildId,
        userId
      );
      // Without `create`, an account that does not exist (erased by /forget a moment ago) is simply
      // not part of the call.
      if (row) accounts.set(userId, row);
    }
  };
  if (create) yield* insertMissing(userIds);
  yield* lockAndRead(userIds);
  // On Postgres a /forget can commit between the insert (which found the row and did nothing) and
  // the lock. The account is then gone: make it again (the tombstone is in place, so no second
  // starting balance) and lock it. A few rounds are plenty; every round needs a new /forget.
  for (let round = 0; create && round < 3; round++) {
    const missing = userIds.filter((id) => !accounts.has(id));
    if (missing.length === 0) break;
    yield* insertMissing(missing);
    yield* lockAndRead(missing);
  }
  if (create && userIds.some((id) => !accounts.has(id))) throw new Error('an economy account kept vanishing');
  for (const userId of given) {
    yield tx.insertId(
      LEDGER_INSERT,
      guildId,
      userId,
      'start',
      config.startingBalance,
      config.startingBalance,
      0,
      null,
      null,
      'Starting balance',
      now
    );
  }
  return accounts;
}

/** The ledger `amount` of one change (see the header). */
function ledgerAmount(kind, cashDelta, bankDelta) {
  if (kind === 'deposit' || kind === 'withdraw') return Math.abs(cashDelta);
  return cashDelta + bankDelta;
}

/**
 * Apply one change to the working balances and write its ledger row. Throws a Refusal when it
 * would break a rule, which rolls the whole transaction back.
 */
function* applyChange(tx, guildId, balances, change, now, ledger) {
  const { userId, kind } = change;
  if (!KINDS.has(kind)) throw new Error(`unknown ledger kind "${kind}"`);
  const bal = balances.get(userId);
  let cashDelta = change.cash ?? 0;
  const bankDelta = change.bank ?? 0;
  if (!isWhole(cashDelta) || !isWhole(bankDelta)) throw new Refusal('invalid_amount');

  if (change.clamp && cashDelta + bankDelta > 0) {
    // Credits are cut to fit under the cap instead of refused.
    const room = Math.max(0, MAX_BALANCE - (bal.cash + bal.bank));
    cashDelta = Math.min(cashDelta, room - bankDelta);
  }
  const noChange = cashDelta === 0 && bankDelta === 0;
  // A change with nothing to move writes no row, unless it asks to be recorded (`record: true`: a
  // `grant` or `revoke`, which are events with an amount of 0).
  if (noChange && !change.record) return { userId, kind, applied: 0, clamped: Boolean(change.clamp) };

  const cash = bal.cash + cashDelta;
  const bank = bal.bank + bankDelta;
  if (cash < 0 || bank < 0) throw new Refusal('insufficient', { userId });
  if (cashDelta + bankDelta > 0 && cash + bank > MAX_BALANCE) throw new Refusal('cap', { userId });

  if (!noChange) {
    const moved = yield tx.run(
      `UPDATE economy_accounts SET cash = ?, bank = ?, updated_at = ?
       WHERE guild_id = ? AND user_id = ? AND cash = ? AND bank = ?`,
      cash,
      bank,
      now,
      guildId,
      userId,
      bal.cash,
      bal.bank
    );
    // Cannot happen under the lock; if it ever did, roll back rather than lose an update.
    if (moved.changes !== 1) throw new Refusal('conflict', { userId });
  }
  bal.cash = cash;
  bal.bank = bank;

  const amount = ledgerAmount(kind, cashDelta, bankDelta);
  const reason = String(change.reason ?? '').slice(0, LIMITS.reason.maxLength);
  const id = yield tx.insertId(
    LEDGER_INSERT,
    guildId,
    userId,
    kind,
    amount,
    cash,
    bank,
    change.counterpartyId ?? null,
    change.actorId ?? null,
    reason,
    now
  );
  const row = {
    id,
    userId,
    kind,
    amount,
    cashAfter: cash,
    bankAfter: bank,
    counterpartyId: change.counterpartyId ?? null,
    actorId: change.actorId ?? null,
    reason,
    createdAt: now,
  };
  ledger.push(row);
  return {
    userId,
    kind,
    applied: amount,
    cashDelta,
    bankDelta,
    clamped: Boolean(change.clamp) && cashDelta !== (change.cash ?? 0),
  };
}

/**
 * Lock accounts, let `plan` decide, apply its changes, all in one transaction.
 *
 * `plan(accounts)` runs inside the transaction on the locked balances, and must be a plain
 * synchronous function (no I/O). `accounts` maps user id to `{ cash, bank, total, dailyStreak,
 * lastDailyAt, lastWorkAt, lastRobAt, lastRobbedAt, lastMessageEarnAt, createdAt }`. It returns
 *   { refuse: { reason, ...details } }                    to change nothing, or
 *   { changes: [...], stamps?: {...}, result?: {...} }    to apply:
 *     change  { userId, kind, cash?, bank?, counterpartyId?, actorId?, reason?, clamp? }
 *             `cash` / `bank` are signed deltas; `clamp` cuts a credit to fit under the cap
 *     stamps  { [userId]: { last_work_at: 123, daily_streak: 4, ... } }  (cooldown columns only)
 *     result  anything; handed back as `result`
 *
 * @param {string} guildId  the server key
 * @param {string[]} userIds  every account the plan reads or changes
 * @param {(accounts: Map<string, any>) => { refuse?: object, changes?: object[], stamps?: object, result?: any }} plan
 * @param {{ now?: number, config?: object, createMissing?: boolean, after?: (tx: any, outcome: object) => Generator }} [opts]
 *   `createMissing: false` leaves an account that does not exist out of the call (the plan sees only
 *   the accounts that exist) instead of opening it; `resetGuild` uses it so a member who just ran
 *   /forget is not re-created.
 *   `after` runs inside the same transaction once the changes are applied (part B inserts the
 *   inventory row of a purchase there); a throw rolls the money back too. It is a generator
 *   function (anything else throws a TypeError before the transaction starts), like the body of
 *   `transaction()` in db/driver.js: `function* (tx, outcome) { yield tx.run(...); }`. It must only
 *   `yield` results of `tx`: it must not await, run a prepare() statement (that throws) or call
 *   another money function.
 * @returns {Promise<{ ok: true, ledger: object[], applied: object[], accounts: Map<string, any>, result?: any } | { ok: false, reason: string, accounts?: Map<string, any> }>}
 */
export async function transact(guildId, userIds, plan, opts = {}) {
  if (opts.after !== undefined && !isGeneratorFunction(opts.after)) {
    throw new TypeError(
      'transact(): `after` must be a generator function, function* (tx, outcome) { yield tx.run(...) }'
    );
  }
  // A reset of this server is running: money calls start after it (it holds the guild).
  if (!opts.insideReset) await waitForReset(guildId);
  const now = opts.now ?? Date.now();
  const config = await settingsFor(guildId, opts.config);
  const ids = [...new Set(userIds)].sort();
  try {
    return await transaction(function* (tx) {
      const rows = yield* openAccounts(tx, guildId, ids, config, now, opts.createMissing !== false);
      const before = new Map([...rows].map(([id, row]) => [id, view(row)]));
      const decision = plan(before);
      // A refusal rolls the transaction back, so it leaves nothing behind, not even the empty
      // accounts it opened (a refused /pay must not create an account for the recipient).
      if (decision?.refuse)
        throw new Refusal(decision.refuse.reason, { ...decision.refuse, accounts: before });

      const balances = new Map([...before].map(([id, v]) => [id, { cash: v.cash, bank: v.bank }]));
      for (const [userId, stamps] of Object.entries(decision?.stamps ?? {})) {
        const cols = Object.keys(stamps);
        if (cols.some((c) => !STAMP_COLUMNS.has(c))) throw new Error('bad stamp column');
        if (!cols.length) continue;
        yield tx.run(
          `UPDATE economy_accounts SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE guild_id = ? AND user_id = ?`,
          ...cols.map((c) => stamps[c]),
          now,
          guildId,
          userId
        );
      }
      const ledger = [];
      const applied = [];
      for (const change of decision?.changes ?? []) {
        applied.push(yield* applyChange(tx, guildId, balances, change, now, ledger));
      }
      const after = new Map(
        [...balances].map(([id, b]) => [
          id,
          { ...before.get(id), cash: b.cash, bank: b.bank, total: b.cash + b.bank },
        ])
      );
      const outcome = { ok: true, ledger, applied, accounts: after, result: decision?.result };
      if (opts.after) yield* opts.after(tx, outcome);
      return outcome;
    });
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, reason: err.reason, ...err.extra };
    throw err;
  }
}

/**
 * Stop a transaction from inside an `after` hook: everything done so far in it is rolled back and
 * the money call resolves to `{ ok: false, reason, ...extra }`. For a rule the hook has to check on
 * rows it reads itself (stock, a purchase limit).
 * @param {string} reason
 * @param {object} [extra]
 * @returns {never}
 */
export function abort(reason, extra = {}) {
  throw new Refusal(reason, extra);
}

/** The settings a call works with: the ones the caller passed (normalised again, so a partial object is safe) or the server's. */
async function settingsFor(guildId, given) {
  return normaliseEconomyConfig(given ?? (await getGuildModule(guildId, 'economy')).config);
}

const refuse = (reason, extra) => ({ ok: false, reason, ...extra });
const positive = (n) => isWhole(n) && n >= 1 && n <= MAX_BALANCE;
const meta = (opts) => ({
  actorId: opts.actorId ?? null,
  counterpartyId: opts.counterpartyId ?? null,
  reason: opts.reason ?? '',
});

/**
 * Add money to a member's cash. A credit that would pass the cap is cut to fit (`clamped`), and
 * one that fits not at all changes nothing (`applied` 0, no ledger row).
 * @param {string} guildId
 * @param {string} userId
 * @param {number} amount  whole number, at least 1
 * @param {{ kind: string, actorId?: string, counterpartyId?: string, reason?: string, now?: number, config?: object, after?: Function }} opts
 * @returns {Promise<{ ok: true, applied: number, clamped: boolean, account: object, ledger: object[] } | { ok: false, reason: string }>}
 */
export async function credit(guildId, userId, amount, opts) {
  if (!positive(amount)) return refuse('invalid_amount');
  const out = await transact(
    guildId,
    [userId],
    () => ({ changes: [{ userId, cash: amount, clamp: true, kind: opts.kind, ...meta(opts) }] }),
    opts
  );
  if (!out.ok) return out;
  const applied = out.applied[0]?.applied ?? 0;
  return {
    ok: true,
    applied,
    clamped: applied < amount,
    account: out.accounts.get(userId),
    ledger: out.ledger,
  };
}

/**
 * Take money from a member. `from: 'cash'` (default) takes cash only; `'cash-then-bank'` takes
 * cash first and the rest from the bank (staff and the shop). Refused as `insufficient` when the
 * member has less than `amount` in those places.
 * @returns {Promise<{ ok: true, applied: number, account: object, ledger: object[] } | { ok: false, reason: string, account?: object }>}
 */
export async function debit(guildId, userId, amount, opts) {
  if (!positive(amount)) return refuse('invalid_amount');
  const out = await transact(
    guildId,
    [userId],
    (accounts) => {
      const acc = accounts.get(userId);
      const available = opts.from === 'cash-then-bank' ? acc.total : acc.cash;
      if (amount > available) return { refuse: { reason: 'insufficient', account: acc } };
      const fromCash = Math.min(amount, acc.cash);
      const fromBank = amount - fromCash;
      return { changes: [{ userId, cash: -fromCash, bank: -fromBank, kind: opts.kind, ...meta(opts) }] };
    },
    opts
  );
  if (!out.ok) return { ok: false, reason: out.reason, account: out.accounts?.get(userId) };
  return {
    ok: true,
    applied: out.applied[0].applied,
    account: out.accounts.get(userId),
    ledger: out.ledger,
  };
}

/**
 * Move `amount` of cash from one member to another, optionally charging the sender `tax` on top
 * (burned: it goes to nobody). The recipient gets exactly `amount`. Three ledger rows at most:
 * the sender's `pay_out`, the sender's `tax`, the recipient's `pay_in`. Refused as `self`,
 * `insufficient` (the sender lacks amount + tax) or `recipient_cap` (it would not fit under the
 * recipient's cap).
 * @param {{ tax?: number, kinds?: { out: string, in: string, tax: string }, actorId?: string, reason?: string, now?: number, config?: object, after?: Function }} [opts]
 */
export async function transfer(guildId, fromId, toId, amount, opts = {}) {
  if (!positive(amount)) return refuse('invalid_amount');
  const tax = opts.tax ?? 0;
  if (!isWhole(tax) || tax < 0) return refuse('invalid_amount');
  if (fromId === toId) return refuse('self');
  const kinds = opts.kinds ?? { out: 'pay_out', in: 'pay_in', tax: 'tax' };
  const out = await transact(
    guildId,
    [fromId, toId],
    (accounts) => {
      const from = accounts.get(fromId);
      const to = accounts.get(toId);
      if (from.cash < amount + tax)
        return { refuse: { reason: 'insufficient', account: from, needed: amount + tax } };
      if (to.total + amount > MAX_BALANCE) return { refuse: { reason: 'recipient_cap', account: to } };
      const m = { reason: opts.reason ?? '', actorId: opts.actorId ?? null };
      return {
        changes: [
          { userId: fromId, cash: -amount, kind: kinds.out, counterpartyId: toId, ...m },
          ...(tax > 0 ? [{ userId: fromId, cash: -tax, kind: kinds.tax, counterpartyId: toId, ...m }] : []),
          { userId: toId, cash: amount, kind: kinds.in, counterpartyId: fromId, ...m },
        ],
      };
    },
    opts
  );
  if (!out.ok) return out;
  return {
    ok: true,
    amount,
    tax,
    from: out.accounts.get(fromId),
    to: out.accounts.get(toId),
    ledger: out.ledger,
  };
}

/** Move cash into the bank. `amount` is a number or `'all'`. Refused: `nothing`, `insufficient`, `bank_cap` never (total is unchanged). */
export async function deposit(guildId, userId, amount, opts = {}) {
  return moveBetweenPurses(guildId, userId, amount, 'deposit', opts);
}

/** Move bank money back to cash. `amount` is a number or `'all'`. */
export async function withdraw(guildId, userId, amount, opts = {}) {
  return moveBetweenPurses(guildId, userId, amount, 'withdraw', opts);
}

async function moveBetweenPurses(guildId, userId, amount, kind, opts) {
  if (amount !== 'all' && !positive(amount)) return refuse('invalid_amount');
  const out = await transact(
    guildId,
    [userId],
    (accounts) => {
      const acc = accounts.get(userId);
      const have = kind === 'deposit' ? acc.cash : acc.bank;
      const moved = amount === 'all' ? have : amount;
      if (moved < 1) return { refuse: { reason: 'nothing', account: acc } };
      if (moved > have) return { refuse: { reason: 'insufficient', account: acc } };
      const sign = kind === 'deposit' ? -1 : 1;
      return {
        changes: [{ userId, cash: sign * moved, bank: -sign * moved, kind, ...meta(opts) }],
        result: { moved },
      };
    },
    opts
  );
  if (!out.ok) return { ok: false, reason: out.reason, account: out.accounts?.get(userId) };
  return { ok: true, moved: out.result.moved, account: out.accounts.get(userId), ledger: out.ledger };
}

/**
 * Set a member's cash to an exact amount (staff). The bank is left alone. Refused as `cap` when
 * cash + bank would pass the cap.
 */
export async function setBalance(guildId, userId, cash, opts = {}) {
  if (!isWhole(cash) || cash < 0 || cash > MAX_BALANCE) return refuse('invalid_amount');
  const out = await transact(
    guildId,
    [userId],
    (accounts) => {
      const acc = accounts.get(userId);
      if (cash + acc.bank > MAX_BALANCE) return { refuse: { reason: 'cap', account: acc } };
      return { changes: [{ userId, cash: cash - acc.cash, kind: opts.kind ?? 'staff_set', ...meta(opts) }] };
    },
    opts
  );
  if (!out.ok) return { ok: false, reason: out.reason, account: out.accounts?.get(userId) };
  return { ok: true, account: out.accounts.get(userId), ledger: out.ledger };
}

const ZERO_STAMPS = {
  daily_streak: 0,
  last_daily_at: 0,
  last_work_at: 0,
  last_rob_at: 0,
  last_robbed_at: 0,
  last_message_earn_at: 0,
};

/**
 * Start a member over: cash back to the starting balance, bank empty, streak and cooldowns
 * cleared. One `reset` ledger row (amount = the change of cash + bank).
 */
export async function resetAccount(guildId, userId, opts = {}) {
  const config = await settingsFor(guildId, opts.config);
  const out = await transact(
    guildId,
    [userId],
    (accounts) => {
      const acc = accounts.get(userId);
      return {
        stamps: { [userId]: ZERO_STAMPS },
        changes: [
          { userId, cash: config.startingBalance - acc.cash, bank: -acc.bank, kind: 'reset', ...meta(opts) },
        ],
        result: { before: acc },
      };
    },
    { ...opts, config }
  );
  if (!out.ok) return out;
  return { ok: true, before: out.result.before, account: out.accounts.get(userId), ledger: out.ledger };
}

/** How many accounts one transaction of {@link resetGuild} handles. */
const RESET_CHUNK = 200;
const listIdsStmt = prepare('SELECT user_id FROM economy_accounts WHERE guild_id = ? ORDER BY user_id');

// Servers with a reset running: guild key -> a promise that settles when it ends. Money calls for
// that server wait for it (transact), a second reset of the same server queues behind it. One
// process runs the bot, so this in-memory hold is enough; the row locks still guard every account.
const resetsRunning = new Map();

async function waitForReset(guildId) {
  while (resetsRunning.has(guildId)) await resetsRunning.get(guildId);
}

/**
 * Reset every account of a server to a fresh one (see {@link resetAccount}). The server is held for
 * the duration: money calls for it start after the reset ends. The accounts that exist when it starts
 * are reset in chunks of 200, one transaction per chunk, each through the same locking as every
 * other money call (user id order, so it cannot deadlock with a payment). Each account that held
 * anything gets one `reset` ledger row (amount = the change of cash + bank); an account that was
 * already fresh has nothing to record. An account that disappears meanwhile (a member ran /forget)
 * is skipped, never re-created.
 *
 * It does not throw for a failing chunk: it stops there and says how far it got, so the caller can
 * still audit and log it. Run it again to finish: the accounts already reset have nothing left to
 * change.
 * @param {string} guildId
 * @param {{ actorId?: string | null, reason?: string, now?: number, config?: object,
 *   beforeChunk?: (index: number) => unknown }} [opts]  `beforeChunk` is a seam for tests: it runs
 *   before each chunk (a throw there fails that chunk like a database error would)
 * @returns {Promise<{ ok: boolean, accounts: number, total: number, error?: string }>}
 *   `accounts` were reset out of `total` listed
 */
export async function resetGuild(guildId, opts = {}) {
  while (resetsRunning.has(guildId)) await resetsRunning.get(guildId);
  let release;
  resetsRunning.set(
    guildId,
    new Promise((resolve) => {
      release = resolve;
    })
  );
  try {
    const config = await settingsFor(guildId, opts.config);
    const reason = String(opts.reason ?? 'Economy reset').slice(0, LIMITS.reason.maxLength);
    const ids = (await listIdsStmt.all(guildId)).map((r) => r.user_id);
    let done = 0;
    for (let at = 0; at < ids.length; at += RESET_CHUNK) {
      const chunk = ids.slice(at, at + RESET_CHUNK);
      try {
        await opts.beforeChunk?.(at / RESET_CHUNK);
        const out = await transact(
          guildId,
          chunk,
          (accounts) => {
            const present = [...accounts.keys()];
            return {
              stamps: Object.fromEntries(present.map((id) => [id, ZERO_STAMPS])),
              changes: present.map((userId) => {
                const acc = accounts.get(userId);
                return {
                  userId,
                  kind: 'reset',
                  cash: config.startingBalance - acc.cash,
                  bank: -acc.bank,
                  actorId: opts.actorId ?? null,
                  reason,
                };
              }),
            };
          },
          { now: opts.now, config, createMissing: false, insideReset: true }
        );
        if (!out.ok) return { ok: false, accounts: done, total: ids.length, error: `refused: ${out.reason}` };
        done += out.accounts.size;
      } catch (err) {
        return { ok: false, accounts: done, total: ids.length, error: err?.message ?? String(err) };
      }
    }
    return { ok: true, accounts: done, total: ids.length };
  } finally {
    resetsRunning.delete(guildId);
    release();
  }
}
