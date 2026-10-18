import { useEffect, useState } from 'react';
import {
  getPersonalizer,
  getPersonalizerPresence,
  savePersonalizerIdentity,
  savePersonalizerPresence,
  getAnnouncement,
  savePersonalizerAnnouncement,
  clearPersonalizerAnnouncement,
} from '../api.js';
import { notify } from '../notify.js';
import LoadError from '../components/LoadError.jsx';
import { confirmDialog } from '../components/ConfirmDialog.jsx';
import { isDirty } from '../components/formEqual.js';
import { useUnsavedChangesGuard } from '../components/useUnsavedChangesGuard.js';

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
  // Three independent forms (identity, presence, announcement), each with its
  // own submit — what was last loaded/saved for each, to flag unsaved edits.
  const [saved, setSaved] = useState(null);
  const dirtyIdentity = isDirty(identity, saved?.identity);
  const dirtyPresence = isDirty(presence, saved?.presence);
  const dirtyAnnouncement = isDirty(announcement, saved?.announcement);
  useUnsavedChangesGuard(dirtyIdentity || dirtyPresence || dirtyAnnouncement);
  const markSaved = (patch) => setSaved((s) => ({ ...s, ...patch }));

  useEffect(() => {
    let cancelled = false;
    Promise.all([getPersonalizer(), getPersonalizerPresence(), getAnnouncement()])
      .then(([p, pr, a]) => {
        if (cancelled) return;
        setState({ loading: false, ...p, ...pr, announcement: a.announcement, error: null });
        const loadedIdentity = {
          username: p.bot?.username ?? '',
          avatarUrl: '',
          bannerUrl: '',
          resetAvatar: false,
        };
        const loadedAnnouncement = a.announcement || { title: '', body: '', severity: 'info' };
        setIdentity(loadedIdentity);
        setPresence(pr.presence);
        if (a.announcement) setAnnouncement(a.announcement);
        setSaved({ identity: loadedIdentity, presence: pr.presence, announcement: loadedAnnouncement });
      })
      .catch((error) => {
        if (!cancelled) setState((s) => ({ ...s, loading: false, error }));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.error) return <LoadError error={state.error} what="the bot personalizer" />;
  if (state.loading) return <p className="v2-state">Loading…</p>;

  async function onSaveIdentity(e) {
    e.preventDefault();
    setSaving(true);
    const sent = identity;
    try {
      const { done, failed } = await savePersonalizerIdentity(sent);
      if (done.length) notify(`Updated ${done.join(', ')}.`, 'info');
      if (failed.length) notify(`Failed: ${failed.join('; ')}.`);
      if (!done.length && !failed.length) notify('Nothing to change.', 'info');
      if (!failed.length) markSaved({ identity: sent });
    } catch (err) {
      notify(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function onSavePresence(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const { presence: savedPresence } = await savePersonalizerPresence(presence);
      setPresence(savedPresence);
      markSaved({ presence: savedPresence });
      notify('Presence updated.', 'info');
    } catch (err) {
      notify(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function onSaveAnnouncement(e) {
    e.preventDefault();
    setSaving(true);
    const sent = announcement;
    try {
      const { announcement: savedAnnouncement } = await savePersonalizerAnnouncement(sent);
      setState((s) => ({ ...s, announcement: savedAnnouncement }));
      markSaved({ announcement: sent });
      notify(
        savedAnnouncement ? 'Announcement published.' : 'Announcement cleared (title was blank).',
        'info'
      );
    } catch (err) {
      notify(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function onClearAnnouncement() {
    const ok = await confirmDialog({
      title: 'Clear the live announcement?',
      body: 'It disappears from every dashboard page for everyone straight away.',
      confirmLabel: 'Clear announcement',
    });
    if (!ok) return;
    setSaving(true);
    try {
      await clearPersonalizerAnnouncement();
      const blank = { title: '', body: '', severity: 'info' };
      setState((s) => ({ ...s, announcement: null }));
      setAnnouncement(blank);
      markSaved({ announcement: blank });
      notify('Announcement cleared.', 'info');
    } catch (err) {
      notify(err.message);
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
        <div className="v2-composer-actions">
          <button type="submit" className="v2-btn-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save identity'}
          </button>
          <span className="v2-composer-status" aria-live="polite">
            {dirtyIdentity ? 'Unsaved changes' : ''}
          </span>
        </div>
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
        <div className="v2-composer-actions">
          <button type="submit" className="v2-btn-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save presence'}
          </button>
          <span className="v2-composer-status" aria-live="polite">
            {dirtyPresence ? 'Unsaved changes' : ''}
          </span>
        </div>
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
        <div className="v2-composer-actions">
          <button type="submit" className="v2-btn-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Publish announcement'}
          </button>
          <span className="v2-composer-status" aria-live="polite">
            {dirtyAnnouncement ? 'Unpublished changes' : ''}
          </span>
          {state.announcement ? (
            <button
              type="button"
              className="v2-btn-danger v2-danger-push"
              disabled={saving}
              onClick={onClearAnnouncement}
            >
              Clear announcement
            </button>
          ) : null}
        </div>
      </form>
    </>
  );
}
