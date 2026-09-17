import { useEffect, useState } from 'react';
import {
  getPersonalizer,
  getPersonalizerPresence,
  savePersonalizerIdentity,
  savePersonalizerPresence,
  ApiError,
} from '../api.js';

export default function Personalizer() {
  const [state, setState] = useState({
    loading: true,
    bot: null,
    presence: null,
    types: [],
    statuses: [],
    error: null,
  });
  const [identity, setIdentity] = useState({
    username: '',
    avatarUrl: '',
    bannerUrl: '',
    resetAvatar: false,
  });
  const [presence, setPresence] = useState({ status: 'online', type: 'Listening', text: '' });
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getPersonalizer(), getPersonalizerPresence()])
      .then(([p, pr]) => {
        if (cancelled) return;
        setState({ loading: false, ...p, ...pr, error: null });
        setIdentity({ username: p.bot?.username ?? '', avatarUrl: '', bannerUrl: '', resetAvatar: false });
        setPresence(pr.presence);
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
            Your session expired — <a href="/auth/discord/login">log in again</a>.
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
    </>
  );
}
