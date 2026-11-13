import { useState, useSyncExternalStore } from 'react';
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

/**
 * A form page with a live preview of the messages it sets. On a wide screen the previews sit in the right
 * column and stay in view while the form scrolls; on a phone or a narrow window they are folded away
 * behind a "Show preview" button above the form, so the form keeps the whole width.
 *
 *   <PreviewLayout previews={[{ key: 'join', title: 'Welcome message', content: form.joinMessage }]}
 *     lookup={{ channels: data.channels, roles: data.roles }}>
 *     …the form…
 *   </PreviewLayout>
 *
 * A preview is { key, title, content?, embed?, note?, samples?, hidden? } (`hidden` leaves it out, e.g.
 * while its switch is off). With nothing to show the form renders alone.
 */
export default function PreviewLayout({ previews, lookup, children }) {
  const wide = useSyncExternalStore(subscribe, isWide, () => false);
  const [shown, setShown] = useState(false);
  const list = previews.filter((p) => !p.hidden);
  if (!list.length) return children;

  const body = (
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
  );

  if (wide) {
    return (
      <div className="v2-with-preview">
        <div className="v2-with-preview-main">{children}</div>
        <aside className="v2-preview-col" aria-label="Preview">
          {body}
        </aside>
      </div>
    );
  }
  return (
    <>
      <div className="v2-preview-toggle">
        <button
          type="button"
          className="v2-btn-ghost"
          aria-expanded={shown}
          aria-controls="v2-preview-panel"
          onClick={() => setShown((s) => !s)}
        >
          {shown ? 'Hide preview' : 'Show preview'}
        </button>
      </div>
      {shown ? (
        <aside id="v2-preview-panel" className="v2-preview-inline" aria-label="Preview">
          {body}
        </aside>
      ) : null}
      {children}
    </>
  );
}
