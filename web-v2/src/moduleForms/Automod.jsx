import { useContext } from 'react';
import { PlatformContext } from '../platformContext.jsx';
import Badge from '../components/Badge.jsx';
import ChipPicker from '../components/ChipPicker.jsx';
import { notify } from '../notify.js';
import LoadError from '../components/LoadError.jsx';
import SaveBar from '../components/SaveBar.jsx';
import UnitInput from '../components/UnitInput.jsx';
import { useModuleForm } from '../components/useModuleForm.js';
import { limitOf, useModuleLimits } from '../components/useModuleLimits.js';

const MODE_LABELS = {
  off: 'Disabled',
  delete: 'Delete message',
  warn: 'Delete + Warn',
  timeout: 'Delete + Timeout',
};
// Rules with an extra "Options" panel.
const WITH_PARAMS = new Set(['links', 'spam', 'mentions', 'caps', 'words', 'emojis', 'spoilers']);
const PRESET_LABELS = { profanity: 'Profanity', sexual: 'Sexual content', slurs: 'Slurs' };

function mode(rule) {
  return rule?.enabled ? rule.action || 'delete' : 'off';
}

const count = (n, one, many = `${one}s`) => `${n} ${Number(n) === 1 ? one : many}`;
const listLength = (text) =>
  String(text ?? '')
    .split(/[\n,]/)
    .filter((x) => x.trim()).length;

/** The current values of a rule's options, in a few words, shown next to "Options". */
export function paramSummary(key, rule) {
  if (!rule) return '';
  switch (key) {
    case 'links': {
      const n = listLength(rule.allowed);
      return n ? `${count(n, 'allowed domain')}` : 'all links blocked';
    }
    case 'spam':
      return `max ${count(rule.max, 'message')} per ${rule.seconds} s`;
    case 'mentions':
      return `max ${count(rule.max, 'mention')}`;
    case 'caps':
      return `${count(rule.minLength, 'letter')} or more, ${rule.percent}% uppercase`;
    case 'emojis':
      return `max ${count(rule.max, 'emoji')}`;
    case 'spoilers':
      return `max ${count(rule.max, 'spoiler tag')}`;
    case 'words': {
      const n = listLength(rule.list);
      return n ? count(n, 'word or phrase', 'words or phrases') : 'no words yet';
    }
    default:
      return '';
  }
}

// The GET/save response always carries links.allowed / words.list as real
// arrays (normaliseAutomodConfig's canonical shape) — but the textarea
// editing them needs a plain string. Convert on the way in; the backend's
// termList() already accepts a raw comma/newline-separated string just as
// happily as an array, so no conversion is needed on the way out. The immunity roles ride
// along in the form as `immunityRoles` and are saved with everything else; the stored list is
// `exemptRoles`, which the server ignores in the save body (the Sylo app echoes a stale copy).
function toFormConfig({ exemptRoles, ...config }) {
  return {
    ...config,
    immunityRoles: exemptRoles ?? [],
    rules: {
      ...config.rules,
      links: { ...config.rules.links, allowed: (config.rules.links.allowed || []).join(', ') },
      words: { ...config.rules.words, list: (config.rules.words.list || []).join(', ') },
    },
  };
}

export default function Automod() {
  const limits = useModuleLimits('automod');
  const { data, form, setForm, status, error, dirty, saving, save, reset } = useModuleForm('automod', {
    toForm: toFormConfig,
    // The native-automod sync reports back how it went — surface that as a toast.
    onSaved: (result) => {
      if (result.nativeNote) notify(result.nativeNote, result.nativeWarned ? 'error' : 'info');
    },
  });
  const { capabilities } = useContext(PlatformContext);

  if (status === 'error') return <LoadError error={error} what="Auto-moderation settings" />;
  if (status === 'loading') return <p className="v2-state">Loading…</p>;

  const setRule = (key, patch) =>
    setForm((f) => ({ ...f, rules: { ...f.rules, [key]: { ...f.rules[key], ...patch } } }));
  const setMode = (key, m) => setRule(key, { enabled: m !== 'off', action: m === 'off' ? 'delete' : m });
  const setNative = (patch) => setForm((f) => ({ ...f, native: { ...f.native, ...patch } }));
  const togglePreset = (p, checked) =>
    setNative({
      presets: checked ? [...form.native.presets, p] : form.native.presets.filter((x) => x !== p),
    });
  const nativeOn = form.native.enabled;

  return (
    <>
      <h1 className="v2-section-title">Auto-moderation</h1>
      <p className="v2-field-hint">
        Each check scans new and edited messages and acts on the first match. Administrators are always
        skipped. Actions are logged to the mod-log channel
        {data.modlogChannelId ? '' : ' (not set — see Settings)'}. Sylo never acts on other bots.
      </p>

      <form onSubmit={save} data-savebar>
        <div className="v2-am-rules">
          {data.automodRules.map(([key, label, hint]) => {
            const off = mode(form.rules[key]) === 'off';
            return (
              <div className={`v2-am-rule${off ? ' is-off' : ''}`} key={key}>
                <div className="v2-am-rule-main">
                  <div className="v2-am-rule-text">
                    <strong>
                      {label}
                      {off ? (
                        <Badge tone="neutral" inline>
                          Off
                        </Badge>
                      ) : null}
                    </strong>
                    <p className="v2-field-hint">{hint}</p>
                  </div>
                  <select
                    aria-label={`What to do for: ${label}`}
                    value={mode(form.rules[key])}
                    onChange={(e) => setMode(key, e.target.value)}
                  >
                    {['off', ...data.automodActions].map((m) => (
                      <option key={m} value={m}>
                        {MODE_LABELS[m] || m}
                      </option>
                    ))}
                  </select>
                </div>

                {WITH_PARAMS.has(key) ? (
                  <details className="v2-am-params">
                    <summary>
                      Options
                      <span className="v2-am-summary"> · {paramSummary(key, form.rules[key])}</span>
                    </summary>
                    {key === 'links' ? (
                      <div className="v2-field">
                        <label htmlFor="am-links-allowed">
                          Allowed domains <span className="v2-field-hint">— blank blocks all links</span>
                        </label>
                        <textarea
                          id="am-links-allowed"
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
                          aria-label="Most messages allowed"
                          min={limitOf(limits, 'rules.spam.max').min}
                          max={limitOf(limits, 'rules.spam.max').max}
                          value={form.rules.spam.max}
                          onChange={(e) => setRule('spam', { max: Number(e.target.value) })}
                        />
                        <span className="v2-field-hint">messages per</span>
                        <input
                          type="number"
                          aria-label="Time window in seconds"
                          min={limitOf(limits, 'rules.spam.seconds').min}
                          max={limitOf(limits, 'rules.spam.seconds').max}
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
                          aria-label="Most mentions allowed"
                          min={limitOf(limits, 'rules.mentions.max').min}
                          max={limitOf(limits, 'rules.mentions.max').max}
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
                          aria-label="Shortest message to check, in letters"
                          min={limitOf(limits, 'rules.caps.minLength').min}
                          max={limitOf(limits, 'rules.caps.minLength').max}
                          value={form.rules.caps.minLength}
                          onChange={(e) => setRule('caps', { minLength: Number(e.target.value) })}
                        />
                        <span className="v2-field-hint">letters,</span>
                        <input
                          type="number"
                          aria-label="Percent in uppercase"
                          min={limitOf(limits, 'rules.caps.percent').min}
                          max={limitOf(limits, 'rules.caps.percent').max}
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
                          aria-label="Most emojis allowed"
                          min={limitOf(limits, 'rules.emojis.max').min}
                          max={limitOf(limits, 'rules.emojis.max').max}
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
                          aria-label="Most spoiler tags allowed"
                          min={limitOf(limits, 'rules.spoilers.max').min}
                          max={limitOf(limits, 'rules.spoilers.max').max}
                          value={form.rules.spoilers.max}
                          onChange={(e) => setRule('spoilers', { max: Number(e.target.value) })}
                        />
                      </div>
                    ) : null}
                    {key === 'words' ? (
                      <div className="v2-field">
                        <label htmlFor="am-words-list">
                          Words / phrases <span className="v2-field-hint">— comma or newline separated</span>
                        </label>
                        <textarea
                          id="am-words-list"
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
            );
          })}
        </div>

        <div className="v2-field">
          <label htmlFor="timeoutMinutes">Timeout length for the "Delete + Timeout" action</label>
          <UnitInput
            id="timeoutMinutes"
            unit="minutes"
            min={limitOf(limits, 'timeoutMinutes').min}
            max={limitOf(limits, 'timeoutMinutes').max}
            value={form.timeoutMinutes}
            onChange={(e) => setForm((f) => ({ ...f, timeoutMinutes: Number(e.target.value) }))}
          />
        </div>

        {capabilities.nativeAutomod ? (
          <>
            <h2 className="v2-group-title">Native Discord AutoMod</h2>
            <p className="v2-field-hint">
              Push the mappable checks onto Discord's built-in AutoMod so they are enforced before a message
              is posted, and keep working while Sylo is offline. Needs the Manage Server permission. Sylo owns
              any rule named "Sylo: …" — edit those here, not in Server Settings.
            </p>
            <div className="v2-field">
              <label className="v2-check">
                <input
                  type="checkbox"
                  checked={nativeOn}
                  onChange={(e) => setNative({ enabled: e.target.checked })}
                />
                <span>Enforce natively</span>
              </label>
              <div className={`v2-check-grid v2-check-sub${nativeOn ? '' : ' is-disabled'}`}>
                {data.nativeMappable.map(([key, label]) => {
                  const ruleOff = mode(form.rules[key]) === 'off';
                  return (
                    <label className="v2-check" key={key}>
                      <input
                        type="checkbox"
                        checked={Boolean(form.native[key])}
                        disabled={!nativeOn}
                        onChange={(e) => setNative({ [key]: e.target.checked })}
                      />
                      <span>
                        {label}
                        {ruleOff ? (
                          <span className="v2-field-hint"> — enable the check above first</span>
                        ) : null}
                      </span>
                    </label>
                  );
                })}
              </div>
              <p className="v2-field-hint v2-check-sub-title">
                Discord keyword presets <span>— Discord-maintained word lists</span>
              </p>
              <div className={`v2-check-grid v2-check-sub${nativeOn ? '' : ' is-disabled'}`}>
                {data.presetKeys.map((p) => (
                  <label className="v2-check" key={p}>
                    <input
                      type="checkbox"
                      checked={form.native.presets.includes(p)}
                      disabled={!nativeOn}
                      onChange={(e) => togglePreset(p, e.target.checked)}
                    />
                    <span>{PRESET_LABELS[p] || p}</span>
                  </label>
                ))}
              </div>
              {nativeOn ? null : (
                <p className="v2-field-hint">These options apply once "Enforce natively" is on.</p>
              )}
            </div>
          </>
        ) : null}

        <h2 className="v2-group-title">Exemptions</h2>
        <div className="v2-field">
          <label htmlFor="am-exempt-channels">
            Exempt channels <span className="v2-field-hint">— automod never acts here</span>
          </label>
          <ChipPicker
            id="am-exempt-channels"
            kind="channel"
            items={data.channels}
            value={form.exemptChannels}
            onChange={(exemptChannels) => setForm((f) => ({ ...f, exemptChannels }))}
          />
        </div>

        <div className="v2-field">
          <label htmlFor="am-immunity-roles">Immunity roles</label>
          <p className="v2-field-hint">
            Members with one of these roles are never touched by auto-moderation or the warning auto-actions.
            Administrators, the server owner and bot-master roles are always immune.
          </p>
          <ChipPicker
            id="am-immunity-roles"
            kind="role"
            items={data.roles}
            value={form.immunityRoles}
            onChange={(immunityRoles) => setForm((f) => ({ ...f, immunityRoles }))}
          />
        </div>
      </form>

      <SaveBar dirty={dirty} saving={saving} onSave={save} onReset={reset} />
    </>
  );
}
