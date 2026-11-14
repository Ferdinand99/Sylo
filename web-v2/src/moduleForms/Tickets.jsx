import { Link } from 'react-router-dom';
import PickerHealth from '../components/PickerHealth.jsx';
import ChipPicker from '../components/ChipPicker.jsx';
import MentionTextarea from '../components/MentionTextarea.jsx';
import PlaceholderBar from '../components/PlaceholderBar.jsx';
import PlaceholderHint from '../components/PlaceholderHint.jsx';
import PreviewLayout from '../components/PreviewLayout.jsx';
import LoadError from '../components/LoadError.jsx';
import SaveBar from '../components/SaveBar.jsx';
import { useModuleForm } from '../components/useModuleForm.js';
import { limitOf, useModuleLimits } from '../components/useModuleLimits.js';
import UnitInput from '../components/UnitInput.jsx';
import { tokensFor } from '../placeholders.js';

// What the bot sends when a message is left empty (DEFAULT_GREETING and DEFAULT_CLOSE in
// src/modules/tickets.js).
const DEFAULT_GREETING =
  'Thanks for contacting the staff of {server}. Your message has been received — a moderator will reply here shortly.';
const DEFAULT_CLOSE = 'This ticket has been closed. Send another message any time to open a new one.';

export default function Tickets() {
  const limits = useModuleLimits('tickets');
  const { guildId, data, form, setForm, status, error, dirty, saving, save, reset } =
    useModuleForm('tickets');

  if (status === 'error') return <LoadError error={error} what="Tickets settings" />;
  if (status === 'loading') return <p className="v2-state">Loading…</p>;

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const tokens = tokensFor('tickets');
  // Both messages reach the member as a direct message from the bot, as an embed.
  const previews = [
    {
      key: 'greeting',
      title: 'Greeting (a direct message to the member)',
      embed: { title: 'Ticket #1 — {server}', description: form.greeting || DEFAULT_GREETING },
    },
    {
      key: 'close',
      title: 'When a ticket is closed (a direct message to the member)',
      embed: {
        description: `${form.closeMessage || DEFAULT_CLOSE}\n\nA transcript of this conversation is attached.`,
      },
    },
  ];

  return (
    <PreviewLayout previews={previews} lookup={{ channels: data.channels, roles: data.roles }}>
      <>
        <h1 className="v2-section-title">Tickets</h1>
        <p className="v2-field-hint">
          Members open a ticket (modmail) by sending the bot a direct message. Staff read and reply from the{' '}
          <Link to={`/guilds/${guildId}/tickets`}>Tickets</Link> page — replies reach the member as an
          anonymous "Staff" DM.
        </p>

        <form onSubmit={save} data-savebar>
          <PlaceholderBar
            fields={[
              { id: 'greeting', label: 'Greeting', tokens },
              { id: 'closeMessage', label: 'Closing message', tokens },
            ]}
          />
          <div className="v2-field">
            <label htmlFor="greeting">Greeting sent when a ticket opens</label>
            <MentionTextarea
              channels={data.channels}
              roles={data.roles}
              id="greeting"
              rows={2}
              maxLength={limitOf(limits, 'greeting').maxLength}
              placeholder="Thanks for contacting the staff of {server}…"
              value={form.greeting}
              onChange={(e) => set({ greeting: e.target.value })}
            />
            <PlaceholderHint
              fieldId="greeting"
              chips={false}
              tokens={tokens}
              value={form.greeting}
              onChange={(greeting) => set({ greeting })}
            />
          </div>

          <div className="v2-field">
            <label htmlFor="closeMessage">Message sent when a ticket is closed</label>
            <MentionTextarea
              channels={data.channels}
              roles={data.roles}
              id="closeMessage"
              rows={2}
              maxLength={limitOf(limits, 'closeMessage').maxLength}
              placeholder="This ticket has been closed…"
              value={form.closeMessage}
              onChange={(e) => set({ closeMessage: e.target.value })}
            />
            <PlaceholderHint
              fieldId="closeMessage"
              chips={false}
              tokens={tokens}
              value={form.closeMessage}
              onChange={(closeMessage) => set({ closeMessage })}
            />
          </div>

          <div className="v2-field">
            <label htmlFor="notifyChannel">
              Staff notification channel{' '}
              <span className="v2-field-hint">— optional, pinged on new tickets/replies</span>
            </label>
            <select
              id="notifyChannel"
              value={form.notifyChannel}
              onChange={(e) => set({ notifyChannel: e.target.value })}
            >
              <option value="">— none —</option>
              {data.channels.map((c) => (
                <option key={c.id} value={c.id}>
                  #{c.name}
                </option>
              ))}
            </select>
            <PickerHealth kind="channel" value={form.notifyChannel} embed />
          </div>

          <div className="v2-field">
            <label>
              Staff roles{' '}
              <span className="v2-field-hint">— may read/reply to tickets even without Manage Server</span>
            </label>
            <ChipPicker
              kind="role"
              items={data.roles}
              value={form.staffRoles}
              onChange={(staffRoles) => set({ staffRoles })}
            />
          </div>

          <div className="v2-field">
            <label className="v2-check">
              <input
                type="checkbox"
                checked={form.showMessageInAlert}
                onChange={(e) => set({ showMessageInAlert: e.target.checked })}
              />
              Include the ticket's opening message in the staff notification
            </label>
            <p className="v2-field-hint">
              Lets staff see what a ticket is about before opening it — off by default since the message may
              be sensitive.
            </p>
          </div>

          <div className="v2-field">
            <label htmlFor="transcriptRetentionDays">Delete closed tickets after</label>
            <UnitInput
              id="transcriptRetentionDays"
              unit="days"
              min={limitOf(limits, 'transcriptRetentionDays').min}
              max={limitOf(limits, 'transcriptRetentionDays').max}
              value={form.transcriptRetentionDays}
              onChange={(e) => set({ transcriptRetentionDays: Number(e.target.value) })}
            />
            <p className="v2-field-hint">
              0 keeps them forever. A daily job removes closed tickets and every message in them once they are
              older than this. Open tickets are never affected.
            </p>
          </div>
        </form>
        <SaveBar dirty={dirty} saving={saving} onSave={save} onReset={reset} />
      </>
    </PreviewLayout>
  );
}
