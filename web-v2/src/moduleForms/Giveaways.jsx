import { useState } from 'react';
import { useCmd } from '../platformContext.jsx';
import { endGiveaway, rerollGiveaway } from '../api.js';
import { notify } from '../notify.js';
import LoadError from '../components/LoadError.jsx';
import SaveBar from '../components/SaveBar.jsx';
import { useModuleForm } from '../components/useModuleForm.js';
import { confirmDialog } from '../components/ConfirmDialog.jsx';

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
  const cmd = useCmd();
  const [busyId, setBusyId] = useState(null);
  const [rerollCounts, setRerollCounts] = useState({});
  const { guildId, data, setData, form, setForm, status, error, dirty, saving, save, reset } =
    useModuleForm('giveaways');

  if (status === 'error') return <LoadError error={error} what="Giveaways settings" />;
  if (status === 'loading') return <p className="v2-state">Loading…</p>;

  async function onEnd(id) {
    const ok = await confirmDialog({
      title: `End giveaway #${id} now?`,
      body: 'The winners are drawn immediately and announced in the giveaway channel.',
      confirmLabel: 'End & draw winners',
      tone: 'default',
    });
    if (!ok) return;
    setBusyId(id);
    try {
      const { giveaways } = await endGiveaway(guildId, id);
      setData((d) => ({ ...d, giveaways }));
    } catch (err) {
      notify(err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function onReroll(id) {
    const ok = await confirmDialog({
      title: `Reroll giveaway #${id}?`,
      body: 'New winners are drawn from the entrants and announced.',
      confirmLabel: 'Reroll',
      tone: 'default',
    });
    if (!ok) return;
    setBusyId(id);
    try {
      const { giveaways } = await rerollGiveaway(guildId, id, rerollCounts[id] || 1);
      setData((d) => ({ ...d, giveaways }));
    } catch (err) {
      notify(err.message);
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
        Staff start giveaways with <code>{cmd('/giveaway start')}</code>; members join by clicking the 🎉
        Enter button. Winners are drawn automatically at the end time — no reactions, no Message Content
        intent.
      </p>

      <form onSubmit={save}>
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
      <SaveBar dirty={dirty} saving={saving} onSave={save} onReset={reset} />
    </>
  );
}
