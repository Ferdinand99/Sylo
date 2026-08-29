// Small progressive-enhancement helpers for the dashboard. No framework.
(() => {
  // --- Toasts -------------------------------------------------------------
  let toastHost;
  function toast(message, kind = 'ok') {
    if (!toastHost) {
      toastHost = document.createElement('div');
      toastHost.className = 'toast-host';
      document.body.appendChild(toastHost);
    }
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = message;
    toastHost.appendChild(el);
    setTimeout(() => el.classList.add('show'), 10);
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 250);
    }, 4000);
  }
  window.syloToast = toast;

  // --- Confirm-on-submit / confirm-on-click -----------------------------
  document.addEventListener('submit', (e) => {
    const msg = e.target.getAttribute('data-confirm');
    if (msg && !window.confirm(msg)) e.preventDefault();
  });
  document.addEventListener('click', (e) => {
    const link = e.target.closest('[data-confirm]');
    if (link && link.tagName === 'A' && !window.confirm(link.getAttribute('data-confirm'))) {
      e.preventDefault();
    }
  });

  // --- module enable/disable toggles ---------------------------------
  document.addEventListener('change', async (e) => {
    const t = e.target;
    if (!t.classList.contains('module-toggle')) return;
    const { guild, module: moduleId } = t.dataset;
    t.disabled = true;
    try {
      const data = await window.syloAction(`/guilds/${guild}/modules/${moduleId}`, { enabled: t.checked });
      t.checked = data.enabled;
      toast(`${moduleId} ${data.enabled ? 'enabled' : 'disabled'}`);
      const dot = t.closest('.mod-link')?.querySelector('.dot');
      if (dot) dot.classList.toggle('on', data.enabled), dot.classList.toggle('off', !data.enabled);
    } catch {
      t.checked = !t.checked; // revert
    } finally {
      t.disabled = false;
    }
  });

  // --- fetch helper for JSON actions (used by later phases) ------------
  window.syloAction = async function syloAction(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* no body */
    }
    if (!res.ok) {
      toast((data && data.error) || `Request failed (${res.status})`, 'bad');
      throw new Error(data?.error || res.statusText);
    }
    return data;
  };
})();
