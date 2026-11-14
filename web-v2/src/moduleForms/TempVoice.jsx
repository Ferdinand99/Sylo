import ChipPicker from '../components/ChipPicker.jsx';
import PlaceholderBar from '../components/PlaceholderBar.jsx';
import PlaceholderHint from '../components/PlaceholderHint.jsx';
import LoadError from '../components/LoadError.jsx';
import SaveBar from '../components/SaveBar.jsx';
import { useModuleForm } from '../components/useModuleForm.js';
import { limitOf, useModuleLimits } from '../components/useModuleLimits.js';
import UnitInput from '../components/UnitInput.jsx';
import { cardTitle } from '../util.js';
import { tokensFor } from '../placeholders.js';
import '../styles/wp2-alerts.css';

function newKey() {
  return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Math.random());
}

const KEEPALIVE_OPTIONS = [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const DEFAULT_NAME = "#{index} - {username}'s Channel";

function toFormRow(h = {}) {
  return {
    key: newKey(),
    id: h.id || '',
    hubChannelId: h.hubChannelId || '',
    categoryId: h.categoryId || '',
    nameTemplate: h.nameTemplate || DEFAULT_NAME,
    userLimit: h.userLimit || 0,
    bitrate: h.bitrate || 0,
    keepAliveMinutes: h.keepAliveMinutes ?? 0,
    ownershipLock: Boolean(h.ownershipLock),
    syncCategory: Boolean(h.syncCategory),
    syncChannel: Boolean(h.syncChannel),
    roleMode: h.roleMode === 'deny' ? 'deny' : 'allow',
    roleList: h.roleList || [],
    useRolesForAccess: Boolean(h.useRolesForAccess),
    ignoredRoles: h.ignoredRoles || [],
    moderatorRoles: h.moderatorRoles || [],
    ownerPerms: {
      manageChannels: h.ownerPerms?.manageChannels !== false,
      managePermissions: Boolean(h.ownerPerms?.managePermissions),
      prioritySpeaker: Boolean(h.ownerPerms?.prioritySpeaker),
      moveMembers: Boolean(h.ownerPerms?.moveMembers),
    },
    textChannel: {
      enabled: Boolean(h.textChannel?.enabled),
      restrictCommands: Boolean(h.textChannel?.restrictCommands),
      pinUsages: Boolean(h.textChannel?.pinUsages),
      restrict: Boolean(h.textChannel?.restrict),
    },
  };
}

function preview(template) {
  return String(template || DEFAULT_NAME)
    .replaceAll('{index}', '1')
    .replaceAll('{count}', '1')
    .replaceAll('{username}', 'player')
    .replaceAll('{user}', 'Player')
    .slice(0, 100);
}

function keepAliveLabel(m) {
  if (m < 0) return 'Never delete';
  if (m === 0) return 'Delete immediately';
  return `${m} minute${m === 1 ? '' : 's'}`;
}

const OWNER_PERMS = [
  ['manageChannels', 'Manage Channel (rename, user limit)'],
  ['managePermissions', 'Manage Permissions'],
  ['prioritySpeaker', 'Priority Speaker'],
  ['moveMembers', 'Move Members'],
];
const TEXT_CHANNEL_OPTIONS = [
  ['enabled', 'Create a paired temporary text channel'],
  ['restrict', 'Only connected members (and mods) can read it'],
  ['pinUsages', 'Pin a message listing the /voice-* commands'],
  ['restrictCommands', 'Only allow /voice-* in this text channel'],
];

const roles = (n) => `${n} role${n === 1 ? '' : 's'}`;

/** One line for each folded section: what is set in it, so the card reads without opening anything. */
function whoCanJoinSummary(h) {
  const n = h.roleList.length;
  const who =
    h.roleMode === 'deny'
      ? `Only members with ${n ? roles(n) : 'a role (none picked)'}`
      : n
        ? `Everyone except ${roles(n)}`
        : 'Everyone';
  const synced = [h.syncCategory && 'the category', h.syncChannel && 'the hub'].filter(Boolean);
  return synced.length ? `${who} · permissions follow ${synced.join(' and ')}` : who;
}
function moderationSummary(h) {
  const parts = [];
  if (h.moderatorRoles.length) parts.push(`${roles(h.moderatorRoles.length)} can moderate`);
  if (h.ignoredRoles.length) parts.push(`${roles(h.ignoredRoles.length)} ignored`);
  return parts.join(' · ') || 'No extra roles';
}
function ownerSummary(h) {
  const on = OWNER_PERMS.filter(([key]) => h.ownerPerms[key]).map(([, label]) => label.split(' (')[0]);
  return on.join(', ') || 'None';
}
function textChannelSummary(h) {
  if (!h.textChannel.enabled) return 'Off';
  const more = TEXT_CHANNEL_OPTIONS.filter(([key]) => key !== 'enabled' && h.textChannel[key]).length;
  return more ? `On · ${more} option${more === 1 ? '' : 's'}` : 'On';
}

/**
 * A settings group that folds away to one line: its title and what is set in it. The hub card holds a lot,
 * and most hubs only ever change the name and the limits. A plain <details>, so it also works from the
 * keyboard and keeps its own open state while the form re-renders.
 */
function FoldSection({ title, summary, children }) {
  return (
    <details className="v2-fold">
      <summary className="v2-fold-head">
        <span className="v2-fold-title">{title}</span>
        <span className="v2-fold-summary">{summary}</span>
      </summary>
      <div className="v2-fold-body">{children}</div>
    </details>
  );
}

const toForm = (config) => ({ hubs: config.hubs.map(toFormRow) });
const fromForm = (form) => ({
  hubs: form.hubs.map((h) => {
    const copy = { ...h };
    delete copy.key;
    return copy;
  }),
});

export default function TempVoice() {
  const limits = useModuleLimits('temp-voice');
  const {
    data: d,
    form,
    setForm,
    status,
    error,
    dirty,
    saving,
    save,
    reset,
  } = useModuleForm('temp-voice', {
    toForm,
    fromForm,
  });

  if (status === 'error') return <LoadError error={error} what="Temporary voice settings" />;
  if (status === 'loading') return <p className="v2-state">Loading…</p>;

  const updateHub = (key, patch) =>
    setForm((f) => ({ hubs: f.hubs.map((h) => (h.key === key ? { ...h, ...patch } : h)) }));
  const addHub = () => setForm((f) => ({ hubs: [...f.hubs, toFormRow()] }));
  const removeHub = (key) => setForm((f) => ({ hubs: f.hubs.filter((h) => h.key !== key) }));

  return (
    <>
      <h1 className="v2-section-title">Temporary voice channels</h1>
      <p className="v2-field-hint">
        A hub is a "Join to create" voice channel. When a member joins it, Sylo makes them a personal voice
        channel, moves them in, and cleans it up after everyone leaves. Needs <strong>Manage Channels</strong>{' '}
        and <strong>Move Members</strong>.
      </p>

      <form onSubmit={save} data-savebar>
        {form.hubs.map((h) => (
          <div className="v2-rule-card" key={h.key}>
            <div className="v2-rule-head">
              <span className="v2-rule-title">
                {cardTitle(d.voiceChannels.find((c) => c.id === h.hubChannelId)?.name, '') || 'Hub'}
              </span>
              <button type="button" className="v2-btn-danger-ghost" onClick={() => removeHub(h.key)}>
                Remove
              </button>
            </div>

            <div className="v2-field-row">
              <div className="v2-field">
                <label>"Join to create" voice channel</label>
                <select
                  value={h.hubChannelId}
                  onChange={(e) => updateHub(h.key, { hubChannelId: e.target.value })}
                >
                  <option value="">— select a voice channel —</option>
                  {d.voiceChannels.map((c) => (
                    <option key={c.id} value={c.id}>
                      🔊 {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="v2-field">
                <label>Category for temporary channels</label>
                <select
                  value={h.categoryId}
                  onChange={(e) => updateHub(h.key, { categoryId: e.target.value })}
                >
                  <option value="">— same category as the hub —</option>
                  {d.categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <PlaceholderBar
              fields={[
                { id: `tv-name-${h.key}`, label: 'Temporary channel name', tokens: tokensFor('tempVoice') },
              ]}
            />
            <div className="v2-field">
              <label htmlFor={`tv-name-${h.key}`}>Temporary channel name</label>
              <input
                id={`tv-name-${h.key}`}
                type="text"
                maxLength={limitOf(limits, 'hubs[].nameTemplate').maxLength}
                placeholder={DEFAULT_NAME}
                value={h.nameTemplate}
                onChange={(e) => updateHub(h.key, { nameTemplate: e.target.value })}
              />
              <PlaceholderHint
                fieldId={`tv-name-${h.key}`}
                chips={false}
                tokens={tokensFor('tempVoice')}
                value={h.nameTemplate}
                onChange={(nameTemplate) => updateHub(h.key, { nameTemplate })}
              />
              <p className="v2-field-hint">Preview: {preview(h.nameTemplate)}</p>
            </div>

            <div className="v2-field-row">
              <div className="v2-field">
                <label>
                  User limit <span className="v2-field-hint">— 0 = ∞</span>
                </label>
                <UnitInput
                  unit="members"
                  min={limitOf(limits, 'hubs[].userLimit').min}
                  max={limitOf(limits, 'hubs[].userLimit').max}
                  value={h.userLimit}
                  onChange={(e) => updateHub(h.key, { userLimit: Number(e.target.value) })}
                />
              </div>
              <div className="v2-field">
                <label>
                  Bitrate <span className="v2-field-hint">— 0 = default</span>
                </label>
                <UnitInput
                  unit="kbps"
                  wide
                  min={limitOf(limits, 'hubs[].bitrate').min}
                  max={limitOf(limits, 'hubs[].bitrate').max}
                  step={8}
                  value={h.bitrate}
                  onChange={(e) => updateHub(h.key, { bitrate: Number(e.target.value) })}
                />
              </div>
              <div className="v2-field">
                <label>Keep alive after empty</label>
                <select
                  value={h.keepAliveMinutes}
                  onChange={(e) => updateHub(h.key, { keepAliveMinutes: Number(e.target.value) })}
                >
                  {KEEPALIVE_OPTIONS.map((m) => (
                    <option key={m} value={m}>
                      {keepAliveLabel(m)}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="v2-field">
              <label className="v2-check">
                <input
                  type="checkbox"
                  checked={h.ownershipLock}
                  onChange={(e) => updateHub(h.key, { ownershipLock: e.target.checked })}
                />
                Ownership lock — don't auto-transfer if the owner leaves (they can /voice-claim it back)
              </label>
            </div>

            <FoldSection title="Who can join" summary={whoCanJoinSummary(h)}>
              <fieldset className="v2-field">
                <legend>Permissions of new channels</legend>
                <label className="v2-check">
                  <input
                    type="checkbox"
                    checked={h.syncCategory}
                    onChange={(e) => updateHub(h.key, { syncCategory: e.target.checked })}
                  />
                  Synchronize permissions with the hub's category
                </label>
                <label className="v2-check">
                  <input
                    type="checkbox"
                    checked={h.syncChannel}
                    onChange={(e) => updateHub(h.key, { syncChannel: e.target.checked })}
                  />
                  Synchronize permissions with the hub channel
                </label>
              </fieldset>

              <div className="v2-field">
                <label htmlFor={`tv-mode-${h.key}`}>Access</label>
                <select
                  id={`tv-mode-${h.key}`}
                  value={h.roleMode}
                  onChange={(e) => updateHub(h.key, { roleMode: e.target.value })}
                >
                  <option value="allow">Everyone except the roles below</option>
                  <option value="deny">Only members with a role below</option>
                </select>
              </div>
              <ChipPicker
                kind="role"
                items={d.roles}
                value={h.roleList}
                onChange={(roleList) => updateHub(h.key, { roleList })}
              />
              <div className="v2-field">
                <label className="v2-check">
                  <input
                    type="checkbox"
                    checked={h.useRolesForAccess}
                    onChange={(e) => updateHub(h.key, { useRolesForAccess: e.target.checked })}
                  />
                  Also use these roles to gate access to the temporary channels
                </label>
              </div>
            </FoldSection>

            <FoldSection title="Moderation" summary={moderationSummary(h)}>
              <div className="v2-field">
                <label>
                  Ignored roles <span className="v2-field-hint">— not affected by /voice-*</span>
                </label>
                <ChipPicker
                  kind="role"
                  items={d.roles}
                  value={h.ignoredRoles}
                  onChange={(ignoredRoles) => updateHub(h.key, { ignoredRoles })}
                />
              </div>

              <div className="v2-field">
                <label>
                  Moderator roles{' '}
                  <span className="v2-field-hint">— can run /voice-* on any temp channel</span>
                </label>
                <ChipPicker
                  kind="role"
                  items={d.roles}
                  value={h.moderatorRoles}
                  onChange={(moderatorRoles) => updateHub(h.key, { moderatorRoles })}
                />
              </div>
            </FoldSection>

            <FoldSection title="Owner permissions" summary={ownerSummary(h)}>
              <fieldset className="v2-field">
                <legend className="v2-sr-only">Owner permissions</legend>
                {OWNER_PERMS.map(([key, label]) => (
                  <label className="v2-check" key={key}>
                    <input
                      type="checkbox"
                      checked={h.ownerPerms[key]}
                      onChange={(e) =>
                        updateHub(h.key, { ownerPerms: { ...h.ownerPerms, [key]: e.target.checked } })
                      }
                    />
                    {label}
                  </label>
                ))}
              </fieldset>
            </FoldSection>

            <FoldSection title="Paired text channel" summary={textChannelSummary(h)}>
              <fieldset className="v2-field">
                <legend className="v2-sr-only">Paired text channel</legend>
                {TEXT_CHANNEL_OPTIONS.map(([key, label]) => (
                  <label className="v2-check" key={key}>
                    <input
                      type="checkbox"
                      checked={h.textChannel[key]}
                      onChange={(e) =>
                        updateHub(h.key, { textChannel: { ...h.textChannel, [key]: e.target.checked } })
                      }
                    />
                    {label}
                  </label>
                ))}
              </fieldset>
            </FoldSection>
          </div>
        ))}
        <button
          type="button"
          className="v2-btn-ghost"
          onClick={addHub}
          disabled={form.hubs.length >= (limitOf(limits, 'hubs').maxItems ?? Infinity)}
        >
          + Add hub
        </button>
      </form>
      <SaveBar dirty={dirty} saving={saving} onSave={save} onReset={reset} />
    </>
  );
}
