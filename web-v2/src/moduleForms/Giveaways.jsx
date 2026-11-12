import { useState } from 'react';
import { useCmd } from '../platformContext.jsx';
import { cancelGiveaway, endGiveaway, rerollGiveaway } from '../api.js';
import { notify } from '../notify.js';
import LoadError from '../components/LoadError.jsx';
import SaveBar from '../components/SaveBar.jsx';
import { useModuleForm } from '../components/useModuleForm.js';
import { limitOf, useModuleLimits } from '../components/useModuleLimits.js';
import { confirmDialog } from '../components/ConfirmDialog.jsx';
import UnitInput from '../components/UnitInput.jsx';

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
  const limits = useModuleLimits('giveaways');
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

  async function onCancel(g) {
    const ok = await confirmDialog({
      title: `Cancel giveaway #${g.id}?`,
      body:
        g.entryFee > 0
          ? `Nobody wins, and everyone who entered gets their entry fee of ${g.entryFee.toLocaleString('en-US')} back.`
          : 'Nobody wins. The giveaway message is closed.',
      confirmLabel: 'Cancel giveaway',
    });
    if (!ok) return;
    setBusyId(g.id);
    try {
      const out = await cancelGiveaway(guildId, g.id);
      setData((d) => ({ ...d, giveaways: out.giveaways }));
      if (g.entryFee > 0) notify(`${out.refunded} entry fee(s) were given back.`, 'info');
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
        Enter button. Winners are drawn automatically at the end time.
      </p>
      <p className="v2-field-hint">
        With the Economy module on, <code>{cmd('/giveaway start')}</code> also takes an <code>entry_fee</code>{' '}
        (paid when a member enters, given back if they leave or if the giveaway is cancelled) and a{' '}
        <code>prize_amount</code> (paid to every winner at the draw).
      </p>

      <form onSubmit={save} data-savebar>
        <div className="v2-field">
          <label htmlFor="ping">Who to ping when winners are announced</label>
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
                    {g.entryFee > 0 ? ` · entry fee ${g.entryFee.toLocaleString('en-US')}` : ''}
                    {g.prizeAmount > 0 ? ` · pays ${g.prizeAmount.toLocaleString('en-US')} each` : ''}
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
                  <button
                    type="button"
                    className="v2-btn-danger-ghost"
                    disabled={busyId === g.id}
                    onClick={() => onCancel(g)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {ended.length > 0 ? (
        <div className="v2-group v2-section-gap">
          <h2 className="v2-group-title">Recently ended ({ended.length})</h2>
          <div className="v2-list">
            {ended.map((g) => (
              <div className="v2-row" key={g.id}>
                <div className="v2-row-main">
                  <h3>
                    #{g.id} · {g.prize}
                  </h3>
                  <p>
                    {g.entries} entr{g.entries === 1 ? 'y' : 'ies'} ·{' '}
                    {g.cancelled
                      ? 'cancelled'
                      : g.wonIds && g.wonIds.length
                        ? `won by ${g.wonIds.map((id, i) => (g.wonNames?.[i] && g.wonNames[i] !== id ? g.wonNames[i] : `a member (ID ${id})`)).join(', ')}`
                        : 'no winner'}
                  </p>
                </div>
                <div className="v2-field-row v2-wrap-row">
                  <label htmlFor={`reroll-${g.id}`}>
                    Reroll<span className="v2-sr-only"> winners of giveaway #{g.id}</span>
                  </label>
                  <UnitInput
                    id={`reroll-${g.id}`}
                    unit={(rerollCounts[g.id] ?? 1) === 1 ? 'winner' : 'winners'}
                    min={limitOf(limits, 'winners').min}
                    max={limitOf(limits, 'winners').max}
                    value={rerollCounts[g.id] ?? 1}
                    onChange={(e) => setRerollCounts((c) => ({ ...c, [g.id]: Number(e.target.value) }))}
                  />
                  <button
                    type="button"
                    className="v2-btn-ghost"
                    disabled={busyId === g.id}
                    onClick={() => onReroll(g.id)}
                  >
                    Reroll<span className="v2-sr-only">{` giveaway #${g.id}`}</span>
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
