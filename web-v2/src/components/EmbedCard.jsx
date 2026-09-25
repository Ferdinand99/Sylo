// One Discord-embed-styled editing card. Originally built for the multi-embed
// Message Creator (pages/MessageBuilder.jsx, `toolbar` prop shown there for
// reordering); extracted here so single-embed module forms — reminders,
// polls, welcome-channel, roles, custom-commands — get the exact same
// click-into-the-preview editing UX via components/EmbedEditor.jsx, instead
// of a second, visually different embed editor.
import ColorPicker from './ColorPicker.jsx';

const URL_RE = /^https?:\/\/\S+$/i;

export function pickImage(current) {
  const u = window.prompt('Image URL (https://…). Leave blank to remove.', current || '');
  if (u === null) return current;
  const trimmed = String(u).trim();
  return URL_RE.test(trimmed) ? trimmed : '';
}

// Auto-growing so a long title/description doesn't scroll inside its own
// tiny box — it should just make the "message" taller, like Discord itself.
export function autoGrow(e) {
  e.target.style.height = 'auto';
  e.target.style.height = `${e.target.scrollHeight}px`;
}

export function AvatarPick({ value, onChange, title }) {
  return (
    <button
      type="button"
      className="v2-embed-avatar-pick"
      title={title}
      onClick={() => onChange(pickImage(value))}
    >
      {value ? <img src={value} alt="" /> : null}
    </button>
  );
}

let uid = 0;
export const newKey = (prefix) => `${prefix}${uid++}`;

function ToolIcon({ name }) {
  const paths = {
    up: <polyline points="18 15 12 9 6 15" />,
    down: <polyline points="6 9 12 15 18 9" />,
    copy: (
      <>
        <rect x="9" y="9" width="12" height="12" rx="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </>
    ),
    trash: (
      <>
        <path d="M3 6h18" />
        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      </>
    ),
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
}

// Move up/down/duplicate/delete row shown on hover — shared by EmbedCard and
// welcome-channel's banner blocks (moduleForms/WelcomeChannel.jsx), since
// both are items in a reorderable list.
export function EmbedToolbar({ toolbar }) {
  if (!toolbar) return null;
  return (
    <div className="v2-embed-toolbar">
      <button type="button" title="Move up" disabled={toolbar.index === 0} onClick={() => toolbar.onMove(-1)}>
        <ToolIcon name="up" />
      </button>
      <button
        type="button"
        title="Move down"
        disabled={toolbar.index === toolbar.count - 1}
        onClick={() => toolbar.onMove(1)}
      >
        <ToolIcon name="down" />
      </button>
      <button type="button" title="Duplicate" onClick={toolbar.onDuplicate}>
        <ToolIcon name="copy" />
      </button>
      <button type="button" title="Delete" onClick={toolbar.onRemove}>
        <ToolIcon name="trash" />
      </button>
    </div>
  );
}

export default function EmbedCard({
  embed,
  onChange,
  author = true,
  description = true,
  fields = true,
  thumb = true,
  footerIcon = true,
  footerKey = 'footerText',
  timestamp = false,
  fixedBody = null,
  placeholders = {},
  toolbar = null,
  onFieldFocus = null,
}) {
  const set = (patch) => onChange({ ...embed, ...patch });
  const setField = (key, patch) =>
    onChange({ ...embed, fields: embed.fields.map((f) => (f.key === key ? { ...f, ...patch } : f)) });
  const addField = () =>
    onChange({
      ...embed,
      fields: [...embed.fields, { key: newKey('f'), name: '', value: '', inline: false }],
    });
  const removeField = (key) => onChange({ ...embed, fields: embed.fields.filter((f) => f.key !== key) });
  const footer = embed[footerKey] ?? '';
  const setFooter = (v) => onChange({ ...embed, [footerKey]: v });

  return (
    <div className="v2-embed-preview">
      <EmbedToolbar toolbar={toolbar} />

      <div className="v2-embed-bar" style={{ background: embed.color }} />

      <div className="v2-embed-body">
        <ColorPicker value={embed.color} onChange={(color) => set({ color })} />
        <div className="v2-embed-top">
          <div className="v2-embed-main">
            {author ? (
              <div className="v2-embed-author-row">
                <AvatarPick
                  value={embed.authorIcon}
                  onChange={(v) => set({ authorIcon: v })}
                  title="Author icon"
                />
                <input
                  className="v2-embed-input v2-embed-author"
                  placeholder={placeholders.author || 'Author name'}
                  maxLength={256}
                  value={embed.authorName}
                  onChange={(e) => set({ authorName: e.target.value })}
                  onFocus={() => onFieldFocus?.('authorName')}
                />
              </div>
            ) : null}

            <input
              className="v2-embed-input v2-embed-title"
              placeholder={placeholders.title || 'Title'}
              maxLength={256}
              value={embed.title}
              onChange={(e) => set({ title: e.target.value })}
              onFocus={() => onFieldFocus?.('title')}
            />
            {description ? (
              <textarea
                className="v2-embed-input v2-embed-desc"
                placeholder={placeholders.description || 'Write your message here!'}
                rows={1}
                maxLength={4096}
                value={embed.description}
                onChange={(e) => {
                  autoGrow(e);
                  set({ description: e.target.value });
                }}
                onFocus={(e) => {
                  autoGrow(e);
                  onFieldFocus?.('description');
                }}
              />
            ) : null}

            {fixedBody}

            {fields ? (
              <>
                {embed.fields.length > 0 ? (
                  <div className="v2-embed-fields-grid">
                    {embed.fields.map((f) => (
                      <div className="v2-embed-field-block" key={f.key}>
                        <button
                          type="button"
                          className="v2-embed-field-remove"
                          onClick={() => removeField(f.key)}
                        >
                          ✕
                        </button>
                        <input
                          className="v2-embed-input v2-embed-field-name"
                          placeholder="Field name"
                          maxLength={256}
                          value={f.name}
                          onChange={(e) => setField(f.key, { name: e.target.value })}
                        />
                        <input
                          className="v2-embed-input v2-embed-field-value"
                          placeholder="Field value"
                          maxLength={1024}
                          value={f.value}
                          onChange={(e) => setField(f.key, { value: e.target.value })}
                        />
                      </div>
                    ))}
                  </div>
                ) : null}
                <button type="button" className="v2-embed-addfield" onClick={addField}>
                  + Add field
                </button>
              </>
            ) : null}
          </div>

          {thumb ? (
            <button
              type="button"
              className={`v2-embed-thumb-pick${embed.thumbnail ? ' has' : ''}`}
              onClick={() => set({ thumbnail: pickImage(embed.thumbnail) })}
            >
              {embed.thumbnail ? <img src={embed.thumbnail} alt="" /> : <span>+ thumbnail</span>}
            </button>
          ) : null}
        </div>

        <button
          type="button"
          className={`v2-embed-image-pick${embed.image ? ' has' : ''}`}
          onClick={() => set({ image: pickImage(embed.image) })}
        >
          {embed.image ? <img src={embed.image} alt="" /> : <span>+ Add an image</span>}
        </button>

        <div className="v2-embed-footer-row">
          {footerIcon ? (
            <AvatarPick
              value={embed.footerIcon}
              onChange={(v) => set({ footerIcon: v })}
              title="Footer icon"
            />
          ) : null}
          <input
            className="v2-embed-input v2-embed-footer"
            placeholder={placeholders.footer || 'Footer text'}
            maxLength={2048}
            value={footer}
            onChange={(e) => setFooter(e.target.value)}
            onFocus={() => onFieldFocus?.(footerKey)}
          />
        </div>

        {timestamp ? (
          <label className="v2-check u-mt-2">
            <input
              type="checkbox"
              checked={Boolean(embed.timestamp)}
              onChange={(e) => set({ timestamp: e.target.checked })}
            />
            Show the current time in the footer
          </label>
        ) : null}
      </div>
    </div>
  );
}
