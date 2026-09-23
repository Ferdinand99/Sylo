import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getModuleConfig, saveModuleConfig, ApiError } from '../api.js';
import { useApiData } from '../useApiData.js';
import ChipPicker from '../components/ChipPicker.jsx';

const ACTION_LABELS = { kick: 'Kick', timeout: 'Timeout', ban: 'Ban' };

function newKey() {
  return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Math.random());
}

function toChannelRow(c = {}) {
  return {
    key: newKey(),
    channelId: c.channelId || '',
    action: c.action || 'kick',
    timeoutMinutes: c.timeoutMinutes || 10,
    deleteMessage: c.deleteMessage !== false,
    triggerCount: c.triggerCount || 0,
  };
}

function toMessageRow(m = {}) {
  return {
    key: newKey(),
    channelId: m.channelId || '',
    messageId: m.messageId || '',
    bait: m.bait || '',
    action: m.action || 'kick',
    timeoutMinutes: m.timeoutMinutes || 10,
    triggerCount: m.triggerCount || 0,
  };
}

export default function Honeypot() {
  const { guildId } = useParams();
  const { data, loading, error } = useApiData(() => getModuleConfig(guildId, 'honeypot'), [guildId]);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data) {
      setForm({
        exemptRoles: data.config.exemptRoles,
        channels: data.config.channels.map(toChannelRow),
        messages: data.config.messages.map(toMessageRow),
      });
    }
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
          `Couldn't load Honeypot settings (${error.message}).`
        )}
      </p>
    );
  }

  const updateChannelRow = (key, patch) =>
    setForm((f) => ({ ...f, channels: f.channels.map((c) => (c.key === key ? { ...c, ...patch } : c)) }));
  const addChannelRow = () => setForm((f) => ({ ...f, channels: [...f.channels, toChannelRow()] }));
  const removeChannelRow = (key) =>
    setForm((f) => ({ ...f, channels: f.channels.filter((c) => c.key !== key) }));

  const updateMessageRow = (key, patch) =>
    setForm((f) => ({ ...f, messages: f.messages.map((m) => (m.key === key ? { ...m, ...patch } : m)) }));
  const addMessageRow = () => setForm((f) => ({ ...f, messages: [...f.messages, toMessageRow()] }));
  const removeMessageRow = (key) =>
    setForm((f) => ({ ...f, messages: f.messages.filter((m) => m.key !== key) }));

  async function onSave(e) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    try {
      const body = {
        exemptRoles: form.exemptRoles,
        channels: form.channels.map((c) => ({
          channelId: c.channelId,
          action: c.action,
          timeoutMinutes: c.timeoutMinutes,
          deleteMessage: c.deleteMessage,
        })),
        messages: form.messages.map((m) => ({
          channelId: m.channelId,
          bait: m.bait,
          action: m.action,
          timeoutMinutes: m.timeoutMinutes,
        })),
      };
      const { config } = await saveModuleConfig(guildId, 'honeypot', body);
      setForm({
        exemptRoles: config.exemptRoles,
        channels: config.channels.map(toChannelRow),
        messages: config.messages.map(toMessageRow),
      });
      setSaved(true);
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <h1 className="v2-section-title">
        Honeypot <span className="v2-beta-tag">Beta</span>
      </h1>
      <p className="v2-field-hint">
        Any real member who posts in a trap channel, or reacts to a trap message, is punished immediately —
        there is no warning or grace period. Administrators and members with an exempt role below are never
        acted on. Every trigger is logged to the mod-log channel.
      </p>

      <form onSubmit={onSave}>
        <h2 className="v2-group-title">Channel honeypots</h2>
        <p className="v2-field-hint">Any message posted in one of these channels triggers the punishment.</p>
        {form.channels.map((c) => (
          <div className="v2-rule-card" key={c.key}>
            <div className="v2-rule-head">
              <span className="v2-field-hint">
                Channel honeypot{c.triggerCount ? ` · triggered ${c.triggerCount}×` : ''}
              </span>
              <button type="button" className="v2-btn-ghost" onClick={() => removeChannelRow(c.key)}>
                remove
              </button>
            </div>
            <div className="v2-field-row">
              <div className="v2-field">
                <label>Channel</label>
                <select
                  value={c.channelId}
                  onChange={(e) => updateChannelRow(c.key, { channelId: e.target.value })}
                >
                  <option value="">— channel —</option>
                  {data.channels.map((ch) => (
                    <option key={ch.id} value={ch.id}>
                      #{ch.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="v2-field">
                <label>Action</label>
                <select
                  value={c.action}
                  onChange={(e) => updateChannelRow(c.key, { action: e.target.value })}
                >
                  {data.actions.map((a) => (
                    <option key={a} value={a}>
                      {ACTION_LABELS[a] || a}
                    </option>
                  ))}
                </select>
              </div>
              <div className="v2-field">
                <label>Timeout (min)</label>
                <input
                  type="number"
                  min={1}
                  max={40320}
                  value={c.timeoutMinutes}
                  onChange={(e) => updateChannelRow(c.key, { timeoutMinutes: Number(e.target.value) })}
                />
              </div>
            </div>
            <label className="v2-check">
              <input
                type="checkbox"
                checked={c.deleteMessage}
                onChange={(e) => updateChannelRow(c.key, { deleteMessage: e.target.checked })}
              />
              Delete the triggering message
            </label>
          </div>
        ))}
        <button type="button" className="v2-btn-ghost" onClick={addChannelRow}>
          + Add channel honeypot
        </button>

        <h2 className="v2-group-title v2-section-gap">Message honeypots</h2>
        <p className="v2-field-hint">
          Sylo posts a trap message in the chosen channel; any reaction to it triggers the punishment.
        </p>
        {form.messages.map((m) => (
          <div className="v2-rule-card" key={m.key}>
            <div className="v2-rule-head">
              <span className="v2-field-hint">
                Message honeypot
                {m.triggerCount
                  ? ` · ${ACTION_LABELS[m.action].toLowerCase()}s so far: ${m.triggerCount}`
                  : ''}
              </span>
              <button type="button" className="v2-btn-ghost" onClick={() => removeMessageRow(m.key)}>
                remove
              </button>
            </div>
            <div className="v2-field-row">
              <div className="v2-field">
                <label>Channel</label>
                <select
                  value={m.channelId}
                  onChange={(e) => updateMessageRow(m.key, { channelId: e.target.value })}
                >
                  <option value="">— channel —</option>
                  {data.channels.map((ch) => (
                    <option key={ch.id} value={ch.id}>
                      #{ch.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="v2-field">
                <label>Action</label>
                <select
                  value={m.action}
                  onChange={(e) => updateMessageRow(m.key, { action: e.target.value })}
                >
                  {data.actions.map((a) => (
                    <option key={a} value={a}>
                      {ACTION_LABELS[a] || a}
                    </option>
                  ))}
                </select>
              </div>
              <div className="v2-field">
                <label>Timeout (min)</label>
                <input
                  type="number"
                  min={1}
                  max={40320}
                  value={m.timeoutMinutes}
                  onChange={(e) => updateMessageRow(m.key, { timeoutMinutes: Number(e.target.value) })}
                />
              </div>
            </div>
            <div className="v2-field">
              <label>
                Bait text <span className="v2-field-hint">— shown in the trap message</span>
              </label>
              <textarea
                rows={2}
                maxLength={500}
                placeholder="Click here to verify your account."
                value={m.bait}
                onChange={(e) => updateMessageRow(m.key, { bait: e.target.value })}
              />
            </div>
            {m.messageId ? (
              <p className="v2-field-hint">
                Live:{' '}
                <a
                  href={`https://discord.com/channels/${guildId}/${m.channelId}/${m.messageId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  jump to message
                </a>
              </p>
            ) : null}
          </div>
        ))}
        <button type="button" className="v2-btn-ghost" onClick={addMessageRow}>
          + Add message honeypot
        </button>

        <div className="v2-field v2-section-gap-sm">
          <label>Exempt roles</label>
          <ChipPicker
            kind="role"
            items={data.roles}
            value={form.exemptRoles}
            onChange={(exemptRoles) => setForm((f) => ({ ...f, exemptRoles }))}
          />
          <p className="v2-field-hint">
            Members with any of these roles are never punished (Administrators are always exempt).
          </p>
        </div>

        <div className="v2-section-gap">
          <button type="submit" className="v2-btn-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          {saved ? <span className="v2-field-hint"> Saved.</span> : null}
        </div>
      </form>

      <h2 className="v2-group-title v2-section-gap">Recent catches</h2>
      {data.catches.length === 0 ? (
        <p className="v2-field-hint">No one has triggered a honeypot yet.</p>
      ) : (
        <div className="v2-list">
          {data.catches.map((c, i) => (
            <div className="v2-row" key={i}>
              <div className="v2-row-main">
                <h3>{c.userTag}</h3>
                <p>
                  #{c.channelName} ({c.kind}) · {ACTION_LABELS[c.action] || c.action} · {c.ago}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
