import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getCustomCommands, saveCustomCommand, deleteCustomCommand, ApiError } from '../api.js';
import ChipPicker from '../components/ChipPicker.jsx';
import EmbedEditor from '../components/EmbedEditor.jsx';
import { newKey } from '../components/EmbedCard.jsx';

const ACTION_TYPES = [
  ['reply', 'Bot responds with a message in the current channel'],
  ['send', 'Bot sends a message to a chosen channel'],
  ['add-role', 'Bot gives the member a role'],
  ['remove-role', 'Bot removes a role from the member'],
];
const ACTION_TITLES = Object.fromEntries(ACTION_TYPES.map(([t, title]) => [t, title]));

function blankMessage() {
  return { key: newKey('m'), content: '', embed: null };
}
function blankAction(type) {
  const a = { key: newKey('a'), type };
  if (type === 'add-role' || type === 'remove-role') {
    a.roleId = '';
  } else {
    a.messages = [blankMessage()];
    if (type === 'reply') a.private = false;
    if (type === 'send') a.channelId = '';
  }
  return a;
}

function ActionBlock({ action, index, count, roles, channels, onChange, onMove, onRemove }) {
  const set = (patch) => onChange({ ...action, ...patch });
  const updateMessage = (key, patch) =>
    set({ messages: action.messages.map((m) => (m.key === key ? { ...m, ...patch } : m)) });
  const addMessage = () => set({ messages: [...action.messages, blankMessage()] });
  const removeMessage = (key) => set({ messages: action.messages.filter((m) => m.key !== key) });

  return (
    <div className="v2-rule-card">
      <div className="v2-rule-head">
        <span>
          {index + 1}. {ACTION_TITLES[action.type]}
        </span>
        <div className="v2-field-row" style={{ marginBottom: 0 }}>
          <button type="button" className="v2-btn-ghost" disabled={index === 0} onClick={() => onMove(-1)}>
            ↑
          </button>
          <button
            type="button"
            className="v2-btn-ghost"
            disabled={index === count - 1}
            onClick={() => onMove(1)}
          >
            ↓
          </button>
          <button type="button" className="v2-btn-ghost" onClick={onRemove}>
            Remove
          </button>
        </div>
      </div>

      {action.type === 'add-role' || action.type === 'remove-role' ? (
        <div className="v2-field">
          <label>Role</label>
          <select value={action.roleId} onChange={(e) => set({ roleId: e.target.value })}>
            <option value="">— select a role —</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <p className="v2-field-hint">Applied to whoever ran the command.</p>
        </div>
      ) : (
        <>
          {action.type === 'send' ? (
            <div className="v2-field">
              <label>Channel</label>
              <select value={action.channelId} onChange={(e) => set({ channelId: e.target.value })}>
                <option value="">— select a channel —</option>
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    #{c.name}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div className="v2-field">
              <label className="v2-check">
                <input
                  type="checkbox"
                  checked={Boolean(action.private)}
                  onChange={(e) => set({ private: e.target.checked })}
                />
                Private — only the person who ran it sees the reply
              </label>
            </div>
          )}

          {action.messages.map((m, mi) => (
            <div className="v2-rule-card" key={m.key}>
              <div className="v2-rule-head">
                <span className="v2-field-hint">Message {mi + 1}</span>
                <div className="v2-field-row" style={{ marginBottom: 0 }}>
                  {!m.embed ? (
                    <button
                      type="button"
                      className="v2-btn-ghost"
                      onClick={() => updateMessage(m.key, { embed: {} })}
                    >
                      + Add embed
                    </button>
                  ) : null}
                  {action.messages.length > 1 ? (
                    <button type="button" className="v2-btn-ghost" onClick={() => removeMessage(m.key)}>
                      Remove
                    </button>
                  ) : null}
                </div>
              </div>
              <textarea
                rows={2}
                placeholder="Write your message here… (leave blank for embed-only)"
                value={m.content}
                onChange={(e) => updateMessage(m.key, { content: e.target.value })}
              />
              {m.embed ? (
                <div className="u-mt-2">
                  <EmbedEditor
                    spec={m.embed}
                    onChange={(embed) => updateMessage(m.key, { embed })}
                    timestamp
                    placeholders={{ title: 'Embed title', description: 'Embed description' }}
                  />
                  <button
                    type="button"
                    className="v2-btn-ghost u-mt-2"
                    onClick={() => updateMessage(m.key, { embed: null })}
                  >
                    Remove embed
                  </button>
                </div>
              ) : null}
            </div>
          ))}
          <button type="button" className="v2-btn-ghost" onClick={addMessage}>
            + Add a message (the bot picks one at random)
          </button>
        </>
      )}
    </div>
  );
}

function CommandForm({ initial, channels, roles, placeholders, onSave, onCancel, saving }) {
  const [name, setName] = useState(initial.name || '');
  const [description, setDescription] = useState(initial.description || '');
  const [actions, setActions] = useState(() => {
    const list =
      Array.isArray(initial.actions) && initial.actions.length ? initial.actions : [blankAction('reply')];
    return list.map((a) => ({
      key: newKey('a'),
      type: a.type || 'reply',
      roleId: a.roleId ? String(a.roleId) : '',
      channelId: a.channelId ? String(a.channelId) : '',
      private: Boolean(a.private),
      messages: (Array.isArray(a.messages) && a.messages.length
        ? a.messages
        : [{ content: '', embed: null }]
      ).map((m) => ({ key: newKey('m'), content: m.content || '', embed: m.embed || null })),
    }));
  });
  const [allowedRoles, setAllowedRoles] = useState(
    Array.isArray(initial.allowedRoles) ? initial.allowedRoles : []
  );
  const [allowedChannels, setAllowedChannels] = useState(
    Array.isArray(initial.allowedChannels) ? initial.allowedChannels : []
  );
  const [cooldownSeconds, setCooldownSeconds] = useState(initial.cooldownSeconds || 0);
  const [picking, setPicking] = useState(false);

  function updateAction(key, next) {
    setActions((as) => as.map((a) => (a.key === key ? next : a)));
  }
  function moveAction(key, dir) {
    setActions((as) => {
      const i = as.findIndex((a) => a.key === key);
      const j = i + dir;
      if (j < 0 || j >= as.length) return as;
      const next = [...as];
      const [item] = next.splice(i, 1);
      next.splice(j, 0, item);
      return next;
    });
  }
  function removeAction(key) {
    setActions((as) => as.filter((a) => a.key !== key));
  }
  function addAction(type) {
    setActions((as) => [...as, blankAction(type)]);
    setPicking(false);
  }

  function submit(e) {
    e.preventDefault();
    onSave({
      id: initial.id || '',
      name,
      description,
      actions: actions.map((a) => {
        if (a.type === 'add-role' || a.type === 'remove-role') return { type: a.type, roleId: a.roleId };
        const out = {
          type: a.type,
          messages: a.messages.map((m) => ({ content: m.content, embed: m.embed })),
        };
        if (a.type === 'reply') out.private = a.private;
        if (a.type === 'send') out.channelId = a.channelId;
        return out;
      }),
      allowedRoles,
      allowedChannels,
      cooldownSeconds,
    });
  }

  return (
    <form onSubmit={submit} className="v2-section-gap">
      <div className="v2-field">
        <label>Name</label>
        <div className="v2-field-row" style={{ alignItems: 'center', marginBottom: 0 }}>
          <span className="v2-field-hint">/</span>
          <input
            type="text"
            maxLength={32}
            pattern="[a-z0-9_-]{1,32}"
            placeholder="my-command"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <p className="v2-field-hint">Lowercase letters, numbers, - and _. This is the slash command.</p>
      </div>

      <div className="v2-field">
        <label>
          Description <span className="v2-field-hint">— shown in Discord's command list</span>
        </label>
        <input
          type="text"
          maxLength={100}
          placeholder="What this command does"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <div className="v2-field">
        <label>Command actions</label>
        <p className="v2-field-hint">Actions run in order — use the ↑ ↓ buttons to reorder.</p>
        {actions.map((a, i) => (
          <ActionBlock
            key={a.key}
            action={a}
            index={i}
            count={actions.length}
            roles={roles}
            channels={channels}
            onChange={(next) => updateAction(a.key, next)}
            onMove={(dir) => moveAction(a.key, dir)}
            onRemove={() => removeAction(a.key)}
          />
        ))}
        {placeholders.length ? (
          <p className="v2-field-hint">
            Placeholders:{' '}
            {placeholders.map((p) => (
              <code key={p} style={{ marginRight: '6px' }}>
                {p}
              </code>
            ))}
          </p>
        ) : null}

        {picking ? (
          <div className="v2-field-row" style={{ flexWrap: 'wrap' }}>
            {ACTION_TYPES.map(([type, title]) => (
              <button type="button" key={type} className="v2-btn-ghost" onClick={() => addAction(type)}>
                {title}
              </button>
            ))}
            <button type="button" className="v2-btn-ghost" onClick={() => setPicking(false)}>
              cancel
            </button>
          </div>
        ) : (
          <button type="button" className="v2-btn-ghost" onClick={() => setPicking(true)}>
            + Add another action
          </button>
        )}
      </div>

      <details className="v2-am-params">
        <summary>
          <strong>Advanced options and permissions</strong>
        </summary>
        <div className="v2-field">
          <label>
            Only these roles may use it <span className="v2-field-hint">— empty = everyone</span>
          </label>
          <ChipPicker kind="role" items={roles} value={allowedRoles} onChange={setAllowedRoles} />
        </div>
        <div className="v2-field">
          <label>
            Only in these channels <span className="v2-field-hint">— empty = anywhere</span>
          </label>
          <ChipPicker kind="channel" items={channels} value={allowedChannels} onChange={setAllowedChannels} />
        </div>
        <div className="v2-field">
          <label>Per-user cooldown (seconds)</label>
          <input
            type="number"
            min={0}
            max={86400}
            style={{ maxWidth: '120px' }}
            value={cooldownSeconds}
            onChange={(e) => setCooldownSeconds(Number(e.target.value))}
          />
        </div>
      </details>

      <div className="v2-field-row">
        <button type="submit" className="v2-btn-primary" disabled={saving}>
          Save &amp; close
        </button>
        <button type="button" className="v2-btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export default function CustomCommands() {
  const { guildId } = useParams();
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const [editingId, setEditingId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);

  function load() {
    return getCustomCommands(guildId)
      .then((data) => setState({ loading: false, data, error: null }))
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
          `Couldn't load Custom commands (${state.error.message}).`
        )}
      </p>
    );
  }

  const d = state.data;

  async function onSave(body) {
    setSaving(true);
    setNotice(null);
    try {
      await saveCustomCommand(guildId, body);
      setCreating(false);
      setEditingId(null);
      await load();
    } catch (err) {
      setNotice(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function onDelete(id) {
    if (!confirm('Delete this command?')) return;
    try {
      await deleteCustomCommand(guildId, id);
      await load();
    } catch (err) {
      setNotice(err.message);
    }
  }

  return (
    <>
      <h1 className="v2-section-title">Custom commands</h1>
      <p className="v2-field-hint">
        Build /slash commands from an ordered list of actions: reply, post to a channel, add or remove a role.
      </p>

      {notice ? <p className="v2-row-warn">{notice}</p> : null}

      <div className="v2-group">
        <h2 className="v2-group-title">Your commands ({d.commands.length})</h2>
        {d.commands.length === 0 ? (
          <p className="v2-note">None yet — create one below.</p>
        ) : (
          <div className="v2-list">
            {d.commands.map((c) => (
              <div className="v2-row" key={c.id}>
                <div className="v2-row-main">
                  <h3>/{c.name}</h3>
                  <p>
                    {c.description || 'No description'} · {c.actions.length} action(s)
                    {c.allowedRoles.length || c.allowedChannels.length ? ' · restricted' : ''}
                    {c.cooldownSeconds ? ` · ${c.cooldownSeconds}s cooldown` : ''}
                  </p>
                  {editingId === c.id ? (
                    <CommandForm
                      initial={c}
                      channels={d.channels}
                      roles={d.roles}
                      placeholders={d.placeholders}
                      saving={saving}
                      onSave={onSave}
                      onCancel={() => setEditingId(null)}
                    />
                  ) : null}
                </div>
                {editingId === c.id ? null : (
                  <div className="v2-field-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                    <button type="button" className="v2-btn-ghost" onClick={() => setEditingId(c.id)}>
                      Edit
                    </button>
                    <button type="button" className="v2-btn-ghost" onClick={() => onDelete(c.id)}>
                      Delete
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {creating ? (
        <div className="v2-group">
          <h2 className="v2-group-title">New command</h2>
          <CommandForm
            initial={{}}
            channels={d.channels}
            roles={d.roles}
            placeholders={d.placeholders}
            saving={saving}
            onSave={onSave}
            onCancel={() => setCreating(false)}
          />
        </div>
      ) : (
        <button type="button" className="v2-btn-primary" onClick={() => setCreating(true)}>
          + New command
        </button>
      )}
    </>
  );
}
