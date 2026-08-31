// Custom-command builder: an ordered list of typed actions, each rendered as a
// card with its own fields (message blocks + a compact embed editor, a channel
// picker, or a role picker). The whole action tree is serialised to a hidden
// input on submit; the server normalises it.
(() => {
  const host = document.getElementById('cc-actions');
  const form = document.getElementById('cc-form');
  const jsonEl = document.getElementById('cc-actions-json');
  if (!host || !form || !jsonEl) return;

  const CC = window.CC || {};
  const ROLES = window.CC_ROLES || [];
  const CHANNELS = window.CC_CHANNELS || [];
  const TYPES = window.CC_ACTION_TYPES || [];
  const PLACEHOLDERS = window.CC_PLACEHOLDERS || [];

  const HEX = /^#[0-9a-f]{6}$/i;
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const askUrl = (cur) => {
    const u = window.prompt('URL (https://…). Leave blank to remove.', cur || '');
    if (u === null) return cur || '';
    const t = u.trim();
    return /^https?:\/\/\S+$/i.test(t) ? t : '';
  };

  // Working model — a deep-ish copy we mutate, then serialise on submit.
  let actions = Array.isArray(CC.actions) && CC.actions.length
    ? JSON.parse(JSON.stringify(CC.actions))
    : [blankAction('reply')];

  function blankMessage() {
    return { content: '', embed: null };
  }
  function blankEmbed() {
    return { color: '#5865f2', title: '', description: '', authorName: '', authorIcon: '', image: '', thumbnail: '', footerText: '', footerIcon: '', timestamp: false, fields: [] };
  }
  function blankAction(type) {
    if (type === 'send') return { type, channelId: '', messages: [blankMessage()] };
    if (type === 'add-role' || type === 'remove-role') return { type, roleId: '' };
    return { type: 'reply', private: false, messages: [blankMessage()] };
  }

  const typeTitle = (t) => (TYPES.find((x) => x.type === t) || {}).title || t;

  const roleOptions = (sel) =>
    `<option value="">— select a role —</option>` +
    ROLES.map((r) => `<option value="${r.id}" ${r.id === sel ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
  const channelOptions = (sel) =>
    `<option value="">— select a channel —</option>` +
    CHANNELS.map((c) => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>#${esc(c.name)}</option>`).join('');

  // --- rendering --------------------------------------------------------

  function embedEditorHTML(embed, ai, mi) {
    const color = HEX.test(embed.color) ? embed.color : '#5865f2';
    const fields = (embed.fields || [])
      .map(
        (f, fi) => `<div class="cc-embed-field" data-fi="${fi}">
          <input type="text" class="cc-e" data-k="fname" value="${esc(f.name)}" placeholder="Field name" />
          <input type="text" class="cc-e" data-k="fvalue" value="${esc(f.value)}" placeholder="Field value" />
          <button type="button" class="link-btn" data-delfield>remove</button>
        </div>`
      )
      .join('');
    return `<div class="cc-embed" data-ai="${ai}" data-mi="${mi}" style="--cc-color:${color}">
      <div class="cc-embed-top">
        <label class="cc-colorwrap" title="Embed colour"><input type="color" class="cc-e" data-k="color" value="${color}" /></label>
        <input type="text" class="cc-e cc-e-title" data-k="title" value="${esc(embed.title)}" placeholder="Embed title" />
        <button type="button" class="link-btn" data-delembed>remove embed</button>
      </div>
      <textarea class="cc-e" data-k="description" rows="2" placeholder="Embed description">${esc(embed.description)}</textarea>
      <div class="cc-embed-grid">
        <input type="text" class="cc-e" data-k="authorName" value="${esc(embed.authorName)}" placeholder="Author name" />
        <button type="button" class="cc-urlbtn ${embed.authorIcon ? 'has' : ''}" data-url="authorIcon">Author icon…</button>
        <button type="button" class="cc-urlbtn ${embed.image ? 'has' : ''}" data-url="image">Image…</button>
        <button type="button" class="cc-urlbtn ${embed.thumbnail ? 'has' : ''}" data-url="thumbnail">Thumbnail…</button>
        <input type="text" class="cc-e" data-k="footerText" value="${esc(embed.footerText)}" placeholder="Footer text" />
        <label class="checkline"><input type="checkbox" class="cc-e" data-k="timestamp" ${embed.timestamp ? 'checked' : ''} /> Timestamp</label>
      </div>
      <div class="cc-embed-fields">${fields}</div>
      <button type="button" class="link-btn" data-addfield>＋ Add field</button>
    </div>`;
  }

  function messageBlockHTML(msg, ai, mi, showRemove) {
    return `<div class="cc-msg" data-ai="${ai}" data-mi="${mi}">
      <div class="cc-msg-head">
        <span class="muted small">Message ${mi + 1}</span>
        <span class="cc-msg-tools">
          ${msg.embed ? '' : '<button type="button" class="link-btn" data-addembed>＋ Add embed</button>'}
          ${showRemove ? '<button type="button" class="link-btn" data-delmsg>remove</button>' : ''}
        </span>
      </div>
      <textarea class="cc-content" rows="2" placeholder="Write your message here… (leave blank for embed-only)">${esc(msg.content)}</textarea>
      ${msg.embed ? embedEditorHTML(msg.embed, ai, mi) : ''}
    </div>`;
  }

  function actionBodyHTML(a, ai) {
    if (a.type === 'add-role' || a.type === 'remove-role') {
      return `<label class="small">Role</label>
        <select class="cc-role">${roleOptions(a.roleId)}</select>
        <p class="muted small">Applied to whoever ran the command.</p>`;
    }
    const msgs = (a.messages || []).map((m, mi) => messageBlockHTML(m, ai, mi, a.messages.length > 1)).join('');
    const chan =
      a.type === 'send'
        ? `<label class="small">Channel</label><select class="cc-channel">${channelOptions(a.channelId)}</select>`
        : `<label class="checkline"><input type="checkbox" class="cc-private" ${a.private ? 'checked' : ''} /> Private — only the person who ran it sees the reply</label>`;
    return `${chan}
      <div class="cc-msgs">${msgs}</div>
      <button type="button" class="link-btn" data-addmsg>＋ Add a message (the bot picks one at random)</button>`;
  }

  function render() {
    host.innerHTML = actions
      .map(
        (a, ai) => `<div class="cc-action" data-ai="${ai}">
        <div class="cc-action-head">
          <span class="cc-action-title"><span class="cc-badge">${ai + 1}</span> ${esc(typeTitle(a.type))}</span>
          <span class="cc-action-tools">
            <button type="button" class="cc-iconbtn" data-move="-1" title="Move up" ${ai === 0 ? 'disabled' : ''}>↑</button>
            <button type="button" class="cc-iconbtn" data-move="1" title="Move down" ${ai === actions.length - 1 ? 'disabled' : ''}>↓</button>
            <button type="button" class="cc-iconbtn danger" data-delaction title="Remove action">✕</button>
          </span>
        </div>
        <div class="cc-action-body stack">${actionBodyHTML(a, ai)}</div>
      </div>`
      )
      .join('');
    if (PLACEHOLDERS.length) {
      const hint = document.createElement('p');
      hint.className = 'muted small';
      hint.innerHTML = 'Placeholders: ' + PLACEHOLDERS.map((p) => `<code>${esc(p)}</code>`).join(' ');
      host.appendChild(hint);
    }
  }

  // --- collect (DOM -> model) -----------------------------------------

  function collect() {
    host.querySelectorAll('.cc-action').forEach((el, ai) => {
      const a = actions[ai];
      if (!a) return;
      if (a.type === 'add-role' || a.type === 'remove-role') {
        a.roleId = el.querySelector('.cc-role')?.value || '';
        return;
      }
      if (a.type === 'send') a.channelId = el.querySelector('.cc-channel')?.value || '';
      if (a.type === 'reply') a.private = !!el.querySelector('.cc-private')?.checked;

      el.querySelectorAll('.cc-msg').forEach((mEl, mi) => {
        const m = a.messages[mi];
        if (!m) return;
        m.content = mEl.querySelector('.cc-content')?.value ?? '';
        const emb = mEl.querySelector('.cc-embed');
        if (!emb) {
          m.embed = null;
          return;
        }
        m.embed = m.embed || blankEmbed();
        emb.querySelectorAll('.cc-e[data-k]').forEach((f) => {
          const k = f.dataset.k;
          if (k === 'fname' || k === 'fvalue') return;
          m.embed[k] = f.type === 'checkbox' ? f.checked : f.value;
        });
        m.embed.fields = [...emb.querySelectorAll('.cc-embed-field')]
          .map((fr) => ({
            name: fr.querySelector('[data-k=fname]')?.value.trim() || '',
            value: fr.querySelector('[data-k=fvalue]')?.value.trim() || '',
            inline: false,
          }))
          .filter((f) => f.name || f.value);
      });
    });
  }

  // --- events --------------------------------------------------------

  host.addEventListener('input', collect);
  host.addEventListener('change', collect);

  host.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const actionEl = btn.closest('.cc-action');
    const ai = actionEl ? Number(actionEl.dataset.ai) : -1;
    const a = actions[ai];

    if (btn.dataset.move && a) {
      collect();
      const to = ai + Number(btn.dataset.move);
      if (to >= 0 && to < actions.length) {
        actions.splice(to, 0, actions.splice(ai, 1)[0]);
        render();
      }
    } else if (btn.hasAttribute('data-delaction')) {
      collect();
      actions.splice(ai, 1);
      if (!actions.length) actions.push(blankAction('reply'));
      render();
    } else if (btn.hasAttribute('data-addmsg') && a) {
      collect();
      a.messages.push(blankMessage());
      render();
    } else if (btn.hasAttribute('data-delmsg')) {
      collect();
      const mi = Number(btn.closest('.cc-msg').dataset.mi);
      a.messages.splice(mi, 1);
      if (!a.messages.length) a.messages.push(blankMessage());
      render();
    } else if (btn.hasAttribute('data-addembed')) {
      collect();
      const mi = Number(btn.closest('.cc-msg').dataset.mi);
      a.messages[mi].embed = blankEmbed();
      render();
    } else if (btn.hasAttribute('data-delembed')) {
      collect();
      const mi = Number(btn.closest('.cc-msg').dataset.mi);
      a.messages[mi].embed = null;
      render();
    } else if (btn.hasAttribute('data-addfield')) {
      collect();
      const mi = Number(btn.closest('.cc-msg').dataset.mi);
      (a.messages[mi].embed.fields = a.messages[mi].embed.fields || []).push({ name: '', value: '' });
      render();
    } else if (btn.hasAttribute('data-delfield')) {
      collect();
      const mi = Number(btn.closest('.cc-msg').dataset.mi);
      const fi = Number(btn.closest('.cc-embed-field').dataset.fi);
      a.messages[mi].embed.fields.splice(fi, 1);
      render();
    } else if (btn.dataset.url) {
      collect();
      const mi = Number(btn.closest('.cc-msg').dataset.mi);
      a.messages[mi].embed[btn.dataset.url] = askUrl(a.messages[mi].embed[btn.dataset.url]);
      render();
    }
  });

  // --- add-action type picker --------------------------------------

  const addBtn = document.getElementById('cc-add-action');
  addBtn.addEventListener('click', () => {
    if (document.querySelector('.cc-typepicker')) return;
    collect();
    const picker = document.createElement('div');
    picker.className = 'cc-typepicker';
    picker.innerHTML =
      TYPES.map((t) => `<button type="button" data-type="${t.type}">${esc(t.title)}</button>`).join('') +
      `<button type="button" class="link-btn" data-cancel>cancel</button>`;
    addBtn.after(picker);
    picker.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.type) {
        actions.push(blankAction(b.dataset.type));
        render();
      }
      picker.remove();
    });
  });

  // --- submit ------------------------------------------------------

  form.addEventListener('submit', () => {
    collect();
    jsonEl.value = JSON.stringify(actions);
  });

  render();
})();
