// Set data-theme before the stylesheet/React load, so a saved "light"
// choice doesn't flash dark-then-light on every page load. Mirrors
// util.js's readTheme() — duplicated here (not imported) because this
// has to run before any module script. A plain script in <head> (not inline) so the
// Content-Security-Policy needs no 'unsafe-inline'; Vite copies public/ to dist/ as /v2/theme.js.
try {
  var t = localStorage.getItem('sylo:v2:theme');
  if (t === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
    document.querySelector('meta[name="theme-color"]').setAttribute('content', '#f5f5f7');
  }
} catch (e) {
  // Storage blocked: the default (dark) look stays.
}
