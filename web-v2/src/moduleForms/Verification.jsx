import LoadError from '../components/LoadError.jsx';
import PickerHealth from '../components/PickerHealth.jsx';
import MentionTextarea from '../components/MentionTextarea.jsx';
import PreviewLayout from '../components/PreviewLayout.jsx';
import SetupCallout from '../components/SetupCallout.jsx';
import SaveBar from '../components/SaveBar.jsx';
import UnitInput from '../components/UnitInput.jsx';
import { useModuleForm } from '../components/useModuleForm.js';
import { limitOf, useModuleLimits } from '../components/useModuleLimits.js';
import { minutesAsText } from '../util.js';

// What the bot posts when the title or the text is left empty (DEFAULTS in src/modules/verification.js).
const DEFAULT_TITLE = 'Verification';
const DEFAULT_BODY = 'Click the button below to verify and unlock the rest of the server.';
const DEFAULT_SUCCESS = 'You are verified — welcome!';

export default function Verification() {
  const limits = useModuleLimits('verification');
  const { data, form, setForm, status, error, dirty, saving, save, reset } = useModuleForm('verification');

  if (status === 'error') return <LoadError error={error} what="Verification settings" />;
  if (status === 'loading') return <p className="v2-state">Loading…</p>;

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const previews = [
    {
      key: 'verify',
      title: 'The verify message',
      embed: {
        color: '#58d68d',
        title: form.title || DEFAULT_TITLE,
        description: form.message || DEFAULT_BODY,
      },
      note: 'Members see a green “✅ Verify” button under the message.',
    },
    {
      key: 'success',
      title: 'Reply after verifying',
      content: form.successMessage || DEFAULT_SUCCESS,
      note: 'Only the member who verified sees this reply.',
    },
  ];

  return (
    <PreviewLayout previews={previews} lookup={{ channels: data.channels, roles: data.roles }}>
      <>
        <h1 className="v2-section-title">Verification</h1>
        <p className="v2-field-hint">
          Posts a message with a <strong>Verify</strong> button in the chosen channel. New members click it to
          get the verified role. In <strong>captcha</strong> mode the button sends them a private link to a
          Cloudflare Turnstile check on this dashboard first.
        </p>
        {!data.turnstileEnabled ? (
          <SetupCallout
            what="Captcha mode"
            singular
            keys="Cloudflare Turnstile keys"
            vars={['TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY']}
          >
            Until then the Verify button works on its own, without the check.
          </SetupCallout>
        ) : null}

        <form onSubmit={save} data-savebar>
          <div className="v2-field">
            <label htmlFor="mode">Mode</label>
            <select id="mode" value={form.mode} onChange={(e) => set({ mode: e.target.value })}>
              {data.modes.map((m) => (
                <option key={m} value={m}>
                  {m === 'captcha' ? 'Captcha (button + Turnstile)' : 'Button only'}
                </option>
              ))}
            </select>
          </div>

          <div className="v2-field">
            <label htmlFor="verifiedRoleId">
              Verified role <span className="v2-field-hint">— given to members who pass</span>
            </label>
            <select
              id="verifiedRoleId"
              required
              value={form.verifiedRoleId}
              onChange={(e) => set({ verifiedRoleId: e.target.value })}
            >
              <option value="">— select —</option>
              {data.roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <PickerHealth kind="role" value={form.verifiedRoleId} />
            <p className="v2-field-hint">
              Sylo's own role must be higher than this one in your server's role list, or it can't give it
              out.
            </p>
          </div>

          <div className="v2-field">
            <label htmlFor="channelId">Verify channel</label>
            <select
              id="channelId"
              required
              value={form.channelId}
              onChange={(e) => set({ channelId: e.target.value })}
            >
              <option value="">— select —</option>
              {data.channels.map((c) => (
                <option key={c.id} value={c.id}>
                  #{c.name}
                </option>
              ))}
            </select>
            <PickerHealth kind="channel" value={form.channelId} embed />
            <p className="v2-field-hint">
              Saving posts the verify message here, or updates the one that is already there. Sylo needs to
              see the channel, send messages and embed links in it.
            </p>
          </div>

          <div className="v2-field">
            <label htmlFor="title">Message title</label>
            <input
              id="title"
              type="text"
              maxLength={limitOf(limits, 'title').maxLength}
              value={form.title}
              onChange={(e) => set({ title: e.target.value })}
            />
          </div>

          <div className="v2-field">
            <label htmlFor="message">Message body</label>
            <MentionTextarea
              channels={data.channels}
              roles={data.roles}
              id="message"
              rows={2}
              maxLength={limitOf(limits, 'message').maxLength}
              value={form.message}
              onChange={(e) => set({ message: e.target.value })}
            />
          </div>

          <div className="v2-field">
            <label htmlFor="successMessage">Reply after verifying</label>
            <input
              id="successMessage"
              type="text"
              maxLength={limitOf(limits, 'successMessage').maxLength}
              value={form.successMessage}
              onChange={(e) => set({ successMessage: e.target.value })}
            />
          </div>

          <div className="v2-field">
            <label htmlFor="logChannelId">
              Log channel <span className="v2-field-hint">— optional</span>
            </label>
            <select
              id="logChannelId"
              value={form.logChannelId}
              onChange={(e) => set({ logChannelId: e.target.value })}
            >
              <option value="">— none —</option>
              {data.channels.map((c) => (
                <option key={c.id} value={c.id}>
                  #{c.name}
                </option>
              ))}
            </select>
            <PickerHealth kind="channel" value={form.logChannelId} embed />
          </div>

          <div className="v2-field">
            <label htmlFor="kickAfterMinutes">Kick members who don't verify within</label>
            <UnitInput
              id="kickAfterMinutes"
              unit="minutes"
              wide
              min={limitOf(limits, 'kickAfterMinutes').min}
              max={limitOf(limits, 'kickAfterMinutes').max}
              value={form.kickAfterMinutes}
              // An emptied field means 0 = never kick, stated in the hint below.
              onChange={(e) => set({ kickAfterMinutes: e.target.value === '' ? 0 : Number(e.target.value) })}
            />
            <p className="v2-field-hint">
              {Number(form.kickAfterMinutes) === 0
                ? '0 means never: nobody is kicked for not verifying.'
                : `${minutesAsText(form.kickAfterMinutes) ? `That is ${minutesAsText(form.kickAfterMinutes)}. ` : ''}0 means never.`}
            </p>
          </div>
        </form>

        <p className="v2-field-hint v2-section-gap">
          Saving (re)posts the verify message. Sylo needs <strong>Manage Roles</strong>, and — for the kick
          option — <strong>Kick Members</strong>.
        </p>
        <SaveBar dirty={dirty} saving={saving} onSave={save} onReset={reset} />
      </>
    </PreviewLayout>
  );
}
