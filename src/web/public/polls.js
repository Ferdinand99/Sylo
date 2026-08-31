// Polls: two in-place embed editors (Polls message + Results message) that
// share the .wc-* Discord-preview look with the Welcome Channel / Reaction Role
// builders. Each edits { content, title, color, footer, image }; the poll body
// (question / choices / ends / mode) is filled by the bot and shown greyed out.
(() => {
  const form = document.getElementById('polls-form');
  if (!form || !window.POLLS) return;

  const HEX = /^#[0-9a-f]{6}$/i;
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const askUrl = (cur) => {
    const u = window.prompt('Image URL (https://…). Leave blank to remove.', cur || '');
    if (u === null) return cur || '';
    const t = u.trim();
    return /^https?:\/\/\S+$/i.test(t) ? t : '';
  };

  const BODY = {
    pm: `<div class="poll-body">
      <div class="poll-body-q">{question}</div>
      <div>🇦&nbsp; First option</div><div>🇧&nbsp; Second option</div><div>🇨&nbsp; …</div>
      <div class="muted small" style="margin-top:6px">Sylo fills the question &amp; choices here</div>
    </div>`,
    rm: `<div class="poll-body">
      <div class="poll-body-q">{question}</div>
      <div>🇦&nbsp; <b>First option</b><br>██████░░░░  60.0% · 6 votes</div>
      <div>🇧&nbsp; <b>Second option</b><br>████░░░░░░  40.0% · 4 votes</div>
      <div class="muted small" style="margin-top:6px">Sylo fills the results here</div>
    </div>`,
  };

  function build(key) {
    const stage = document.getElementById(`${key}-stage`);
    const hidden = document.getElementById(`${key}-json`);
    if (!stage || !hidden) return null;

    const model = Object.assign({ content: '', title: '', color: '#5b7cfa', footer: '', image: '' }, window.POLLS[key] || {});
    if (!HEX.test(model.color)) model.color = '#5b7cfa';

    const ed = (k, ph, cls) =>
      `<div class="wc-ed ${cls || ''}" contenteditable="plaintext-only" data-k="${k}" data-ph="${esc(ph)}">${esc(model[k] || '')}</div>`;

    function render() {
      stage.innerHTML = `
        ${ed('content', 'Message above the embed — optional', 'poll-content')}
        <div class="wc-embed" style="--wc-color:${HEX.test(model.color) ? model.color : '#5b7cfa'}">
          <label class="wc-colorwrap" title="Embed colour"><input type="color" class="wc-color" value="${
            HEX.test(model.color) ? model.color : '#5b7cfa'
          }" /></label>
          <div class="wc-embed-body">
            ${ed('title', key === 'rm' ? '📊 Results — {question}' : '📊 {question}', 'wc-title')}
            ${BODY[key]}
            <button type="button" class="wc-image${model.image ? ' has' : ''}" data-img>${
              model.image ? `<img src="${esc(model.image)}" alt="">` : '<span>＋ Add an image</span>'
            }</button>
            <div class="wc-row wc-footrow">${ed('footer', key === 'rm' ? 'Winner: {winner} · {total} total votes' : '{ends} · {mode}')}</div>
          </div>
        </div>`;
    }

    function collect() {
      stage.querySelectorAll('.wc-ed[data-k]').forEach((el) => {
        model[el.dataset.k] = el.textContent.trim();
      });
      const c = stage.querySelector('.wc-color');
      if (c) model.color = c.value;
    }

    stage.addEventListener('input', collect);
    stage.addEventListener('change', (e) => {
      if (e.target.classList.contains('wc-color')) collect();
    });
    stage.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-img]');
      if (!btn) return;
      collect();
      model.image = askUrl(model.image);
      render();
    });

    render();
    return { model, collect, serialise: () => (collect(), (hidden.value = JSON.stringify(model))) };
  }

  const editors = ['pm', 'rm'].map(build).filter(Boolean);

  // Variable chips → insert token into the last-focused editable field.
  let lastField = null;
  document.addEventListener('focusin', (e) => {
    if (e.target.classList?.contains('wc-ed')) lastField = e.target;
  });
  form.querySelectorAll('.poll-vars').forEach((row) => {
    row.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-var]');
      if (!b) return;
      const scope = document.getElementById(`${row.dataset.for}-stage`);
      const target = lastField && scope.contains(lastField) ? lastField : scope.querySelector('.wc-title');
      if (!target) return;
      target.textContent = (target.textContent + (target.textContent ? ' ' : '') + b.dataset.var).trim();
      target.dispatchEvent(new Event('input', { bubbles: true }));
    });
  });

  form.addEventListener('submit', () => editors.forEach((ed) => ed.serialise()));
})();
