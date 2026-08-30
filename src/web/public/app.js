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
      // Reflect the new state on the sidebar link's status dot.
      const dot = document.querySelector(`.sb-link[data-module="${moduleId}"] .sb-dot`);
      if (dot) {
        dot.classList.toggle('on', data.enabled);
        dot.classList.toggle('off', !data.enabled);
      }
    } catch {
      t.checked = !t.checked; // revert
    } finally {
      t.disabled = false;
    }
  });

  // --- plugin-grid "Enable" buttons (overview) ------------------------
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.plugin-btn.enable');
    if (!btn) return;
    e.preventDefault();
    const { guild, module: moduleId, config } = btn.dataset;
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const data = await window.syloAction(`/guilds/${guild}/modules/${moduleId}`, { enabled: true });
      if (data.enabled) {
        const link = document.createElement('a');
        link.className = 'plugin-btn active';
        link.href = config || `/guilds/${guild}/m/${moduleId}`;
        link.textContent = '✓ Active';
        btn.replaceWith(link);
        btn.closest('.plugin-card')?.classList.add('is-on');
        const dot = document.querySelector(`.sb-link[data-module="${moduleId}"] .sb-dot`);
        if (dot) { dot.classList.add('on'); dot.classList.remove('off'); }
        toast(`${moduleId} enabled`);
      }
    } catch {
      btn.disabled = false;
      btn.textContent = '+ Enable';
    }
  });

  // --- chip picker (chips + add-dropdown, à la MEE6) — roles or channels ---
  function makeRoleChip(id, name, color, field, kind) {
    const chip = document.createElement('span');
    chip.className = 'role-chip';
    chip.dataset.id = id;
    chip.dataset.name = name;
    chip.dataset.color = color || '';
    let lead;
    if (kind === 'channel') {
      lead = document.createElement('span');
      lead.className = 'chip-hash';
      lead.textContent = '#';
    } else {
      lead = document.createElement('span');
      lead.className = 'role-dot';
      lead.style.background = color || 'var(--muted)';
    }
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'role-chip-x';
    x.setAttribute('aria-label', 'Remove');
    x.textContent = '×';
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = field || 'botMasterRoles';
    input.value = id;
    chip.append(lead, document.createTextNode(name), x, input);
    return chip;
  }

  document.addEventListener('change', (e) => {
    const sel = e.target.closest('.role-picker-add');
    if (!sel || !sel.value) return;
    const picker = sel.closest('.role-picker');
    const opt = sel.selectedOptions[0];
    picker.querySelector('[data-role-chips]').appendChild(
      makeRoleChip(sel.value, opt.dataset.name || opt.textContent, opt.dataset.color, picker.dataset.field, picker.dataset.kind)
    );
    opt.remove();
    sel.value = '';
  });

  document.addEventListener('click', (e) => {
    const x = e.target.closest('.role-chip-x');
    if (!x) return;
    const chip = x.closest('.role-chip');
    const sel = chip.closest('.role-picker')?.querySelector('.role-picker-add');
    if (sel) {
      const o = document.createElement('option');
      o.value = chip.dataset.id;
      o.textContent = chip.dataset.name;
      o.dataset.name = chip.dataset.name;
      o.dataset.color = chip.dataset.color || '';
      sel.appendChild(o);
    }
    chip.remove();
  });

  // --- emoji picker ----------------------------------------------------
  const COMMON_EMOJI = (
    '😀 😂 😍 😎 🤔 😴 🥳 😢 😡 👍 👎 👌 🙏 👏 🙌 💪 🔥 ✨ ⭐ 🌟 💯 ✅ ❌ ⚠️ ❗ ❓ 💡 🔔 📌 📢 ' +
    '🎮 🕹️ 🎧 🎵 🎬 📷 💻 📱 🖥️ ⌨️ 🛠️ ⚙️ 🔧 🔒 🔑 🚀 🛰️ 🌍 🗺️ 🏆 🥇 🎯 🎲 ♠️ ♥️ ♦️ ♣️ ' +
    '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💖 💗 🎉 🎊 🎁 🍕 🍔 🍟 🌮 🍺 🍻 ☕ 🧊 🐶 🐱 🦊 🐸 🐼 🦁 🐢 🐧'
  ).split(' ');

  let pickerEl = null;
  let pickerTarget = null;
  let customEmojiCache = new Map(); // guildId -> array

  function closePicker() {
    pickerEl?.remove();
    pickerEl = null;
    pickerTarget = null;
  }

  async function openPicker(button) {
    if (pickerEl) return closePicker();
    const input = button.previousElementSibling;
    pickerTarget = input;
    const guildId = button.dataset.guild;

    pickerEl = document.createElement('div');
    pickerEl.className = 'emoji-pop';
    pickerEl.innerHTML = '<div class="emoji-sec">Loading…</div>';
    button.parentElement.style.position = 'relative';
    button.parentElement.appendChild(pickerEl);

    let custom = customEmojiCache.get(guildId);
    if (!custom) {
      try {
        const r = await fetch(`/guilds/${guildId}/emojis`);
        custom = (await r.json()).custom || [];
      } catch {
        custom = [];
      }
      customEmojiCache.set(guildId, custom);
    }

    const cell = (label, value, isImg) =>
      `<button type="button" class="emoji-cell" data-value="${value.replace(/"/g, '&quot;')}">` +
      (isImg ? `<img src="${label}" alt="">` : label) +
      '</button>';

    pickerEl.innerHTML =
      (custom.length
        ? `<div class="emoji-sec">Server</div><div class="emoji-grid">${custom
            .map((e) => cell(e.url, e.display, true))
            .join('')}</div>`
        : '') +
      `<div class="emoji-sec">Emoji</div><div class="emoji-grid">${COMMON_EMOJI.map((e) => cell(e, e, false)).join(
        ''
      )}</div>`;
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.emoji-btn');
    if (btn) {
      e.preventDefault();
      openPicker(btn);
      return;
    }
    const cellBtn = e.target.closest('.emoji-cell');
    if (cellBtn && pickerTarget) {
      pickerTarget.value = cellBtn.dataset.value;
      closePicker();
      return;
    }
    if (pickerEl && !e.target.closest('.emoji-pop')) closePicker();
  });

  // --- server switcher: close the dropdown on outside click / Escape ---
  document.addEventListener('click', (e) => {
    const open = document.querySelector('.srv-switch[open]');
    if (open && !e.target.closest('.srv-switch')) open.removeAttribute('open');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelector('.srv-switch[open]')?.removeAttribute('open');
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
