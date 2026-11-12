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
