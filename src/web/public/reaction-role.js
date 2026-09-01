// Reaction-role builder: a single in-place embed editor (shares the .wc-* look
// with the Welcome Channel builder) plus the emoji↔role rows.
(() => {
  const stage = document.getElementById('rr-embed');
  const form = document.getElementById('rr-form');
  if (!stage || !form) return;

  const rr = window.RR || {};
  const embed = rr.embed && typeof rr.embed === 'object' ? rr.embed : { kind: 'embed', color: '#5865f2' };
  const rolesList = window.RR_ROLES || [];
  const guildId = window.RR_GUILD || '';
  const HEX = /^#[0-9a-f]{6}$/i;

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const askUrl = (cur) => {
    const u = window.prompt('Image URL (https://…). Leave blank to remove.', cur || '');
    if (u === null) return cur || '';
    const t = u.trim();
    return /^https?:\/\/\S+$/i.test(t) ? t : '';
  };
  const ed = (k, v, ph, cls) =>
    `<div class="wc-ed ${cls || ''}" contenteditable="plaintext-only" data-k="${k}" data-ph="${esc(ph)}">${esc(v || '')}</div>`;
  const iconBtn = (k, v) =>
    `<button type="button" class="wc-icon${v ? ' has' : ''}" data-img="${k}"${
      v ? ` style="background-image:url('${esc(v)}')"` : ''
    }></button>`;

  function renderEmbed() {
    const color = HEX.test(embed.color) ? embed.color : '#5865f2';
    const fields = (embed.fields || [])
      .map(
        (f, fi) => `<div class="wc-field" data-fi="${fi}">
          <div class="wc-ed wc-fname" contenteditable="plaintext-only" data-k="fname" data-ph="Field name">${esc(f.name || '')}</div>
          <div class="wc-ed wc-fval" contenteditable="plaintext-only" data-k="fvalue" data-ph="Field value">${esc(f.value || '')}</div>
          <button type="button" class="wc-x" data-delfield title="Remove field">×</button>
        </div>`
      )
      .join('');
    stage.innerHTML = `<div class="wc-embed" style="--wc-color:${color}">
      <label class="wc-colorwrap" title="Embed colour"><input type="color" class="wc-color" value="${color}" /></label>
      <button type="button" class="wc-thumb${embed.thumbnail ? ' has' : ''}" data-img="thumbnail">${
        embed.thumbnail ? `<img src="${esc(embed.thumbnail)}" alt="">` : '<span>thumb</span>'
      }</button>
      <div class="wc-embed-body">
        <div class="wc-row">${iconBtn('authorIcon', embed.authorIcon)}${ed('authorName', embed.authorName, 'Header')}</div>
        ${ed('title', embed.title, 'Title', 'wc-title')}
        ${ed('description', embed.description, 'Description', 'wc-desc')}
        <div class="wc-fields">${fields}</div>
        <button type="button" class="wc-addfield" data-addfield>+ Add new field</button>
        <button type="button" class="wc-image${embed.image ? ' has' : ''}" data-img="image">${
          embed.image ? `<img src="${esc(embed.image)}" alt="">` : '<span>＋ Add an image</span>'
        }</button>
        <div class="wc-row wc-footrow">${iconBtn('footerIcon', embed.footerIcon)}${ed('footerText', embed.footerText, 'Footer')}</div>
      </div>
    </div>`;
  }

  function collectEmbed() {
    stage.querySelectorAll('.wc-ed[data-k]').forEach((f) => {
      const k = f.dataset.k;
      if (k === 'fname' || k === 'fvalue') return;
      embed[k] = f.textContent.trim();
    });
    const c = stage.querySelector('.wc-color');
    if (c) embed.color = c.value;
    embed.fields = [...stage.querySelectorAll('.wc-field')]
      .map((fr) => ({
        name: fr.querySelector('.wc-fname')?.textContent.trim() || '',
        value: fr.querySelector('.wc-fval')?.textContent.trim() || '',
        inline: false,
      }))
      .filter((f) => f.name || f.value);
  }

  stage.addEventListener('input', collectEmbed);
  stage.addEventListener('change', (e) => {
    if (e.target.classList.contains('wc-color')) collectEmbed();
  });
  stage.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.img) {
      collectEmbed();
      embed[btn.dataset.img] = askUrl(embed[btn.dataset.img]);
      renderEmbed();
    } else if (btn.hasAttribute('data-addfield')) {
      collectEmbed();
      (embed.fields = embed.fields || []).push({ name: '', value: '' });
      renderEmbed();
    } else if (btn.hasAttribute('data-delfield')) {
      collectEmbed();
      embed.fields.splice(Number(btn.closest('.wc-field').dataset.fi), 1);
      renderEmbed();
    }
  });

  // --- style toggle (reactions / buttons / dropdown) ------------------
  const rowsEl = document.getElementById('rr-rows');
  const countEl = document.getElementById('rr-count');
  const maxEl = document.getElementById('rr-max');
  const rowsTitle = document.getElementById('rr-rows-title');
  const addBtn = document.getElementById('rr-add');
  const roleOptions = rolesList.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('');
  const BTN_STYLES = ['secondary', 'primary', 'success', 'danger'];

  const styleOf = () => form.dataset.style || 'reaction';
  const maxRows = () => (styleOf() === 'reaction' ? 20 : 25);

  function applyStyle() {
    const s = styleOf();
    maxEl.textContent = maxRows();
    rowsTitle.textContent = s === 'reaction' ? 'Reactions & roles' : s === 'buttons' ? 'Buttons & roles' : 'Menu options';
    addBtn.textContent = s === 'reaction' ? '＋ Add reaction' : s === 'buttons' ? '＋ Add button' : '＋ Add option';
    document.querySelectorAll('[class*="rr-when-"]').forEach((el) => {
      el.hidden = ![...el.classList].some((c) => c === `rr-when-${s}`);
    });
    rowsEl.querySelectorAll('.rr-row').forEach((row) => decorateRow(row, s));
  }

  function decorateRow(row, s) {
    row.querySelector('.rr-emoji').placeholder = s === 'reaction' ? '👋 (required)' : '👋 (optional)';
    row.querySelector('.rr-row-label').hidden = s === 'reaction';
    row.querySelector('.rr-row-btnstyle').hidden = s !== 'buttons';
  }

  form.querySelectorAll('input[name="rr_style"]').forEach((r) =>
    r.addEventListener('change', () => {
      if (r.checked) {
        form.dataset.style = r.value;
        applyStyle();
      }
    })
  );

  // --- emoji / label / role rows -------------------------------------
  const updateCount = () => {
    countEl.textContent = rowsEl.children.length;
  };
  function addRow(p = {}) {
    if (rowsEl.children.length >= maxRows()) return;
    const row = document.createElement('div');
    row.className = 'rr-row';
    row.innerHTML = `
      <input type="text" name="rr_emoji" class="rr-emoji" value="${esc(p.display || '')}" />
      <button type="button" class="emoji-btn" data-guild="${esc(guildId)}">😀</button>
      <input type="text" name="rr_label" class="rr-row-label" value="${esc(p.label || '')}" placeholder="Button label (optional)" maxlength="80" hidden />
      <select name="rr_role"><option value="">— select a role —</option>${roleOptions}</select>
      <select name="rr_btnstyle" class="rr-row-btnstyle" hidden>${BTN_STYLES.map(
        (b) => `<option value="${b}"${(p.btnStyle || 'secondary') === b ? ' selected' : ''}>${b}</option>`
      ).join('')}</select>
      <button type="button" class="wc-x" data-delrow title="Remove">×</button>`;
    if (p.roleId) row.querySelector('select[name="rr_role"]').value = p.roleId;
    rowsEl.appendChild(row);
    decorateRow(row, styleOf());
    updateCount();
  }
  rowsEl.addEventListener('click', (e) => {
    const d = e.target.closest('[data-delrow]');
    if (d) {
      d.closest('.rr-row').remove();
      updateCount();
    }
  });
  addBtn.addEventListener('click', () => addRow());

  (rr.pairs || []).forEach((p) => addRow(p));
  if (!(rr.pairs || []).length) addRow();
  applyStyle();

  form.addEventListener('submit', () => {
    collectEmbed();
    document.getElementById('rr-embed-spec').value = JSON.stringify(embed);
  });

  renderEmbed();
})();
