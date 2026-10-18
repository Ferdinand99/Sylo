import LoadError from '../components/LoadError.jsx';
import SaveBar from '../components/SaveBar.jsx';
import { useModuleForm } from '../components/useModuleForm.js';

const ACTION_LABELS = { timeout: 'Timeout', kick: 'Kick', ban: 'Ban' };

function newKey() {
  return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Math.random());
}

function toFormRule(r) {
  return {
    key: newKey(),
    count: r.count ?? 3,
    action: r.action || 'timeout',
    durationMinutes: r.durationMinutes ?? 60,
  };
}

const toForm = (config) => ({
  dmOnPunish: config.dmOnPunish,
  infractionRetentionDays: config.infractionRetentionDays,
  rules: config.warnThresholds.map(toFormRule),
});
const fromForm = (form) => ({
  dmOnPunish: form.dmOnPunish,
  infractionRetentionDays: form.infractionRetentionDays,
  warnThresholds: form.rules.map((r) => ({
    count: r.count,
    action: r.action,
    durationMinutes: r.durationMinutes,
  })),
});

export default function Moderation() {
  const { guildId, data, form, setForm, status, error, dirty, saving, save, reset } = useModuleForm(
    'moderation',
    { toForm, fromForm }
  );

  if (status === 'error') return <LoadError error={error} what="Moderation settings" />;
  if (status === 'loading') return <p className="v2-state">Loading…</p>;

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const updateRule = (key, patch) =>
    setForm((f) => ({ ...f, rules: f.rules.map((r) => (r.key === key ? { ...r, ...patch } : r)) }));
  const addRule = () => setForm((f) => ({ ...f, rules: [...f.rules, toFormRule({})] }));
  const removeRule = (key) => setForm((f) => ({ ...f, rules: f.rules.filter((r) => r.key !== key) }));

  return (
    <>
      <h1 className="v2-section-title">Moderation</h1>
      <p className="v2-field-hint">
        Warning thresholds apply an action automatically once a member reaches a given warning count — the{' '}
        <strong>strictest</strong> matching rule wins. Warnings and bans themselves are managed on the{' '}
        <a href={`/guilds/${guildId}/moderation`}>Moderation</a> page, not here.
      </p>

      <form onSubmit={save}>
        <div className="v2-field">
          <label className="v2-check">
            <input
              type="checkbox"
              checked={form.dmOnPunish}
              onChange={(e) => set({ dmOnPunish: e.target.checked })}
            />
            DM the user when they are punished
          </label>
        </div>

        <h2 className="v2-group-title">Warning thresholds</h2>
        {form.rules.length === 0 ? (
          <p className="v2-field-hint">No rules yet — warnings alone have no effect.</p>
        ) : null}
        {form.rules.map((r) => (
          <div className="v2-rule-card" key={r.key}>
            <div className="v2-rule-head">
              <span className="v2-field-hint">Rule</span>
              <button type="button" className="v2-btn-ghost" onClick={() => removeRule(r.key)}>
                remove rule
              </button>
            </div>
            <div className="v2-field-row">
              <div className="v2-field">
                <label>At warning #</label>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={r.count}
                  onChange={(e) => updateRule(r.key, { count: Number(e.target.value) })}
                />
              </div>
              <div className="v2-field">
                <label>Action</label>
                <select value={r.action} onChange={(e) => updateRule(r.key, { action: e.target.value })}>
                  {data.thresholdActions.map((a) => (
                    <option key={a} value={a}>
                      {ACTION_LABELS[a] || a}
                    </option>
                  ))}
                </select>
              </div>
              {r.action === 'timeout' ? (
                <div className="v2-field">
                  <label>Timeout (min)</label>
                  <input
                    type="number"
                    min={1}
                    value={r.durationMinutes}
                    onChange={(e) => updateRule(r.key, { durationMinutes: Number(e.target.value) })}
                  />
                </div>
              ) : null}
            </div>
          </div>
        ))}
        <button type="button" className="v2-btn-ghost" onClick={addRule}>
          + Add rule
        </button>

        <div className="v2-field v2-section-gap-sm">
          <label htmlFor="infractionRetentionDays">
            Delete inactive cases after <span className="v2-field-hint">— days; 0 = keep forever</span>
          </label>
          <input
            id="infractionRetentionDays"
            type="number"
            min={0}
            max={3650}
            value={form.infractionRetentionDays}
            onChange={(e) => set({ infractionRetentionDays: Number(e.target.value) })}
          />
          <p className="v2-field-hint">
            A daily job removes cases that have been deleted or resolved (an unban / untimeout) once they are
            older than this. Active warnings and the visible history are never auto-removed.
          </p>
        </div>
      </form>
      <SaveBar dirty={dirty} saving={saving} onSave={save} onReset={reset} />
    </>
  );
}
