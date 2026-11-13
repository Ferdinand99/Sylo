import { useCmd } from '../platformContext.jsx';
import PlaceholderHint from '../components/PlaceholderHint.jsx';
import MentionTextarea from '../components/MentionTextarea.jsx';
import PreviewLayout from '../components/PreviewLayout.jsx';
import LoadError from '../components/LoadError.jsx';
import SaveBar from '../components/SaveBar.jsx';
import SendTestButton from '../components/SendTestButton.jsx';
import { useModuleForm } from '../components/useModuleForm.js';
import { limitOf, useModuleLimits } from '../components/useModuleLimits.js';
import { tokensFor } from '../placeholders.js';

export default function Birthdays() {
  const cmd = useCmd();
  const limits = useModuleLimits('birthdays');
  const { data, form, setForm, status, error, dirty, saving, save, reset } = useModuleForm('birthdays');

  if (status === 'error') return <LoadError error={error} what="Birthdays settings" />;
  if (status === 'loading') return <p className="v2-state">Loading…</p>;

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const previews = [
    {
      key: 'birthday',
      title: 'Birthday message',
      hidden: !form.channel,
      content: form.pingRole && form.roleId ? `<@&${form.roleId}>` : '',
      embed: { description: form.message },
      samples: { '{age}': '27' },
    },
  ];
  return (
    <PreviewLayout previews={previews} lookup={{ channels: data.channels ?? [], roles: data.roles ?? [] }}>
      <>
        <h1 className="v2-section-title">Birthdays</h1>
        <p className="v2-field-hint">
          Members save their own date with <code>{cmd('/birthday set')}</code>. Sylo posts the message once a
          day, shortly after midnight in the time zone Sylo runs in (not each member's own).
        </p>

        <form onSubmit={save} data-savebar>
          <div className="v2-field">
            <label htmlFor="channel">Announcement channel</label>
            <select id="channel" value={form.channel} onChange={(e) => set({ channel: e.target.value })}>
              <option value="">— none (no message) —</option>
              {data.channels.map((c) => (
                <option key={c.id} value={c.id}>
                  #{c.name}
                </option>
              ))}
            </select>
          </div>

          <div className="v2-field">
            <label htmlFor="message">Message</label>
            <MentionTextarea
              channels={data.channels}
              roles={data.roles}
              id="message"
              rows={2}
              maxLength={limitOf(limits, 'message').maxLength}
              placeholder="🎂 Happy birthday {user}! 🎉"
              value={form.message}
              onChange={(e) => set({ message: e.target.value })}
            />
            <PlaceholderHint
              fieldId="message"
              tokens={tokensFor('birthdays')}
              value={form.message}
              onChange={(message) => set({ message })}
            />
          </div>

          <div className="v2-field">
            <label htmlFor="roleId">
              Birthday role{' '}
              <span className="v2-field-hint">(optional — granted for the day, removed after)</span>
            </label>
            <select id="roleId" value={form.roleId} onChange={(e) => set({ roleId: e.target.value })}>
              <option value="">— none —</option>
              {data.roles.map((r) => (
                <option key={r.id} value={r.id}>
                  @{r.name}
                </option>
              ))}
            </select>
            <p className="v2-field-hint">
              Sylo's highest role must sit above this one, and it needs <strong>Manage Roles</strong>.
            </p>
          </div>

          <label className="v2-check">
            <input
              type="checkbox"
              checked={form.pingRole}
              onChange={(e) => set({ pingRole: e.target.checked })}
            />
            Ping the birthday role in the announcement
          </label>
        </form>
        <SendTestButton
          moduleId="birthdays"
          disabled={dirty}
          sample="a sample birthday message (not your own text)"
          channelName={data.channels.find((c) => c.id === form.channel)?.name}
        />
        <SaveBar dirty={dirty} saving={saving} onSave={save} onReset={reset} />
      </>
    </PreviewLayout>
  );
}
