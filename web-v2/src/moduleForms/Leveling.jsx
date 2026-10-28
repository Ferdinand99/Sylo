import { useState } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../api.js';
import ChipPicker from '../components/ChipPicker.jsx';
import { notify } from '../notify.js';
import LoadError from '../components/LoadError.jsx';
import SaveBar from '../components/SaveBar.jsx';
import { useModuleForm } from '../components/useModuleForm.js';
import { confirmDialog } from '../components/ConfirmDialog.jsx';

function newKey() {
  return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Math.random());
}

const ANNOUNCE_LABELS = {
  channel: 'In a channel',
  reply: 'Reply to their message',
  dm: 'Direct message',
  off: 'No announcement',
};

const toForm = (config) => ({
  ...config,
  rewards: config.rewards.map((r) => ({ key: newKey(), ...r })),
  multipliers: config.multipliers.map((m) => ({ key: newKey(), ...m })),
});
const fromForm = (form) => {
  const body = {
    ...form,
    rewards: form.rewards.map(({ level, roleId }) => ({ level, roleId })),
    multipliers: form.multipliers.map(({ type, id, factor }) => ({ type, id, factor })),
  };
  delete body.key;
  return body;
};

export default function Leveling() {
  const { guildId, data, form, setForm, status, error, dirty, saving, save, reset } = useModuleForm(
    'leveling',
    {
      toForm,
      fromForm,
    }
  );
  const [xpUserId, setXpUserId] = useState('');
  const [xpValue, setXpValue] = useState('');
  const [xpBusy, setXpBusy] = useState(false);

  if (status === 'error') return <LoadError error={error} what="Leveling settings" />;
  if (status === 'loading') return <p className="v2-state">Loading…</p>;

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const addReward = () => set({ rewards: [...form.rewards, { key: newKey(), level: 5, roleId: '' }] });
  const updateReward = (key, patch) =>
    set({ rewards: form.rewards.map((r) => (r.key === key ? { ...r, ...patch } : r)) });
  const removeReward = (key) => set({ rewards: form.rewards.filter((r) => r.key !== key) });

  const addMultiplier = () =>
    set({ multipliers: [...form.multipliers, { key: newKey(), type: 'role', id: '', factor: 2 }] });
  const updateMultiplier = (key, patch) =>
    set({ multipliers: form.multipliers.map((m) => (m.key === key ? { ...m, ...patch } : m)) });
  const removeMultiplier = (key) => set({ multipliers: form.multipliers.filter((m) => m.key !== key) });

  async function onSetXp(e) {
    e.preventDefault();
    setXpBusy(true);
    try {
      await apiFetch(`/api/v2/guilds/${guildId}/modules/leveling/xp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: xpUserId, xp: Number(xpValue) }),
      });
      notify('XP updated.', 'info');
      setXpUserId('');
      setXpValue('');
    } catch (err) {
      notify(err.message);
    } finally {
      setXpBusy(false);
    }
  }

  async function onResetAll() {
    const ok = await confirmDialog({
      title: 'Wipe all leveling data?',
      body: "Every member's XP, level and message count on this server is deleted. This can't be undone.",
      confirmLabel: 'Wipe all leveling data',
      typeToConfirm: 'RESET',
    });
    if (!ok) return;
    setXpBusy(true);
    try {
      await apiFetch(`/api/v2/guilds/${guildId}/modules/leveling/xp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reset: true }),
      });
      notify('All leveling data wiped.', 'info');
    } catch (err) {
      notify(err.message);
    } finally {
      setXpBusy(false);
    }
  }

  return (
    <>
      <h1 className="v2-section-title">Leveling</h1>
      <p className="v2-field-hint">
        Members earn 15–25 XP per message (once per cooldown), plus optional voice XP, on a MEE6-style curve —
        scaled by the XP rate and any role/channel multipliers below. The public web leaderboard toggle is on
        the Leaderboard page. Turn the <code>/rank</code> and <code>/leaderboard</code> commands off, or limit
        them to certain channels or roles, on the <Link to={`/guilds/${guildId}/commands`}>Commands</Link>{' '}
        page.
      </p>

      <form onSubmit={save} data-savebar>
        <div className="v2-group">
          <h2 className="v2-group-title">Leveling up</h2>
          <div className="v2-field">
            <label>Level-up announcement</label>
            <select value={form.announce} onChange={(e) => set({ announce: e.target.value })}>
              {data.announceModes.map((m) => (
                <option key={m} value={m}>
                  {ANNOUNCE_LABELS[m] || m}
                </option>
              ))}
            </select>
          </div>
          <div className="v2-field">
            <label>
              Announcement channel <span className="v2-field-hint">— blank = wherever they levelled up</span>
            </label>
            <select value={form.announceChannel} onChange={(e) => set({ announceChannel: e.target.value })}>
              <option value="">— current channel —</option>
              {data.channels.map((c) => (
                <option key={c.id} value={c.id}>
                  #{c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="v2-field">
            <label>
              Level-up message{' '}
              <span className="v2-field-hint">
                — {'{player}'} {'{level}'} {'{username}'} {'{server}'}
              </span>
            </label>
            <textarea
              rows={2}
              maxLength={2000}
              placeholder="GG {player}, you just advanced to level {level}!"
              value={form.announceMessage}
              onChange={(e) => set({ announceMessage: e.target.value })}
            />
          </div>
          <div className="v2-field">
            <label>XP cooldown (seconds)</label>
            <input
              type="number"
              min={0}
              max={3600}
              value={form.cooldownSeconds}
              onChange={(e) => set({ cooldownSeconds: Number(e.target.value) })}
            />
          </div>
        </div>

        <div className="v2-group">
          <h2 className="v2-group-title">Role rewards</h2>
          <div className="v2-field">
            <label className="v2-check">
              <input
                type="radio"
                name="stackRewards"
                checked={form.stackRewards}
                onChange={() => set({ stackRewards: true })}
              />
              Stack previous rewards — a member can hold several reward roles at once
            </label>
            <label className="v2-check">
              <input
                type="radio"
                name="stackRewards"
                checked={!form.stackRewards}
                onChange={() => set({ stackRewards: false })}
              />
              Remove previous rewards — a member only keeps the highest reward role
            </label>
          </div>

          {form.rewards.map((r) => (
            <div className="v2-field-row" key={r.key}>
              <input
                type="number"
                min={1}
                max={1000}
                style={{ maxWidth: '90px' }}
                value={r.level}
                onChange={(e) => updateReward(r.key, { level: Number(e.target.value) })}
              />
              <select value={r.roleId} onChange={(e) => updateReward(r.key, { roleId: e.target.value })}>
                <option value="">— select a role —</option>
                {data.roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </select>
              <button type="button" className="v2-btn-ghost" onClick={() => removeReward(r.key)}>
                remove
              </button>
            </div>
          ))}
          <button type="button" className="v2-btn-ghost" onClick={addReward}>
            + Add role reward
          </button>

          <div className="v2-field v2-section-gap">
            <label className="v2-check">
              <input
                type="checkbox"
                checked={form.removeRewardsOnXpLoss}
                onChange={(e) => set({ removeRewardsOnXpLoss: e.target.checked })}
              />
              Remove a reward role when a member drops below its level
            </label>
          </div>
        </div>

        <div className="v2-group">
          <h2 className="v2-group-title">XP rate</h2>
          <div className="v2-field-row">
            {data.xpRates.map((x) => (
              <label className="v2-check" key={x}>
                <input
                  type="radio"
                  name="xpRate"
                  checked={form.xpRate === x}
                  onChange={() => set({ xpRate: x })}
                />
                x{x}
              </label>
            ))}
          </div>
        </div>

        <div className="v2-group">
          <h2 className="v2-group-title">Voice XP</h2>
          <div className="v2-field">
            <label className="v2-check">
              <input
                type="checkbox"
                checked={form.voiceXpEnabled}
                onChange={(e) => set({ voiceXpEnabled: e.target.checked })}
              />
              Give XP for time in voice
            </label>
          </div>
          <div className="v2-field">
            <label>
              XP per active voice-minute <span className="v2-field-hint">— before rate/multipliers</span>
            </label>
            <input
              type="number"
              min={1}
              max={60}
              value={form.voiceXpPerMin}
              onChange={(e) => set({ voiceXpPerMin: Number(e.target.value) })}
            />
          </div>
          <div className="v2-field">
            <label className="v2-check">
              <input
                type="checkbox"
                checked={form.voiceAfkExcluded}
                onChange={(e) => set({ voiceAfkExcluded: e.target.checked })}
              />
              Only when actually active — 2+ non-bot members, not deafened, not the AFK channel
            </label>
          </div>
        </div>

        <div className="v2-group">
          <h2 className="v2-group-title">XP multipliers</h2>
          <p className="v2-field-hint">
            The highest matching role factor is multiplied by the channel factor; both default to 1×, result
            capped at 10×.
          </p>
          {form.multipliers.map((m) => (
            <div className="v2-field-row" key={m.key}>
              <select
                value={`${m.type}:${m.id}`}
                onChange={(e) => {
                  const [type, id] = e.target.value.split(':');
                  updateMultiplier(m.key, { type, id });
                }}
              >
                <option value="role:">— select a role or channel —</option>
                <optgroup label="Roles">
                  {data.roles.map((r) => (
                    <option key={r.id} value={`role:${r.id}`}>
                      @{r.name}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Channels">
                  {data.channels.map((c) => (
                    <option key={c.id} value={`channel:${c.id}`}>
                      #{c.name}
                    </option>
                  ))}
                </optgroup>
              </select>
              <input
                type="number"
                min={0.1}
                max={5}
                step={0.05}
                style={{ maxWidth: '100px' }}
                value={m.factor}
                onChange={(e) => updateMultiplier(m.key, { factor: Number(e.target.value) })}
              />
              <button type="button" className="v2-btn-ghost" onClick={() => removeMultiplier(m.key)}>
                remove
              </button>
            </div>
          ))}
          <button type="button" className="v2-btn-ghost" onClick={addMultiplier}>
            + Add multiplier
          </button>
        </div>

        <div className="v2-group">
          <h2 className="v2-group-title">No-XP roles</h2>
          <div className="v2-field">
            <label className="v2-check">
              <input
                type="radio"
                name="noXpRolesMode"
                checked={form.noXpRolesMode === 'allow'}
                onChange={() => set({ noXpRolesMode: 'allow' })}
              />
              Allow all roles to gain XP, except the ones below
            </label>
            <label className="v2-check">
              <input
                type="radio"
                name="noXpRolesMode"
                checked={form.noXpRolesMode === 'deny'}
                onChange={() => set({ noXpRolesMode: 'deny' })}
              />
              Deny all roles from gaining XP, except the ones below
            </label>
          </div>
          <ChipPicker
            kind="role"
            items={data.roles}
            value={form.noXpRoles}
            onChange={(noXpRoles) => set({ noXpRoles })}
          />
        </div>

        <div className="v2-group">
          <h2 className="v2-group-title">No-XP channels</h2>
          <div className="v2-field">
            <label className="v2-check">
              <input
                type="radio"
                name="noXpChannelsMode"
                checked={form.noXpChannelsMode === 'allow'}
                onChange={() => set({ noXpChannelsMode: 'allow' })}
              />
              Allow all channels to gain XP, except the ones below
            </label>
            <label className="v2-check">
              <input
                type="radio"
                name="noXpChannelsMode"
                checked={form.noXpChannelsMode === 'deny'}
                onChange={() => set({ noXpChannelsMode: 'deny' })}
              />
              Deny all channels from gaining XP, except the ones below
            </label>
          </div>
          <ChipPicker
            kind="channel"
            items={data.channels}
            value={form.noXpChannels}
            onChange={(noXpChannels) => set({ noXpChannels })}
          />
        </div>
      </form>

      <div className="v2-group">
        <h2 className="v2-group-title">Leaderboard preview ({data.board.total} tracked)</h2>
        {data.board.rows.length === 0 ? (
          <p className="v2-note">No XP earned yet.</p>
        ) : (
          <div className="v2-list">
            {data.board.rows.map((r) => (
              <div className="v2-row" key={r.rank}>
                <div className="v2-row-main">
                  <h3>
                    #{r.rank} {r.name}
                  </h3>
                  <p>
                    Level {r.level} · {r.xp} XP
                    {r.voiceXp ? ` · ${r.voiceXp} voice XP (${r.voiceMinutes} min)` : ''} · {r.messages}{' '}
                    messages
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="v2-group">
        <h2 className="v2-group-title">Set XP for a user</h2>
        <form onSubmit={onSetXp} className="v2-field-row">
          <input
            type="text"
            placeholder="user ID or @mention"
            value={xpUserId}
            onChange={(e) => setXpUserId(e.target.value)}
          />
          <input
            type="number"
            min={0}
            placeholder="xp"
            style={{ maxWidth: '120px' }}
            value={xpValue}
            onChange={(e) => setXpValue(e.target.value)}
          />
          <button type="submit" className="v2-btn-ghost" disabled={xpBusy}>
            Update
          </button>
        </form>
      </div>

      <div className="v2-danger-zone">
        <p className="v2-danger-zone-text">
          <strong>Reset all leveling data</strong>
          <span>Wipes every member's XP, level and message count on this server.</span>
        </p>
        <button type="button" className="v2-btn-danger" onClick={onResetAll} disabled={xpBusy}>
          Reset all…
        </button>
      </div>
      <SaveBar dirty={dirty} saving={saving} onSave={save} onReset={reset} />
    </>
  );
}
