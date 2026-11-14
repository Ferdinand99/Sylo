/**
 * A simple list of what a change touches: one line per field with the value now and the value after.
 * `changes` is [{ label, before, after }] (the values are text already, long ones cut and secrets masked
 * by the server); `more` is how many changes were left out of the list.
 *
 * The history page's diff may replace this where both show "what changes"; the props are the plain data.
 */
export default function ChangeList({ changes, more = 0, label = 'Changes' }) {
  if (!changes.length) return null;
  return (
    <ul className="v2-changelist" aria-label={label}>
      {changes.map((c) => (
        <li key={c.path ?? c.label} className="v2-changelist-row">
          <span className="v2-changelist-label">{c.label}</span>
          <span className="v2-changelist-values">
            <del className="v2-changelist-before">{c.before}</del>
            <span className="v2-changelist-arrow" aria-hidden="true">
              →
            </span>
            <span className="v2-sr-only"> becomes </span>
            <ins className="v2-changelist-after">{c.after}</ins>
          </span>
        </li>
      ))}
      {more > 0 ? (
        <li className="v2-changelist-more">
          …and {more} more {more === 1 ? 'change' : 'changes'}
        </li>
      ) : null}
    </ul>
  );
}
