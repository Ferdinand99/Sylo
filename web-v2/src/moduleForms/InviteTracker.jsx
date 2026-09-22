import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getModuleConfig, saveModuleConfig, setInviteBonus, ApiError } from '../api.js';
import { useApiData } from '../useApiData.js';

export default function InviteTracker() {
  const { guildId } = useParams();
  const { data, loading, error, setData } = useApiData(
    () => getModuleConfig(guildId, 'invite-tracker'),
    [guildId]
  );
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [bonusUser, setBonusUser] = useState('');
  const [bonusValue, setBonusValue] = useState(0);
  const [bonusBusy, setBonusBusy] = useState(false);

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
          `Couldn't load Invite tracker settings (${error.message}).`
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
      const { config } = await saveModuleConfig(guildId, 'invite-tracker', form);
      setForm(config);
      setSaved(true);
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function onSetBonus(e) {
    e.preventDefault();
    setBonusBusy(true);
    try {
      const { board } = await setInviteBonus(guildId, bonusUser.trim(), Number(bonusValue));
      setData((d) => ({ ...d, board }));
      setBonusUser('');
      setBonusValue(0);
    } catch (err) {
      alert(err.message);
    } finally {
      setBonusBusy(false);
    }
  }

  const { board } = data;

  return (
    <>
      <h1 className="v2-section-title">Invite tracker</h1>
      <p className="v2-field-hint">
        Members get a personal invite link with <code>/invites</code>. When someone joins through it, that
        member's invite count goes up. <code>/inviter</code> and <code>/invites-leaderboard</code> read this
        same data.
      </p>

      {!board.canReadInvites ? (
        <p className="v2-warn-text">
          Sylo needs the Manage Server permission to read this server's invites — without it, joins can't be
          attributed to an inviter.
        </p>
      ) : null}

      <form onSubmit={onSave}>
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
            min={0}
            max={168}
            value={form.graceHours}
            onChange={(e) => set({ graceHours: Number(e.target.value) })}
          />
          <p className="v2-field-hint">
            A join that leaves inside this window is not counted. 0 disables the guard.
          </p>
        </div>

        <div className="v2-section-gap">
          <button type="submit" className="v2-btn-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          {saved ? <span className="v2-field-hint"> Saved.</span> : null}
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
    </>
  );
}
