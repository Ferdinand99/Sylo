// Economy storage: one account per member per server, and the append-only ledger.
//
// Money NEVER moves through this file. Every change of a balance goes through the money API
// (src/modules/lib/economy.js), which updates the account and writes the ledger row in one
// transaction. This file owns the tables and the reads: accounts, the ranking, a member's ledger,
// the retention prune, and erasing a member. The tables are created here for Postgres (SQLite
// creates them in migration 66, src/db/index.js).
//
//   economy_accounts       guild_id + user_id      cash, bank, daily_streak, last_*_at (epoch ms; 0 = never)
//   economy_transactions   id (surrogate)          kind, amount (signed), cash_after, bank_after,
//                                                  counterparty_id, actor_id, reason, created_at
//   economy_cooldowns      guild_id + user_id      the cooldown tombstone /forget leaves (see eraseMember)
//
// LOCK ORDER (the global order of every transaction that touches a member's economy rows; the money API in
// src/modules/lib/economy.js has the same text):
//   1. economy_accounts: ALL the accounts of the call, up front, one at a time in user id order (each is made
//      if missing, locked and read before the next one). No other table is touched before this.
//   2. economy_transactions: the member's ledger rows (appended; /forget locks every row naming the member
//      in id order with SELECT ... FOR UPDATE before it changes any)
//   3. inside a transaction's `after` hook: the giveaway row, the item row (economy_items), the member's
//      inventory rows, giveaway entries and prizes, temporary-role records
//   4. economy_cooldowns: written by /forget after the account, read without a lock when an account is made
// A statement outside a transaction (a sweep, a prune, a claim) holds one lock at a time. The prunes use FOR
// UPDATE SKIP LOCKED, so they never wait on a row while holding others.
//
// `guild_id` is the server key (a Discord id, or "fluxer:<id>"), like every other table, so the
// guild-leave purge and /forget find the rows. All amounts are whole numbers; BIGINT on Postgres
// (the driver reads it back as a Number: every value stays below the 1,000,000,000 cap).
import { config } from '../config.js';
import { prepare, registerPostgresBootstrap, transaction } from './driver.js';

// Postgres only: SQLite runs a transaction start to end without interleaving, so it needs no row locks.
const postgres = Boolean(config.databaseUrl);

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS economy_accounts (
    guild_id             TEXT NOT NULL,
    user_id              TEXT NOT NULL,
    cash                 BIGINT NOT NULL DEFAULT 0,
    bank                 BIGINT NOT NULL DEFAULT 0,
    daily_streak         INTEGER NOT NULL DEFAULT 0,
    last_daily_at        BIGINT NOT NULL DEFAULT 0,
    last_work_at         BIGINT NOT NULL DEFAULT 0,
    last_rob_at          BIGINT NOT NULL DEFAULT 0,
    last_robbed_at       BIGINT NOT NULL DEFAULT 0,
    last_message_earn_at BIGINT NOT NULL DEFAULT 0,
    created_at           BIGINT NOT NULL,
    updated_at           BIGINT NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_economy_accounts_total ON economy_accounts (guild_id, (cash + bank) DESC);
  CREATE TABLE IF NOT EXISTS economy_transactions (
    id              BIGSERIAL PRIMARY KEY,
    guild_id        TEXT NOT NULL,
    user_id         TEXT NOT NULL,
    kind            TEXT NOT NULL,
    amount          BIGINT NOT NULL,
    cash_after      BIGINT NOT NULL,
    bank_after      BIGINT NOT NULL,
    counterparty_id TEXT,
    actor_id        TEXT,
    reason          TEXT NOT NULL DEFAULT '',
    created_at      BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_economy_transactions_user ON economy_transactions (guild_id, user_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_economy_transactions_created ON economy_transactions (guild_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_economy_transactions_created_at ON economy_transactions (created_at);
  CREATE TABLE IF NOT EXISTS economy_cooldowns (
    guild_id      TEXT NOT NULL,
    user_id       TEXT NOT NULL,
    last_daily_at BIGINT NOT NULL DEFAULT 0,
    last_work_at  BIGINT NOT NULL DEFAULT 0,
    last_rob_at   BIGINT NOT NULL DEFAULT 0,
    expires_at    BIGINT NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_economy_cooldowns_expires ON economy_cooldowns (expires_at);
`);

/** How long ledger rows are kept. Balances are not affected by the prune. */
export const LEDGER_RETENTION_DAYS = 180;

/**
 * How long /forget keeps a member's cooldown tombstone. The longest cooldown any setting allows is
 * 168 hours (the rob cooldown; daily is 24 hours, work at most 24), so 7 days from the moment of
 * forgetting always outlasts every cooldown that was running.
 */
export const TOMBSTONE_DAYS = 7;

/** The ways the member list can be sorted, each with a fixed ORDER BY (never built from input). */
const ORDERS = {
  total: '(cash + bank)',
  cash: 'cash',
  bank: 'bank',
};
export const ACCOUNT_SORTS = Object.keys(ORDERS);

const getStmt = prepare('SELECT * FROM economy_accounts WHERE guild_id = ? AND user_id = ?');
const countStmt = prepare('SELECT COUNT(*) AS n FROM economy_accounts WHERE guild_id = ?');
const rankStmt = prepare(
  'SELECT COUNT(*) AS n FROM economy_accounts WHERE guild_id = ? AND (cash + bank) > ?'
);
// One statement per sort and direction. The user id breaks ties so a page boundary never shuffles.
const listStmts = Object.fromEntries(
  Object.entries(ORDERS).flatMap(([name, expr]) =>
    ['DESC', 'ASC'].map((dir) => [
      `${name}:${dir}`,
      prepare(
        `SELECT * FROM economy_accounts WHERE guild_id = ? ORDER BY ${expr} ${dir}, user_id ASC LIMIT ? OFFSET ?`
      ),
    ])
  )
);
const ledgerStmt = prepare(
  'SELECT * FROM economy_transactions WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT ?'
);
const ledgerCountStmt = prepare(
  'SELECT COUNT(*) AS n FROM economy_transactions WHERE guild_id = ? AND user_id = ?'
);
// SKIP LOCKED: a row an erasure (or anything else) holds is left for the next prune instead of waited for,
// so the prune never waits on a row while it holds others (a /forget locks the rows it needs in id order).
const pruneStmt = prepare(
  postgres
    ? `DELETE FROM economy_transactions WHERE id IN
         (SELECT id FROM economy_transactions WHERE created_at < ? ORDER BY id FOR UPDATE SKIP LOCKED)`
    : 'DELETE FROM economy_transactions WHERE created_at < ?'
);
// Like the ledger prune: a row somebody holds (a /forget writing its record) is left for the next run.
const pruneCooldownsStmt = prepare(
  postgres
    ? `DELETE FROM economy_cooldowns WHERE (guild_id, user_id) IN
         (SELECT guild_id, user_id FROM economy_cooldowns WHERE expires_at < ? ORDER BY guild_id, user_id FOR UPDATE SKIP LOCKED)`
    : 'DELETE FROM economy_cooldowns WHERE expires_at < ?'
);

// COUNT(*) comes back as a string from postgres.js: coerce so both drivers agree.
const num = (row) => Number(row?.n) || 0;

/** A member's account row, or null when they have none yet. */
export const getAccount = async (guildId, userId) => (await getStmt.get(guildId, userId)) ?? null;

/** How many members have an account in a server. */
export const accountCount = async (guildId) => num(await countStmt.get(guildId));

/**
 * A page of accounts. `sort` is `total` (cash + bank), `cash` or `bank`; `dir` is `desc` (richest
 * first, the default) or `asc`.
 */
export async function listAccounts(guildId, { sort = 'total', dir = 'desc', limit = 25, offset = 0 } = {}) {
  const key = `${ACCOUNT_SORTS.includes(sort) ? sort : 'total'}:${String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC'}`;
  return listStmts[key].all(guildId, Math.max(1, Math.floor(limit)), Math.max(0, Math.floor(offset)));
}

/** The leaderboard: richest first by cash + bank. */
export const topAccounts = (guildId, limit = 10, offset = 0) =>
  listAccounts(guildId, { sort: 'total', dir: 'desc', limit, offset });

/** 1-based rank by total among the accounts of a server (ties share the better rank). */
export async function rankOfTotal(guildId, total) {
  return num(await rankStmt.get(guildId, total)) + 1;
}

/** A member's newest ledger rows, newest first. */
export const listTransactions = (guildId, userId, limit = 50) =>
  ledgerStmt.all(guildId, userId, Math.max(1, Math.floor(limit)));

/** How many ledger rows a member has. */
export const transactionCount = async (guildId, userId) => num(await ledgerCountStmt.get(guildId, userId));

/**
 * Delete ledger rows (every server) older than the retention window. Balances are untouched.
 * @param {number} [now] epoch ms, overridable for tests
 * @returns {Promise<number>} rows removed
 */
export async function pruneTransactions(now = Date.now()) {
  return (await pruneStmt.run(now - LEDGER_RETENTION_DAYS * 86_400_000)).changes;
}

/**
 * Delete cooldown tombstones that have run out (called by the daily prune).
 * @param {number} [now] epoch ms, overridable for tests
 * @returns {Promise<number>} rows removed
 */
export async function pruneCooldowns(now = Date.now()) {
  return (await pruneCooldownsStmt.run(now)).changes;
}

/**
 * Erase a member (/forget): their account and their own ledger rows go; where they are named on
 * someone else's row (as the other side of a payment or robbery, or as the staff member who made
 * an adjustment) the name comes off and the row stays.
 *
 * One small record stays for {@link TOMBSTONE_DAYS} days: the server, the member id and the times of
 * their last daily, work and rob. That it exists also says the starting balance was already given.
 * Without it /forget would be a way to reset every cooldown and collect the starting balance again,
 * over and over. A new account made inside that window gets no starting balance and keeps the
 * cooldowns (see modules/lib/economy.js). The hourly prune deletes the record once it has run out.
 *
 * Everything happens in one transaction, with the account row locked first (like every money call),
 * so a payout that commits meanwhile cannot slip between the read and the delete.
 *
 * Lock order (see modules/lib/economy.js): the account, then EVERY ledger row that names the member
 * (their own, and the ones where they are the counterparty or the actor) locked together in id order,
 * and only then the changes. Two members erased at the same moment, who paid each other, would otherwise
 * each delete their own rows and then wait for rows the other one holds ("deadlock detected" in the
 * stress test); locking in id order makes one of them wait for the other instead.
 * @param {number} [now] epoch ms, overridable for tests
 */
export async function eraseMember(guildId, userId, now = Date.now()) {
  return transaction(function* (tx) {
    yield tx.run(
      'UPDATE economy_accounts SET updated_at = updated_at WHERE guild_id = ? AND user_id = ?',
      guildId,
      userId
    );
    if (postgres) {
      yield tx.run(
        `SELECT id FROM economy_transactions
         WHERE guild_id = ? AND (user_id = ? OR counterparty_id = ? OR actor_id = ?)
         ORDER BY id FOR UPDATE`,
        guildId,
        userId,
        userId,
        userId
      );
    }
    const existing = yield tx.get(
      'SELECT * FROM economy_accounts WHERE guild_id = ? AND user_id = ?',
      guildId,
      userId
    );
    if (existing) {
      yield tx.run(
        `INSERT INTO economy_cooldowns (guild_id, user_id, last_daily_at, last_work_at, last_rob_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (guild_id, user_id) DO UPDATE SET
           last_daily_at = excluded.last_daily_at,
           last_work_at  = excluded.last_work_at,
           last_rob_at   = excluded.last_rob_at,
           expires_at    = excluded.expires_at`,
        guildId,
        userId,
        Number(existing.last_daily_at),
        Number(existing.last_work_at),
        Number(existing.last_rob_at),
        now + TOMBSTONE_DAYS * 86_400_000
      );
    }
    const account = (yield tx.run(
      'DELETE FROM economy_accounts WHERE guild_id = ? AND user_id = ?',
      guildId,
      userId
    )).changes;
    const transactions = (yield tx.run(
      'DELETE FROM economy_transactions WHERE guild_id = ? AND user_id = ?',
      guildId,
      userId
    )).changes;
    const counterparty = (yield tx.run(
      'UPDATE economy_transactions SET counterparty_id = NULL WHERE guild_id = ? AND counterparty_id = ?',
      guildId,
      userId
    )).changes;
    const actor = (yield tx.run(
      'UPDATE economy_transactions SET actor_id = NULL WHERE guild_id = ? AND actor_id = ?',
      guildId,
      userId
    )).changes;
    return { account, transactions, counterparty, actor };
  });
}
