import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  getModuleConfig,
  saveModuleConfig,
  setCountingCount,
  resetCountingCount,
  releaseCountingPenalty,
  ApiError,
} from '../api.js';
import { useApiData } from '../useApiData.js';

export default function Counting() {
  const { guildId } = useParams();
  const { data, loading, error, setData } = useApiData(() => getModuleConfig(guildId, 'counting'), [guildId]);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [countInput, setCountInput] = useState('');
  const [countBusy, setCountBusy] = useState(false);
  const [releasing, setReleasing] = useState(null);

  useEffect(() => {
    if (data) {
      setForm(data.config);
      setCountInput(String(data.state.current));
    }
  }, [data]);

  if ((loading && !data) || !form) return <p className="v2-state">Loading…</p>;

  if (error) {
    const notAuthed = error instanceof ApiError && error.notAuthenticated;
    return (
      <p className="v2-state">
        {notAuthed ? (
          <>
            Your session expired — <a href="/auth/discord/login">log in again</a>.
          </>
        ) : (
          `Couldn't load Counting settings (${error.message}).`
        )}
      </p>
    );
  }

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  async function onSave(e) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    try {
      const { config } = await saveModuleConfig(guildId, 'counting', form);
      setForm(config);
      setSaved(true);
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function onSetCount() {
    const n = Number(countInput);
    if (!Number.isInteger(n) || n < 0) return alert('Enter a whole number, 0 or higher.');
    setCountBusy(true);
    try {
      const { state } = await setCountingCount(guildId, n);
      setData((d) => ({ ...d, state }));
    } catch (err) {
      alert(err.message);
    } finally {
      setCountBusy(false);
    }
  }

  async function onResetCount() {
    if (!confirm('Reset the count to 0?')) return;
    setCountBusy(true);
    try {
      const { state } = await resetCountingCount(guildId);
      setData((d) => ({ ...d, state }));
      setCountInput('0');
    } catch (err) {
      alert(err.message);
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
      alert(err.message);
    } finally {
      setReleasing(null);
    }
  }

  return (
    <>
      <h1 className="v2-section-title">Counting</h1>
      <p className="v2-field-hint">
        Members count upward in the chosen channel — one number per message. A wrong number{' '}
        {form.resetOnFail === false
          ? 'is rejected and deleted.'
          : 'breaks the streak and it starts over from 1.'}
      </p>

      <form onSubmit={onSave}>
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
            React with ✅ on a correct count (🎉 on a new record)
          </label>
          <label className="v2-check">
            <input
              type="checkbox"
              checked={form.allowSameUser}
              onChange={(e) => set({ allowSameUser: e.target.checked })}
            />
            Allow the same person to count multiple times in a row (off = counters must alternate)
          </label>
          <label className="v2-check">
            <input
              type="checkbox"
              checked={form.resetOnFail}
              onChange={(e) => set({ resetOnFail: e.target.checked })}
            />
            Reset to 0 when someone posts the wrong number
          </label>
        </div>

        <div className="v2-field v2-section-gap">
          <label htmlFor="penaltyRoleId">
            Penalty role <span className="v2-field-hint">— optional</span>
          </label>
          <select
            id="penaltyRoleId"
            value={form.penaltyRoleId}
            onChange={(e) => set({ penaltyRoleId: e.target.value })}
          >
            <option value="">— none (no penalty) —</option>
            {data.roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <p className="v2-field-hint">
            When someone breaks the streak, Sylo removes this role from them and gives it back later. Point it
            at whatever role lets people type in the counting channel. Sylo's own top role must sit above it.
            This is not a ban or a timeout — only this one role is touched.
          </p>
        </div>

        <div className="v2-field">
          <label htmlFor="penaltyMinutes">Bench for (minutes)</label>
          <input
            id="penaltyMinutes"
            type="number"
            min={1}
            max={10080}
            value={form.penaltyMinutes}
            onChange={(e) => set({ penaltyMinutes: Number(e.target.value) })}
          />
        </div>

        <div className="v2-section-gap">
          <button type="submit" className="v2-btn-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          {saved ? <span className="v2-field-hint"> Saved.</span> : null}
        </div>
      </form>

      {data.penalties.length > 0 ? (
        <div className="v2-group v2-section-gap">
          <h2 className="v2-group-title">Currently benched</h2>
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
      <div className="v2-field">
        <label htmlFor="countInput">Set the count to</label>
        <div className="v2-field-row">
          <input
            id="countInput"
            type="number"
            min={0}
            value={countInput}
            onChange={(e) => setCountInput(e.target.value)}
          />
          <button type="button" className="v2-btn-primary" disabled={countBusy} onClick={onSetCount}>
            Update
          </button>
          <button type="button" className="v2-btn-ghost" disabled={countBusy} onClick={onResetCount}>
            Reset to 0
          </button>
        </div>
      </div>
      <p className="v2-field-hint">
        The next number posted in the channel must be one higher than this. The last-counter lock is cleared,
        so anyone may post it.
      </p>
    </>
  );
}
