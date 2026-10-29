import { useEffect, useRef, useState } from 'react';
import { useCmd } from '../platformContext.jsx';
import { deleteQuote, getQuotes } from '../api.js';
import { notify } from '../notify.js';
import LoadError from '../components/LoadError.jsx';
import SaveBar from '../components/SaveBar.jsx';
import ChipPicker from '../components/ChipPicker.jsx';
import { useModuleForm } from '../components/useModuleForm.js';
import { limitOf, useModuleLimits } from '../components/useModuleLimits.js';
import { confirmDialog } from '../components/ConfirmDialog.jsx';

const day = (ms) => new Date(ms).toISOString().slice(0, 10);

export default function QuoteBoard() {
  const cmd = useCmd();
  const limits = useModuleLimits('quote-board');
  const { guildId, data, setData, form, baseline, set, status, error, dirty, saving, save, reset } =
    useModuleForm('quote-board');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  // The search the list on screen was fetched with; the config answer comes with the unfiltered one.
  const shown = useRef('');

  useEffect(() => {
    if (shown.current === search) return undefined;
    shown.current = search;
    let live = true;
    const timer = setTimeout(() => {
      getQuotes(guildId, { q: search })
        .then(({ total, quotes }) => live && setData((d) => ({ ...d, total, quotes })))
        .catch((err) => notify(err.message));
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [guildId, search, setData]);

  if (status === 'error') return <LoadError error={error} what="Quote board" />;
  if (status === 'loading') return <p className="v2-state">Loading…</p>;

  async function onRemove(item) {
    const ok = await confirmDialog({
      title: `Remove quote #${item.number}?`,
      body: 'The quote is deleted and its number will not be used again. The original message stays.',
      confirmLabel: 'Remove',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await deleteQuote(guildId, item.number);
      const fresh = await getQuotes(guildId, { q: search });
      setData((d) => ({ ...d, total: fresh.total, quotes: fresh.quotes }));
    } catch (err) {
      notify(err.message);
    } finally {
      setBusy(false);
    }
  }

  const publicUrl = `${window.location.origin}${data.publicPath}`;

  return (
    <>
      <h1 className="v2-section-title">Quote board</h1>
      <p className="v2-field-hint">
        Members save a message with the <strong>Save quote</strong> menu (right-click a message, Apps) or{' '}
        <code>{cmd('/quote save')}</code>, and bring quotes back with <code>{cmd('/quote random')}</code>,{' '}
        <code>{cmd('/quote search')}</code>, <code>{cmd('/quote user')}</code> and{' '}
        <code>{cmd('/quote show')}</code>. Only the text, the author&apos;s name and the date are kept; files
        are counted, never copied.
      </p>

      <form onSubmit={save} data-savebar>
        <div className="v2-field">
          <label className="v2-check">
            <input
              type="checkbox"
              checked={form.publicPage}
              onChange={(e) => set({ publicPage: e.target.checked })}
            />
            Public quote page
          </label>
          <p className="v2-field-hint">
            Anyone with the link can read the latest quotes, without signing in: the text, the author&apos;s
            display name and the date. No IDs and no jump links. Quotes from channels that @everyone cannot
            read are never shown there.
          </p>
          {baseline.publicPage ? (
            <p className="v2-field-hint">
              Link: <a href={publicUrl}>{publicUrl}</a>
            </p>
          ) : null}
        </div>

        <div className="v2-field">
          <label htmlFor="saveMode">Who may save quotes</label>
          <select id="saveMode" value={form.saveMode} onChange={(e) => set({ saveMode: e.target.value })}>
            <option value="everyone">Everyone</option>
            <option value="roles">Staff and the roles below</option>
          </select>
        </div>

        {form.saveMode === 'roles' ? (
          <div className="v2-field">
            <label>Roles that may save</label>
            <ChipPicker
              kind="role"
              items={data.roles}
              value={form.saveRoles}
              onChange={(saveRoles) => set({ saveRoles })}
            />
          </div>
        ) : null}

        <div className="v2-field">
          <label>
            Staff roles{' '}
            <span className="v2-field-hint">
              — may remove any quote (Manage Messages, Manage Server and Administrator always may)
            </span>
          </label>
          <ChipPicker
            kind="role"
            items={data.roles}
            value={form.staffRoles}
            onChange={(staffRoles) => set({ staffRoles })}
          />
        </div>
      </form>

      <div className="v2-group v2-section-gap">
        <h2 className="v2-group-title">
          Quotes ({search ? `${data.quotes.length} of ${data.total}` : data.total})
        </h2>
        <div className="v2-field">
          <label htmlFor="quote-search">Search</label>
          <input
            id="quote-search"
            type="search"
            placeholder="Text or author name"
            maxLength={limitOf(limits, 'query').maxLength}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {data.quotes.length === 0 ? <p className="v2-note">Nothing here yet.</p> : null}
        <div className="v2-list">
          {data.quotes.map((q) => (
            <div className="v2-row" key={q.number}>
              <div className="v2-row-main">
                <h3>
                  #{q.number} · {q.author || 'Unknown'}
                </h3>
                {q.text ? <p>{q.text}</p> : null}
                <p className="v2-field-hint">
                  {day(q.messageAt)}
                  {q.channel ? ` · #${q.channel}` : ''}
                  {q.attachments > 0 ? ` · 📎 ${q.attachments}` : ''}
                  {q.publicSource ? '' : ' · not on the public page'} ·{' '}
                  <a href={q.url} target="_blank" rel="noreferrer">
                    Open message
                  </a>
                </p>
              </div>
              <div className="v2-field-row">
                <button type="button" className="v2-btn-danger" disabled={busy} onClick={() => onRemove(q)}>
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
      <SaveBar dirty={dirty} saving={saving} onSave={save} onReset={reset} />
    </>
  );
}
