const ICONS = {
  warning: (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false">
      <path
        d="M10 2.5 18.5 17h-17L10 2.5Z M10 8v4.2 M10 14.4v.1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  info: (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false">
      <circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M10 9v5 M10 6.3v.1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  ),
};

/**
 * A tinted box with an icon for something the reader should notice before they carry on (a feature
 * that is not switched on for this Sylo, a side effect of saving). `tone` is "warning" or "info".
 * The meaning is in the words, the tint and icon only help.
 */
export default function Callout({ tone = 'info', title = '', children, className = '' }) {
  return (
    <div className={`v2-callout is-${tone}${className ? ` ${className}` : ''}`} role="note">
      <span className="v2-callout-icon">{ICONS[tone] ?? ICONS.info}</span>
      <div className="v2-callout-body">
        {title ? <strong className="v2-callout-title">{title}</strong> : null}
        {children}
      </div>
    </div>
  );
}
