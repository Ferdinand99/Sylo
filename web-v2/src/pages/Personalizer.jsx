import { useEffect, useState } from 'react';
import {
  getPersonalizer,
  getPersonalizerPresence,
  savePersonalizerIdentity,
  savePersonalizerPresence,
  getAnnouncement,
  savePersonalizerAnnouncement,
  clearPersonalizerAnnouncement,
  ApiError,
} from '../api.js';

export default function Personalizer() {
  const [state, setState] = useState({
    loading: true,
    bot: null,
    presence: null,
    types: [],
    statuses: [],
    announcementSeverities: [],
    announcement: null,
    error: null,
  });
  const [identity, setIdentity] = useState({
    username: '',
    avatarUrl: '',
    bannerUrl: '',
    resetAvatar: false,
  });
  const [presence, setPresence] = useState({ status: 'online', type: 'Listening', text: '' });
  const [announcement, setAnnouncement] = useState({ title: '', body: '', severity: 'info' });
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getPersonalizer(), getPersonalizerPresence(), getAnnouncement()])
      .then(([p, pr, a]) => {
        if (cancelled) return;
        setState({ loading: false, ...p, ...pr, announcement: a.announcement, error: null });
        setIdentity({ username: p.bot?.username ?? '', avatarUrl: '', bannerUrl: '', resetAvatar: false });
        setPresence(pr.presence);
        if (a.announcement) setAnnouncement(a.announcement);
      })
      .catch((error) => {
        if (!cancelled) setState((s) => ({ ...s, loading: false, error }));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.loading) return <p className="v2-state">Loading…</p>;

  if (state.error) {
    const notAuthed = state.error instanceof ApiError && state.error.notAuthenticated;
    return (
      <p className="v2-state">
        {notAuthed ? (
          <>
            Your session expired — <a href="/auth/login">log in again</a>.
          </>
        ) : (
          `Couldn't load the bot personalizer (${state.error.message}).`
        )}
      </p>
    );
  }

  async function onSaveIdentity(e) {
    e.preventDefault();
    setSaving(true);
    setNotice(null);
    try {
      const { done, failed } = await savePersonalizerIdentity(identity);
      setNotice(
        [
          done.length ? `Updated ${done.join(', ')}.` : '',
          failed.length ? `Failed: ${failed.join('; ')}.` : '',
        ]
          .filter(Boolean)
          .join(' ') || 'Nothing to change.'
      );
    } catch (err) {
      setNotice(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function onSavePresence(e) {
    e.preventDefault();
    setSaving(true);
    setNotice(null);
    try {
      const { presence: saved } = await savePersonalizerPresence(presence);
      setPresence(saved);
      setNotice('Presence updated.');
    } catch (err) {
      setNotice(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function onSaveAnnouncement(e) {
    e.preventDefault();
    setSaving(true);
    setNotice(null);
    try {
      const { announcement: saved } = await savePersonalizerAnnouncement(announcement);
      setState((s) => ({ ...s, announcement: saved }));
      setNotice(saved ? 'Announcement published.' : 'Announcement cleared (title was blank).');
    } catch (err) {
      setNotice(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function onClearAnnouncement() {
    setSaving(true);
    setNotice(null);
    try {
      await clearPersonalizerAnnouncement();
      setState((s) => ({ ...s, announcement: null }));
      setAnnouncement({ title: '', body: '', severity: 'info' });
      setNotice('Announcement cleared.');
    } catch (err) {
      setNotice(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <h1 className="v2-section-title">Bot Personalizer</h1>

      {!state.bot ? (
        <p className="v2-note">The bot isn't connected yet — try again in a moment.</p>
      ) : (
        <div className="v2-hero">
          <img src={state.bot.avatar} alt="" />
          <div>
            <h2>{state.bot.tag}</h2>
            <p>Bot-wide identity — affects every server Sylo is in.</p>
          </div>
        </div>
      )}

      {notice ? <p className="v2-note">{notice}</p> : null}

      <form onSubmit={onSaveIdentity}>
        <div className="v2-field">
          <label htmlFor="username">Username</label>
          <input
            id="username"
            type="text"
            value={identity.username}
            onChange={(e) => setIdentity((f) => ({ ...f, username: e.target.value }))}
          />
          <p className="v2-field-hint">2–32 characters. Discord limits this to ~2 changes/hour.</p>
        </div>
        <div className="v2-field">
          <label htmlFor="avatarUrl">Avatar URL</label>
          <input
            id="avatarUrl"
            type="url"
            placeholder="https://…"
            value={identity.avatarUrl}
            disabled={identity.resetAvatar}
            onChange={(e) => setIdentity((f) => ({ ...f, avatarUrl: e.target.value }))}
          />
          <label className="v2-field-hint">
            <input
              type="checkbox"
              checked={identity.resetAvatar}
              onChange={(e) => setIdentity((f) => ({ ...f, resetAvatar: e.target.checked }))}
            />{' '}
            Reset avatar to Discord's default instead
          </label>
        </div>
        <div className="v2-field">
          <label htmlFor="bannerUrl">Banner URL</label>
          <input
            id="bannerUrl"
            type="url"
            placeholder="https://…"
            value={identity.bannerUrl}
            onChange={(e) => setIdentity((f) => ({ ...f, bannerUrl: e.target.value }))}
          />
        </div>
        <button type="submit" className="v2-btn-primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save identity'}
        </button>
      </form>

      <h2 className="v2-group-title v2-section-gap">Presence</h2>
      <form onSubmit={onSavePresence}>
        <div className="v2-field">
          <label htmlFor="pstatus">Status</label>
          <select
            id="pstatus"
            value={presence.status}
            onChange={(e) => setPresence((p) => ({ ...p, status: e.target.value }))}
          >
            {state.statuses.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="v2-field">
          <label htmlFor="ptype">Activity type</label>
          <select
            id="ptype"
            value={presence.type}
            onChange={(e) => setPresence((p) => ({ ...p, type: e.target.value }))}
          >
            {state.types.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div className="v2-field">
          <label htmlFor="ptext">Text</label>
          <input
            id="ptext"
            type="text"
            value={presence.text}
            onChange={(e) => setPresence((p) => ({ ...p, text: e.target.value }))}
          />
        </div>
        <button type="submit" className="v2-btn-primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save presence'}
        </button>
      </form>

      <h2 className="v2-group-title v2-section-gap">Announcement</h2>
      <p className="v2-field-hint">
        Shown to everyone signed in to the dashboard, on every page — e.g. to explain an incident or outage.{' '}
        <strong>Critical</strong> announcements have no dismiss button and stay until you clear them.
      </p>
      {state.announcement ? (
        <p className="v2-note">
          Currently live: <strong>{state.announcement.title}</strong> ({state.announcement.severity})
        </p>
      ) : null}
      <form onSubmit={onSaveAnnouncement}>
        <div className="v2-field">
          <label htmlFor="annTitle">Title</label>
          <input
            id="annTitle"
            type="text"
            maxLength={200}
            placeholder="e.g. Scheduled maintenance tonight"
            value={announcement.title}
            onChange={(e) => setAnnouncement((a) => ({ ...a, title: e.target.value }))}
          />
        </div>
        <div className="v2-field">
          <label htmlFor="annBody">Message</label>
          <textarea
            id="annBody"
            rows={3}
            maxLength={2000}
            placeholder="Optional details"
            value={announcement.body}
            onChange={(e) => setAnnouncement((a) => ({ ...a, body: e.target.value }))}
          />
        </div>
        <div className="v2-field">
          <label htmlFor="annSeverity">Severity</label>
          <select
            id="annSeverity"
            value={announcement.severity}
            onChange={(e) => setAnnouncement((a) => ({ ...a, severity: e.target.value }))}
          >
            {state.announcementSeverities.map((s) => (
              <option key={s} value={s}>
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="v2-btn-primary" disabled={saving}>
          {saving ? 'Saving…' : 'Publish announcement'}
        </button>{' '}
        {state.announcement ? (
          <button type="button" className="v2-btn-ghost" disabled={saving} onClick={onClearAnnouncement}>
            Clear
          </button>
        ) : null}
      </form>
    </>
  );
}
