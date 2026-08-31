// Embed-message builder: a WYSIWYG multi-embed editor (shares the .wc-* Discord
// preview look with the Welcome Channel builder) plus an optional list of link
// buttons. Serialises { content, embeds, rows } into #mb-spec on submit.
(() => {
  const stage = document.getElementById('mb-stage');
  const form = document.getElementById('mb-form');
  if (!stage || !form) return;

  const $content = document.getElementById('mb-content');
  const linksEl = document.getElementById('mb-links');
  const HEX = /^#[0-9a-f]{6}$/i;

  const spec = window.MB && typeof window.MB === 'object' ? window.MB : {};
  const embeds = Array.isArray(spec.embeds) ? spec.embeds : [];
  // Preserve any non-link component rows (e.g. role selects) untouched.
  const keepRows = (Array.isArray(spec.rows) ? spec.rows : []).filter(
    (r) => r.type !== 'buttons' || (r.buttons || []).some((b) => b.style !== 'link')
  );
  const linkButtons = (Array.isArray(spec.rows) ? spec.rows : [])
    .flatMap((r) => (r.type === 'buttons' ? r.buttons || [] : []))
    .filter((b) => b.style === 'link' || b.url)
    .map((b) => ({ label: b.label || '', url: b.url || '', emoji: b.emoji || '' }));

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

  function block(e, i) {
    const color = HEX.test(e.color) ? e.color : '#5865f2';
    const fields = (e.fields || [])
      .map(
        (f, fi) => `<div class="wc-field" data-fi="${fi}">
          <div class="wc-ed wc-fname" contenteditable="plaintext-only" data-k="fname" data-ph="Field name">${esc(f.name || '')}</div>
          <div class="wc-ed wc-fval" contenteditable="plaintext-only" data-k="fvalue" data-ph="Field value">${esc(f.value || '')}</div>
          <button type="button" class="wc-x" data-delfield title="Remove field">×</button>
        </div>`
      )
      .join('');
    return `<div class="wc-embed" data-i="${i}" style="--wc-color:${color}">
      <div class="wc-tools">
        <button type="button" data-up title="Move up">▲</button>
        <button type="button" data-down title="Move down">▼</button>
        <button type="button" data-del title="Delete">✕</button>
      </div>
      <label class="wc-colorwrap" title="Embed colour"><input type="color" class="wc-color" value="${color}" /></label>
      <button type="button" class="wc-thumb${e.thumbnail ? ' has' : ''}" data-img="thumbnail">${
        e.thumbnail ? `<img src="${esc(e.thumbnail)}" alt="">` : '<span>thumb</span>'
      }</button>
      <div class="wc-embed-body">
        <div class="wc-row">${iconBtn('authorIcon', e.authorIcon)}${ed('authorName', e.authorName, 'Header')}</div>
        ${ed('title', e.title, 'Title', 'wc-title')}
        ${ed('description', e.description, 'Description', 'wc-desc')}
        <div class="wc-fields">${fields}</div>
        <button type="button" class="wc-addfield" data-addfield>+ Add new field</button>
        <button type="button" class="wc-image${e.image ? ' has' : ''}" data-img="image">${
          e.image ? `<img src="${esc(e.image)}" alt="">` : '<span>＋ Add an image</span>'
        }</button>
        <div class="wc-row wc-footrow">${iconBtn('footerIcon', e.footerIcon)}${ed('footerText', e.footerText, 'Footer')}</div>
      </div>
    </div>`;
  }

  function render() {
    stage.innerHTML = embeds.length
      ? embeds.map(block).join('')
      : '<p class="muted wc-empty">No embeds yet — “Add embed” below.</p>';
  }

  function collect() {
    stage.querySelectorAll('.wc-embed').forEach((el) => {
      const e = embeds[Number(el.dataset.i)];
      if (!e) return;
      el.querySelectorAll('.wc-ed[data-k]').forEach((f) => {
        const k = f.dataset.k;
        if (k === 'fname' || k === 'fvalue') return;
        e[k] = f.textContent.trim();
      });
      const c = el.querySelector('.wc-color');
      if (c) e.color = c.value;
      e.fields = [...el.querySelectorAll('.wc-field')]
        .map((fr) => ({
          name: fr.querySelector('.wc-fname')?.textContent.trim() || '',
          value: fr.querySelector('.wc-fval')?.textContent.trim() || '',
          inline: false,
        }))
        .filter((f) => f.name || f.value);
    });
  }

  stage.addEventListener('input', collect);
  stage.addEventListener('change', (ev) => {
    if (ev.target.classList.contains('wc-color')) collect();
  });
  stage.addEventListener('click', (ev) => {
    const wrap = ev.target.closest('.wc-embed');
    if (!wrap) return;
    const i = Number(wrap.dataset.i);
    const e = embeds[i];
    const btn = ev.target.closest('button');
    if (!btn || !e) return;
    if (btn.dataset.img) {
      collect();
      e[btn.dataset.img] = askUrl(e[btn.dataset.img]);
      render();
    } else if (btn.hasAttribute('data-del')) {
      collect();
      embeds.splice(i, 1);
      render();
    } else if (btn.hasAttribute('data-up') && i > 0) {
      collect();
      [embeds[i - 1], embeds[i]] = [embeds[i], embeds[i - 1]];
      render();
    } else if (btn.hasAttribute('data-down') && i < embeds.length - 1) {
      collect();
      [embeds[i + 1], embeds[i]] = [embeds[i], embeds[i + 1]];
      render();
    } else if (btn.hasAttribute('data-addfield')) {
      collect();
      (e.fields = e.fields || []).push({ name: '', value: '' });
      render();
    } else if (btn.hasAttribute('data-delfield')) {
      collect();
      e.fields.splice(Number(btn.closest('.wc-field').dataset.fi), 1);
      render();
    }
  });

  document.getElementById('mb-add').addEventListener('click', () => {
    if (embeds.length >= 10) return;
    collect();
    embeds.push({ color: '#5865f2' });
    render();
  });

  // --- link buttons ---------------------------------------------------
  function linkRow(b = {}) {
    const row = document.createElement('div');
    row.className = 'mb-link';
    row.innerHTML = `
      <input type="text" class="mb-l-label" placeholder="Label" maxlength="80" value="${esc(b.label)}" />
      <input type="text" class="mb-l-emoji" placeholder="emoji" maxlength="64" value="${esc(b.emoji)}" />
      <input type="text" class="mb-l-url" placeholder="https://…" value="${esc(b.url)}" />
      <button type="button" class="wc-x" data-dellink title="Remove">×</button>`;
    return row;
  }
  linksEl.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-dellink]')) ev.target.closest('.mb-link').remove();
  });
  document.getElementById('mb-addlink').addEventListener('click', () => {
    if (linksEl.querySelectorAll('.mb-link').length >= 5) return;
    linksEl.appendChild(linkRow());
  });
  linkButtons.forEach((b) => linksEl.appendChild(linkRow(b)));

  function serialiseLinks() {
    const buttons = [...linksEl.querySelectorAll('.mb-link')]
      .map((r) => ({
        style: 'link',
        label: r.querySelector('.mb-l-label').value.trim(),
        emoji: r.querySelector('.mb-l-emoji').value.trim(),
        url: r.querySelector('.mb-l-url').value.trim(),
      }))
      .filter((b) => b.url && (b.label || b.emoji));
    return buttons.length ? [...keepRows, { type: 'buttons', buttons }] : keepRows;
  }

  form.addEventListener('submit', () => {
    collect();
    document.getElementById('mb-spec').value = JSON.stringify({
      content: ($content.value || '').trim(),
      embeds,
      rows: serialiseLinks(),
    });
  });

  render();
})();
