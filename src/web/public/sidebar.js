// Sidebar behaviour: the mobile drawer, and remembering which module categories
// are collapsed. hx-boost navigation replaces the sidebar DOM on every page
// change, so this re-binds after each htmx swap. Bindings are marked with a
// dataset flag so a swap that doesn't touch the sidebar is a no-op.
(function () {
  var body = document.body;
  function closeNav() {
    body.classList.remove('nav-open');
  }

  function bind() {
    var toggle = document.querySelector('.sb-toggle');
    if (toggle && !toggle.dataset.bound) {
      toggle.dataset.bound = '1';
      toggle.addEventListener('click', function () {
        body.classList.add('nav-open');
      });
    }

    var scrim = document.querySelector('.sb-scrim');
    if (scrim && !scrim.dataset.bound) {
      scrim.dataset.bound = '1';
      scrim.addEventListener('click', closeNav);
    }

    var sidebar = document.querySelector('.sidebar');
    if (sidebar && !sidebar.dataset.bound) {
      sidebar.dataset.bound = '1';
      sidebar.addEventListener('click', function (e) {
        if (e.target.closest('a.sb-link, .srv-switch-menu a')) closeNav();
      });
    }

    var theme = document.querySelector('.sb-theme');
    if (theme && !theme.dataset.bound) {
      theme.dataset.bound = '1';
      theme.addEventListener('click', function () {
        var root = document.documentElement;
        var current =
          root.dataset.theme ||
          (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
        var next = current === 'dark' ? 'light' : 'dark';
        root.dataset.theme = next;
        try {
          localStorage.setItem('sylo:theme', next);
        } catch (_) {
          /* storage disabled */
        }
      });
    }

    document.querySelectorAll('.sb-modgroup[data-k]').forEach(function (d) {
      if (d.dataset.bound) return;
      d.dataset.bound = '1';
      var k = 'sb:' + d.dataset.k;
      try {
        if (localStorage.getItem(k) === '0') d.open = false;
      } catch (_) {
        /* private mode / storage disabled */
      }
      d.addEventListener('toggle', function () {
        try {
          localStorage.setItem(k, d.open ? '1' : '0');
        } catch (_) {
          /* ignore */
        }
      });
    });
  }

  document.addEventListener('DOMContentLoaded', bind);
  // htmx:load fires on first-processed content and after every swap (incl. a
  // boosted full-page navigation).
  document.addEventListener('htmx:load', bind);
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeNav();
  });
})();
