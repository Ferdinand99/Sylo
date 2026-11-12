// Splits a block of SQL into its statements, for the Postgres bootstrap (db/driver.js).
//
// Why: a text with several statements sent in ONE query runs as one implicit transaction, so every lock
// a statement takes is kept until the last one finished. The bootstrap is full of `ALTER TABLE ... ADD
// COLUMN IF NOT EXISTS` (an ACCESS EXCLUSIVE lock even when the column is there) and `CREATE INDEX IF NOT
// EXISTS` (a SHARE lock even when the index is there). A process that booted late, while another process
// was already writing to the same tables, held the lock of its ALTER while its CREATE INDEX waited for
// the other process's write, and the other process then waited for the ALTER: "deadlock detected".
// One statement per query holds one lock at a time and never waits while holding another.
//
// It understands what the bootstrap texts use: `--` and block comments, '...' strings (with ''),
// "..." names and $tag$...$tag$ bodies. A `;` anywhere else ends a statement.

/** The statement without the comments in front of it (what the checks below look at). */
const stripLeadingComments = (statement) =>
  statement.replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, '');

/**
 * What a bootstrap statement would add, if it is one of the two idempotent forms that still take a heavy
 * lock when there is nothing to do: `ALTER TABLE t ADD COLUMN IF NOT EXISTS c ...` (ACCESS EXCLUSIVE) and
 * `CREATE [UNIQUE] INDEX IF NOT EXISTS i ON t ...` (SHARE, which also holds up every writer behind it). The
 * driver looks the thing up in the catalog first and skips the statement when it is already there, so
 * a normal start-up takes no table lock at all.
 * @param {string} statement
 * @returns {{ kind: 'column', table: string, column: string } | { kind: 'index', name: string } | null}
 */
export function idempotentTarget(statement) {
  const text = stripLeadingComments(statement);
  const column =
    /^ALTER\s+TABLE\s+(?:ONLY\s+)?"?(\w+)"?\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+"?(\w+)"?/i.exec(text);
  // only a statement that adds exactly one column can be skipped on one column's say-so
  if (column && (text.match(/\bADD\s+COLUMN\b/gi) ?? []).length === 1) {
    return { kind: 'column', table: column[1], column: column[2] };
  }
  const index = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+"?(\w+)"?/i.exec(text);
  if (index) return { kind: 'index', name: index[1] };
  return null;
}

/**
 * @param {string} text
 * @returns {string[]} the statements, trimmed, without empty ones and without comment-only ones
 */
export function splitStatements(text) {
  const out = [];
  let current = '';
  let hasCode = false; // the statement being built has something that is not a comment or space
  const push = () => {
    if (hasCode) out.push(current.trim());
    current = '';
    hasCode = false;
  };
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '-' && next === '-') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      current += text.slice(i, stop);
      i = stop;
    } else if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      current += text.slice(i, stop);
      i = stop;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n) {
        if (text[j] === c) {
          if (text[j + 1] === c)
            j += 2; // a doubled quote is a quote inside
          else break;
        } else j += 1;
      }
      current += text.slice(i, j + 1);
      hasCode = true;
      i = j + 1;
    } else if (c === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(text.slice(i, i + 64));
      if (tag) {
        const end = text.indexOf(tag[0], i + tag[0].length);
        const stop = end === -1 ? n : end + tag[0].length;
        current += text.slice(i, stop);
        hasCode = true;
        i = stop;
      } else {
        current += c;
        hasCode = true;
        i += 1;
      }
    } else if (c === ';') {
      push();
      i += 1;
    } else {
      current += c;
      if (!/\s/.test(c)) hasCode = true;
      i += 1;
    }
  }
  push();
  return out;
}
