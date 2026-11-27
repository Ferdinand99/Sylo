import { parseInline } from '../../../src/lib/changelog.js';

/**
 * A line of text with the inline markdown a server admin writes in a Discord message (**bold**, `code` and
 * [links](https://…)) shown as such. It never makes HTML: the text goes through the same parser as the changelog
 * (src/lib/changelog.js), which hands back plain segments, and a link is only made for an http(s) address.
 */
export default function InlineMarkdown({ text }) {
  return parseInline(String(text ?? '')).map((s, i) => {
    if (s.code) return <code key={i}>{s.code}</code>;
    if (s.href)
      return (
        <a key={i} href={s.href} target="_blank" rel="noopener noreferrer">
          {s.text}
        </a>
      );
    if (s.bold) return <strong key={i}>{s.text}</strong>;
    return <span key={i}>{s.text}</span>;
  });
}
