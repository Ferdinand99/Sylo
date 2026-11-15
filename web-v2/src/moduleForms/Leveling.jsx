import { useState } from 'react';
import PickerHealth from '../components/PickerHealth.jsx';
import { Link } from 'react-router-dom';
import { apiFetch } from '../api.js';
import ChipPicker from '../components/ChipPicker.jsx';
import HowItWorks from '../components/HowItWorks.jsx';
import PlaceholderHint from '../components/PlaceholderHint.jsx';
import MentionTextarea from '../components/MentionTextarea.jsx';
import PreviewLayout from '../components/PreviewLayout.jsx';
import { notify } from '../notify.js';
import LoadError from '../components/LoadError.jsx';
import SaveBar from '../components/SaveBar.jsx';
import { useModuleForm } from '../components/useModuleForm.js';
import { limitOf, useModuleLimits } from '../components/useModuleLimits.js';
import { confirmDialog } from '../components/ConfirmDialog.jsx';
import UnitInput from '../components/UnitInput.jsx';
import Meta, { plural } from '../components/Meta.jsx';
import MemberPicker from '../components/MemberPicker.jsx';
import SectionIndex from '../components/SectionIndex.jsx';
import { tokensFor } from '../placeholders.js';
import '../styles/wp1-members.css';

const SECTIONS = [
  ['lvl-up', 'Leveling up'],
  ['lvl-rewards', 'Role rewards'],
  ['lvl-rate', 'XP rate'],
  ['lvl-voice', 'Voice'],
  ['lvl-multipliers', 'Multipliers'],
  ['lvl-by-role', 'XP by role'],
  ['lvl-by-channel', 'XP by channel'],
  ['lvl-board', 'Leaderboard'],
  ['lvl-set-xp', 'Set XP'],
  ['lvl-danger', 'Danger zone'],
];

/** "2h 30m", "45m", "3h": minutes as the other dashboard pages write a duration. */
export function shortMinutes(minutes) {
  const n = Math.max(0, Math.round(Number(minutes) || 0));
  const h = Math.floor(n / 60);
  const m = n % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

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
  const limits = useModuleLimits('leveling');
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

  const previews = [
    {
      key: 'levelup',
      title: 'Level-up message',
      hidden: form.announce === 'off',
      content: form.announceMessage,
      samples: { '{level}': '12' },
    },
  ];
  return (
    <PreviewLayout previews={previews} lookup={{ channels: data.channels ?? [], roles: data.roles ?? [] }}>
      <>
        <h1 className="v2-section-title">Leveling</h1>
        <p className="v2-field-hint">
          Members earn XP by chatting and level up, and you can reward levels with roles.
        </p>
        <p className="v2-field-hint">
          Commands: <code>/rank</code> <code>/leaderboard</code>. Turn them off, or limit them to certain
          channels or roles, on the <Link to={`/guilds/${guildId}/commands`}>Commands</Link> page.
        </p>
        <HowItWorks>
          <p>
            Members earn 15–25 XP per message (once per cooldown), plus optional voice XP. Each level needs
            more than the last, scaled by the XP rate and any role or channel multipliers below.
          </p>
          <p>The public leaderboard on/off switch is on the Leaderboard page.</p>
        </HowItWorks>

        <SectionIndex sections={SECTIONS} />

        <form onSubmit={save} data-savebar>
          <div className="v2-group">
            <h2 className="v2-group-title" id="lvl-up">
              Leveling up
            </h2>
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
                Announcement channel{' '}
                <span className="v2-field-hint">— blank = wherever they levelled up</span>
              </label>
              <select value={form.announceChannel} onChange={(e) => set({ announceChannel: e.target.value })}>
                <option value="">— current channel —</option>
                {data.channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    #{c.name}
                  </option>
                ))}
              </select>
              <PickerHealth kind="channel" value={form.announceChannel} />
            </div>
            <div className="v2-field">
              <label htmlFor="announceMessage">Level-up message</label>
              <MentionTextarea
                channels={data.channels}
                roles={data.roles}
                id="announceMessage"
                rows={2}
                maxLength={limitOf(limits, 'announceMessage').maxLength}
                placeholder="GG {player}, you just advanced to level {level}!"
                value={form.announceMessage}
                onChange={(e) => set({ announceMessage: e.target.value })}
              />
              <PlaceholderHint
                fieldId="announceMessage"
                tokens={tokensFor('leveling')}
                value={form.announceMessage}
                onChange={(announceMessage) => set({ announceMessage })}
              />
            </div>
            <div className="v2-field">
              <label>XP cooldown</label>
              <UnitInput
                unit="seconds"
                min={limitOf(limits, 'cooldownSeconds').min}
                max={limitOf(limits, 'cooldownSeconds').max}
                value={form.cooldownSeconds}
                onChange={(e) => set({ cooldownSeconds: Number(e.target.value) })}
              />
            </div>
          </div>

          <div className="v2-group">
            <h2 className="v2-group-title" id="lvl-rewards">
              Role rewards
            </h2>
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
              <div className="v2-field-row v2-pair-row" key={r.key}>
                <span className="v2-pair-prefix" aria-hidden="true">
                  Level
                </span>
                <input
                  type="number"
                  aria-label="Reward level"
                  min={limitOf(limits, 'rewards[].level').min}
                  max={limitOf(limits, 'rewards[].level').max}
                  className="v2-input-num"
                  value={r.level}
                  onChange={(e) => updateReward(r.key, { level: Number(e.target.value) })}
                />
                <span className="v2-pair-arrow" aria-hidden="true">
                  →
                </span>
                <select
                  aria-label="Reward role"
                  value={r.roleId}
                  onChange={(e) => updateReward(r.key, { roleId: e.target.value })}
                >
                  <option value="">— select a role —</option>
                  {data.roles.map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.name}
                    </option>
                  ))}
                </select>
                <PickerHealth kind="role" value={r.roleId} />
                <button type="button" className="v2-btn-danger-ghost" onClick={() => removeReward(r.key)}>
                  Remove
                </button>
              </div>
            ))}
            <button
              type="button"
              className="v2-btn-ghost"
              onClick={addReward}
              disabled={form.rewards.length >= (limitOf(limits, 'rewards').maxItems ?? Infinity)}
            >
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
            <h2 className="v2-group-title" id="lvl-rate">
              XP rate
            </h2>
            <div className="v2-field">
              <label htmlFor="xpRate">Speed everyone levels up at</label>
              <select
                id="xpRate"
                value={String(form.xpRate)}
                onChange={(e) => set({ xpRate: data.xpRates.find((x) => String(x) === e.target.value) ?? 1 })}
              >
                {data.xpRates.map((x) => (
                  <option key={x} value={String(x)}>
                    {`x${x}`}
                    {x === 1 ? ' (normal)' : ''}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="v2-group">
            <h2 className="v2-group-title" id="lvl-voice">
              Voice XP
            </h2>
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
                Voice XP <span className="v2-field-hint">— before rate/multipliers</span>
              </label>
              <UnitInput
                unit="XP per active minute"
                min={limitOf(limits, 'voiceXpPerMin').min}
                max={limitOf(limits, 'voiceXpPerMin').max}
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
            <h2 className="v2-group-title" id="lvl-multipliers">
              XP multipliers
            </h2>
            <p className="v2-field-hint">
              The highest matching role factor is multiplied by the channel factor; both default to 1×, result
              capped at 10×.
            </p>
            {form.multipliers.map((m) => (
              <div className="v2-field-row v2-pair-row v2-pair-row-multiplier" key={m.key}>
                <select
                  aria-label="Role or channel"
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
                <span className="v2-pair-arrow" aria-hidden="true">
                  ×
                </span>
                <input
                  type="number"
                  aria-label="XP factor"
                  min={limitOf(limits, 'multipliers[].factor').min}
                  max={limitOf(limits, 'multipliers[].factor').max}
                  step={0.05}
                  className="v2-input-num"
                  value={m.factor}
                  onChange={(e) => updateMultiplier(m.key, { factor: Number(e.target.value) })}
                />
                <button type="button" className="v2-btn-danger-ghost" onClick={() => removeMultiplier(m.key)}>
                  Remove
                </button>
              </div>
            ))}
            <button
              type="button"
              className="v2-btn-ghost"
              onClick={addMultiplier}
              disabled={form.multipliers.length >= (limitOf(limits, 'multipliers').maxItems ?? Infinity)}
            >
              + Add multiplier
            </button>
          </div>

          <div className="v2-group">
            <h2 className="v2-group-title" id="lvl-by-role">
              XP by role
            </h2>
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
            <h2 className="v2-group-title" id="lvl-by-channel">
              XP by channel
            </h2>
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
          <h2 className="v2-group-title" id="lvl-board">
            Leaderboard preview ({data.board.total} tracked)
          </h2>
          {data.board.rows.length === 0 ? (
            <p className="v2-note">No XP earned yet.</p>
          ) : (
            <div className="v2-list">
              {data.board.rows.slice(0, 5).map((r) => (
                <div className="v2-row" key={r.rank}>
                  <div className="v2-row-main">
                    <h3>
                      #{r.rank} {r.name}
                    </h3>
                    <p>
                      <Meta
                        items={[
                          `Level ${r.level}`,
                          `${r.xp} XP`,
                          r.voiceXp ? `${r.voiceXp} voice XP (${shortMinutes(r.voiceMinutes)})` : false,
                          plural(r.messages, 'message'),
                        ]}
                      />
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
          {data.board.rows.length > 0 ? (
            <p className="v2-field-hint">
              <Link to={`/guilds/${guildId}/leaderboard`}>Full leaderboard →</Link>
            </p>
          ) : null}
        </div>

        <div className="v2-group">
          <h2 className="v2-group-title" id="lvl-set-xp">
            Set XP for a user
          </h2>
          <form onSubmit={onSetXp} className="v2-field-row">
            <MemberPicker
              id="xp-member"
              label="Member"
              value={xpUserId}
              onChange={setXpUserId}
              placeholder="Search by name, or paste an ID"
              clearLabel="Choose another member"
            />
            <input
              type="number"
              aria-label="New XP total"
              min={limitOf(limits, 'xp').min}
              max={limitOf(limits, 'xp').max}
              placeholder="xp"
              style={{ maxWidth: '120px' }}
              value={xpValue}
              onChange={(e) => setXpValue(e.target.value)}
            />
            <button type="submit" className="v2-btn-ghost" disabled={xpBusy || !xpUserId || xpValue === ''}>
              Update
            </button>
          </form>
        </div>

        <div className="v2-danger-zone" id="lvl-danger">
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
    </PreviewLayout>
  );
}
