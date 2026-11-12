import { useEffect, useRef, useState } from 'react';
import { useCmd } from '../platformContext.jsx';
import {
  decideSuggestion,
  deleteSuggestion,
  getSuggestions,
  moveAllSuggestionsBack,
  moveSuggestionBack,
} from '../api.js';
import { notify } from '../notify.js';
import LoadError from '../components/LoadError.jsx';
import SaveBar from '../components/SaveBar.jsx';
import ChipPicker from '../components/ChipPicker.jsx';
import { useModuleForm } from '../components/useModuleForm.js';
import { limitOf, useModuleLimits } from '../components/useModuleLimits.js';
import { confirmDialog } from '../components/ConfirmDialog.jsx';
import Badge from '../components/Badge.jsx';
import UnitInput from '../components/UnitInput.jsx';
import Time from '../components/Time.jsx';

const STATUS_LABEL = {
  open: '⏳ Open',
  considering: '🤔 Considering',
  approved: '✅ Approved',
  denied: '❌ Denied',
  implemented: '🚀 Implemented',
};

// Colour follows meaning; the label always carries the word too.
const STATUS_TONE = {
  open: 'neutral',
  considering: 'warning',
  approved: 'success',
  denied: 'danger',
  implemented: 'success',
};

const FILTERS = [
  ['all', 'All'],
  ['open', 'Open and considering'],
  ['approved', 'Approved'],
  ['denied', 'Denied'],
  ['implemented', 'Implemented'],
];

// The staff actions, in the order of the "Set status" list: [action, status it sets, label].
const ACTIONS = [
  ['approve', 'approved', 'Approved'],
  ['deny', 'denied', 'Denied'],
  ['implement', 'implemented', 'Implemented'],
  ['consider', 'considering', 'Considering'],
];

function Item({ item, busy, limits, onDecide, onMoveBack, onDelete }) {
  const [action, setAction] = useState(null);
  const [pick, setPick] = useState('');
  const [reason, setReason] = useState('');
  const pickRef = useRef(null);
  const returnFocus = useRef(false);

  // The panel replaces the select; when it closes, focus goes back to the select.
  useEffect(() => {
    if (!action && returnFocus.current) {
      returnFocus.current = false;
      pickRef.current?.focus();
    }
  }, [action]);

  function closePanel() {
    returnFocus.current = true;
    setAction(null);
    setPick('');
  }

  return (
    <div className="v2-row v2-row-stack">
      <div className="v2-row-main">
        <h3>
          #{item.number}
          {item.title ? ` · ${item.title}` : ''}
          <Badge tone={STATUS_TONE[item.status] ?? 'neutral'} inline raw>
            {STATUS_LABEL[item.status] ?? item.status}
          </Badge>
        </h3>
        <p>{item.text}</p>
        <p className="v2-field-hint">
          👍 {item.up} · 👎 {item.down} · <Time value={item.createdAt} />
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
                  closePanel();
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
                autoFocus
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
            <button type="submit" className="v2-btn-primary" disabled={busy}>
              Set to {ACTIONS.find(([a]) => a === action)[2]}
            </button>
            <button type="button" className="v2-btn-ghost" onClick={closePanel}>
              Close
            </button>
          </form>
        ) : null}
      </div>
      {action ? null : (
        <div className="v2-row-actions">
          <select
            ref={pickRef}
            aria-label={`Set status of suggestion #${item.number}`}
            value={pick}
            disabled={busy}
            onChange={(e) => setPick(e.target.value)}
          >
            <option value="">Set status…</option>
            {ACTIONS.filter(([, status]) => status !== item.status).map(([a, , label]) => (
              <option key={a} value={a}>
                {label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="v2-btn-ghost"
            disabled={busy || !pick}
            onClick={() => setAction(pick)}
          >
            Set…
          </button>
          {item.canMoveBack ? (
            <button
              type="button"
              className="v2-btn-ghost"
              disabled={busy}
              title="Post it again in the suggestions channel"
              onClick={() => onMoveBack(item)}
            >
              Move back
            </button>
          ) : null}
          <button
            type="button"
            className="v2-btn-danger-ghost"
            disabled={busy}
            onClick={() => onDelete(item)}
          >
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
  // Saving can change which suggestions count as "outside" (a new suggestions channel): the list is
  // fetched again after a save, so the banner and the Move back buttons are right without a reload.
  const [savedTick, setSavedTick] = useState(0);
  const { guildId, data, setData, form, set, status, error, dirty, saving, save, reset } = useModuleForm(
    'suggestions',
    { onSaved: () => setSavedTick((n) => n + 1) }
  );
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('new');
  const [busy, setBusy] = useState(false);
  const handledSave = useRef(0);
  // The filter the list on screen was fetched with; the config answer comes with the default one.
  const shown = useRef('all/new');

  useEffect(() => {
    if (shown.current === `${filter}/${sort}`) return;
    shown.current = `${filter}/${sort}`;
    let live = true;
    getSuggestions(guildId, { status: filter, sort })
      .then(({ suggestions, outside }) => live && setData((d) => ({ ...d, suggestions, outside })))
      .catch((err) => notify(err.message));
    return () => {
      live = false;
    };
  }, [guildId, filter, sort, setData]);

  useEffect(() => {
    if (handledSave.current === savedTick) return undefined;
    handledSave.current = savedTick;
    let live = true;
    getSuggestions(guildId, { status: filter, sort })
      .then(({ suggestions, outside }) => live && setData((d) => ({ ...d, suggestions, outside })))
      .catch((err) => notify(err.message));
    return () => {
      live = false;
    };
  }, [savedTick, guildId, filter, sort, setData]);

  if (status === 'error') return <LoadError error={error} what="Suggestions" />;
  if (status === 'loading') return <p className="v2-state">Loading…</p>;

  async function refetch() {
    const { suggestions, outside } = await getSuggestions(guildId, { status: filter, sort });
    setData((d) => ({ ...d, suggestions, outside }));
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

  async function onMoveBack(item) {
    setBusy(true);
    try {
      await moveSuggestionBack(guildId, item.number);
      await refetch();
      notify(`Suggestion #${item.number} is back in the suggestions channel.`, 'info');
    } catch (err) {
      notify(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function onMoveAllBack() {
    const ok = await confirmDialog({
      title: `Move ${data.outside} ${data.outside === 1 ? 'suggestion' : 'suggestions'} back?`,
      body: 'Sylo posts each one again in the suggestions channel, oldest first, and removes the old post (with a log channel in "copy" mode, a decided suggestion keeps the old post as its log copy). A suggestion whose old post Sylo cannot reach is skipped and listed afterwards (on Discord, a missing Read Message History permission in the old channel causes this). A temporary error stops the run. This can take a while.',
      confirmLabel: 'Move all back',
    });
    if (!ok) return;
    setBusy(true);
    let total = 0;
    let after = 0;
    const failed = [];
    const skippedText = () =>
      failed.length
        ? ` ${failed.length} could not be moved and stay where they are: ${failed
            .map((f) => `#${f.number}`)
            .join(', ')}. ${failed[0].error}`
        : '';
    try {
      // The server moves a batch at a time; ask again (after the last one it looked at) until
      // nothing is left or it stops.
      for (;;) {
        const result = await moveAllSuggestionsBack(guildId, after);
        total += result.moved;
        failed.push(...(result.failed ?? []));
        if (result.error) {
          notify(`${result.error} ${total} moved back, ${result.remaining} left.${skippedText()}`);
          break;
        }
        if (!result.remaining || !(result.next > after)) {
          notify(
            `${total} ${total === 1 ? 'suggestion' : 'suggestions'} moved back.${skippedText()}`,
            failed.length ? 'error' : 'info'
          );
          break;
        }
        after = result.next;
      }
    } catch (err) {
      notify(`${err.message} ${total} moved back before that.`);
    } finally {
      await refetch().catch((err) => notify(err.message));
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
            <option value="">— decided suggestions only change status where they are —</option>
            {data.channels.map((c) => (
              <option key={c.id} value={c.id}>
                #{c.name}
              </option>
            ))}
          </select>
          <p className="v2-field-hint">
            Where a suggestion that is approved, denied or implemented is also posted. Pick how below.
          </p>
          <fieldset className="v2-field" disabled={!form.logChannel}>
            <legend className="v2-field-hint">When a suggestion is decided</legend>
            <label className="v2-check">
              <input
                type="radio"
                name="logMode"
                checked={form.logMode === 'copy'}
                onChange={() => set({ logMode: 'copy' })}
              />
              Copy to the log channel and keep the original
            </label>
            <label className="v2-check">
              <input
                type="radio"
                name="logMode"
                checked={form.logMode === 'move'}
                onChange={() => set({ logMode: 'move' })}
              />
              Move to the log channel (delete the original)
            </label>
          </fieldset>
          {form.logChannel ? (
            <p className="v2-field-hint">
              {form.logMode === 'move'
                ? 'The original is deleted and the suggestion lives in the log channel from then on.'
                : 'The original stays in the suggestions channel and shows its status. The copy in the log channel is updated if the status changes again and removed if the suggestion is reopened.'}
            </p>
          ) : null}
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
            Sylo deletes the message and posts it as a suggestion. Needs the suggestions channel above and the
            Manage Messages permission. It also has to be allowed to read message text, which only the bot
            owner can switch on. Messages with attachments are left alone.
          </p>
        </div>

        <div className="v2-field">
          <label htmlFor="cooldownSeconds">Cooldown between suggestions</label>
          <UnitInput
            id="cooldownSeconds"
            unit="seconds"
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
        {data.outside > 0 ? (
          <div className="v2-field-row">
            <p className="v2-field-hint">
              {data.outside} {data.outside === 1 ? 'suggestion is' : 'suggestions are'} not in the suggestions
              channel (for example after an earlier move to the log channel).
            </p>
            <button type="button" className="v2-btn-ghost" disabled={busy} onClick={onMoveAllBack}>
              Move all back
            </button>
          </div>
        ) : null}
        <div className="v2-field-row v2-sug-filters">
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
              onMoveBack={onMoveBack}
              onDelete={onDelete}
            />
          ))}
        </div>
      </div>
      <SaveBar dirty={dirty} saving={saving} onSave={save} onReset={reset} />
    </>
  );
}
