import { useId } from 'react';

// A feature toggle whose settings only show once it's on — the same
// pattern V1's "mee-row"/"mee-body" convention uses across most module
// pages (welcome.ejs, birthdays.ejs, …), reused here rather than
// reinvented per module. The whole header row (knob + title) is one
// role="switch" button, so the title is a click target too and screen
// readers hear "<title>, switch, on/off".
export default function ToggleSection({ title, description, on, onToggle, disabled, children }) {
  const descId = useId();
  return (
    <div className={`v2-toggle-section${on ? ' is-on' : ''}`}>
      <button
        type="button"
        role="switch"
        aria-checked={Boolean(on)}
        aria-describedby={description ? descId : undefined}
        className="v2-toggle-section-head v2-ts-head"
        disabled={disabled}
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
