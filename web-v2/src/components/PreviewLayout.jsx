import { Children, Fragment, isValidElement, useState, useSyncExternalStore } from 'react';
import MessagePreview from './MessagePreview.jsx';

// Wide enough for the form and a preview column side by side.
const WIDE_QUERY = '(min-width: 1180px)';
// Where matchMedia does not exist (a test environment) the layout is the narrow one.
const query = () => (typeof window.matchMedia === 'function' ? window.matchMedia(WIDE_QUERY) : null);
function subscribe(onChange) {
  const mq = query();
  mq?.addEventListener('change', onChange);
  return () => mq?.removeEventListener('change', onChange);
}
const isWide = () => Boolean(query()?.matches);

/** The children as a flat list: a single fragment (a form's whole page) is opened up. */
function flatten(children) {
  const list = Children.toArray(children);
  if (list.length === 1 && isValidElement(list[0]) && list[0].type === Fragment) {
    return Children.toArray(list[0].props.children);
  }
  return list;
}

/**
 * A form page with a live preview of the messages it sets. On a wide screen the previews sit in the right
 * column and stay in view while the form scrolls; on a phone or a narrow window a "Show preview" button
 * after the page's introduction folds them away, so the form keeps the whole width.
 *
 *   <PreviewLayout previews={[{ key: 'join', title: 'Welcome message', content: form.joinMessage }]}
 *     lookup={{ channels: data.channels, roles: data.roles }}>
 *     …the form…
 *   </PreviewLayout>
 *
 * A preview is { key, title, content?, embed?, note?, samples?, hidden? } (`hidden` leaves it out, e.g.
 * while its switch is off). The form always sits under the same two elements, whatever the previews and
 * the window width do, so it is never remounted: the field a person is typing in keeps its focus and its
 * state when a preview appears or disappears or the window is resized. `toggleAfter` is how many of the
 * form's top-level elements (the title and the introduction) come before the narrow-screen button.
 */
export default function PreviewLayout({ previews, lookup, children, toggleAfter = 2 }) {
  const wide = useSyncExternalStore(subscribe, isWide, () => false);
  const [shown, setShown] = useState(false);
  const list = previews.filter((p) => !p.hidden);
  const has = list.length > 0;

  const body = has ? (
    <div className="v2-preview-list">
      {list.map((p) => (
        <div key={p.key} className="v2-preview-item">
          <h2 className="v2-preview-title">{p.title}</h2>
          <MessagePreview content={p.content} embed={p.embed} lookup={lookup} samples={p.samples} />
          {p.note ? <p className="v2-field-hint">{p.note}</p> : null}
        </div>
      ))}
      <p className="v2-field-hint v2-preview-foot">
        Sample data. This is how members will see it; nothing is sent.
      </p>
    </div>
  ) : null;

  const nodes = flatten(children);
  if (has && !wide) {
    nodes.splice(
      Math.min(toggleAfter, nodes.length),
      0,
      <div key="v2-preview-toggle" className="v2-preview-toggle">
        <button
          type="button"
          className="v2-btn-ghost"
          aria-expanded={shown}
          aria-controls="v2-preview-panel"
          onClick={() => setShown((s) => !s)}
        >
          {shown ? 'Hide preview' : 'Show preview'}
        </button>
        {shown ? (
          <aside id="v2-preview-panel" className="v2-preview-inline" aria-label="Preview">
            {body}
          </aside>
        ) : null}
      </div>
    );
  }

  const side = has && wide;
  return (
    <div className={side ? 'v2-with-preview' : 'v2-with-preview-off'}>
      <div className="v2-with-preview-main">{nodes}</div>
      {side ? (
        <aside className="v2-preview-col" aria-label="Preview">
          {body}
        </aside>
      ) : null}
    </div>
  );
}
