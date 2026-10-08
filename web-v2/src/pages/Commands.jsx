import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { getCommands, saveCommand } from '../api.js';
import { useApiData } from '../useApiData.js';
import { notify } from '../notify.js';
import ChipPicker from '../components/ChipPicker.jsx';
import LoadError from '../components/LoadError.jsx';
import Meta from '../components/Meta.jsx';

// One command: on/off, plus optional limits to certain channels and roles.
// Empty channel and role lists mean "allowed everywhere, for everyone".
function CommandRow({ command, channels, roles, guildId, onSaved }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const form = draft ?? {
    enabled: command.enabled,
    channels: command.allowedChannels,
    roles: command.allowedRoles,
  };

  async function save(next) {
    setSaving(true);
    try {
      const { command: saved } = await saveCommand(guildId, command.name, next);
      onSaved(saved);
      setDraft(null);
      notify(`${command.name} updated.`, 'info');
    } catch (err) {
      notify(err.message);
    } finally {
      setSaving(false);
    }
  }

  const limited = command.allowedChannels.length > 0 || command.allowedRoles.length > 0;
  return (
    <div className={`v2-row v2-cmd-row ${command.enabled ? 'is-on' : 'is-off'}`}>
      <div className="v2-row-main">
        <h3>{command.name}</h3>
        <p>
          <Meta
            items={[
              command.description,
              !command.enabled && 'turned off',
              limited && 'limited to certain channels or roles',
            ]}
          />
        </p>
        {open ? (
          <div className="v2-cmd-limits">
            <div className="v2-field">
              <label>Only in these channels</label>
              <ChipPicker
                kind="channel"
                items={channels}
                value={form.channels}
                onChange={(next) => setDraft({ ...form, channels: next })}
              />
              <p className="v2-field-hint">Leave empty to allow it in every channel.</p>
            </div>
            <div className="v2-field">
              <label>Only for these roles</label>
              <ChipPicker
                kind="role"
                items={roles}
                value={form.roles}
                onChange={(next) => setDraft({ ...form, roles: next })}
              />
              <p className="v2-field-hint">Leave empty to allow everyone.</p>
            </div>
            <div className="v2-field-row">
              <button
                type="button"
                className="v2-btn-primary"
                disabled={saving || !draft}
                onClick={() => save(form)}
              >
                {saving ? 'Saving…' : 'Save limits'}
              </button>
              <button
                type="button"
                className="v2-btn-ghost"
                onClick={() => {
                  setDraft(null);
                  setOpen(false);
                }}
              >
                Close
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="v2-btn-ghost v2-cmd-open" onClick={() => setOpen(true)}>
            Limits
          </button>
        )}
      </div>
      <button
        type="button"
        className={`v2-toggle${command.enabled ? ' is-on' : ''}`}
        aria-label={`${command.name}: ${command.enabled ? 'on, click to turn off' : 'off, click to turn on'}`}
        disabled={saving}
        onClick={() =>
          save({
            enabled: !command.enabled,
            channels: command.allowedChannels,
            roles: command.allowedRoles,
          })
        }
      />
    </div>
  );
}

export default function Commands() {
  const { guildId } = useParams();
  const { data, loading, error, setData } = useApiData(() => getCommands(guildId), [guildId]);
  const [query, setQuery] = useState('');

  if (loading && !data) return <p className="v2-state">Loading…</p>;
  if (error) return <LoadError error={error} what="the commands" />;

  const q = query.trim().toLowerCase();
  const shown = data.commands.filter(
    (c) => !q || c.name.includes(q) || (c.description ?? '').toLowerCase().includes(q)
  );
  const onSaved = (saved) =>
    setData((d) => ({
      ...d,
      commands: d.commands.map((c) =>
        c.name === saved.name
          ? {
              ...c,
              enabled: saved.enabled,
              allowedChannels: saved.allowedChannels,
              allowedRoles: saved.allowedRoles,
            }
          : c
      ),
    }));

  return (
    <>
      <h1 className="v2-section-title">Commands</h1>
      <p className="v2-field-hint">
        Turn a command off for this server, or limit it to certain channels and roles. Members who are not
        allowed get no response.
      </p>
      <input
        className="v2-search"
        type="search"
        placeholder="Search commands…"
        aria-label="Search commands"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="v2-list v2-modules v2-cmd-list">
        {shown.map((c) => (
          <CommandRow
            key={c.name}
            command={c}
            channels={data.channels}
            roles={data.roles}
            guildId={guildId}
            onSaved={onSaved}
          />
        ))}
      </div>
      {!shown.length ? <p className="v2-state">No commands match "{query}".</p> : null}
    </>
  );
}
