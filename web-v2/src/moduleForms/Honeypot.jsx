import { useMessageLink } from '../platformContext.jsx';
import ChipPicker from '../components/ChipPicker.jsx';
import LoadError from '../components/LoadError.jsx';
import SaveBar from '../components/SaveBar.jsx';
import { useModuleForm } from '../components/useModuleForm.js';
import { limitOf, useModuleLimits } from '../components/useModuleLimits.js';

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

const toForm = (config) => ({
  exemptRoles: config.exemptRoles,
  channels: config.channels.map(toChannelRow),
  messages: config.messages.map(toMessageRow),
});
const fromForm = (form) => ({
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
});

export default function Honeypot() {
  const messageLink = useMessageLink();
  const limits = useModuleLimits('honeypot');
  const { guildId, data, form, setForm, status, error, dirty, saving, save, reset } = useModuleForm(
    'honeypot',
    { toForm, fromForm }
  );

  if (status === 'error') return <LoadError error={error} what="Honeypot settings" />;
  if (status === 'loading') return <p className="v2-state">Loading…</p>;

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

      <form onSubmit={save} data-savebar>
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
                  min={limitOf(limits, 'channels[].timeoutMinutes').min}
                  max={limitOf(limits, 'channels[].timeoutMinutes').max}
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
        <button
          type="button"
          className="v2-btn-ghost"
          onClick={addChannelRow}
          disabled={form.channels.length >= (limitOf(limits, 'channels').maxItems ?? Infinity)}
        >
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
                  min={limitOf(limits, 'messages[].timeoutMinutes').min}
                  max={limitOf(limits, 'messages[].timeoutMinutes').max}
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
                maxLength={limitOf(limits, 'messages[].bait').maxLength}
                placeholder="Click here to verify your account."
                value={m.bait}
                onChange={(e) => updateMessageRow(m.key, { bait: e.target.value })}
              />
            </div>
            {m.messageId ? (
              <p className="v2-field-hint">
                Live:{' '}
                <a
                  href={messageLink(guildId, m.channelId, m.messageId)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  jump to message
                </a>
              </p>
            ) : null}
          </div>
        ))}
        <button
          type="button"
          className="v2-btn-ghost"
          onClick={addMessageRow}
          disabled={form.messages.length >= (limitOf(limits, 'messages').maxItems ?? Infinity)}
        >
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
      <SaveBar dirty={dirty} saving={saving} onSave={save} onReset={reset} />
    </>
  );
}
