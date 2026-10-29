import { useState } from 'react';
import { useCmd } from '../platformContext.jsx';
import { setInviteBonus } from '../api.js';
import { notify } from '../notify.js';
import LoadError from '../components/LoadError.jsx';
import SaveBar from '../components/SaveBar.jsx';
import { useModuleForm } from '../components/useModuleForm.js';
import { limitOf, useModuleLimits } from '../components/useModuleLimits.js';

export default function InviteTracker() {
  const cmd = useCmd();
  const [bonusUser, setBonusUser] = useState('');
  const [bonusValue, setBonusValue] = useState(0);
  const [bonusBusy, setBonusBusy] = useState(false);
  const limits = useModuleLimits('invite-tracker');
  const { guildId, data, setData, form, setForm, status, error, dirty, saving, save, reset } =
    useModuleForm('invite-tracker');

  if (status === 'error') return <LoadError error={error} what="Invite tracker settings" />;
  if (status === 'loading') return <p className="v2-state">Loading…</p>;

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  async function onSetBonus(e) {
    e.preventDefault();
    setBonusBusy(true);
    try {
      const { board } = await setInviteBonus(guildId, bonusUser.trim(), Number(bonusValue));
      setData((d) => ({ ...d, board }));
      setBonusUser('');
      setBonusValue(0);
    } catch (err) {
      notify(err.message);
    } finally {
      setBonusBusy(false);
    }
  }

  const { board } = data;

  return (
    <>
      <h1 className="v2-section-title">Invite tracker</h1>
      <p className="v2-field-hint">
        Members get a personal invite link with <code>{cmd('/invites')}</code>. When someone joins through it,
        that member's invite count goes up. <code>{cmd('/inviter')}</code> and{' '}
        <code>{cmd('/invites-leaderboard')}</code> read this same data.
      </p>

      {!board.canReadInvites ? (
        <p className="v2-warn-text">
          Sylo needs the Manage Server permission to read this server's invites — without it, joins can't be
          attributed to an inviter.
        </p>
      ) : null}

      <form onSubmit={save} data-savebar>
        <div className="v2-field">
          <label htmlFor="joinLogChannelId">
            Join / leave log channel <span className="v2-field-hint">— optional</span>
          </label>
          <select
            id="joinLogChannelId"
            value={form.joinLogChannelId}
            onChange={(e) => set({ joinLogChannelId: e.target.value })}
          >
            <option value="">— none —</option>
            {data.channels.map((c) => (
              <option key={c.id} value={c.id}>
                #{c.name}
              </option>
            ))}
          </select>
          <p className="v2-field-hint">Sylo posts a line here each time someone joins or leaves.</p>
        </div>

        <div className="v2-field">
          <label htmlFor="graceHours">Fake-invite grace window (hours)</label>
          <input
            id="graceHours"
            type="number"
            min={limitOf(limits, 'graceHours').min}
            max={limitOf(limits, 'graceHours').max}
            value={form.graceHours}
            onChange={(e) => set({ graceHours: Number(e.target.value) })}
          />
          <p className="v2-field-hint">
            A join that leaves inside this window is not counted. 0 disables the guard.
          </p>
        </div>
      </form>

      <h2 className="v2-group-title v2-section-gap">
        Leaderboard{' '}
        <span className="v2-field-hint">
          {board.total} inviter{board.total === 1 ? '' : 's'}
        </span>
      </h2>
      {board.rows.length === 0 ? (
        <p className="v2-field-hint">No invites tracked yet.</p>
      ) : (
        <div className="v2-list">
          {board.rows.map((r) => (
            <div className="v2-row" key={r.userId}>
              <div className="v2-row-main">
                <h3>
                  #{r.rank} · {r.name}
                </h3>
                <p>
                  {r.net} invite{r.net === 1 ? '' : 's'} · {r.regular} joined · {r.leaves} left · {r.bonus}{' '}
                  bonus
                </p>
              </div>
            </div>
          ))}
        </div>
      )}

      <h2 className="v2-group-title v2-section-gap">Adjust bonus invites</h2>
      <p className="v2-field-hint">
        Add or subtract from a member's total (e.g. to reward a giveaway). Sets the bonus outright.
      </p>
      <form onSubmit={onSetBonus}>
        <div className="v2-field-row">
          <input
            type="text"
            placeholder="Member ID or @mention"
            value={bonusUser}
            onChange={(e) => setBonusUser(e.target.value)}
            required
          />
          <input
            type="number"
            className="v2-input-sm"
            value={bonusValue}
            onChange={(e) => setBonusValue(e.target.value)}
            required
          />
          <button type="submit" className="v2-btn-primary" disabled={bonusBusy}>
            {bonusBusy ? 'Setting…' : 'Set bonus'}
          </button>
        </div>
      </form>
      <SaveBar dirty={dirty} saving={saving} onSave={save} onReset={reset} />
    </>
  );
}
