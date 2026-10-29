import { useEffect, useRef, useState } from 'react';
import { useCmd } from '../platformContext.jsx';
import { decideSuggestion, deleteSuggestion, getSuggestions } from '../api.js';
import { notify } from '../notify.js';
import LoadError from '../components/LoadError.jsx';
import SaveBar from '../components/SaveBar.jsx';
import ChipPicker from '../components/ChipPicker.jsx';
import { useModuleForm } from '../components/useModuleForm.js';
import { limitOf, useModuleLimits } from '../components/useModuleLimits.js';
import { confirmDialog } from '../components/ConfirmDialog.jsx';

const STATUS_LABEL = {
  open: '⏳ Open',
  considering: '🤔 Considering',
  approved: '✅ Approved',
  denied: '❌ Denied',
  implemented: '🚀 Implemented',
};

const FILTERS = [
  ['all', 'All'],
  ['open', 'Open and considering'],
  ['approved', 'Approved'],
  ['denied', 'Denied'],
  ['implemented', 'Implemented'],
];

// The staff actions, in the order of the buttons: [action, button label].
const ACTIONS = [
  ['approve', 'Approve'],
  ['deny', 'Deny'],
  ['implement', 'Implemented'],
  ['consider', 'Considering'],
];

const day = (ms) => new Date(ms).toISOString().slice(0, 10);

function Item({ item, busy, limits, onDecide, onDelete }) {
  const [action, setAction] = useState(null);
  const [reason, setReason] = useState('');

  return (
    <div className="v2-row">
      <div className="v2-row-main">
        <h3>
          #{item.number}
          {item.title ? ` · ${item.title}` : ''}{' '}
          <span className="v2-field-hint">{STATUS_LABEL[item.status]}</span>
        </h3>
        <p>{item.text}</p>
        <p className="v2-field-hint">
          👍 {item.up} · 👎 {item.down} · {day(item.createdAt)}
          {item.author
            ? ` · by ${item.author}${item.anonymous ? ' (hidden from members)' : ''}`
            : ' · author removed'}
        </p>
        {item.reason ? <p className="v2-field-hint">Reason: {item.reason}</p> : null}
        {action ? (
          <form
            className="v2-field-row"
            onSubmit={(e) => {
              e.preventDefault();
              onDecide(item, action, reason).then((ok) => {
                if (ok) {
                  setAction(null);
                  setReason('');
                }
              });
            }}
          >
            <div className="v2-field">
              <label htmlFor={`reason-${item.number}`}>
                Reason{' '}
                <span className="v2-field-hint">— optional, shown on the post and sent to the author</span>
              </label>
              <input
                id={`reason-${item.number}`}
                type="text"
                maxLength={limitOf(limits, 'reason').maxLength}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
            <button type="submit" className="v2-btn-primary" disabled={busy}>
              {ACTIONS.find(([a]) => a === action)[1]}
            </button>
            <button type="button" className="v2-btn-ghost" onClick={() => setAction(null)}>
              Close
            </button>
          </form>
        ) : null}
      </div>
      {action ? null : (
        <div className="v2-field-row">
          {ACTIONS.map(([a, label]) => (
            <button
              key={a}
              type="button"
              className="v2-btn-ghost"
              disabled={busy}
              onClick={() => setAction(a)}
            >
              {label}
            </button>
          ))}
          <button type="button" className="v2-btn-danger" disabled={busy} onClick={() => onDelete(item)}>
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

export default function Suggestions() {
  const cmd = useCmd();
  const limits = useModuleLimits('suggestions');
  const { guildId, data, setData, form, set, status, error, dirty, saving, save, reset } =
    useModuleForm('suggestions');
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('new');
  const [busy, setBusy] = useState(false);
  // The filter the list on screen was fetched with; the config answer comes with the default one.
  const shown = useRef('all/new');

  useEffect(() => {
    if (shown.current === `${filter}/${sort}`) return;
    shown.current = `${filter}/${sort}`;
    let live = true;
    getSuggestions(guildId, { status: filter, sort })
      .then(({ suggestions }) => live && setData((d) => ({ ...d, suggestions })))
      .catch((err) => notify(err.message));
    return () => {
      live = false;
    };
  }, [guildId, filter, sort, setData]);

  if (status === 'error') return <LoadError error={error} what="Suggestions" />;
  if (status === 'loading') return <p className="v2-state">Loading…</p>;

  async function refetch() {
    const { suggestions } = await getSuggestions(guildId, { status: filter, sort });
    setData((d) => ({ ...d, suggestions }));
  }

  async function onDecide(item, action, reason) {
    setBusy(true);
    try {
      await decideSuggestion(guildId, item.number, action, reason);
      await refetch();
      return true;
    } catch (err) {
      notify(err.message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(item) {
    const ok = await confirmDialog({
      title: `Delete suggestion #${item.number}?`,
      body: 'The suggestion, its votes and its post are removed. This cannot be undone.',
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await deleteSuggestion(guildId, item.number);
      await refetch();
    } catch (err) {
      notify(err.message);
    } finally {
      setBusy(false);
    }
  }

  const cooldown = limitOf(limits, 'cooldownSeconds');

  return (
    <>
      <h1 className="v2-section-title">Suggestions</h1>
      <p className="v2-field-hint">
        Members post ideas with <code>{cmd('/suggest')}</code>; everyone votes with 👍 and 👎. Staff decide
        with <code>{cmd('/suggestion approve')}</code>, <code>{cmd('/suggestion deny')}</code>,{' '}
        <code>{cmd('/suggestion implement')}</code> and <code>{cmd('/suggestion consider')}</code>, or below.
      </p>

      <form onSubmit={save} data-savebar>
        <div className="v2-field">
          <label htmlFor="channel">Suggestions channel</label>
          <select id="channel" value={form.channel} onChange={(e) => set({ channel: e.target.value })}>
            <option value="">— the channel the command is used in —</option>
            {data.channels.map((c) => (
              <option key={c.id} value={c.id}>
                #{c.name}
              </option>
            ))}
          </select>
        </div>

        <div className="v2-field">
          <label htmlFor="logChannel">
            Log channel <span className="v2-field-hint">— optional</span>
          </label>
          <select
            id="logChannel"
            value={form.logChannel}
            onChange={(e) => set({ logChannel: e.target.value })}
          >
            <option value="">— decided suggestions stay where they are —</option>
            {data.channels.map((c) => (
              <option key={c.id} value={c.id}>
                #{c.name}
              </option>
            ))}
          </select>
          <p className="v2-field-hint">
            A suggestion that is approved, denied or implemented is reposted here and the original is deleted.
          </p>
        </div>

        <div className="v2-field">
          <label className="v2-check">
            <input
              type="checkbox"
              checked={form.anonymous}
              onChange={(e) => set({ anonymous: e.target.checked })}
            />
            Anonymous suggestions
          </label>
          <p className="v2-field-hint">
            New posts do not show who wrote them. Staff still see the author on this page.
          </p>
        </div>

        <div className="v2-field">
          <label className="v2-check">
            <input
              type="checkbox"
              checked={form.dmAuthor}
              onChange={(e) => set({ dmAuthor: e.target.checked })}
            />
            DM the author when staff decide
          </label>
          <p className="v2-field-hint">Members with DMs closed are skipped quietly.</p>
        </div>

        <div className="v2-field">
          <label className="v2-check">
            <input
              type="checkbox"
              checked={form.messagesToSuggestions}
              onChange={(e) => set({ messagesToSuggestions: e.target.checked })}
            />
            Turn messages in the channel into suggestions
          </label>
          <p className="v2-field-hint">
            Sylo deletes the message and posts it as a suggestion. Needs the suggestions channel above, Manage
            Messages and the Message Content intent. Messages with attachments are left alone.
          </p>
        </div>

        <div className="v2-field">
          <label htmlFor="cooldownSeconds">Cooldown between suggestions (seconds)</label>
          <input
            id="cooldownSeconds"
            type="number"
            min={cooldown.min}
            max={cooldown.max}
            value={form.cooldownSeconds}
            onChange={(e) => set({ cooldownSeconds: e.target.value === '' ? '' : Number(e.target.value) })}
          />
          <p className="v2-field-hint">Per member. 0 turns it off.</p>
        </div>

        <div className="v2-field">
          <label>
            Staff roles <span className="v2-field-hint">— may decide without Manage Server</span>
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
        <h2 className="v2-group-title">Suggestions ({data.suggestions.length})</h2>
        <div className="v2-field-row">
          <div className="v2-field">
            <label htmlFor="sug-filter">Show</label>
            <select id="sug-filter" value={filter} onChange={(e) => setFilter(e.target.value)}>
              {FILTERS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="v2-field">
            <label htmlFor="sug-sort">Order</label>
            <select id="sug-sort" value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="new">Newest first</option>
              <option value="top">Most votes first</option>
            </select>
          </div>
        </div>
        {data.suggestions.length === 0 ? <p className="v2-note">Nothing here yet.</p> : null}
        <div className="v2-list">
          {data.suggestions.map((item) => (
            <Item
              key={item.id}
              item={item}
              busy={busy}
              limits={limits}
              onDecide={onDecide}
              onDelete={onDelete}
            />
          ))}
        </div>
      </div>
      <SaveBar dirty={dirty} saving={saving} onSave={save} onReset={reset} />
    </>
  );
}
