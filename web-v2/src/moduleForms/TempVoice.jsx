import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getModuleConfig, saveModuleConfig, ApiError } from '../api.js';
import ChipPicker from '../components/ChipPicker.jsx';

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

export default function TempVoice() {
  const { guildId } = useParams();
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  function load() {
    return getModuleConfig(guildId, 'temp-voice')
      .then((data) => {
        setState({ loading: false, data, error: null });
        setForm({ hubs: data.config.hubs.map(toFormRow) });
      })
      .catch((error) => setState({ loading: false, data: null, error }));
  }

  useEffect(() => {
    load();
  }, [guildId]);

  if ((state.loading && !state.data) || !form) return <p className="v2-state">Loading…</p>;
  if (state.error) {
    const notAuthed = state.error instanceof ApiError && state.error.notAuthenticated;
    return (
      <p className="v2-state">
        {notAuthed ? (
          <>
            Your session expired — <a href="/auth/discord/login">log in again</a>.
          </>
        ) : (
          `Couldn't load Temporary voice settings (${state.error.message}).`
        )}
      </p>
    );
  }

  const d = state.data;

  const updateHub = (key, patch) =>
    setForm((f) => ({ hubs: f.hubs.map((h) => (h.key === key ? { ...h, ...patch } : h)) }));
  const addHub = () => setForm((f) => ({ hubs: [...f.hubs, toFormRow()] }));
  const removeHub = (key) => setForm((f) => ({ hubs: f.hubs.filter((h) => h.key !== key) }));

  async function onSave(e) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    try {
      const body = {
        hubs: form.hubs.map((h) => {
          const copy = { ...h };
          delete copy.key;
          return copy;
        }),
      };
      const { config } = await saveModuleConfig(guildId, 'temp-voice', body);
      setForm({ hubs: config.hubs.map(toFormRow) });
      setSaved(true);
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <h1 className="v2-section-title">Temporary voice channels</h1>
      <p className="v2-field-hint">
        A hub is a "Join to create" voice channel. When a member joins it, Sylo makes them a personal voice
        channel, moves them in, and cleans it up after everyone leaves. Needs <strong>Manage Channels</strong>{' '}
        and <strong>Move Members</strong>.
      </p>

      <form onSubmit={onSave}>
        {form.hubs.map((h) => (
          <div className="v2-rule-card" key={h.key}>
            <div className="v2-rule-head">
              <span className="v2-field-hint">Hub</span>
              <button type="button" className="v2-btn-ghost" onClick={() => removeHub(h.key)}>
                remove
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

            <div className="v2-field">
              <label>Temporary channel name</label>
              <input
                type="text"
                maxLength={95}
                placeholder={DEFAULT_NAME}
                value={h.nameTemplate}
                onChange={(e) => updateHub(h.key, { nameTemplate: e.target.value })}
              />
              <p className="v2-field-hint">
                Tokens: {'{index}'} (Nth channel), {'{username}'}. Preview: {preview(h.nameTemplate)}
              </p>
            </div>

            <div className="v2-field-row">
              <div className="v2-field">
                <label>
                  User limit <span className="v2-field-hint">— 0 = ∞</span>
                </label>
                <input
                  type="number"
                  min={0}
                  max={99}
                  style={{ maxWidth: '100px' }}
                  value={h.userLimit}
                  onChange={(e) => updateHub(h.key, { userLimit: Number(e.target.value) })}
                />
              </div>
              <div className="v2-field">
                <label>
                  Bitrate (kbps) <span className="v2-field-hint">— 0 = default</span>
                </label>
                <input
                  type="number"
                  min={0}
                  max={384}
                  step={8}
                  style={{ maxWidth: '100px' }}
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

            <h3 className="v2-field-hint u-mt-2">Permissions</h3>
            <div className="v2-field">
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
            </div>

            <div className="v2-field">
              <label>Who can join</label>
              <select value={h.roleMode} onChange={(e) => updateHub(h.key, { roleMode: e.target.value })}>
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
                Moderator roles <span className="v2-field-hint">— can run /voice-* on any temp channel</span>
              </label>
              <ChipPicker
                kind="role"
                items={d.roles}
                value={h.moderatorRoles}
                onChange={(moderatorRoles) => updateHub(h.key, { moderatorRoles })}
              />
            </div>

            <h3 className="v2-field-hint u-mt-2">Owner permissions</h3>
            <div className="v2-field">
              {[
                ['manageChannels', 'Manage Channel (rename, user limit)'],
                ['managePermissions', 'Manage Permissions'],
                ['prioritySpeaker', 'Priority Speaker'],
                ['moveMembers', 'Move Members'],
              ].map(([key, label]) => (
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
            </div>

            <h3 className="v2-field-hint u-mt-2">Text channel</h3>
            <div className="v2-field">
              {[
                ['enabled', 'Create a paired temporary text channel'],
                ['restrict', 'Only connected members (and mods) can read it'],
                ['pinUsages', 'Pin a message listing the /voice-* commands'],
                ['restrictCommands', 'Only allow /voice-* in this text channel'],
              ].map(([key, label]) => (
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
            </div>
          </div>
        ))}
        <button type="button" className="v2-btn-ghost" onClick={addHub}>
          + Add hub
        </button>

        <div className="v2-section-gap">
          <button type="submit" className="v2-btn-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          {saved ? <span className="v2-field-hint"> Saved.</span> : null}
        </div>
      </form>
    </>
  );
}
