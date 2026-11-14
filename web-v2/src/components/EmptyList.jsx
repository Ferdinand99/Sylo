import '../styles/wp5-lists.css';

/**
 * The empty state of a list: one line that says what is missing, and the same "+ New …" action as the
 * page header (pass it as a secondary button, so the page still has one accent button).
 */
export default function EmptyList({ children, action = null }) {
  return (
    <div className="v2-empty">
      <p className="v2-note">{children}</p>
      {action}
    </div>
  );
}
