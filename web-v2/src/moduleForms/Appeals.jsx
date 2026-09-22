import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getModuleConfig, saveModuleConfig, ApiError } from '../api.js';
import { useApiData } from '../useApiData.js';

const QUESTION_SLOTS = 5;

function padQuestions(questions) {
  const padded = [...questions];
  while (padded.length < QUESTION_SLOTS) padded.push('');
  return padded.slice(0, QUESTION_SLOTS);
}

export default function Appeals() {
  const { guildId } = useParams();
  const { data, loading, error } = useApiData(() => getModuleConfig(guildId, 'appeals'), [guildId]);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data) setForm({ ...data.config, questions: padQuestions(data.config.questions) });
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
          `Couldn't load Ban appeals settings (${error.message}).`
        )}
      </p>
    );
  }

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const setQuestion = (i, value) =>
    setForm((f) => ({ ...f, questions: f.questions.map((q, idx) => (idx === i ? value : q)) }));

  async function onSave(e) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    try {
      const { config } = await saveModuleConfig(guildId, 'appeals', form);
      setForm({ ...config, questions: padQuestions(config.questions) });
      setSaved(true);
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <h1 className="v2-section-title">Ban appeals</h1>
      <p className="v2-field-hint">
        When a member is banned, Sylo DMs them a private link to an appeal form on this dashboard. Their
        answers show up on the <a href={`/guilds/${guildId}/appeals`}>Appeals tab</a>. The decision (and, on
        accept, a single-use rejoin invite) is always shown on that same link when they reopen it — Discord
        won't let a bot DM someone it no longer shares a server with, so the page is the reliable channel.
        {!data.dashboardUrlSet ? (
          <>
            {' '}
            <span className="v2-row-warn">
              Set <code>DASHBOARD_URL</code> to a URL your members can reach — without it the appeal link
              cannot be built.
            </span>
          </>
        ) : null}
      </p>

      <form onSubmit={onSave}>
        <div className="v2-field">
          <label>
            Appeal form questions <span className="v2-field-hint">— 1 to 5; blank rows are dropped</span>
          </label>
          {form.questions.map((q, i) => (
            <input
              key={i}
              type="text"
              maxLength={200}
              placeholder={`Question ${i + 1}${i === 0 ? ' (required)' : ' (optional)'}`}
              value={q}
              onChange={(e) => setQuestion(i, e.target.value)}
            />
          ))}
        </div>

        <div className="v2-field">
          <label className="v2-check">
            <input
              type="checkbox"
              checked={form.autoUnbanOnAccept}
              onChange={(e) => set({ autoUnbanOnAccept: e.target.checked })}
            />
            Lift the ban automatically when an appeal is accepted
          </label>
        </div>

        <div className="v2-field">
          <label htmlFor="reviewChannelId">
            Staff review channel{' '}
            <span className="v2-field-hint">— optional; gets new-appeal and decision notices</span>
          </label>
          <select
            id="reviewChannelId"
            value={form.reviewChannelId}
            onChange={(e) => set({ reviewChannelId: e.target.value })}
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
          <label htmlFor="cooldownDays">Cooldown after a denied appeal (days, 0 = allow immediately)</label>
          <input
            id="cooldownDays"
            type="number"
            min={0}
            max={90}
            value={form.cooldownDays}
            onChange={(e) => set({ cooldownDays: Number(e.target.value) })}
          />
        </div>

        <div className="v2-field">
          <label htmlFor="appealMessage">
            Extra line in the ban DM <span className="v2-field-hint">— optional</span>
          </label>
          <textarea
            id="appealMessage"
            rows={2}
            maxLength={1000}
            placeholder="e.g. Appeals are reviewed within 48 hours."
            value={form.appealMessage}
            onChange={(e) => set({ appealMessage: e.target.value })}
          />
        </div>

        <div className="v2-field">
          <label htmlFor="appealServerInvite">
            Appeals server invite <span className="v2-field-hint">— optional</span>
          </label>
          <input
            id="appealServerInvite"
            type="text"
            maxLength={100}
            placeholder="https://discord.gg/…"
            value={form.appealServerInvite}
            onChange={(e) => set({ appealServerInvite: e.target.value })}
          />
          <p className="v2-field-hint">
            A permanent invite to another server Sylo is in. If the banned user joins it, Sylo shares a server
            with them and can also DM the decision.
          </p>
        </div>

        <div className="v2-section-gap">
          <button type="submit" className="v2-btn-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          {saved ? <span className="v2-field-hint"> Saved.</span> : null}
        </div>
      </form>

      <p className="v2-field-hint v2-section-gap">
        Sylo needs <strong>Ban Members</strong> to read ban reasons and auto-unban on accept, and{' '}
        <strong>Create Invite</strong> to mint the rejoin link. The review channel post always includes the
        appeal link so you can share it manually if a member's DMs are closed.
      </p>
    </>
  );
}
