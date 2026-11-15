import LoadError from '../components/LoadError.jsx';
import SetupCallout from '../components/SetupCallout.jsx';
import SaveBar from '../components/SaveBar.jsx';
import { useModuleForm } from '../components/useModuleForm.js';
import { limitOf, useModuleLimits } from '../components/useModuleLimits.js';
import UnitInput from '../components/UnitInput.jsx';
import '../styles/wp2-alerts.css';

// One channel picker per alert kind; empty means the main channel.
function ChannelPick({ value, onChange, channels }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Channel for this alert">
      <option value="">— main channel —</option>
      {channels.map((c) => (
        <option key={c.id} value={c.id}>
          #{c.name}
        </option>
      ))}
    </select>
  );
}

// The alerts, one grid row each: the alert | its own number (where it has one) | its channel. `option` is the
// number: the words before it, which setting it is, and the unit after it.
const ALERTS = [
  {
    kind: 'versionState',
    label: 'App version state changes (waiting for review, in review, rejected, ready for sale …)',
  },
  { kind: 'build', label: 'Builds finished or failed processing' },
  { kind: 'betaReview', label: 'TestFlight review started, approved or rejected' },
  { kind: 'feedback', label: 'TestFlight feedback and crashes' },
  {
    kind: 'reviews',
    label: 'New customer reviews',
    option: { lead: 'only up to', field: 'maxStars', unit: 'stars', aria: 'Highest star rating to alert on' },
  },
  {
    kind: 'expiry',
    label: 'Certificates and profiles expiring',
    option: {
      lead: 'from',
      field: 'days',
      unit: 'days before',
      aria: 'Days before expiry to start alerting',
    },
    hint: 'Also sent at 7 days and 1 day before. Needs a team API key.',
  },
];

// The app list is edited as free text (one id per line); it travels as an array.
const toForm = (config) => ({ ...config, appsText: config.apps.join('\n') });
const fromForm = (form) => {
  const { appsText, ...rest } = form;
  return { ...rest, apps: appsText.split(/[\s,]+/).filter(Boolean) };
};

// Owner-only: the server refuses everyone else, so this page is only ever reached by the owner.
export default function AppleConnect() {
  const limits = useModuleLimits('apple-connect');
  const { data, form, setForm, status, error, dirty, saving, save, reset } = useModuleForm('apple-connect', {
    toForm,
    fromForm,
  });

  if (status === 'error') return <LoadError error={error} what="App Store Connect settings" />;
  if (status === 'loading') return <p className="v2-state">Loading…</p>;

  const setKind = (kind, patch) =>
    setForm((f) => ({ ...f, events: { ...f.events, [kind]: { ...f.events[kind], ...patch } } }));
  const ev = form.events;

  return (
    <>
      <h1 className="v2-section-title">App Store Connect</h1>
      <p className="v2-field-hint">
        Alerts from your Apple Developer account: an app version moving through review, builds and TestFlight,
        new reviews, tester feedback, and certificates about to expire. Checked about every 5 minutes. Only
        the Sylo owner can see this module.
      </p>
      {!data.appleEnabled ? (
        <SetupCallout
          what="App Store Connect alerts"
          keys="an Apple API key"
          vars={['APPLE_KEY_ID', 'APPLE_PRIVATE_KEY', 'APPLE_ISSUER_ID']}
          where="the issuer ID is only needed for a team key"
        >
          You can set things up now; alerts start once the key is in.
        </SetupCallout>
      ) : null}

      <form onSubmit={save} data-savebar>
        <div className="v2-field">
          <label htmlFor="apple-channel">
            Main channel <span className="v2-field-hint">— used by every alert without its own</span>
          </label>
          <select
            id="apple-channel"
            value={form.channelId}
            onChange={(e) => setForm((f) => ({ ...f, channelId: e.target.value }))}
          >
            <option value="">— select a channel —</option>
            {data.channels.map((c) => (
              <option key={c.id} value={c.id}>
                #{c.name}
              </option>
            ))}
          </select>
        </div>

        <div className="v2-field">
          <label htmlFor="apple-role">
            Ping role <span className="v2-field-hint">— optional</span>
          </label>
          <select
            id="apple-role"
            value={form.roleId}
            onChange={(e) => setForm((f) => ({ ...f, roleId: e.target.value }))}
          >
            <option value="">— none —</option>
            {data.roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </div>

        <div className="v2-field">
          <label htmlFor="apple-apps">
            Apps{' '}
            <span className="v2-field-hint">— App Store Connect app ids, one per line; empty means all</span>
          </label>
          <textarea
            id="apple-apps"
            rows={2}
            placeholder="e.g. 1234567890 (one per line). Leave empty for all apps."
            value={form.appsText}
            onChange={(e) => setForm((f) => ({ ...f, appsText: e.target.value }))}
          />
        </div>

        <p className="v2-field-hint">
          Each alert can go to its own channel; leave it on main channel to use the one above.
        </p>
        <div className="v2-field v2-alert-grid">
          {ALERTS.map(({ kind, label, option, hint }) => (
            <div className="v2-alert-line" key={kind}>
              <label className="v2-check">
                <input
                  type="checkbox"
                  checked={ev[kind].enabled}
                  onChange={(e) => setKind(kind, { enabled: e.target.checked })}
                />
                <span>{label}</span>
              </label>
              <span className="v2-alert-option">
                {option ? (
                  <>
                    <span className="v2-nowrap">{option.lead}</span>
                    <UnitInput
                      aria-label={option.aria}
                      unit={option.unit}
                      min={limitOf(limits, `events.${kind}.${option.field}`).min}
                      max={limitOf(limits, `events.${kind}.${option.field}`).max}
                      value={ev[kind][option.field]}
                      onChange={(e) => setKind(kind, { [option.field]: Number(e.target.value) })}
                    />
                  </>
                ) : null}
              </span>
              <ChannelPick
                channels={data.channels}
                value={ev[kind].channelId}
                onChange={(channelId) => setKind(kind, { channelId })}
              />
              {hint ? <p className="v2-field-hint v2-alert-hint">{hint}</p> : null}
            </div>
          ))}
        </div>
      </form>
      <SaveBar dirty={dirty} saving={saving} onSave={save} onReset={reset} />
    </>
  );
}
