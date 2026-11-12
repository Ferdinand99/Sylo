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
//
// `guild_id` is the server key (a Discord id, or "fluxer:<id>"), like every other table, so the
// guild-leave purge and /forget find the rows. All amounts are whole numbers; BIGINT on Postgres
// (the driver reads it back as a Number: every value stays below the 1,000,000,000 cap).
import { prepare, registerPostgresBootstrap } from './driver.js';

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
`);

/** How long ledger rows are kept. Balances are not affected by the prune. */
export const LEDGER_RETENTION_DAYS = 180;

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
const pruneStmt = prepare('DELETE FROM economy_transactions WHERE created_at < ?');

const forget = {
  account: prepare('DELETE FROM economy_accounts WHERE guild_id = ? AND user_id = ?'),
  ledger: prepare('DELETE FROM economy_transactions WHERE guild_id = ? AND user_id = ?'),
  counterparty: prepare(
    'UPDATE economy_transactions SET counterparty_id = NULL WHERE guild_id = ? AND counterparty_id = ?'
  ),
  actor: prepare('UPDATE economy_transactions SET actor_id = NULL WHERE guild_id = ? AND actor_id = ?'),
};

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
 * Erase a member (/forget): their account and their own ledger rows go; where they are named on
 * someone else's row (as the other side of a payment or robbery, or as the staff member who made
 * an adjustment) the name comes off and the row stays.
 */
export async function eraseMember(guildId, userId) {
  const account = (await forget.account.run(guildId, userId)).changes;
  const transactions = (await forget.ledger.run(guildId, userId)).changes;
  const counterparty = (await forget.counterparty.run(guildId, userId)).changes;
  const actor = (await forget.actor.run(guildId, userId)).changes;
  return { account, transactions, counterparty, actor };
}
