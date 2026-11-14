import '../styles/wp5-lists.css';

/**
 * The top of a list page: the title, the page's one accent "+ New …" button and the intro. On a wide
 * screen the button is at the right of the title; on a phone it sits under the intro and fills the width.
 * Pass the button (or a link styled as one) as `action`, or nothing while an editor is open. The intro
 * (any number of paragraphs) is the children.
 *
 *   <ListPageHead title="Reminders" action={<button className="v2-btn-primary" …>+ New reminder</button>}>
 *     <p className="v2-field-hint">Post a message to a channel on a schedule.</p>
 *   </ListPageHead>
 */
export default function ListPageHead({ title, action = null, children }) {
  return (
    <div className="v2-listhead">
      <h1 className="v2-section-title">{title}</h1>
      {action ? <div className="v2-listhead-action">{action}</div> : null}
      <div className="v2-listhead-intro">{children}</div>
    </div>
  );
}
