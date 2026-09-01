// Progressive-enhancement helpers that aren't htmx or Alpine: CSRF plumbing for
// plain forms / raw fetch, and confirm-on-submit. Everything else moved to
// htmx-setup.js (toasts) or Alpine components in alpine-components.js.
(() => {
  // --- CSRF: attach the session token to every same-origin mutating request --
  const CSRF = document.querySelector('meta[name="csrf-token"]')?.content || '';
  if (CSRF) {
    document.addEventListener('submit', (e) => {
      const form = e.target;
      if (!(form instanceof HTMLFormElement)) return;
      if ((form.method || 'get').toLowerCase() === 'get') return;
      if (!form.querySelector('input[name="_csrf"]')) {
        const h = document.createElement('input');
        h.type = 'hidden';
        h.name = '_csrf';
        h.value = CSRF;
        form.appendChild(h);
      }
    });
    // Raw fetch() callers (e.g. the backup import on /health) get the header too.
    // htmx sends its own via the htmx:configRequest hook in htmx-setup.js.
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, init = {}) => {
      try {
        const url = new URL(typeof input === 'string' ? input : input.url, location.origin);
        const method = (init.method || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
        if (url.origin === location.origin && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
          const headers = new Headers(init.headers || {});
          if (!headers.has('x-csrf-token')) headers.set('x-csrf-token', CSRF);
          init = { ...init, headers };
        }
      } catch {
        /* leave the request untouched */
      }
      return nativeFetch(input, init);
    };
  }

  // --- Confirm-on-submit / confirm-on-click ---------------------------------
  // Plain (non-htmx) forms and links opt in with data-confirm="…".
  document.addEventListener('submit', (e) => {
    // data-confirm may sit on the <form> or on the submitter <button>.
    const msg = e.submitter?.getAttribute('data-confirm') || e.target.getAttribute('data-confirm');
    if (msg && !window.confirm(msg)) e.preventDefault();
  });
  document.addEventListener('click', (e) => {
    const link = e.target.closest('[data-confirm]');
    if (link && link.tagName === 'A' && !window.confirm(link.getAttribute('data-confirm'))) {
      e.preventDefault();
    }
  });
})();
