// A feature toggle whose settings only show once it's on — the same
// pattern V1's "mee-row"/"mee-body" convention uses across most module
// pages (welcome.ejs, birthdays.ejs, …), reused here rather than
// reinvented per module.
export default function ToggleSection({ title, description, on, onToggle, disabled, children }) {
  return (
    <div className="v2-toggle-section">
      <div className="v2-toggle-section-head">
        <button
          type="button"
          className={`v2-toggle${on ? ' is-on' : ''}`}
          aria-label={on ? `${title} — click to turn off` : `${title} — click to turn on`}
          disabled={disabled}
          onClick={onToggle}
        />
        <span className="v2-toggle-section-title">{title}</span>
      </div>
      {description ? <p className="v2-field-hint">{description}</p> : null}
      {on ? <div className="v2-toggle-section-body">{children}</div> : null}
    </div>
  );
}
