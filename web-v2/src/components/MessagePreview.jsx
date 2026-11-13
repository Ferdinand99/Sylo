import { useOverview } from '../OverviewContext.jsx';
import { previewParts, sampleValues } from '../mentions.js';
import AppTag from './AppTag.jsx';

/** A message template as Discord shows it: sample data in the placeholders, mentions as names. */
function Rendered({ text, lookup, samples }) {
  const parts = previewParts(text, { samples, lookup });
  return parts.map((p, i) => {
    if (p.kind === 'bold') return <strong key={i}>{p.text}</strong>;
    if (p.kind === 'code') return <code key={i}>{p.text}</code>;
    if (p.kind === 'mention')
      return (
        <span key={i} className="v2-msg-mention">
          {p.text}
        </span>
      );
    if (p.kind === 'missing')
      return (
        <span key={i} className="v2-msg-mention is-missing">
          {p.text}
        </span>
      );
    return <span key={i}>{p.text}</span>;
  });
}

/**
 * A read-only, Discord-style preview of one message the bot will send: its text, and an optional embed
 * (title, description, fields, footer). The same look as the message builder, so a person sees the same
 * thing in both. Placeholders are filled with sample data and # / @ mentions show their names.
 *
 *   <MessagePreview content={form.joinMessage} lookup={{ channels, roles }} />
 *   <MessagePreview embed={{ description: form.message }} content={roleMention} />
 *
 * `samples` adds or overrides placeholder values (see mentions.js sampleValues). Nothing here is
 * editable and nothing is sent.
 */
export default function MessagePreview({
  content = '',
  embed = null,
  lookup = {},
  samples = {},
  className = '',
}) {
  const overview = useOverview();
  const server = overview?.data?.guild?.name ?? 'Your server';
  const values = sampleValues({ server, extra: samples });
  const empty = !String(content).trim() && !embed;
  return (
    <div className={`v2-msg-preview v2-msg-readonly${className ? ` ${className}` : ''}`}>
      <div className="v2-msg-head">
        <div className="v2-msg-avatar" aria-hidden="true">
          S
        </div>
        <div className="v2-msg-head-text">
          <span className="v2-msg-botname">Sylo</span>
          <AppTag />
          <span className="v2-msg-time">Today</span>
        </div>
      </div>
      {empty ? <p className="v2-msg-empty">Nothing to send yet.</p> : null}
      {String(content).trim() ? (
        <p className="v2-msg-text">
          <Rendered text={content} lookup={lookup} samples={values} />
        </p>
      ) : null}
      {embed ? (
        <div className="v2-embed-preview v2-embed-readonly">
          <span className="v2-embed-bar" style={{ background: embed.color ?? 'var(--accent)' }} />
          <div className="v2-embed-body">
            {embed.authorName ? <p className="v2-embed-author">{embed.authorName}</p> : null}
            {embed.title ? (
              <p className="v2-embed-title">
                <Rendered text={embed.title} lookup={lookup} samples={values} />
              </p>
            ) : null}
            {embed.description ? (
              <p className="v2-embed-desc">
                <Rendered text={embed.description} lookup={lookup} samples={values} />
              </p>
            ) : null}
            {(embed.fields ?? []).length ? (
              <div className="v2-embed-fields">
                {embed.fields.map((f, i) => (
                  <div key={i} className={`v2-embed-field${f.inline ? ' is-inline' : ''}`}>
                    <strong>{f.name}</strong>
                    <span>{f.value}</span>
                  </div>
                ))}
              </div>
            ) : null}
            {embed.footer ? <p className="v2-embed-footer">{embed.footer}</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
