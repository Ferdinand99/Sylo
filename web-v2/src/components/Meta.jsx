import { Fragment } from 'react';

// A row of short facts ("Level 3", "1,200 XP", ...) shown side by side with
// space between them instead of a separator character. Falsy items are skipped,
// so a fact that does not apply can be passed as `cond && 'text'`. A real space
// sits between the items, so copied text and screen readers get the gap too.
export default function Meta({ items }) {
  return items
    .filter((x) => x !== null && x !== undefined && x !== false && x !== '')
    .map((x, i) => (
      <Fragment key={i}>
        {i > 0 ? ' ' : null}
        <span className="v2-meta-item">{x}</span>
      </Fragment>
    ));
}

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
