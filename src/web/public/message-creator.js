// Message Creator editor: repeatable fields/rows/buttons, serialise to a single
// JSON spec, and render a Discord-ish live preview. No framework.
(() => {
  const form = document.getElementById('mc-form');
  if (!form) return;
  const roles = window.MC_ROLES || [];
  const spec = window.MC_SPEC || {};
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };
  const roleOptions = (selected) =>
    '<option value="">— role —</option>' +
    roles.map((r) => `<option value="${r.id}"${r.id === selected ? ' selected' : ''}>${escapeHtml(r.name)}</option>`).join('');
  const escapeHtml = (s) =>
    String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  // --- builders -------------------------------------------------------
  function fieldRow(f = {}) {
    const n = el('div', 'mc-repeat');
    n.innerHTML = `
      <input type="text" name="f_name" placeholder="Field name" maxlength="256" value="${escapeHtml(f.name)}">
      <input type="text" name="f_value" placeholder="Field value" maxlength="1024" value="${escapeHtml(f.value)}">
      <label class="small"><input type="checkbox" name="f_inline" ${f.inline ? 'checked' : ''}> inline</label>
      <button type="button" class="link-btn" data-del>remove</button>`;
    return n;
  }
  function buttonEl(b = {}) {
    const n = el('div', 'mc-btn');
    n.innerHTML = `
      <select name="b_style">
        ${['link', 'primary', 'secondary', 'success', 'danger'].map((s) => `<option value="${s}"${s === b.style ? ' selected' : ''}>${s}</option>`).join('')}
      </select>
      <input type="text" name="b_label" placeholder="Label" maxlength="80" value="${escapeHtml(b.label)}">
      <input type="text" name="b_emoji" placeholder="emoji" maxlength="64" value="${escapeHtml(b.emoji)}" style="width:70px">
      <input type="text" name="b_url" placeholder="https://… (link)" value="${escapeHtml(b.url)}">
      <select name="b_role">${roleOptions(b.roleId)}</select>
      <button type="button" class="link-btn" data-del>remove</button>`;
    return n;
  }
  function buttonRow(row = {}) {
    const n = el('div', 'mc-row');
    n.dataset.type = 'buttons';
    n.innerHTML = `<div class="mc-row-head"><b>Button row</b><button type="button" class="link-btn" data-delrow>remove row</button></div><div class="mc-btns"></div><button type="button" class="secondary" data-addbtn>+ Button</button>`;
    const holder = $('.mc-btns', n);
    (row.buttons || []).forEach((b) => holder.appendChild(buttonEl(b)));
    if (!(row.buttons || []).length) holder.appendChild(buttonEl());
    return n;
  }
  function optEl(o = {}) {
    const n = el('div', 'mc-btn');
    n.innerHTML = `
      <input type="text" name="o_label" placeholder="Label" maxlength="100" value="${escapeHtml(o.label)}">
      <input type="text" name="o_desc" placeholder="Description" maxlength="100" value="${escapeHtml(o.description)}">
      <input type="text" name="o_emoji" placeholder="emoji" maxlength="64" value="${escapeHtml(o.emoji)}" style="width:70px">
      <select name="o_role">${roleOptions(o.roleId)}</select>
      <button type="button" class="link-btn" data-del>remove</button>`;
    return n;
  }
  function selectRow(row = {}) {
    const n = el('div', 'mc-row');
    n.dataset.type = 'roleselect';
    n.innerHTML = `<div class="mc-row-head"><b>Role select</b><button type="button" class="link-btn" data-delrow>remove row</button></div>
      <div class="mc-two">
        <div><label class="small">Placeholder</label><input type="text" name="rs_placeholder" maxlength="150" value="${escapeHtml(row.placeholder)}"></div>
        <div><label class="small">Min / Max</label><span><input type="number" name="rs_min" min="0" value="${row.min ?? 0}" style="width:60px"> <input type="number" name="rs_max" min="1" value="${row.max ?? 1}" style="width:60px"></span></div>
      </div>
      <label class="small">Options</label><div class="mc-opts"></div><button type="button" class="secondary" data-addopt>+ Option</button>`;
    const holder = $('.mc-opts', n);
    (row.options || []).forEach((o) => holder.appendChild(optEl(o)));
    if (!(row.options || []).length) holder.appendChild(optEl());
    return n;
  }

  // --- hydrate from spec -------------------------------------------
  const e0 = (spec.embeds && spec.embeds[0]) || {};
  const setV = (name, v) => { const n = form.elements[name]; if (n && v != null) n.value = v; };
  setV('e_content', spec.content || '');
  $('#content').value = spec.content || '';
  setV('e_title', e0.title); setV('e_url', e0.url); setV('e_desc', e0.description);
  if (e0.color) setV('e_color', e0.color);
  form.elements['e_timestamp'].checked = !!e0.timestamp;
  setV('e_authorName', e0.authorName); setV('e_authorIcon', e0.authorIcon); setV('e_authorUrl', e0.authorUrl);
  setV('e_footerText', e0.footerText); setV('e_footerIcon', e0.footerIcon);
  setV('e_thumbnail', e0.thumbnail); setV('e_image', e0.image);
  (e0.fields || []).forEach((f) => $('#fields').appendChild(fieldRow(f)));
  (spec.rows || []).forEach((r) => $('#rows').appendChild(r.type === 'roleselect' ? selectRow(r) : buttonRow(r)));

  // --- events ----------------------------------------------------
  document.addEventListener('click', (e) => {
    const add = e.target.closest('[data-add]');
    if (add) {
      if (add.dataset.add === 'field') $('#fields').appendChild(fieldRow());
      if (add.dataset.add === 'btnrow' && $$('#rows .mc-row').length < 5) $('#rows').appendChild(buttonRow());
      if (add.dataset.add === 'selrow' && $$('#rows .mc-row').length < 5) $('#rows').appendChild(selectRow());
      update();
    }
    if (e.target.closest('[data-addbtn]')) {
      e.target.closest('.mc-row').querySelector('.mc-btns').appendChild(buttonEl());
      update();
    }
    if (e.target.closest('[data-addopt]')) {
      e.target.closest('.mc-row').querySelector('.mc-opts').appendChild(optEl());
      update();
    }
    if (e.target.matches('[data-del]')) { e.target.closest('.mc-repeat, .mc-btn').remove(); update(); }
    if (e.target.matches('[data-delrow]')) { e.target.closest('.mc-row').remove(); update(); }
  });
  form.addEventListener('input', update);
  form.addEventListener('submit', () => { $('#mc-spec').value = JSON.stringify(serialize()); });

  // --- serialise -----------------------------------------------
  function serialize() {
    const v = (name, r = form) => (r.elements ? r.elements[name] : r.querySelector(`[name="${name}"]`));
    const gv = (name, r) => {
      const n = r ? r.querySelector(`[name="${name}"]`) : form.elements[name];
      return (n && n.value != null ? n.value : '').trim();
    };
    const gc = (name, r) => {
      const n = r ? r.querySelector(`[name="${name}"]`) : form.elements[name];
      return !!(n && n.checked);
    };

    const embed = {
      title: gv('e_title'), url: gv('e_url'), description: gv('e_desc'), color: gv('e_color'),
      timestamp: gc('e_timestamp'),
      authorName: gv('e_authorName'), authorIcon: gv('e_authorIcon'), authorUrl: gv('e_authorUrl'),
      footerText: gv('e_footerText'), footerIcon: gv('e_footerIcon'),
      thumbnail: gv('e_thumbnail'), image: gv('e_image'),
      fields: $$('#fields .mc-repeat').map((f) => ({
        name: gv('f_name', f), value: gv('f_value', f), inline: gc('f_inline', f),
      })).filter((x) => x.name || x.value),
    };
    const rows = $$('#rows .mc-row').map((row) => {
      if (row.dataset.type === 'roleselect') {
        return {
          type: 'roleselect', placeholder: gv('rs_placeholder', row),
          min: gv('rs_min', row), max: gv('rs_max', row),
          options: $$('.mc-btn', row).map((o) => ({
            label: gv('o_label', o), description: gv('o_desc', o), emoji: gv('o_emoji', o), roleId: gv('o_role', o),
          })).filter((o) => o.label && o.roleId),
        };
      }
      return {
        type: 'buttons',
        buttons: $$('.mc-btn', row).map((b) => ({
          style: gv('b_style', b), label: gv('b_label', b), emoji: gv('b_emoji', b),
          url: gv('b_url', b), roleId: gv('b_role', b),
        })).filter((b) => b.label || b.emoji),
      };
    });
    return { content: ( $('#content').value || '' ).trim(), embeds: [embed], rows };
  }

  // --- preview ---------------------------------------------------
  function update() {
    const s = serialize();
    $('#mc-spec').value = JSON.stringify(s);
    const p = $('#mc-preview');
    const e = s.embeds[0];
    const hasEmbed = e.title || e.description || (e.fields && e.fields.length) || e.image || e.thumbnail || e.authorName || e.footerText;
    let html = '';
    if (s.content) html += `<div class="dc-content">${escapeHtml(s.content).replace(/\n/g, '<br>')}</div>`;
    if (hasEmbed) {
      html += `<div class="dc-embed" style="border-left-color:${/^#[0-9a-f]{6}$/i.test(e.color) ? e.color : '#4aa3df'}">`;
      if (e.authorName) html += `<div class="dc-author">${escapeHtml(e.authorName)}</div>`;
      if (e.title) html += `<div class="dc-title">${escapeHtml(e.title)}</div>`;
      if (e.description) html += `<div class="dc-desc">${escapeHtml(e.description).replace(/\n/g, '<br>')}</div>`;
      if (e.fields && e.fields.length) {
        html += '<div class="dc-fields">' + e.fields.map((f) => `<div class="dc-field${f.inline ? ' inline' : ''}"><b>${escapeHtml(f.name)}</b><div>${escapeHtml(f.value).replace(/\n/g, '<br>')}</div></div>`).join('') + '</div>';
      }
      if (e.image) html += `<img class="dc-image" src="${escapeHtml(e.image)}" alt="">`;
      if (e.footerText) html += `<div class="dc-footer">${escapeHtml(e.footerText)}</div>`;
      html += '</div>';
    }
    const chips = [];
    s.rows.forEach((r) => {
      if (r.type === 'roleselect') chips.push(`<span class="dc-chip">▾ ${escapeHtml(r.placeholder || 'Role select')}</span>`);
      else (r.buttons || []).forEach((b) => chips.push(`<span class="dc-chip ${b.style}">${escapeHtml(b.emoji ? b.emoji + ' ' : '')}${escapeHtml(b.label || 'Button')}</span>`));
    });
    if (chips.length) html += `<div class="dc-components">${chips.join('')}</div>`;
    p.innerHTML = html || '<p class="muted">Nothing yet.</p>';
  }

  update();
})();
