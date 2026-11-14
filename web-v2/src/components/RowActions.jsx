import { Link } from 'react-router-dom';
import OverflowMenu from './OverflowMenu.jsx';
import '../styles/wp5-lists.css';

/**
 * The actions of one list row: the most used one (Edit) as a button, and the rest (Pause, Unpublish,
 * Delete …) in a "⋯" menu, so the row never wraps on a phone. The same pattern as the shop's rows.
 *
 *   <RowActions
 *     edit={{ onClick: () => setEditingId(r.id) }}          // or { to: '/guilds/1/messages/7' } for a link
 *     menuLabel={`More actions for ${r.name}`}
 *     items={[{ label: 'Pause', onClick }, { label: 'Delete', danger: true, onClick }]}
 *   />
 *
 * `edit` may carry a `label` (default "Edit") and `disabled`. A destructive item still asks for its own
 * confirmation in its onClick; the menu only picks the action. Without `items` there is no "⋯".
 */
export default function RowActions({ edit, menuLabel, items = [] }) {
  return (
    <div className="v2-row-actions v2-row-actions-menu">
      {edit?.to ? (
        <Link className="v2-btn-ghost" to={edit.to}>
          {edit.label ?? 'Edit'}
        </Link>
      ) : edit ? (
        <button type="button" className="v2-btn-ghost" disabled={edit.disabled} onClick={edit.onClick}>
          {edit.label ?? 'Edit'}
        </button>
      ) : null}
      {items.length ? <OverflowMenu label={menuLabel} items={items} /> : null}
    </div>
  );
}
