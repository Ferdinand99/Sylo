import AutoGrowTextarea from '../components/AutoGrowTextarea.jsx';
import HowItWorks from '../components/HowItWorks.jsx';
import MentionTextarea from '../components/MentionTextarea.jsx';
import PlaceholderBar from '../components/PlaceholderBar.jsx';
import PlaceholderHint from '../components/PlaceholderHint.jsx';
import PreviewLayout from '../components/PreviewLayout.jsx';
import LoadError from '../components/LoadError.jsx';
import SaveBar from '../components/SaveBar.jsx';
import { useModuleForm } from '../components/useModuleForm.js';
import { limitOf, useModuleLimits } from '../components/useModuleLimits.js';
import { cardTitle, hostOf } from '../util.js';
import { tokensFor } from '../placeholders.js';
import { rssPreview } from '../alertPreviews.js';
import { focusedRow, useFocusedKey } from '../useFocusedKey.js';
import '../styles/wp2-alerts.css';

// Per-type ref field label/placeholder.
const HINTS = {
  url: ['Feed URL', 'https://example.com/feed.xml'],
  reddit: ['Subreddit or user', 'r/programming or u/spez'],
  mastodon: ['Handle', '@user@mastodon.social'],
  bluesky: ['Handle', 'name.bsky.social'],
};
const TYPE_LABELS = { url: 'RSS / Atom URL', reddit: 'Reddit', mastodon: 'Mastodon', bluesky: 'Bluesky' };

function newKey() {
  return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Math.random());
}

function toFormRow(f = {}) {
  return {
    key: newKey(),
    // Bot-managed: assigned server-side on first save, carried through
    // unmodified after that so posted-item dedup state stays attached to
    // this row rather than resetting.
    id: f.id || '',
    type: f.type || 'url',
    ref: f.ref || '',
    channelId: f.channelId || '',
    roleId: f.roleId || '',
    template: f.template || '',
  };
}

const toForm = (config) => ({ feeds: config.feeds.map(toFormRow) });
const fromForm = (form) => ({
  feeds: form.feeds.map((row) => ({
    id: row.id,
    type: row.type,
    ref: row.ref,
    channelId: row.channelId,
    roleId: row.roleId,
    template: row.template,
  })),
});

export default function RssAlerts() {
  const limits = useModuleLimits('rss');
  const { data, form, setForm, status, error, dirty, saving, save, reset } = useModuleForm('rss', {
    toForm,
    fromForm,
  });
  const [focusedKey, focusProps] = useFocusedKey();

  if (status === 'error') return <LoadError error={error} what="RSS alerts settings" />;
  if (status === 'loading') return <p className="v2-state">Loading…</p>;

  const updateRow = (key, patch) =>
    setForm((f) => ({ ...f, feeds: f.feeds.map((row) => (row.key === key ? { ...row, ...patch } : row)) }));
  const addRow = () => setForm((f) => ({ ...f, feeds: [...f.feeds, toFormRow()] }));
  const removeRow = (key) => setForm((f) => ({ ...f, feeds: f.feeds.filter((row) => row.key !== key) }));

  // The preview follows the feed that was edited last (the first one until another is touched).
  const shown = focusedRow(form.feeds, focusedKey);
  const previews = shown ? [rssPreview(shown, data.defaultTemplate)] : [];

  return (
    <PreviewLayout previews={previews} lookup={{ channels: data.channels, roles: data.roles }}>
      <>
        <h1 className="v2-section-title">RSS alerts</h1>
        <p className="v2-field-hint">
          Sylo checks each feed every few minutes and posts new items to the chosen channel. The source can be
          an RSS or Atom link, or a Reddit, Mastodon or Bluesky handle.
        </p>
        <HowItWorks>
          <p>Sylo turns a handle into that platform's feed for you.</p>
          <p>
            The first check only remembers the items that are already there; anything new after that is
            posted. You can add up to 15 feeds.
          </p>
        </HowItWorks>

        <form onSubmit={save} data-savebar>
          {form.feeds.length === 0 ? <p className="v2-field-hint">No feeds yet — add one below.</p> : null}
          {form.feeds.map((row) => {
            const hint = HINTS[row.type] || HINTS.url;
            return (
              <div className="v2-rule-card" key={row.key} {...focusProps(row.key)}>
                <div className="v2-rule-head">
                  <span className="v2-rule-title">
                    {(row.type === 'url' ? hostOf(row.ref, '') : '') || cardTitle(row.ref, 'Feed')}
                  </span>
                  <button type="button" className="v2-btn-danger-ghost" onClick={() => removeRow(row.key)}>
                    Remove
                  </button>
                </div>

                <div className="v2-field">
                  <label htmlFor={`rss-type-${row.key}`}>Source</label>
                  <select
                    id={`rss-type-${row.key}`}
                    value={row.type}
                    onChange={(e) => updateRow(row.key, { type: e.target.value })}
                  >
                    {data.feedTypes.map((t) => (
                      <option key={t} value={t}>
                        {TYPE_LABELS[t] || t}
                      </option>
                    ))}
                  </select>
                </div>
                {/* The address is the longest thing on the card: it gets the whole row. */}
                <div className="v2-field v2-field-full">
                  <label htmlFor={`rss-ref-${row.key}`}>{hint[0]}</label>
                  <input
                    id={`rss-ref-${row.key}`}
                    type="text"
                    maxLength={limitOf(limits, 'feeds[].ref').maxLength}
                    placeholder={hint[1]}
                    value={row.ref}
                    onChange={(e) => updateRow(row.key, { ref: e.target.value })}
                  />
                </div>

                <div className="v2-field-row">
                  <div className="v2-field">
                    <label htmlFor={`rss-to-${row.key}`}>Announce in</label>
                    <select
                      id={`rss-to-${row.key}`}
                      value={row.channelId}
                      onChange={(e) => updateRow(row.key, { channelId: e.target.value })}
                    >
                      <option value="">— select a channel —</option>
                      {data.channels.map((c) => (
                        <option key={c.id} value={c.id}>
                          #{c.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="v2-field">
                    <label>
                      Ping role <span className="v2-field-hint">— optional</span>
                    </label>
                    <select
                      value={row.roleId}
                      onChange={(e) => updateRow(row.key, { roleId: e.target.value })}
                    >
                      <option value="">— none —</option>
                      {data.roles.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <PlaceholderBar
                  fields={[{ id: `rss-msg-${row.key}`, label: 'Message', tokens: tokensFor('rss') }]}
                />
                <div className="v2-field">
                  <label htmlFor={`rss-msg-${row.key}`}>
                    Message <span className="v2-field-hint">— blank uses the default</span>
                  </label>
                  <MentionTextarea
                    as={AutoGrowTextarea}
                    channels={data.channels}
                    roles={data.roles}
                    id={`rss-msg-${row.key}`}
                    rows={2}
                    maxLength={limitOf(limits, 'feeds[].template').maxLength}
                    placeholder={data.defaultTemplate}
                    value={row.template}
                    onChange={(e) => updateRow(row.key, { template: e.target.value })}
                  />
                  <PlaceholderHint
                    fieldId={`rss-msg-${row.key}`}
                    chips={false}
                    tokens={tokensFor('rss')}
                    value={row.template}
                    onChange={(template) => updateRow(row.key, { template })}
                  />
                </div>
              </div>
            );
          })}
          <button
            type="button"
            className="v2-btn-ghost"
            onClick={addRow}
            disabled={form.feeds.length >= (limitOf(limits, 'feeds').maxItems ?? Infinity)}
          >
            + Add feed
          </button>
        </form>
        <SaveBar dirty={dirty} saving={saving} onSave={save} onReset={reset} />
      </>
    </PreviewLayout>
  );
}
