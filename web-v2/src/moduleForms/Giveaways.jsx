import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getModuleConfig, saveModuleConfig, endGiveaway, rerollGiveaway, ApiError } from '../api.js';
import { useApiData } from '../useApiData.js';

function rel(ms) {
  const s = Math.round((ms - Date.now()) / 1000);
  const a = Math.abs(s);
  const [n, unit] =
    a < 60
      ? [a, 's']
      : a < 3600
        ? [Math.round(a / 60), 'm']
        : a < 86400
          ? [Math.round(a / 3600), 'h']
          : [Math.round(a / 86400), 'd'];
  return s < 0 ? `${n}${unit} ago` : `in ${n}${unit}`;
}

export default function Giveaways() {
  const { guildId } = useParams();
  const { data, loading, error, setData } = useApiData(
    () => getModuleConfig(guildId, 'giveaways'),
    [guildId]
  );
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [rerollCounts, setRerollCounts] = useState({});

  useEffect(() => {
    if (data) setForm(data.config);
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
          `Couldn't load Giveaways settings (${error.message}).`
        )}
      </p>
    );
  }

  async function onSave(e) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    try {
      const { config } = await saveModuleConfig(guildId, 'giveaways', form);
      setForm(config);
      setSaved(true);
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function onEnd(id) {
    if (!confirm(`End giveaway #${id} now and draw the winners?`)) return;
    setBusyId(id);
    try {
      const { giveaways } = await endGiveaway(guildId, id);
      setData((d) => ({ ...d, giveaways }));
    } catch (err) {
      alert(err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function onReroll(id) {
    if (!confirm(`Reroll giveaway #${id}?`)) return;
    setBusyId(id);
    try {
      const { giveaways } = await rerollGiveaway(guildId, id, rerollCounts[id] || 1);
      setData((d) => ({ ...d, giveaways }));
    } catch (err) {
      alert(err.message);
    } finally {
      setBusyId(null);
    }
  }

  const active = data.giveaways.filter((g) => g.state === 'active');
  const ended = data.giveaways.filter((g) => g.state === 'ended');

  return (
    <>
      <h1 className="v2-section-title">Giveaways</h1>
      <p className="v2-field-hint">
        Staff start giveaways with <code>/giveaway start</code>; members join by clicking the 🎉 Enter button.
        Winners are drawn automatically at the end time — no reactions, no Message Content intent.
      </p>

      <form onSubmit={onSave}>
        <div className="v2-field">
          <label htmlFor="ping">Ping with the winner message</label>
          <select
            id="ping"
            value={form.ping}
            onChange={(e) => setForm((f) => ({ ...f, ping: e.target.value }))}
          >
            <option value="none">No ping</option>
            <option value="here">@here</option>
            <option value="everyone">@everyone</option>
          </select>
        </div>

        <div className="v2-field">
          <label className="v2-check">
            <input
              type="checkbox"
              checked={form.dmWinners}
              onChange={(e) => setForm((f) => ({ ...f, dmWinners: e.target.checked }))}
            />
            Also DM each winner
          </label>
        </div>

        <div className="v2-section-gap">
          <button type="submit" className="v2-btn-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          {saved ? <span className="v2-field-hint"> Saved.</span> : null}
        </div>
      </form>

      <div className="v2-group v2-section-gap">
        <h2 className="v2-group-title">Active giveaways ({active.length})</h2>
        {active.length === 0 ? (
          <p className="v2-field-hint">None running. Start one with /giveaway start.</p>
        ) : (
          <div className="v2-list">
            {active.map((g) => (
              <div className="v2-row" key={g.id}>
                <div className="v2-row-main">
                  <h3>
                    #{g.id} · {g.prize}
                  </h3>
                  <p>
                    #{g.channel} · {g.winners} winner{g.winners === 1 ? '' : 's'} · {g.entries} entr
                    {g.entries === 1 ? 'y' : 'ies'} · ends {rel(g.endsAt)}
                    {g.requiredRoleId ? ' · role-gated' : ''}
                  </p>
                </div>
                <div className="v2-field-row">
                  <button
                    type="button"
                    className="v2-btn-ghost"
                    disabled={busyId === g.id}
                    onClick={() => onEnd(g.id)}
                  >
                    End now
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {ended.length > 0 ? (
        <div className="v2-group v2-section-gap">
          <h2 className="v2-group-title">Recently ended</h2>
          <div className="v2-list">
            {ended.map((g) => (
              <div className="v2-row" key={g.id}>
                <div className="v2-row-main">
                  <h3>
                    #{g.id} · {g.prize}
                  </h3>
                  <p>
                    {g.entries} entr{g.entries === 1 ? 'y' : 'ies'} ·{' '}
                    {g.wonIds && g.wonIds.length
                      ? `won by ${g.wonIds.map((id) => `@${id}`).join(', ')}`
                      : 'no winner'}
                  </p>
                </div>
                <div className="v2-field-row">
                  <input
                    type="number"
                    className="v2-input-sm"
                    min={1}
                    max={20}
                    value={rerollCounts[g.id] ?? 1}
                    onChange={(e) => setRerollCounts((c) => ({ ...c, [g.id]: Number(e.target.value) }))}
                  />
                  <button
                    type="button"
                    className="v2-btn-ghost"
                    disabled={busyId === g.id}
                    onClick={() => onReroll(g.id)}
                  >
                    Reroll
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}
