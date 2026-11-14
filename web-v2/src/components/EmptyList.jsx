import { Link } from 'react-router-dom';
import '../styles/wp5-lists.css';
import '../styles/p1-polish.css';

/**
 * The empty state of a list: one line that says what the list is for and what a person gets from it,
 * and the one primary button that starts it. Pass the button as `start` ({ label, onClick } for an action,
 * { label, to } for a link): it is drawn as the page's accent button, and while it is on screen the
 * header's own "+ New …" button steps aside (styles/p1-polish.css), so the page keeps one accent button.
 *
 * `action` is the older form, an element for the same place (a secondary button); use `start` for new work.
 *
 *   <EmptyList start={{ label: 'Add your first reminder', onClick: () => setCreating(true) }}>
 *     Post a message in a channel on a schedule, once or on repeat.
 *   </EmptyList>
 */
export default function EmptyList({ children, action = null, start = null }) {
  return (
    <div className={`v2-empty${start ? ' has-start' : ''}`}>
      <p className="v2-note">{children}</p>
      {start ? (
        start.to ? (
          <Link className="v2-btn-primary" to={start.to}>
            {start.label}
          </Link>
        ) : (
          <button type="button" className="v2-btn-primary" onClick={start.onClick}>
            {start.label}
          </button>
        )
      ) : (
        action
      )}
    </div>
  );
}
