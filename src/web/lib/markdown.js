// Tiny, dependency-free Markdown -> HTML converter for roadmap suggestion
// descriptions — member-submitted text, so every code path here treats it as
// untrusted: HTML is escaped *before* any markdown syntax is applied, and
// link targets are scheme-checked, so there's no way raw HTML or a
// `javascript:` URL survives into the rendered page. Deliberately small —
// bold/italic/inline code/links, one level of `- ` bullet lists, and
// paragraph breaks. Not a general-purpose parser (no headings, tables, or
// nested lists) — mirrors the same "just enough" approach as
// site/docs.js's converter, for the same reason: it only has to cover what a
// short suggestion actually needs.

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function safeHref(url) {
  return /^https?:\/\//i.test(url) ? url : null;
}

// Private-use-area markers (never typed by a human, so they can't collide
// with real message content) stand in for code spans while the rest of the
// inline syntax is processed, then get swapped back for real <code> tags.
const CODE_MARK_START = '';
const CODE_MARK_END = '';

function renderInline(raw) {
  const codeSpans = [];
  let text = raw.replace(/`([^`]+)`/g, (_, code) => {
    codeSpans.push(escapeHtml(code));
    return `${CODE_MARK_START}${codeSpans.length - 1}${CODE_MARK_END}`;
  });

  text = escapeHtml(text);

  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label, url) => {
    const href = safeHref(url);
    return href ? `<a href="${href}" target="_blank" rel="noopener">${label}</a>` : whole;
  });
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(?<![*\w])_([^_]+)_(?!\w)/g, '<em>$1</em>');
  text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  const markRe = new RegExp(`${CODE_MARK_START}(\\d+)${CODE_MARK_END}`, 'g');
  text = text.replace(markRe, (_, idx) => `<code>${codeSpans[idx]}</code>`);
  return text;
}

/** Render a short, untrusted piece of Markdown to safe HTML. */
export function mdToHtml(raw) {
  const lines = String(raw ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  const blocks = [];
  let para = [];
  let list = null;

  const flushPara = () => {
    if (para.length) {
      blocks.push(`<p>${renderInline(para.join(' '))}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push(`<ul>${list.map((item) => `<li>${renderInline(item)}</li>`).join('')}</ul>`);
      list = null;
    }
  };

  for (const line of lines) {
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) {
      flushPara();
      (list ??= []).push(bullet[1]);
    } else if (line.trim() === '') {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();

  return blocks.join('');
}
