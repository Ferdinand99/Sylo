// Sets the colour theme of the public pages before first paint. Loaded from <head> as a plain
// (blocking) script, so a saved light choice does not flash dark first. The dashboard (/v2) keeps
// the choice in localStorage['sylo:v2:theme'] ('light' or 'dark'; dark is the default look). If that
// is empty, the old classic dashboard's 'sylo:theme' is used once and copied over; the old key is
// left alone.
(function () {
  var root = document.documentElement;
  try {
    var theme = localStorage.getItem('sylo:v2:theme');
    if (theme !== 'light' && theme !== 'dark') {
      var old = localStorage.getItem('sylo:theme');
      theme = old === 'light' || old === 'dark' ? old : null;
      if (theme) localStorage.setItem('sylo:v2:theme', theme);
    }
    if (theme === 'light') root.setAttribute('data-theme', 'light');
  } catch (e) {
    // Storage blocked: the default (dark) look stays.
  }
})();
