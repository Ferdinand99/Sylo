// Turns CHANGELOG.md (release-please's format) into plain data for the
// Changelog page. Nothing here produces HTML: inline markdown becomes
// segments ({ text }, { text, href }, { code }, { text, bold }) that React
// renders as text, so a changelog line can never inject markup.

const RELEASE = /^##\s+(?:\[([^\]]+)\]\(([^)]+)\)|(\S+))\s*(?:\((\d{4}-\d{2}-\d{2})\))?/;
const SECTION = /^###\s+(.+?)\s*$/;
const ITEM = /^[*-]\s+(.+)$/;
// "([#261](…/issues/261))" or "(#261)" style PR / issue references.
const PR_REF = /\s*\(\[(#\d+)\]\(([^)]+)\)\)/g;
// "([d8fdf6c](…/commit/d8fdf6c))" — the commit hash adds nothing for readers.
const COMMIT_REF = /\s*\(\[[0-9a-f]{7,40}\]\([^)]+\)\)/g;
const SCOPE = /^\*\*([^*]+?):\*\*\s*/;

const safeHref = (url) => (/^https?:\/\//i.test(url) ? url : null);

/** Inline markdown (links, `code`, **bold**) → render-safe segments. */
export function parseInline(src) {
  const out = [];
  const re = /\[([^\]]+)\]\(([^()\s]+(?:\([^()\s]*\))?)\)|`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m.index > last) out.push({ text: src.slice(last, m.index) });
    if (m[1] !== undefined) {
      const href = safeHref(m[2]);
      out.push(href ? { text: m[1], href } : { text: m[1] });
    } else if (m[3] !== undefined) {
      out.push({ code: m[3] });
    } else {
      out.push({ text: m[4], bold: true });
    }
    last = re.lastIndex;
  }
  if (last < src.length) out.push({ text: src.slice(last) });
  return out;
}

function parseItem(raw) {
  let line = raw.replace(COMMIT_REF, '');
  const refs = [];
  line = line.replace(PR_REF, (_, label, url) => {
    const href = safeHref(url);
    if (href) refs.push({ label, url: href });
    return '';
  });
  let scope = null;
  const scoped = line.match(SCOPE);
  if (scoped) {
    scope = scoped[1];
    line = line.slice(scoped[0].length);
  }
  // Commit subjects start lower-case by convention; on the page they read as sentences.
  const trimmed = line.trim();
  const text = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return { scope, text, segments: parseInline(text), refs };
}

/**
 * @returns {{ version: string, url: string|null, date: string|null,
 *   sections: { title: string, items: ReturnType<typeof parseItem>[] }[] }[]}
 */
export function parseChangelog(md) {
  const releases = [];
  let release = null;
  let section = null;
  for (const line of String(md).split(/\r?\n/)) {
    const r = line.match(RELEASE);
    if (r) {
      release = {
        version: (r[1] ?? r[3]).replace(/^v/, ''),
        url: r[2] ? safeHref(r[2]) : null,
        date: r[4] ?? null,
        sections: [],
      };
      section = null;
      releases.push(release);
      continue;
    }
    if (!release) continue;
    const s = line.match(SECTION);
    if (s) {
      section = { title: s[1], items: [] };
      release.sections.push(section);
      continue;
    }
    const i = line.match(ITEM);
    if (i) {
      if (!section) {
        section = { title: 'Changes', items: [] };
        release.sections.push(section);
      }
      const item = parseItem(i[1]);
      if (item.text) section.items.push(item);
    }
  }
  for (const r of releases) r.sections = r.sections.filter((s) => s.items.length);
  return releases;
}
