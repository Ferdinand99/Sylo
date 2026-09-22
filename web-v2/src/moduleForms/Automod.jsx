import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getModuleConfig, saveModuleConfig, ApiError } from '../api.js';
import { useApiData } from '../useApiData.js';

const MODE_LABELS = {
  off: 'Disabled',
  delete: 'Delete message',
  warn: 'Delete + Warn',
  timeout: 'Delete + Timeout',
};
// Rules with an extra "Settings" panel — same set as V1's automod.ejs.
const WITH_PARAMS = new Set(['links', 'spam', 'mentions', 'caps', 'words', 'emojis', 'spoilers']);
const PRESET_LABELS = { profanity: 'Profanity', sexual: 'Sexual content', slurs: 'Slurs' };

function mode(rule) {
  return rule?.enabled ? rule.action || 'delete' : 'off';
}

// The GET/save response always carries links.allowed / words.list as real
// arrays (normaliseAutomodConfig's canonical shape) — but the textarea
// editing them needs a plain string. Convert on the way in; the backend's
// termList() already accepts a raw comma/newline-separated string just as
// happily as an array, so no conversion is needed on the way out.
function toFormConfig(config) {
  return {
    ...config,
    rules: {
      ...config.rules,
      links: { ...config.rules.links, allowed: (config.rules.links.allowed || []).join(', ') },
      words: { ...config.rules.words, list: (config.rules.words.list || []).join(', ') },
    },
  };
}

export default function Automod() {
  const { guildId } = useParams();
  const { data, loading, error } = useApiData(() => getModuleConfig(guildId, 'automod'), [guildId]);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [nativeNote, setNativeNote] = useState(null);

  useEffect(() => {
    if (data) setForm(toFormConfig(data.config));
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
          `Couldn't load Auto-moderation settings (${error.message}).`
        )}
      </p>
    );
  }

  const setRule = (key, patch) =>
    setForm((f) => ({ ...f, rules: { ...f.rules, [key]: { ...f.rules[key], ...patch } } }));
  const setMode = (key, m) => setRule(key, { enabled: m !== 'off', action: m === 'off' ? 'delete' : m });
  const setNative = (patch) => setForm((f) => ({ ...f, native: { ...f.native, ...patch } }));
  const togglePreset = (p, checked) =>
    setNative({
      presets: checked ? [...form.native.presets, p] : form.native.presets.filter((x) => x !== p),
    });

  async function onSave(e) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    setNativeNote(null);
    try {
      const result = await saveModuleConfig(guildId, 'automod', form);
      setForm(toFormConfig(result.config));
      setSaved(true);
      if (result.nativeNote) setNativeNote({ text: result.nativeNote, warned: result.nativeWarned });
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <h1 className="v2-section-title">Auto-moderation</h1>
      <p className="v2-field-hint">
        Each check scans new and edited messages and acts on the first match. Administrators are always
        skipped. Actions are logged to the mod-log channel
        {data.modlogChannelId ? '' : ' (not set — see Settings)'}. Sylo never acts on other bots.
      </p>

      <form onSubmit={onSave}>
        <div className="v2-am-rules">
          {data.automodRules.map(([key, label, hint]) => (
            <div className="v2-am-rule" key={key}>
              <div className="v2-am-rule-main">
                <div>
                  <strong>{label}</strong>
                  <p className="v2-field-hint">{hint}</p>
                </div>
                <select value={mode(form.rules[key])} onChange={(e) => setMode(key, e.target.value)}>
                  {['off', ...data.automodActions].map((m) => (
                    <option key={m} value={m}>
                      {MODE_LABELS[m] || m}
                    </option>
                  ))}
                </select>
              </div>

              {WITH_PARAMS.has(key) ? (
                <details className="v2-am-params">
                  <summary>Settings</summary>
                  {key === 'links' ? (
                    <div className="v2-field">
                      <label>
                        Allowed domains <span className="v2-field-hint">— blank blocks all links</span>
                      </label>
                      <textarea
                        rows={2}
                        placeholder="youtube.com, twitch.tv"
                        value={form.rules.links.allowed}
                        onChange={(e) => setRule('links', { allowed: e.target.value })}
                      />
                    </div>
                  ) : null}
                  {key === 'spam' ? (
                    <div className="v2-field-row">
                      <span className="v2-field-hint">Max</span>
                      <input
                        type="number"
                        min={2}
                        max={30}
                        value={form.rules.spam.max}
                        onChange={(e) => setRule('spam', { max: Number(e.target.value) })}
                      />
                      <span className="v2-field-hint">messages per</span>
                      <input
                        type="number"
                        min={1}
                        max={60}
                        value={form.rules.spam.seconds}
                        onChange={(e) => setRule('spam', { seconds: Number(e.target.value) })}
                      />
                      <span className="v2-field-hint">s</span>
                    </div>
                  ) : null}
                  {key === 'mentions' ? (
                    <div className="v2-field-row">
                      <span className="v2-field-hint">Max mentions</span>
                      <input
                        type="number"
                        min={1}
                        max={50}
                        value={form.rules.mentions.max}
                        onChange={(e) => setRule('mentions', { max: Number(e.target.value) })}
                      />
                    </div>
                  ) : null}
                  {key === 'caps' ? (
                    <div className="v2-field-row">
                      <span className="v2-field-hint">At least</span>
                      <input
                        type="number"
                        min={4}
                        max={200}
                        value={form.rules.caps.minLength}
                        onChange={(e) => setRule('caps', { minLength: Number(e.target.value) })}
                      />
                      <span className="v2-field-hint">letters,</span>
                      <input
                        type="number"
                        min={50}
                        max={100}
                        value={form.rules.caps.percent}
                        onChange={(e) => setRule('caps', { percent: Number(e.target.value) })}
                      />
                      <span className="v2-field-hint">% uppercase</span>
                    </div>
                  ) : null}
                  {key === 'emojis' ? (
                    <div className="v2-field-row">
                      <span className="v2-field-hint">Max emojis</span>
                      <input
                        type="number"
                        min={1}
                        max={50}
                        value={form.rules.emojis.max}
                        onChange={(e) => setRule('emojis', { max: Number(e.target.value) })}
                      />
                    </div>
                  ) : null}
                  {key === 'spoilers' ? (
                    <div className="v2-field-row">
                      <span className="v2-field-hint">Max spoiler tags</span>
                      <input
                        type="number"
                        min={1}
                        max={30}
                        value={form.rules.spoilers.max}
                        onChange={(e) => setRule('spoilers', { max: Number(e.target.value) })}
                      />
                    </div>
                  ) : null}
                  {key === 'words' ? (
                    <div className="v2-field">
                      <label>
                        Words / phrases <span className="v2-field-hint">— comma or newline separated</span>
                      </label>
                      <textarea
                        rows={2}
                        placeholder="badword, another phrase"
                        value={form.rules.words.list}
                        onChange={(e) => setRule('words', { list: e.target.value })}
                      />
                    </div>
                  ) : null}
                </details>
              ) : null}
            </div>
          ))}
        </div>

        <h2 className="v2-group-title">Native Discord AutoMod</h2>
        <p className="v2-field-hint">
          Push the mappable checks onto Discord's built-in AutoMod so they are enforced before a message is
          posted, and keep working while Sylo is offline. Needs the Manage Server permission. Sylo owns any
          rule named "Sylo: …" — edit those here, not in Server Settings.
        </p>
        <div className="v2-field">
          <label className="v2-check">
            <input
              type="checkbox"
              checked={form.native.enabled}
              onChange={(e) => setNative({ enabled: e.target.checked })}
            />
            Enforce natively
          </label>
          <div className="v2-check-grid">
            {data.nativeMappable.map(([key, label]) => (
              <label className="v2-check" key={key}>
                <input
                  type="checkbox"
                  checked={Boolean(form.native[key])}
                  onChange={(e) => setNative({ [key]: e.target.checked })}
                />
                {label}
                {mode(form.rules[key]) === 'off' ? (
                  <span className="v2-field-hint"> — enable the check above first</span>
                ) : null}
              </label>
            ))}
          </div>
          <p className="v2-field-hint">
            Discord keyword presets <span>— Discord-maintained word lists</span>
          </p>
          <div className="v2-check-grid">
            {data.presetKeys.map((p) => (
              <label className="v2-check" key={p}>
                <input
                  type="checkbox"
                  checked={form.native.presets.includes(p)}
                  onChange={(e) => togglePreset(p, e.target.checked)}
                />
                {PRESET_LABELS[p] || p}
              </label>
            ))}
          </div>
        </div>

        <div className="v2-field">
          <label htmlFor="timeoutMinutes">Timeout length for the "Delete + Timeout" action (minutes)</label>
          <input
            id="timeoutMinutes"
            type="number"
            min={1}
            max={40320}
            value={form.timeoutMinutes}
            onChange={(e) => setForm((f) => ({ ...f, timeoutMinutes: Number(e.target.value) }))}
          />
        </div>

        <div className="v2-field">
          <label htmlFor="exemptChannels">
            Exempt channels <span className="v2-field-hint">— automod never acts here</span>
          </label>
          <select
            id="exemptChannels"
            multiple
            value={form.exemptChannels}
            onChange={(e) =>
              setForm((f) => ({ ...f, exemptChannels: [...e.target.selectedOptions].map((o) => o.value) }))
            }
          >
            {data.channels.map((c) => (
              <option key={c.id} value={c.id}>
                #{c.name}
              </option>
            ))}
          </select>
        </div>

        <div className="v2-section-gap">
          <button type="submit" className="v2-btn-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save automod'}
          </button>
          {saved ? <span className="v2-field-hint"> Saved.</span> : null}
          {nativeNote ? (
            <p className={nativeNote.warned ? 'v2-warn-text' : 'v2-field-hint'}>{nativeNote.text}</p>
          ) : null}
        </div>
      </form>
    </>
  );
}
