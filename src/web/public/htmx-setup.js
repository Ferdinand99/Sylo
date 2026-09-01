// htmx wiring for the Sylo dashboard.
//   - puts the CSRF token on every htmx request
//   - bridges  HX-Trigger: {"toast":{"msg":"…","kind":"ok|bad|info"}}  to the
//     existing toast UI (window.syloToast, defined in app.js)
//   - shows a visible message when a request fails, so a failed save is never
//     silent
//
// Loaded with `defer` right after htmx.min.js; only attaches document-level
// listeners, so load order relative to htmx does not matter.
(function () {
  var meta = document.querySelector('meta[name="csrf-token"]');
  var token = meta ? meta.getAttribute('content') : '';

  document.addEventListener('htmx:configRequest', function (evt) {
    if (token) evt.detail.headers['X-CSRF-Token'] = token;
  });

  // Server-driven toast. htmx dispatches HX-Trigger events on <body>; they bubble.
  document.addEventListener('toast', function (evt) {
    var d = evt.detail || {};
    if (window.syloToast) window.syloToast(d.msg || 'Done.', d.kind || 'ok');
  });

  // A module was enabled/disabled somewhere — reflect it on the sidebar dot.
  document.addEventListener('moduleToggled', function (evt) {
    var d = evt.detail || {};
    var dot = document.querySelector('.sb-link[data-module="' + d.id + '"] .sb-dot');
    if (dot) {
      dot.classList.toggle('on', !!d.enabled);
      dot.classList.toggle('off', !d.enabled);
    }
  });

  document.addEventListener('htmx:responseError', function (evt) {
    var status = evt.detail && evt.detail.xhr ? evt.detail.xhr.status : 0;
    if (window.syloToast) {
      window.syloToast('Request failed (' + status + ') — reload the page and try again.', 'bad');
    }
  });
  document.addEventListener('htmx:sendError', function () {
    if (window.syloToast) window.syloToast('Network error — check your connection.', 'bad');
  });
})();
