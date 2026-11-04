import { Fragment } from 'react';

// Past this length a fact is more a sentence than a label ("the reason a moderator typed"), so it
// may wrap inside itself; shorter facts never break in the middle ("by harbor_master").
const LONG_FACT = 40;

// A row of short facts ("Level 3", "1,200 XP", ...) shown side by side, separated by " · ". Each
// fact stays on one line, so a narrow screen wraps between facts and never inside one. Falsy
// items are skipped, so a fact that does not apply can be passed as `cond && 'text'`. A real
// space sits between the items, so copied text and screen readers get the gap too; the dot itself
// is decoration and is hidden from screen readers.
export default function Meta({ items }) {
  const shown = items.filter((x) => x !== null && x !== undefined && x !== false && x !== '');
  return shown.map((x, i) => (
    <Fragment key={i}>
      {i > 0 ? ' ' : null}
      <span className={`v2-meta-item${typeof x === 'string' && x.length > LONG_FACT ? ' is-long' : ''}`}>
        {x}
        {i < shown.length - 1 ? (
          <span className="v2-meta-sep" aria-hidden="true">
            {' ·'}
          </span>
        ) : null}
      </span>
    </Fragment>
  ));
}

// "1 warning" / "1,284 warnings" — a number also gets its thousands separators.
export const plural = (n, one, many = `${one}s`) =>
  `${typeof n === 'number' ? n.toLocaleString() : n} ${n === 1 ? one : many}`;
