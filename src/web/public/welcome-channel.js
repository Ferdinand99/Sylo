// Welcome Channel builder — an in-place (WYSIWYG) editor: each element renders
// as a live Discord embed you edit directly. Serialises into #wc-spec on submit.
(() => {
  const stage = document.getElementById('wc-stage');
  if (!stage) return;

  const presets = window.WC_PRESETS || [];
  const spec = window.WC_SPEC && typeof window.WC_SPEC === 'object' ? window.WC_SPEC : { content: '', embeds: [] };
  spec.embeds = Array.isArray(spec.embeds) ? spec.embeds : [];

  const HEX = /^#[0-9a-f]{6}$/i;
  const $content = document.getElementById('wc-content');
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const askUrl = (cur) => {
    const u = window.prompt('Image URL (https://…). Leave blank to remove.', cur || '');
    if (u === null) return cur || '';
    const t = u.trim();
    return /^https?:\/\/\S+$/i.test(t) ? t : '';
  };
  const ed = (k, val, ph, cls) =>
    `<div class="wc-ed ${cls || ''}" contenteditable="plaintext-only" data-k="${k}" data-ph="${esc(ph)}">${esc(val || '')}</div>`;
  const iconBtn = (key, val) =>
    `<button type="button" class="wc-icon${val ? ' has' : ''}" data-img="${key}"${
      val ? ` style="background-image:url('${esc(val)}')"` : ''
    }></button>`;

  function embedBlock(e, i) {
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

  function bannerBlock(e, i) {
    const color = HEX.test(e.color) ? e.color : '#5865f2';
    return `<div class="wc-embed wc-isbanner" data-i="${i}" style="--wc-color:${color}">
      <div class="wc-tools">
        <button type="button" data-up title="Move up">▲</button>
        <button type="button" data-down title="Move down">▼</button>
        <button type="button" data-del title="Delete">✕</button>
      </div>
      <button type="button" class="wc-image wc-image-lg${e.image ? ' has' : ''}" data-img="image">${
        e.image ? `<img src="${esc(e.image)}" alt="">` : '<span>＋ Add a banner image</span>'
      }</button>
      ${ed('description', e.description, 'Caption (optional)')}
    </div>`;
  }

  function render() {
    stage.innerHTML = spec.embeds.length
      ? spec.embeds.map((e, i) => (e.kind === 'banner' ? bannerBlock(e, i) : embedBlock(e, i))).join('')
      : '<p class="muted wc-empty">No elements yet — pick one from “Add element” below.</p>';
  }

  function collect() {
    spec.content = $content.value;
    stage.querySelectorAll('.wc-embed').forEach((el) => {
      const e = spec.embeds[Number(el.dataset.i)];
      if (!e) return;
      el.querySelectorAll('.wc-ed[data-k]').forEach((f) => {
        const k = f.dataset.k;
        if (k === 'fname' || k === 'fvalue') return; // per-field, handled below
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

  // add-element cards
  document.getElementById('wc-add-grid').innerHTML = presets
    .map(
      (p) =>
        `<button type="button" class="wc-add-card" data-preset="${p.id}"><b>${esc(p.label)}</b><span class="wc-add-mini wc-add-${p.kind}"></span></button>`
    )
    .join('');

  document.getElementById('wc-add-grid').addEventListener('click', (ev) => {
    const card = ev.target.closest('.wc-add-card');
    if (!card) return;
    const p = presets.find((x) => x.id === card.dataset.preset);
    if (!p || spec.embeds.length >= 10) return;
    collect();
    spec.embeds.push(Object.assign({ kind: p.kind }, p.defaults || {}));
    render();
  });

  stage.addEventListener('input', collect);

  stage.addEventListener('change', (ev) => {
    if (ev.target.classList.contains('wc-color')) collect();
  });

  stage.addEventListener('click', (ev) => {
    const block = ev.target.closest('.wc-embed');
    if (!block) return;
    const i = Number(block.dataset.i);
    const e = spec.embeds[i];
    const btn = ev.target.closest('button');
    if (!btn || !e) return;

    if (btn.dataset.img) {
      collect();
      e[btn.dataset.img] = askUrl(e[btn.dataset.img]);
      render();
    } else if (btn.hasAttribute('data-del')) {
      collect();
      spec.embeds.splice(i, 1);
      render();
    } else if (btn.hasAttribute('data-up') && i > 0) {
      collect();
      [spec.embeds[i - 1], spec.embeds[i]] = [spec.embeds[i], spec.embeds[i - 1]];
      render();
    } else if (btn.hasAttribute('data-down') && i < spec.embeds.length - 1) {
      collect();
      [spec.embeds[i + 1], spec.embeds[i]] = [spec.embeds[i], spec.embeds[i + 1]];
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

  document.getElementById('wc-reset').addEventListener('click', () => {
    if (!window.confirm('Clear all elements and the message text?')) return;
    spec.embeds = [];
    $content.value = '';
    render();
  });

  document.getElementById('wc-form').addEventListener('submit', () => {
    collect();
    document.getElementById('wc-spec').value = JSON.stringify(spec);
  });

  render();
})();
