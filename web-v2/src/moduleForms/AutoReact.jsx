import EmojiPicker from '../components/EmojiPicker.jsx';
import LoadError from '../components/LoadError.jsx';
import SaveBar from '../components/SaveBar.jsx';
import { useModuleForm } from '../components/useModuleForm.js';
import { limitOf, useModuleLimits } from '../components/useModuleLimits.js';
import UnitInput from '../components/UnitInput.jsx';
import MemberPicker from '../components/MemberPicker.jsx';
import { useMemberNames } from '../memberNames.js';
import { cardTitle, channelTitle } from '../util.js';
import { appendEmoji } from '../emojiText.js';
import '../styles/wp1-members.css';

const MODE_LABELS = { always: 'React to every message', random: 'React at a random chance' };
const ROLE_ACTION_LABELS = { add: 'Give it to them', remove: 'Take it away from them' };

function newKey() {
  return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Math.random());
}

function toFormRule(r) {
  return {
    key: newKey(),
    targetUsers: (r.targetUsers || []).map(String),
    targetRoleId: (r.targetRoles || [])[0] || '',
    channelId: r.channelId || '',
    emojisText: (r.emojis || []).join(' '),
    mode: r.mode || 'always',
    chance: r.chance || 50,
    roleId: r.roleId || '',
    roleAction: r.roleAction || 'add',
  };
}

// A rule's title says who it is for and what it does: "@Infected → 🧟 🔥 in #general". Until the rule has a
// target it is named by its emoji and channel, and "Rule 2" while it is still empty.
function ruleTitle(r, channels, roles, names, index) {
  const emojis = cardTitle(r.emojisText, '', 24);
  const where = channelTitle(channels, r.channelId, '');
  const role = roles.find((x) => String(x.id) === String(r.targetRoleId));
  const [firstUser] = r.targetUsers;
  const userName = firstUser ? (names.get(firstUser) ?? 'member') : '';
  const target = role
    ? `@${role.name}`
    : userName
      ? `@${userName}${r.targetUsers.length > 1 ? ` +${r.targetUsers.length - 1}` : ''}`
      : '';
  const what = emojis ? (where ? `${emojis} in ${where}` : emojis) : where;
  if (target && what) return `${target} → ${what}`;
  return target || what || `Rule ${index + 1}`;
}

function RuleTitle({ rule, channels, roles, index }) {
  const names = useMemberNames(...rule.targetUsers.slice(0, 1).map((id) => `<@${id}>`));
  return <span className="v2-rule-title">{ruleTitle(rule, channels, roles, names, index)}</span>;
}

function emptyFormRule() {
  return toFormRule({});
}

const toForm = (config) => ({
  cooldownSeconds: config.cooldownSeconds,
  logChannelId: config.logChannelId,
  rules: config.rules.length ? config.rules.map(toFormRule) : [emptyFormRule()],
});
const fromForm = (form) => ({
  cooldownSeconds: form.cooldownSeconds,
  logChannelId: form.logChannelId,
  rules: form.rules.map((r) => ({
    // The API takes the ids as one text, separated by spaces.
    targetUsersText: r.targetUsers.join(' '),
    targetRoleId: r.targetRoleId,
    channelId: r.channelId,
    emojis: r.emojisText,
    mode: r.mode,
    chance: r.chance,
    roleId: r.roleId,
    roleAction: r.roleAction,
  })),
});

export default function AutoReact() {
  const limits = useModuleLimits('auto-react');
  const { data, form, setForm, status, error, dirty, saving, save, reset } = useModuleForm('auto-react', {
    toForm,
    fromForm,
  });

  if (status === 'error') return <LoadError error={error} what="Auto-react settings" />;
  if (status === 'loading') return <p className="v2-state">Loading…</p>;

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const updateRule = (key, patch) =>
    setForm((f) => ({ ...f, rules: f.rules.map((r) => (r.key === key ? { ...r, ...patch } : r)) }));
  const addRule = () => setForm((f) => ({ ...f, rules: [...f.rules, emptyFormRule()] }));
  const removeRule = (key) => setForm((f) => ({ ...f, rules: f.rules.filter((r) => r.key !== key) }));

  return (
    <>
      <h1 className="v2-section-title">Auto-react</h1>
      <p className="v2-field-hint">
        Reacts automatically to messages from chosen users or roles. Rules are checked top to bottom; the{' '}
        <strong>first</strong> one that matches is used. Example: react with 🧟 to anyone with the "Infected"
        role, and also give the "Infected" role to a few specific people to kick off the game.
      </p>

      <form onSubmit={save} data-savebar>
        <div className="v2-field">
          <label htmlFor="cooldownSeconds">Per-user cooldown</label>
          <UnitInput
            id="cooldownSeconds"
            unit="seconds"
            min={limitOf(limits, 'cooldownSeconds').min}
            max={limitOf(limits, 'cooldownSeconds').max}
            value={form.cooldownSeconds}
            onChange={(e) => set({ cooldownSeconds: Number(e.target.value) })}
          />
          <p className="v2-field-hint">
            How long to wait before reacting to the same person again, so one active chatter doesn't get
            reacted to on every message.
          </p>
        </div>

        <div className="v2-field">
          <label htmlFor="logChannelId">
            Log channel <span className="v2-field-hint">— optional</span>
          </label>
          <select
            id="logChannelId"
            value={form.logChannelId}
            onChange={(e) => set({ logChannelId: e.target.value })}
          >
            <option value="">— none —</option>
            {data.channels.map((c) => (
              <option key={c.id} value={c.id}>
                #{c.name}
              </option>
            ))}
          </select>
          <p className="v2-field-hint">
            Posts one line here every time a rule triggers — who it reacted to and what changed.
          </p>
        </div>

        <h2 className="v2-group-title">Rules</h2>
        {form.rules.map((r, i) => (
          <div className="v2-rule-card" key={r.key}>
            <div className="v2-rule-head">
              <RuleTitle rule={r} channels={data.channels} roles={data.roles} index={i} />
              <button type="button" className="v2-btn-danger-ghost" onClick={() => removeRule(r.key)}>
                Remove rule
              </button>
            </div>
            <p className="v2-field-hint v2-rule-lead">
              Matches if <strong>either</strong> the users or the role below match.
            </p>
            {!r.targetUsers.length && !r.targetRoleId ? (
              <p className="v2-ph-warn v2-ph-warn-block" role="status">
                <span aria-hidden="true">⚠ </span>
                This rule has no users and no role yet, so it will be removed when you save.
              </p>
            ) : null}

            <div className="v2-field">
              <label htmlFor={`target-users-${r.key}`}>
                Target users <span className="v2-field-hint">— optional</span>
              </label>
              <MemberPicker
                multiple
                id={`target-users-${r.key}`}
                value={r.targetUsers}
                onChange={(targetUsers) => updateRule(r.key, { targetUsers })}
                max={limitOf(limits, 'rules[].targetUsers').maxItems}
                placeholder="Search by name, or paste an ID"
              />
              <p className="v2-field-hint">
                Type two letters of a name and pick the member. For someone who has left, paste their user ID.
              </p>
            </div>

            <div className="v2-field">
              <label htmlFor={`target-role-${r.key}`}>
                Target role <span className="v2-field-hint">— optional</span>
              </label>
              <select
                id={`target-role-${r.key}`}
                value={r.targetRoleId}
                onChange={(e) => updateRule(r.key, { targetRoleId: e.target.value })}
              >
                <option value="">— no role —</option>
                {data.roles.map((rl) => (
                  <option key={rl.id} value={rl.id}>
                    {rl.name}
                  </option>
                ))}
              </select>
              <p className="v2-field-hint">
                Anyone with this role matches too, on top of the specific users above.
              </p>
            </div>

            <div className="v2-field">
              <label>
                Channel <span className="v2-field-hint">— optional</span>
              </label>
              <select value={r.channelId} onChange={(e) => updateRule(r.key, { channelId: e.target.value })}>
                <option value="">— all channels —</option>
                {data.channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    #{c.name}
                  </option>
                ))}
              </select>
              <p className="v2-field-hint">
                Leave as "all channels" for this rule to trigger anywhere. Pick one to lock the "game" to a
                single channel.
              </p>
            </div>

            <div className="v2-field">
              <label htmlFor={`emojis-${r.key}`}>Emoji to react with</label>
              <div className="v2-field-row v2-emoji-row">
                <input
                  id={`emojis-${r.key}`}
                  type="text"
                  placeholder="🧟 🔥"
                  value={r.emojisText}
                  onChange={(e) => updateRule(r.key, { emojisText: e.target.value })}
                />
                <EmojiPicker
                  onPick={(emoji) => updateRule(r.key, { emojisText: appendEmoji(r.emojisText, emoji) })}
                />
              </div>
              <p className="v2-field-hint">
                Pick one or more with the smiley, or type or paste them, separated by spaces or commas —
                unicode (🧟) or a server custom emoji.
              </p>
            </div>

            <div className="v2-field">
              <label>When to react</label>
              <div className="v2-field-row">
                <select value={r.mode} onChange={(e) => updateRule(r.key, { mode: e.target.value })}>
                  {data.modes.map((m) => (
                    <option key={m} value={m}>
                      {MODE_LABELS[m] || m}
                    </option>
                  ))}
                </select>
                {r.mode === 'random' ? (
                  <UnitInput
                    unit="% chance"
                    aria-label="Chance to react"
                    min={limitOf(limits, 'rules[].chance').min}
                    max={limitOf(limits, 'rules[].chance').max}
                    value={r.chance}
                    onChange={(e) => updateRule(r.key, { chance: Number(e.target.value) })}
                  />
                ) : null}
              </div>
            </div>

            <div className="v2-field">
              <label>
                Also change a role <span className="v2-field-hint">— optional</span>
              </label>
              <div className="v2-field-row">
                <select
                  aria-label="Role to change"
                  value={r.roleId}
                  onChange={(e) => updateRule(r.key, { roleId: e.target.value })}
                >
                  <option value="">— no role change —</option>
                  {data.roles.map((rl) => (
                    <option key={rl.id} value={rl.id}>
                      {rl.name}
                    </option>
                  ))}
                </select>
                {r.roleId ? (
                  <>
                    <span aria-hidden="true">→</span>
                    <select
                      aria-label="What to do with the role"
                      value={r.roleAction}
                      onChange={(e) => updateRule(r.key, { roleAction: e.target.value })}
                    >
                      {data.roleActions.map((a) => (
                        <option key={a} value={a}>
                          {ROLE_ACTION_LABELS[a] || a}
                        </option>
                      ))}
                    </select>
                  </>
                ) : null}
              </div>
              <p className="v2-field-hint">
                Leave as "no role change" to just react without touching roles. Set a role here to also give
                (or take away) it from the message author — e.g. to mark them "Infected".
              </p>
            </div>
          </div>
        ))}
        <button
          type="button"
          className="v2-btn-ghost"
          onClick={addRule}
          disabled={form.rules.length >= (limitOf(limits, 'rules').maxItems ?? Infinity)}
        >
          + Add rule
        </button>
      </form>
      <SaveBar dirty={dirty} saving={saving} onSave={save} onReset={reset} />
    </>
  );
}
