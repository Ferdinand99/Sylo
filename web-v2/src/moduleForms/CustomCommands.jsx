import { useContext, useEffect, useState } from 'react';
import PickerHealth from '../components/PickerHealth.jsx';
import { useParams } from 'react-router-dom';
import { getCustomCommands, saveCustomCommand, deleteCustomCommand } from '../api.js';
import { notify } from '../notify.js';
import LoadError from '../components/LoadError.jsx';
import { confirmDialog } from '../components/ConfirmDialog.jsx';
import ChipPicker from '../components/ChipPicker.jsx';
import EmbedEditor from '../components/EmbedEditor.jsx';
import PlaceholderHint from '../components/PlaceholderHint.jsx';
import PlaceholderBar from '../components/PlaceholderBar.jsx';
import PreviewLayout from '../components/PreviewLayout.jsx';
import MentionTextarea from '../components/MentionTextarea.jsx';
import ListPageHead from '../components/ListPageHead.jsx';
import RowActions from '../components/RowActions.jsx';
import EmptyList from '../components/EmptyList.jsx';
import { newKey } from '../components/EmbedCard.jsx';
import { limitOf, useModuleLimits } from '../components/useModuleLimits.js';
import { PlatformContext } from '../platformContext.jsx';
import Meta, { plural } from '../components/Meta.jsx';
import { tokensFor } from '../placeholders.js';

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

const SENDS_MESSAGES = (a) => a.type === 'reply' || a.type === 'send';
const messageFieldId = (action, message) => `cc-msg-${action.key}-${message.key}`;
// "Action 2", or "Action 2, message 3" where the action has several messages to pick from.
const messageName = (action, index, mi) =>
  action.messages.length > 1 ? `Action ${index + 1}, message ${mi + 1}` : `Action ${index + 1}`;

/** An embed as the editor keeps it, in the shape MessagePreview draws. */
const previewEmbed = (e) =>
  e
    ? {
        color: e.color,
        title: e.title,
        description: e.description,
        authorName: e.authorName,
        fields: e.fields,
        footer: e.footerText,
      }
    : null;

function ActionBlock({ action, index, count, roles, channels, tokens, onChange, onMove, onRemove }) {
  const limits = useModuleLimits('custom-commands');
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
          <button type="button" className="v2-btn-danger-ghost" onClick={onRemove}>
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
          <PickerHealth kind="role" value={action.roleId} />
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
              <PickerHealth kind="channel" value={action.channelId} />
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
                    <button
                      type="button"
                      className="v2-btn-danger-ghost"
                      onClick={() => removeMessage(m.key)}
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
              </div>
              <MentionTextarea
                id={messageFieldId(action, m)}
                aria-label={`Message ${mi + 1} text`}
                rows={2}
                channels={channels}
                roles={roles}
                maxLength={limitOf(limits, 'commands[].actions[].messages[].content').maxLength}
                placeholder="Write your message here… (leave blank for embed-only)"
                value={m.content}
                onChange={(e) => updateMessage(m.key, { content: e.target.value })}
              />
              <PlaceholderHint
                chips={false}
                fieldId={messageFieldId(action, m)}
                tokens={tokens}
                value={m.content}
                onChange={(content) => updateMessage(m.key, { content })}
              />
              {m.embed ? (
                <div className="u-mt-2">
                  <EmbedEditor
                    spec={m.embed}
                    onChange={(embed) => updateMessage(m.key, { embed })}
                    timestamp
                    placeholders={{ title: 'Embed title', description: 'Embed description' }}
                    vars={tokens.map((t) => ({ token: t.token, label: t.token.replace(/[{}]/g, '') }))}
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
          <button
            type="button"
            className="v2-btn-ghost"
            onClick={addMessage}
            disabled={
              action.messages.length >=
              (limitOf(limits, 'commands[].actions[].messages').maxItems ?? Infinity)
            }
          >
            + Add a message (the bot picks one at random)
          </button>
        </>
      )}
    </div>
  );
}

function CommandForm({ initial, title, channels, roles, placeholders, onSave, onCancel, saving }) {
  const limits = useModuleLimits('custom-commands');
  const tokens = tokensFor('customCommands', placeholders);
  const { platform, commandPrefix } = useContext(PlatformContext);
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

  // One row of placeholder chips for the whole command: it writes into the message field edited last.
  const barFields = actions.flatMap((a, i) =>
    SENDS_MESSAGES(a)
      ? a.messages.map((m, mi) => ({ id: messageFieldId(a, m), label: messageName(a, i, mi), tokens }))
      : []
  );
  const previews = actions.flatMap((a, i) =>
    SENDS_MESSAGES(a)
      ? a.messages.map((m, mi) => ({
          key: messageFieldId(a, m),
          title: `${messageName(a, i, mi)}: ${a.type === 'reply' ? 'reply' : 'message to a channel'}`,
          content: m.content,
          embed: previewEmbed(m.embed),
          note: [
            a.type === 'reply' && a.private ? 'Only the person who ran the command sees this reply.' : '',
            a.type === 'send' && a.channelId
              ? `Posted in #${channels.find((c) => c.id === a.channelId)?.name ?? 'the chosen channel'}.`
              : '',
            a.messages.length > 1 ? "The bot picks one of this action's messages at random." : '',
          ]
            .filter(Boolean)
            .join(' '),
        }))
      : []
  );

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
    <PreviewLayout previews={previews} lookup={{ channels, roles }} toggleAfter={3}>
      <>
        <button type="button" className="v2-btn-ghost v2-btn-compact" onClick={onCancel}>
          ← Custom commands
        </button>
        <h1 className="v2-section-title">{title}</h1>
        <p className="v2-field-hint">
          Each action runs in order when a member uses the command. Click into a message, then click a
          placeholder to insert it there.
        </p>
        <form onSubmit={submit} className="v2-section-gap">
          <div className="v2-field">
            <label>Name</label>
            <div className="v2-field-row" style={{ alignItems: 'center', marginBottom: 0 }}>
              <span className="v2-field-hint">{commandPrefix}</span>
              <input
                type="text"
                maxLength={limitOf(limits, 'commands[].name').maxLength}
                pattern={`[a-z0-9_-]{1,${limitOf(limits, 'commands[].name').maxLength ?? ''}}`}
                placeholder="my-command"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <p className="v2-field-hint">
              Lowercase letters, numbers, - and _.{' '}
              {platform === 'fluxer'
                ? `Members run it as ${commandPrefix}name in chat.`
                : 'This is the slash command.'}
            </p>
          </div>

          <div className="v2-field">
            <label>
              Description{' '}
              <span className="v2-field-hint">
                {platform === 'fluxer'
                  ? '— a note for you; Fluxer has no command list to show it in'
                  : "— shown in Discord's command list"}
              </span>
            </label>
            <input
              type="text"
              maxLength={limitOf(limits, 'commands[].description').maxLength}
              placeholder="What this command does"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="v2-field">
            <label>Command actions</label>
            <p className="v2-field-hint">Actions run in order — use the ↑ ↓ buttons to reorder.</p>
            {barFields.length ? <PlaceholderBar fields={barFields} /> : null}
            {actions.map((a, i) => (
              <ActionBlock
                key={a.key}
                action={a}
                index={i}
                count={actions.length}
                roles={roles}
                channels={channels}
                tokens={tokens}
                onChange={(next) => updateAction(a.key, next)}
                onMove={(dir) => moveAction(a.key, dir)}
                onRemove={() => removeAction(a.key)}
              />
            ))}

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
              <button
                type="button"
                className="v2-btn-ghost"
                onClick={() => setPicking(true)}
                disabled={actions.length >= (limitOf(limits, 'commands[].actions').maxItems ?? Infinity)}
              >
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
              <ChipPicker
                kind="channel"
                items={channels}
                value={allowedChannels}
                onChange={setAllowedChannels}
              />
            </div>
            <div className="v2-field">
              <label>Per-user cooldown (seconds)</label>
              <input
                type="number"
                min={limitOf(limits, 'commands[].cooldownSeconds').min}
                max={limitOf(limits, 'commands[].cooldownSeconds').max}
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
      </>
    </PreviewLayout>
  );
}

export default function CustomCommands() {
  const { platform } = useContext(PlatformContext);
  const { guildId } = useParams();
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const [editingId, setEditingId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);

  function load() {
    return getCustomCommands(guildId)
      .then((data) => setState({ loading: false, data, error: null }))
      .catch((error) => setState({ loading: false, data: null, error }));
  }

  useEffect(() => {
    load();
    // Reload when the server changes; `load` is re-created every render and reads guildId itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guildId]);

  if (state.error) return <LoadError error={state.error} what="Custom commands" />;
  if (state.loading) return <p className="v2-state">Loading…</p>;

  const d = state.data;

  async function onSave(body) {
    setSaving(true);
    try {
      await saveCustomCommand(guildId, body);
      setCreating(false);
      setEditingId(null);
      await load();
    } catch (err) {
      notify(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function onDelete(id) {
    const ok = await confirmDialog({
      title: 'Delete this command?',
      body: 'Members can no longer run it. This can’t be undone.',
      confirmLabel: 'Delete command',
    });
    if (!ok) return;
    try {
      await deleteCustomCommand(guildId, id);
      await load();
    } catch (err) {
      notify(err.message);
    }
  }

  // The editor takes the whole page: the actions, the message fields and their preview need the room.
  const editing = editingId === null ? null : d.commands.find((c) => c.id === editingId);
  if (creating || editing) {
    return (
      <CommandForm
        key={creating ? 'new' : editing.id}
        initial={creating ? {} : editing}
        title={creating ? 'New command' : `Edit /${editing.name}`}
        channels={d.channels}
        roles={d.roles}
        placeholders={d.placeholders}
        saving={saving}
        onSave={onSave}
        onCancel={() => {
          setCreating(false);
          setEditingId(null);
        }}
      />
    );
  }

  return (
    <>
      <ListPageHead
        title="Custom commands"
        action={
          <button type="button" className="v2-btn-primary" onClick={() => setCreating(true)}>
            + New command
          </button>
        }
      >
        <p className="v2-field-hint">
          Build {platform === 'fluxer' ? 'chat commands' : '/slash commands'} from an ordered list of actions:
          reply, post to a channel, add or remove a role.
        </p>
      </ListPageHead>

      <div className="v2-group">
        <h2 className="v2-group-title">Your commands ({d.commands.length})</h2>
        {d.commands.length === 0 ? (
          <EmptyList
            action={
              <button type="button" className="v2-btn-ghost" onClick={() => setCreating(true)}>
                + New command
              </button>
            }
          >
            None yet — create one to give members a command of your own.
          </EmptyList>
        ) : (
          <div className="v2-list">
            {d.commands.map((c) => (
              <div className="v2-row v2-row-stack" key={c.id}>
                <div className="v2-row-main">
                  <h3>/{c.name}</h3>
                  <p>
                    <Meta
                      items={[
                        c.description || 'No description',
                        plural(c.actions.length, 'action'),
                        (c.allowedRoles.length > 0 || c.allowedChannels.length > 0) &&
                          'limited to certain roles or channels',
                        c.cooldownSeconds ? `${c.cooldownSeconds}s cooldown` : false,
                      ]}
                    />
                  </p>
                  {c.reserved ? (
                    <p className="v2-note">
                      Rename needed: /{c.name} is now a built-in command, so this command is switched off
                      until you give it another name.
                    </p>
                  ) : null}
                </div>
                <RowActions
                  edit={{ onClick: () => setEditingId(c.id) }}
                  menuLabel={`More actions for /${c.name}`}
                  items={[{ label: 'Delete', danger: true, onClick: () => onDelete(c.id) }]}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
