import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getModuleConfig, saveModuleConfig, ApiError } from '../api.js';
import { useApiData } from '../useApiData.js';
import ChipPicker from '../components/ChipPicker.jsx';

export default function Tickets() {
  const { guildId } = useParams();
  const { data, loading, error } = useApiData(() => getModuleConfig(guildId, 'tickets'), [guildId]);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data) setForm(data.config);
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
          `Couldn't load Tickets settings (${error.message}).`
        )}
      </p>
    );
  }

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  async function onSave(e) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    try {
      const { config } = await saveModuleConfig(guildId, 'tickets', {
        ...form,
        action: e.nativeEvent.submitter?.value,
      });
      setForm(config);
      setSaved(true);
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <h1 className="v2-section-title">Tickets</h1>
      <p className="v2-field-hint">
        Zgłoszenia wysłane na DM trafiają do prywatnych kanałów na Discordzie. Administracja odpowiada w
        kanale, a bot przekazuje odpowiedzi użytkownikowi na DM. Panel zachowuje historię rozmów.
      </p>

      <form onSubmit={onSave}>
        <h2>Discord ticket panel</h2>
        <p className="v2-field-hint">
          Each topic opens a private text channel in its selected category. Staff roles below and
          administrators have access. Closing sends a text transcript to the ticket log channel, then deletes
          the ticket channel. Failed archiving retains the channel. Modmail retention does not delete Discord
          transcripts.
        </p>
        <div className="v2-field">
          <label>Panel channel</label>
          <select value={form.panelChannel || ''} onChange={(e) => set({ panelChannel: e.target.value })}>
            <option value="">— none —</option>
            {data.channels.map((c) => (
              <option key={c.id} value={c.id}>
                #{c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="v2-field">
          <label>Panel title</label>
          <input
            maxLength={256}
            value={form.panelTitle || ''}
            onChange={(e) => set({ panelTitle: e.target.value })}
          />
        </div>
        <div className="v2-field">
          <label>Panel message</label>
          <textarea
            maxLength={2000}
            value={form.panelText || ''}
            onChange={(e) => set({ panelText: e.target.value })}
          />
        </div>
        <div className="v2-field">
          <label>Ticket log channel</label>
          <select
            value={form.ticketLogChannel || ''}
            onChange={(e) => set({ ticketLogChannel: e.target.value })}
          >
            <option value="">— none —</option>
            {data.channels.map((c) => (
              <option key={c.id} value={c.id}>
                #{c.name}
              </option>
            ))}
          </select>
        </div>
        <h3>Ticket topics</h3>
        <p className="v2-field-hint">
          Up to 25 topics. One open channel ticket per member. Save and publish to update the Discord menu.
        </p>
        {(form.ticketTypes || []).map((type, index) => {
          const update = (patch) =>
            set({
              ticketTypes: form.ticketTypes.map((row, i) => (i === index ? { ...row, ...patch } : row)),
            });
          return (
            <fieldset key={type.id || index} className="v2-field">
              <label>Topic name</label>
              <input maxLength={100} value={type.label} onChange={(e) => update({ label: e.target.value })} />
              <label>Description</label>
              <input
                maxLength={100}
                value={type.description}
                onChange={(e) => update({ description: e.target.value })}
              />
              <label>Destination category</label>
              <select value={type.categoryId} onChange={(e) => update({ categoryId: e.target.value })}>
                <option value="">— choose a category —</option>
                {data.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => set({ ticketTypes: form.ticketTypes.filter((_, i) => i !== index) })}
              >
                Remove topic
              </button>
            </fieldset>
          );
        })}
        <button
          type="button"
          disabled={(form.ticketTypes || []).length >= 25}
          onClick={() =>
            set({
              ticketTypes: [
                ...(form.ticketTypes || []),
                { id: crypto.randomUUID(), label: '', description: '', categoryId: '' },
              ],
            })
          }
        >
          Add topic
        </button>
        <button type="submit" value="publish" disabled={saving}>
          Save and publish panel
        </button>
        <h2>DM tickets (modmail)</h2>
        <div className="v2-field">
          <label htmlFor="greeting">
            Greeting sent when a ticket opens{' '}
            <span className="v2-field-hint">— {'{server}'} is replaced</span>
          </label>
          <textarea
            id="greeting"
            rows={2}
            maxLength={1500}
            placeholder="Thanks for contacting the staff of {server}…"
            value={form.greeting}
            onChange={(e) => set({ greeting: e.target.value })}
          />
        </div>

        <div className="v2-field">
          <label htmlFor="closeMessage">Message sent when a ticket is closed</label>
          <textarea
            id="closeMessage"
            rows={2}
            maxLength={1500}
            placeholder="This ticket has been closed…"
            value={form.closeMessage}
            onChange={(e) => set({ closeMessage: e.target.value })}
          />
        </div>

        <div className="v2-field">
          <label htmlFor="dmCategory">Kategoria zgłoszeń z DM</label>
          <select
            id="dmCategory"
            value={form.dmCategory || ''}
            onChange={(e) => set({ dmCategory: e.target.value })}
          >
            <option value="">— kategoria kanału panelu / pierwszego tematu —</option>
            {data.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <p className="v2-field-hint">
            Odpowiadaj w prywatnym kanale zgłoszenia. Bot przekazuje wiadomości na DM. Zamknięcie zapisuje
            rozmowę w kanale logów ticketów i usuwa kanał.
          </p>
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
            Lets staff see what a ticket is about before opening it — off by default since the message may be
            sensitive.
          </p>
        </div>

        <div className="v2-field">
          <label htmlFor="transcriptRetentionDays">
            Delete closed tickets after <span className="v2-field-hint">— days; 0 = keep forever</span>
          </label>
          <input
            id="transcriptRetentionDays"
            type="number"
            min={0}
            max={3650}
            value={form.transcriptRetentionDays}
            onChange={(e) => set({ transcriptRetentionDays: Number(e.target.value) })}
          />
          <p className="v2-field-hint">
            A daily job removes closed tickets and every message in them once they are older than this. Open
            tickets are never affected.
          </p>
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
