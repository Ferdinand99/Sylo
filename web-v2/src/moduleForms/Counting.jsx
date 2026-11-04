import { useEffect, useState } from 'react';
import { setCountingCount, resetCountingCount, releaseCountingPenalty } from '../api.js';
import { notify } from '../notify.js';
import LoadError from '../components/LoadError.jsx';
import SaveBar from '../components/SaveBar.jsx';
import { useModuleForm } from '../components/useModuleForm.js';
import { limitOf, useModuleLimits } from '../components/useModuleLimits.js';
import { confirmDialog } from '../components/ConfirmDialog.jsx';
import UnitInput from '../components/UnitInput.jsx';

export default function Counting() {
  const limits = useModuleLimits('counting');
  const { guildId, data, setData, form, setForm, status, error, dirty, saving, save, reset } =
    useModuleForm('counting');
  const [countInput, setCountInput] = useState('');
  const [countError, setCountError] = useState('');
  const [countBusy, setCountBusy] = useState(false);
  const [releasing, setReleasing] = useState(null);

  useEffect(() => {
    if (data) setCountInput(String(data.state.current));
  }, [data]);

  if (status === 'error') return <LoadError error={error} what="Counting settings" />;
  if (status === 'loading') return <p className="v2-state">Loading…</p>;

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  async function onSetCount() {
    const n = Number(countInput);
    if (!Number.isInteger(n) || n < 0) {
      setCountError('Enter a whole number, 0 or higher.');
      return;
    }
    setCountError('');
    setCountBusy(true);
    try {
      const { state } = await setCountingCount(guildId, n);
      setData((d) => ({ ...d, state }));
    } catch (err) {
      notify(err.message);
    } finally {
      setCountBusy(false);
    }
  }

  async function onResetCount() {
    const ok = await confirmDialog({
      title: 'Reset the count to 0?',
      body: `The current count (${data.state.current}) is cleared and the next number posted must be 1. The best streak is kept.`,
      confirmLabel: 'Reset to 0',
    });
    if (!ok) return;
    setCountBusy(true);
    try {
      const { state } = await resetCountingCount(guildId);
      setData((d) => ({ ...d, state }));
      setCountInput('0');
    } catch (err) {
      notify(err.message);
    } finally {
      setCountBusy(false);
    }
  }

  async function onRelease(userId) {
    setReleasing(userId);
    try {
      await releaseCountingPenalty(guildId, userId);
      setData((d) => ({ ...d, penalties: d.penalties.filter((p) => p.userId !== userId) }));
    } catch (err) {
      notify(err.message);
    } finally {
      setReleasing(null);
    }
  }

  return (
    <>
      <h1 className="v2-section-title">Counting</h1>
      <p className="v2-field-hint">
        Members count upward in the chosen channel — one number per message. A wrong number is rejected; the
        reset option below decides whether it also sends the count back to 0.
      </p>

      <form onSubmit={save} data-savebar>
        <div className="v2-field">
          <label htmlFor="channelId">Counting channel</label>
          <select id="channelId" value={form.channelId} onChange={(e) => set({ channelId: e.target.value })}>
            <option value="">— none —</option>
            {data.channels.map((c) => (
              <option key={c.id} value={c.id}>
                #{c.name}
              </option>
            ))}
          </select>
        </div>

        <div className="v2-field">
          <label className="v2-check">
            <input type="checkbox" checked={form.react} onChange={(e) => set({ react: e.target.checked })} />
            <span>React to correct counts</span>
          </label>
          <p className="v2-field-hint v2-check-hint">✅ on a correct count, 🎉 on a new record.</p>
          <label className="v2-check">
            <input
              type="checkbox"
              checked={form.allowSameUser}
              onChange={(e) => set({ allowSameUser: e.target.checked })}
            />
            <span>Let the same person count twice in a row</span>
          </label>
          <p className="v2-field-hint v2-check-hint">When off, counters must take turns.</p>
          <label className="v2-check">
            <input
              type="checkbox"
              checked={form.resetOnFail}
              onChange={(e) => set({ resetOnFail: e.target.checked })}
            />
            <span>Reset to 0 when someone posts the wrong number</span>
          </label>
          <p className="v2-field-hint v2-check-hint">
            When off, the wrong number is just rejected and the streak is kept.
          </p>
        </div>

        <div className="v2-field v2-section-gap">
          <label htmlFor="penaltyRoleId">
            Counting access role <span className="v2-field-hint">— optional</span>
          </label>
          <select
            id="penaltyRoleId"
            value={form.penaltyRoleId}
            onChange={(e) => set({ penaltyRoleId: e.target.value })}
          >
            <option value="">— none (nobody loses access) —</option>
            {data.roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <p className="v2-field-hint">
            Removed for a while when someone breaks the count, then given back. Pick the role that lets people
            type in the counting channel. Sylo's own top role must sit above it. This is not a ban or a
            timeout — only this one role is touched.
          </p>
        </div>

        <div className="v2-field">
          <label htmlFor="penaltyMinutes">Remove it for</label>
          <UnitInput
            id="penaltyMinutes"
            unit="minutes"
            disabled={!form.penaltyRoleId}
            min={limitOf(limits, 'penaltyMinutes').min}
            max={limitOf(limits, 'penaltyMinutes').max}
            value={form.penaltyMinutes}
            onChange={(e) => set({ penaltyMinutes: Number(e.target.value) })}
          />
          {form.penaltyRoleId ? null : (
            <p className="v2-field-hint">Pick a counting access role above to set this.</p>
          )}
        </div>
      </form>

      {data.penalties.length > 0 ? (
        <div className="v2-group v2-section-gap">
          <h2 className="v2-group-title">Currently without access</h2>
          <div className="v2-list">
            {data.penalties.map((p) => (
              <div className="v2-row" key={p.userId}>
                <div className="v2-row-main">
                  <h3>{p.label}</h3>
                  <p>
                    {p.roleName} · back at{' '}
                    {Number.isFinite(p.restoreAt)
                      ? new Date(p.restoreAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
                      : '—'}
                  </p>
                </div>
                <div className="v2-field-row">
                  <button
                    type="button"
                    className="v2-btn-ghost"
                    disabled={releasing === p.userId}
                    onClick={() => onRelease(p.userId)}
                  >
                    {releasing === p.userId ? 'Releasing…' : 'Release now'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <h2 className="v2-group-title v2-section-gap">Current game</h2>
      <p className="v2-field-hint">
        Count is at <strong>{data.state.current}</strong> · best streak <strong>{data.state.record}</strong>
        {data.state.lastUserId ? (
          <>
            {' '}
            · last number by <code>&lt;@{data.state.lastUserId}&gt;</code>
          </>
        ) : null}
      </p>
      <div className="v2-field v2-count-set">
        <label htmlFor="countInput">Set the count to</label>
        <div className="v2-field-row">
          <input
            id="countInput"
            type="number"
            className="v2-input-num v2-input-num-wide"
            min={limitOf(limits, 'count').min}
            max={limitOf(limits, 'count').max}
            value={countInput}
            aria-invalid={countError ? true : undefined}
            aria-describedby={countError ? 'countInput-error' : undefined}
            onChange={(e) => {
              setCountInput(e.target.value);
              if (countError) setCountError('');
            }}
          />
          <button type="button" className="v2-btn-ghost" disabled={countBusy} onClick={onSetCount}>
            Update
          </button>
          <button
            type="button"
            className="v2-btn-danger-ghost v2-danger-push"
            disabled={countBusy}
            onClick={onResetCount}
          >
            Reset to 0
          </button>
        </div>
        {countError ? (
          <p id="countInput-error" className="v2-field-error">
            {countError}
          </p>
        ) : null}
      </div>
      <p className="v2-field-hint">
        The next number posted in the channel must be one higher than this. The last-counter lock is cleared,
        so anyone may post it.
      </p>
      <SaveBar dirty={dirty} saving={saving} onSave={save} onReset={reset} />
    </>
  );
}
