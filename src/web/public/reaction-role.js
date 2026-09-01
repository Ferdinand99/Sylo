// Reaction-role builder: a single in-place embed editor (shares the .wc-* look
// with the Welcome Channel builder) plus the emoji↔role rows.
(() => {
  const stage = document.getElementById('rr-embed');
  const form = document.getElementById('rr-form');
  if (!stage || !form) return;

  const rr = window.RR || {};
  const embed = rr.embed && typeof rr.embed === 'object' ? rr.embed : { kind: 'embed', color: '#5865f2' };
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

  form.addEventListener('submit', () => {
    collectEmbed();
    document.getElementById('rr-embed-spec').value = JSON.stringify(embed);
  });

  renderEmbed();
})();
