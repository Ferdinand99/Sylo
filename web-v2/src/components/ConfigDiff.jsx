import { diffSettings, formatValue, pathText } from '../configDiff.js';

/**
 * The settings that changed, one row each, with the value before and after. Shows changed fields only,
 * with a readable name where one is known and the key itself otherwise. `names` maps channel and role ids
 * to their names. Used by the audit log; a preview of an import can use it for the same job.
 *
 * Each value is labelled "Before" and "After" in words: the colours only help.
 */
export default function ConfigDiff({ before, after, names = {} }) {
  const { rows, more } = diffSettings(before, after);
  if (!rows.length) return <p className="v2-field-hint">Nothing differs.</p>;
  return (
    <div className="v2-diff">
      <ul className="v2-diff-list">
        {rows.map((row, i) => (
          <li className="v2-diff-row" key={`${row.path.join('/')}-${i}`}>
            <span className="v2-diff-path v2-break" title={row.path.join(' › ')}>
              {pathText(row.path)}
            </span>
            {row.kind === 'changed' ? (
              <>
                <DiffValue tone="before" word="Before" value={row.before} names={names} />
                <DiffValue tone="after" word="After" value={row.after} names={names} />
              </>
            ) : null}
            {row.kind === 'added' ? (
              <DiffValue tone="after" word="Added" value={row.after} names={names} />
            ) : null}
            {row.kind === 'removed' ? (
              <DiffValue tone="before" word="Removed" value={row.before} names={names} />
            ) : null}
            {row.kind === 'list' ? (
              <>
                {row.removed.length ? (
                  <DiffValue tone="before" word="Removed" value={row.removed} names={names} />
                ) : null}
                {row.added.length ? (
                  <DiffValue tone="after" word="Added" value={row.added} names={names} />
                ) : null}
              </>
            ) : null}
            {row.kind === 'hidden' ? (
              <span className="v2-diff-value is-hidden">Changed (the value is not shown)</span>
            ) : null}
          </li>
        ))}
      </ul>
      {more ? <p className="v2-field-hint">and {more} more changed.</p> : null}
    </div>
  );
}

function DiffValue({ tone, word, value, names }) {
  return (
    <span className={`v2-diff-value is-${tone}`}>
      <span className="v2-diff-word">{word}</span>
      <span className="v2-diff-text v2-break">{formatValue(value, names)}</span>
    </span>
  );
}
