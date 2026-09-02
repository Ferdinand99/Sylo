// htmx wiring for the Sylo dashboard.
//   - defines the toast UI (window.syloToast) used across the dashboard
//   - puts the CSRF token on every htmx request
//   - bridges  HX-Trigger: {"toast":{"msg":"…","kind":"ok|bad|info"}}  to a toast
//   - shows a visible message when a request fails, so a failed save is never
//     silent
//
// Loaded with `defer` right after htmx.min.js; only attaches document-level
// listeners, so load order relative to htmx does not matter.
(function () {
  var meta = document.querySelector('meta[name="csrf-token"]');
  var token = meta ? meta.getAttribute('content') : '';

  // --- Toasts ------------------------------------------------------------
  var toastHost;
  window.syloToast = function syloToast(message, kind) {
    // hx-boost swaps <body>'s innerHTML, which detaches an earlier toast-host.
    // Re-create / re-attach whenever it isn't in the document.
    if (!toastHost || !toastHost.isConnected) {
      toastHost = document.createElement('div');
      toastHost.className = 'toast-host';
      document.body.appendChild(toastHost);
    }
    var el = document.createElement('div');
    el.className = 'toast ' + (kind || 'ok');
    el.textContent = message;
    toastHost.appendChild(el);
    setTimeout(function () {
      el.classList.add('show');
    }, 10);
    setTimeout(function () {
      el.classList.remove('show');
      setTimeout(function () {
        el.remove();
      }, 250);
    }, 4000);
  };

  // A server-rendered result banner (.banner-flash, from a ?msg= redirect) is
  // shown as a toast instead — one consistent "saved" cue everywhere, whether
  // the response came back over htmx or a full navigation. Persistent state
  // banners (plain .banner) are left alone.
  function flashBannersToToast() {
    // Scan the whole document, not just the swapped node — a boosted navigation
    // can fire htmx:load with a target that doesn't contain the banner. Each is
    // removed, so a second pass is a no-op.
    document.querySelectorAll('.banner-flash').forEach(function (el) {
      var kind = el.classList.contains('bad') ? 'bad' : el.classList.contains('info') ? 'info' : 'ok';
      var text = (el.textContent || '').trim();
      el.remove();
      if (text && window.syloToast) window.syloToast(text, kind);
    });
  }
  document.addEventListener('DOMContentLoaded', flashBannersToToast);
  document.addEventListener('htmx:load', flashBannersToToast);
  document.addEventListener('htmx:afterSettle', flashBannersToToast);

  document.addEventListener('htmx:configRequest', function (evt) {
    if (token) evt.detail.headers['X-CSRF-Token'] = token;
  });

  // Server-driven toast. htmx dispatches HX-Trigger events on <body>; they bubble.
  document.addEventListener('toast', function (evt) {
    var d = evt.detail || {};
    if (window.syloToast) window.syloToast(d.msg || 'Done.', d.kind || 'ok');
  });

  // A module was enabled/disabled somewhere — reflect it on the sidebar dot and
  // (on the overview) the plugin card.
  document.addEventListener('moduleToggled', function (evt) {
    var d = evt.detail || {};
    var dot = document.querySelector('.sb-link[data-module="' + d.id + '"] .sb-dot');
    if (dot) {
      dot.classList.toggle('on', !!d.enabled);
      dot.classList.toggle('off', !d.enabled);
    }
    var card = document.getElementById('plugin-card-' + d.id);
    if (card) card.classList.toggle('is-on', !!d.enabled);
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
