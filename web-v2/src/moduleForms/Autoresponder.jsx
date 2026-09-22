import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getModuleConfig, saveModuleConfig, ApiError } from '../api.js';
import { useApiData } from '../useApiData.js';
import ChipPicker from '../components/ChipPicker.jsx';

const MATCH_LABELS = {
  contains: 'contains',
  exact: 'is exactly',
  startswith: 'starts with',
  wholeword: 'whole word',
};

function newKey() {
  return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Math.random());
}

function toFormRow(r = {}) {
  return {
    key: newKey(),
    trigger: r.trigger || '',
    match: r.match || 'contains',
    response: r.response || '',
    embed: Boolean(r.embed),
    deleteTrigger: Boolean(r.deleteTrigger),
  };
}

export default function Autoresponder() {
  const { guildId } = useParams();
  const { data, loading, error } = useApiData(() => getModuleConfig(guildId, 'autoresponder'), [guildId]);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data) {
      setForm({
        cooldownSeconds: data.config.cooldownSeconds,
        ignoreChannels: data.config.ignoreChannels,
        ignoreRoles: data.config.ignoreRoles,
        responders: data.config.responders.length ? data.config.responders.map(toFormRow) : [toFormRow()],
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
          `Couldn't load Autoresponder settings (${error.message}).`
        )}
      </p>
    );
  }

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const updateRow = (key, patch) =>
    setForm((f) => ({ ...f, responders: f.responders.map((r) => (r.key === key ? { ...r, ...patch } : r)) }));
  const addRow = () => setForm((f) => ({ ...f, responders: [...f.responders, toFormRow()] }));
  const removeRow = (key) =>
    setForm((f) => ({ ...f, responders: f.responders.filter((r) => r.key !== key) }));

  async function onSave(e) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    try {
      const body = {
        cooldownSeconds: form.cooldownSeconds,
        ignoreChannels: form.ignoreChannels,
        ignoreRoles: form.ignoreRoles,
        responders: form.responders.map((r) => ({
          trigger: r.trigger,
          match: r.match,
          response: r.response,
          embed: r.embed,
          deleteTrigger: r.deleteTrigger,
        })),
      };
      const { config } = await saveModuleConfig(guildId, 'autoresponder', body);
      setForm({
        cooldownSeconds: config.cooldownSeconds,
        ignoreChannels: config.ignoreChannels,
        ignoreRoles: config.ignoreRoles,
        responders: config.responders.length ? config.responders.map(toFormRow) : [toFormRow()],
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
      <h1 className="v2-section-title">Autoresponder</h1>
      <p className="v2-field-hint">
        Replies automatically when a message matches a trigger — no prefix. First matching responder wins.
        Placeholders:{' '}
        {data.placeholders.map((p) => (
          <code key={p}> {p} </code>
        ))}
        . Deleting the trigger needs the Manage Messages permission.
      </p>

      <form onSubmit={onSave}>
        <div className="v2-field">
          <label htmlFor="cooldownSeconds">Per-channel cooldown (seconds)</label>
          <input
            id="cooldownSeconds"
            type="number"
            min={0}
            max={300}
            value={form.cooldownSeconds}
            onChange={(e) => set({ cooldownSeconds: Number(e.target.value) })}
          />
        </div>

        <h2 className="v2-group-title">Responders</h2>
        {form.responders.map((r) => (
          <div className="v2-rule-card" key={r.key}>
            <div className="v2-rule-head">
              <span className="v2-field-hint">Responder</span>
              <button type="button" className="v2-btn-ghost" onClick={() => removeRow(r.key)}>
                remove
              </button>
            </div>

            <div className="v2-field-row">
              <div className="v2-field">
                <label>Trigger</label>
                <input
                  type="text"
                  placeholder="trigger phrase"
                  value={r.trigger}
                  onChange={(e) => updateRow(r.key, { trigger: e.target.value })}
                />
              </div>
              <div className="v2-field">
                <label>Match</label>
                <select value={r.match} onChange={(e) => updateRow(r.key, { match: e.target.value })}>
                  {data.matchModes.map((m) => (
                    <option key={m} value={m}>
                      {MATCH_LABELS[m] || m}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="v2-field">
              <label>Reply</label>
              <textarea
                rows={2}
                maxLength={2000}
                placeholder="Reply…"
                value={r.response}
                onChange={(e) => updateRow(r.key, { response: e.target.value })}
              />
            </div>

            <div className="v2-field-row">
              <label className="v2-check">
                <input
                  type="checkbox"
                  checked={r.embed}
                  onChange={(e) => updateRow(r.key, { embed: e.target.checked })}
                />
                Send as an embed
              </label>
              <label className="v2-check">
                <input
                  type="checkbox"
                  checked={r.deleteTrigger}
                  onChange={(e) => updateRow(r.key, { deleteTrigger: e.target.checked })}
                />
                Delete the trigger message
              </label>
            </div>
          </div>
        ))}
        <button type="button" className="v2-btn-ghost" onClick={addRow}>
          + Add responder
        </button>

        <div className="v2-field v2-section-gap-sm">
          <label>Ignore channels</label>
          <ChipPicker
            kind="channel"
            items={data.channels}
            value={form.ignoreChannels}
            onChange={(ignoreChannels) => set({ ignoreChannels })}
          />
        </div>

        <div className="v2-field">
          <label>Ignore roles</label>
          <ChipPicker
            kind="role"
            items={data.roles}
            value={form.ignoreRoles}
            onChange={(ignoreRoles) => set({ ignoreRoles })}
          />
        </div>

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
