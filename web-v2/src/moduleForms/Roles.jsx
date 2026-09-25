import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getRoles, saveAutoroles, saveReactionRole, deleteReactionRole, ApiError } from '../api.js';
import ChipPicker from '../components/ChipPicker.jsx';
import EmbedEditor from '../components/EmbedEditor.jsx';
import { newKey } from '../components/EmbedCard.jsx';

const BTN_STYLES = ['secondary', 'primary', 'success', 'danger'];
const STYLES = [
  ['reaction', 'Reactions', 'Members react with an emoji. Needs Add Reactions permission.'],
  ['buttons', 'Buttons', 'Members click a button. Up to 25, no reaction permission needed.'],
  ['select', 'Dropdown', 'Members pick from a select menu. Best for long lists.'],
];

function blankRow() {
  return { key: newKey('r'), emoji: '', label: '', roleId: '', btnStyle: 'secondary' };
}

function rowsMeta(style) {
  if (style === 'reaction') return { max: 20, title: 'Reactions & roles', addLabel: '+ Add reaction' };
  if (style === 'buttons') return { max: 25, title: 'Buttons & roles', addLabel: '+ Add button' };
  return { max: 25, title: 'Menu options', addLabel: '+ Add option' };
}

function ReactionRoleForm({ initial, channels, roles, onSave, onCancel, saving }) {
  const [style, setStyle] = useState(initial.style || 'reaction');
  const [channelId, setChannelId] = useState(initial.channelId || '');
  const [message, setMessage] = useState(initial.message || '');
  const [embedSpec, setEmbedSpec] = useState(initial.embed || {});
  const [exclusive, setExclusive] = useState(Boolean(initial.exclusive));
  const [mode, setMode] = useState(initial.mode === 'reverse' ? 'reverse' : 'default');
  const [placeholder, setPlaceholder] = useState(initial.placeholder || '');
  const [selMin, setSelMin] = useState(initial.selMin || 0);
  const [selMax, setSelMax] = useState(initial.selMax || 0);
  const [rows, setRows] = useState(() => {
    const pairs = Array.isArray(initial.pairs) && initial.pairs.length ? initial.pairs : [{}];
    return pairs.map((p) => ({
      key: newKey('r'),
      emoji: p.display || '',
      label: p.label || '',
      roleId: p.roleId ? String(p.roleId) : '',
      btnStyle: p.btnStyle || 'secondary',
    }));
  });

  const meta = rowsMeta(style);

  function updateRow(key, patch) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }
  function addRow() {
    if (rows.length < meta.max) setRows((rs) => [...rs, blankRow()]);
  }
  function removeRow(key) {
    setRows((rs) => {
      const next = rs.filter((r) => r.key !== key);
      return next.length ? next : [blankRow()];
    });
  }

  function submit(e) {
    e.preventDefault();
    onSave({
      id: initial.id || '',
      channelId,
      style,
      message,
      embed: embedSpec,
      exclusive,
      mode,
      placeholder,
      selMin,
      selMax,
      pairs: rows.map((r) => ({ emoji: r.emoji, label: r.label, roleId: r.roleId, btnStyle: r.btnStyle })),
    });
  }

  return (
    <form onSubmit={submit} className="v2-section-gap">
      <div className="v2-field">
        <label>Style</label>
        <div className="v2-tabs">
          {STYLES.map(([val, label]) => (
            <button
              type="button"
              key={val}
              className={`v2-tab${style === val ? ' is-active' : ''}`}
              onClick={() => setStyle(val)}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="v2-field-hint">{STYLES.find(([val]) => val === style)[2]}</p>
      </div>

      <div className="v2-field">
        <label>Channel</label>
        <select value={channelId} onChange={(e) => setChannelId(e.target.value)} required>
          <option value="">— select a channel —</option>
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              #{c.name}
            </option>
          ))}
        </select>
      </div>

      <div className="v2-field">
        <label>
          Message text <span className="v2-field-hint">— optional, above the embed</span>
        </label>
        <textarea
          rows={2}
          placeholder="Pick your roles below!"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
      </div>

      <EmbedEditor spec={embedSpec} onChange={setEmbedSpec} />

      <div className="v2-field u-mt-2">
        <label className="v2-check">
          <input type="checkbox" checked={exclusive} onChange={(e) => setExclusive(e.target.checked)} />
          Only one role from this set at a time (picking one removes the others)
        </label>
      </div>

      {style === 'select' ? (
        <div className="v2-field-row">
          <div className="v2-field">
            <label>Dropdown placeholder</label>
            <input
              type="text"
              maxLength={150}
              placeholder="Pick your roles"
              value={placeholder}
              onChange={(e) => setPlaceholder(e.target.value)}
            />
          </div>
          <div className="v2-field">
            <label>Min picks</label>
            <input
              type="number"
              min={0}
              max={25}
              style={{ maxWidth: '90px' }}
              value={selMin}
              onChange={(e) => setSelMin(Number(e.target.value))}
            />
          </div>
          <div className="v2-field">
            <label>
              Max picks <span className="v2-field-hint">— 0 = no limit</span>
            </label>
            <input
              type="number"
              min={0}
              max={25}
              style={{ maxWidth: '90px' }}
              value={selMax}
              onChange={(e) => setSelMax(Number(e.target.value))}
            />
          </div>
        </div>
      ) : null}

      <div className="v2-field">
        <label>
          {meta.title}{' '}
          <span className="v2-field-hint">
            ({rows.length} / {meta.max})
          </span>
        </label>
        {rows.map((row) => (
          <div className="v2-field-row" key={row.key}>
            <input
              type="text"
              placeholder={style === 'reaction' ? '👋 (required)' : '👋 (optional)'}
              value={row.emoji}
              onChange={(e) => updateRow(row.key, { emoji: e.target.value })}
              style={{ maxWidth: '110px' }}
            />
            {style !== 'reaction' ? (
              <input
                type="text"
                placeholder="Button label (optional)"
                maxLength={80}
                value={row.label}
                onChange={(e) => updateRow(row.key, { label: e.target.value })}
              />
            ) : null}
            <select value={row.roleId} onChange={(e) => updateRow(row.key, { roleId: e.target.value })}>
              <option value="">— select a role —</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            {style === 'buttons' ? (
              <select value={row.btnStyle} onChange={(e) => updateRow(row.key, { btnStyle: e.target.value })}>
                {BTN_STYLES.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            ) : null}
            <button type="button" className="v2-embed-x" onClick={() => removeRow(row.key)} title="Remove">
              ×
            </button>
          </div>
        ))}
        <button type="button" className="v2-btn-ghost" disabled={rows.length >= meta.max} onClick={addRow}>
          {meta.addLabel}
        </button>
      </div>

      {style !== 'select' ? (
        <div className="v2-field">
          <label>Reaction mode</label>
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="default">
              Default — the interaction adds the role; undoing it takes it away.
            </option>
            <option value="reverse">
              Reverse — the interaction removes the role (opt-out); undoing it gives it back.
            </option>
          </select>
        </div>
      ) : null}

      <div className="v2-field-row">
        <button type="submit" className="v2-btn-primary" disabled={saving}>
          {saving ? 'Publishing…' : 'Publish'}
        </button>
        <button type="button" className="v2-btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export default function Roles() {
  const { guildId } = useParams();
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const [autoroles, setAutoroles] = useState([]);
  const [savingAutoroles, setSavingAutoroles] = useState(false);
  const [autorolesSaved, setAutorolesSaved] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);

  function load() {
    return getRoles(guildId)
      .then((data) => {
        setState({ loading: false, data, error: null });
        setAutoroles(data.autoroles);
      })
      .catch((error) => setState({ loading: false, data: null, error }));
  }

  useEffect(() => {
    load();
  }, [guildId]);

  if (state.loading) return <p className="v2-state">Loading…</p>;
  if (state.error) {
    const notAuthed = state.error instanceof ApiError && state.error.notAuthenticated;
    return (
      <p className="v2-state">
        {notAuthed ? (
          <>
            Your session expired — <a href="/auth/discord/login">log in again</a>.
          </>
        ) : (
          `Couldn't load Reaction roles settings (${state.error.message}).`
        )}
      </p>
    );
  }

  const d = state.data;

  async function onSaveAutoroles(e) {
    e.preventDefault();
    setSavingAutoroles(true);
    setAutorolesSaved(false);
    try {
      await saveAutoroles(guildId, autoroles);
      setAutorolesSaved(true);
    } catch (err) {
      alert(err.message);
    } finally {
      setSavingAutoroles(false);
    }
  }

  async function onSaveRr(body) {
    setSaving(true);
    try {
      const { error } = await saveReactionRole(guildId, body);
      setCreating(false);
      setEditingId(null);
      setNotice(error || null);
      await load();
    } catch (err) {
      setNotice(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function onDelete(id) {
    if (!confirm('Delete this reaction-role set and its message?')) return;
    try {
      await deleteReactionRole(guildId, id);
      await load();
    } catch (err) {
      setNotice(err.message);
    }
  }

  return (
    <>
      <h1 className="v2-section-title">Reaction roles &amp; autoroles</h1>
      <p className="v2-field-hint">Self-assign roles from a message; roles automatically on join.</p>

      {notice ? <p className="v2-note">{notice}</p> : null}

      <div className="v2-group">
        <h2 className="v2-group-title">Reaction roles ({d.reactionMessages.length})</h2>
        {d.reactionMessages.length === 0 ? (
          <p className="v2-note">None yet — create one to let members self-assign roles.</p>
        ) : (
          <div className="v2-list">
            {d.reactionMessages.map((rm) => {
              const channel = d.channels.find((c) => c.id === rm.channelId);
              const title = rm.embed?.title || (rm.message || '').slice(0, 60) || 'Reaction role';
              const style = rm.style || 'reaction';
              return (
                <div className="v2-row" key={rm.id}>
                  <div className="v2-row-main">
                    <h3>{title}</h3>
                    <p>
                      #{channel ? channel.name : rm.channelId} · {(rm.pairs || []).length} role(s) · {style}
                      {style !== 'select' ? ` · ${rm.mode || 'default'}` : ''}
                      {rm.exclusive ? ' · exclusive' : ''}
                    </p>
                    {editingId === rm.id ? (
                      <ReactionRoleForm
                        initial={rm}
                        channels={d.channels}
                        roles={d.roles}
                        saving={saving}
                        onSave={onSaveRr}
                        onCancel={() => setEditingId(null)}
                      />
                    ) : null}
                  </div>
                  {editingId === rm.id ? null : (
                    <div className="v2-field-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                      <span className={`v2-status-pill ${rm.messageId ? 'completed' : 'pending'}`}>
                        {rm.messageId ? 'published' : 'draft'}
                      </span>
                      <button type="button" className="v2-btn-ghost" onClick={() => setEditingId(rm.id)}>
                        Edit
                      </button>
                      <button type="button" className="v2-btn-ghost" onClick={() => onDelete(rm.id)}>
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {creating ? (
        <div className="v2-group">
          <h2 className="v2-group-title">New reaction role</h2>
          <ReactionRoleForm
            initial={{}}
            channels={d.channels}
            roles={d.roles}
            saving={saving}
            onSave={onSaveRr}
            onCancel={() => setCreating(false)}
          />
        </div>
      ) : (
        <button type="button" className="v2-btn-primary" onClick={() => setCreating(true)}>
          + New reaction role
        </button>
      )}

      <div className="v2-group v2-section-gap">
        <h2 className="v2-group-title">Autoroles on join</h2>
        <p className="v2-field-hint">Given automatically when a member joins.</p>
        <form onSubmit={onSaveAutoroles}>
          <ChipPicker kind="role" items={d.roles} value={autoroles} onChange={setAutoroles} />
          <div className="v2-section-gap">
            <button type="submit" className="v2-btn-primary" disabled={savingAutoroles}>
              {savingAutoroles ? 'Saving…' : 'Save autoroles'}
            </button>
            {autorolesSaved ? <span className="v2-field-hint"> Saved.</span> : null}
          </div>
        </form>
      </div>
    </>
  );
}
