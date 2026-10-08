// Topbar button that flips the dashboard between dark (default) and light —
// see styles.css's :root[data-theme='light'] block for the palette. State
// lives in Shell.jsx (persisted via util.js's readTheme/writeTheme); this
// component is just the button + the two icons.
export default function ThemeToggle({ theme, onToggle }) {
  const isLight = theme === 'light';
  return (
    <button
      type="button"
      className="v2-theme-toggle"
      onClick={onToggle}
      title={isLight ? 'Switch to dark theme' : 'Switch to light theme'}
      aria-label={isLight ? 'Switch to dark theme' : 'Switch to light theme'}
    >
      {isLight ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
        </svg>
      )}
    </button>
  );
}
