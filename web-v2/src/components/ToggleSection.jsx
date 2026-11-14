import { useId } from 'react';
import { useAccess } from '../access.jsx';

// A feature toggle whose settings only show once it's on — used
// across most module pages (welcome, birthdays, …), shared here rather than
// reinvented per module. The whole header row (knob + title) is one
// role="switch" button, so the title is a click target too and screen
// readers hear "<title>, switch, on/off". Disabled below Edit access (access.jsx).
export default function ToggleSection({ title, description, on, onToggle, disabled, children }) {
  const descId = useId();
  const { can } = useAccess();
  return (
    <div className={`v2-toggle-section${on ? ' is-on' : ''}`}>
      <button
        type="button"
        role="switch"
        aria-checked={Boolean(on)}
        aria-describedby={description ? descId : undefined}
        className="v2-toggle-section-head v2-ts-head"
        disabled={disabled || !can('edit')}
        onClick={onToggle}
      >
        <span className={`v2-toggle${on ? ' is-on' : ''}`} aria-hidden="true" />
        <span className="v2-toggle-section-title">{title}</span>
      </button>
      {description ? (
        <p id={descId} className="v2-field-hint">
          {description}
        </p>
      ) : null}
      {on ? <div className="v2-toggle-section-body">{children}</div> : null}
    </div>
  );
}
