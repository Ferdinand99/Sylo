import { useEffect, useState } from 'react';
import { readTheme, writeTheme } from '../util.js';

// --bg-main per theme (styles.css) — what the browser chrome should match.
const THEME_COLOR = { dark: '#0b0b0d', light: '#f5f5f7' };

// The dark/light choice, shared by the signed-in shell and the public one.
// index.html's inline script already set data-theme before first paint for
// a saved "light" choice (avoids a flash of dark-then-light) — this just
// keeps it in sync as the user toggles, and handles switching back to dark.
// Also keeps the browser chrome / status bar colour (theme-color meta in
// index.html) matched to the topbar background of the active theme.
export default function useTheme() {
  const [theme, setTheme] = useState(() => readTheme() ?? 'dark');

  useEffect(() => {
    if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', theme === 'light' ? THEME_COLOR.light : THEME_COLOR.dark);
  }, [theme]);

  function toggleTheme() {
    setTheme((t) => {
      const next = t === 'light' ? 'dark' : 'light';
      writeTheme(next);
      return next;
    });
  }

  return [theme, toggleTheme];
}
