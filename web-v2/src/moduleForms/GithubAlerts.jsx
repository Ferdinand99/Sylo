import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  getGithubWatches,
  createGithubWatch,
  updateGithubWatch,
  deleteGithubWatch,
  toggleGithubWatch,
  regenGithubSecret,
  ApiError,
} from '../api.js';

const BLANK = { repo: '', channelId: '', roleId: '', changelogPath: '', events: ['push', 'release'] };

function WatchForm({ initial, channels, roles, eventTypes, onSave, onCancel, saving }) {
  const [repo, setRepo] = useState(initial.repo);
  const [channelId, setChannelId] = useState(initial.channelId);
  const [roleId, setRoleId] = useState(initial.roleId);
  const [changelogPath, setChangelogPath] = useState(initial.changelogPath);
  const [events, setEvents] = useState(new Set(initial.events));

  function toggleEvent(key) {
    setEvents((e) => {
      const next = new Set(e);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function submit(e) {
    e.preventDefault();
    onSave({ repo, channelId, roleId, changelogPath, events: [...events] });
  }

  return (
    <form onSubmit={submit} className="v2-section-gap">
      <div className="v2-field">
        <label>Repo</label>
        <input
          type="text"
          placeholder="owner/repo"
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          required
        />
        <p className="v2-field-hint">Either owner/repo or the full github.com/owner/repo URL.</p>
      </div>

      <div className="v2-field">
        <label>Post in</label>
        <select value={channelId} onChange={(e) => setChannelId(e.target.value)} required>
          <option value="">— select a channel —</option>
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              #{c.name}
            </option>
          ))}
        </select>
      </div>

      <div className="v2-field">
        <label>
          Ping role <span className="v2-field-hint">— optional</span>
        </label>
        <select value={roleId} onChange={(e) => setRoleId(e.target.value)}>
          <option value="">— none —</option>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </div>

      <div className="v2-field">
        <label>What to post</label>
        {eventTypes.map((e) => (
          <label className="v2-check" key={e.key}>
            <input type="checkbox" checked={events.has(e.key)} onChange={() => toggleEvent(e.key)} />
            {e.label}
          </label>
        ))}
      </div>

      <div className="v2-field">
        <label>
          Changelog file path <span className="v2-field-hint">— optional</span>
        </label>
        <input
          type="text"
          placeholder="CHANGELOG.md"
          value={changelogPath}
          onChange={(e) => setChangelogPath(e.target.value)}
        />
        <p className="v2-field-hint">
          When a push changes this exact file, Sylo posts only its newest entry — independent of the event
          checkboxes above. Public repos only.
        </p>
      </div>

      <div className="v2-field-row">
        <button type="submit" className="v2-btn-primary" disabled={saving}>
          Save &amp; close
        </button>
        <button type="button" className="v2-btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function WebhookDetails({ watch, guildId, onRegenerated }) {
  const [busy, setBusy] = useState(false);

  async function regen() {
    if (
      !confirm(
        "Generate a new secret? The old one (and the old value in GitHub's webhook settings) stops working immediately."
      )
    )
      return;
    setBusy(true);
    try {
      const { watch: updated } = await regenGithubSecret(guildId, watch.id);
      onRegenerated(updated);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="v2-section-gap">
      <p className="v2-field-hint">
        In this repo on GitHub: Settings → Webhooks → Add webhook. Content type application/json, events{' '}
        <strong>Send me everything</strong> — Sylo only posts the checked event types regardless.
      </p>
      <div className="v2-field">
        <label>Payload URL</label>
        <input
          type="text"
          readOnly
          value={watch.webhookUrl || '— DASHBOARD_URL not set —'}
          onClick={(e) => e.target.select()}
        />
      </div>
      <div className="v2-field">
        <label>Secret</label>
        <input type="text" readOnly value={watch.secret} onClick={(e) => e.target.select()} />
      </div>
      <button type="button" className="v2-btn-ghost" onClick={regen} disabled={busy}>
        Regenerate secret
      </button>
    </div>
  );
}

export default function GithubAlerts() {
  const { guildId } = useParams();
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const [notice, setNotice] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [webhookOpenId, setWebhookOpenId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);

  function load() {
    return getGithubWatches(guildId)
      .then((data) => setState({ loading: false, data, error: null }))
      .catch((error) => setState({ loading: false, data: null, error }));
  }

  useEffect(() => {
    load();
  }, [guildId]);

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
          `Couldn't load GitHub alerts settings (${state.error.message}).`
        )}
      </p>
    );
  }

  const d = state.data;

  async function onCreate(body) {
    setSaving(true);
    setNotice(null);
    try {
      await createGithubWatch(guildId, body);
      setCreating(false);
      await load();
    } catch (err) {
      setNotice(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function onEdit(id, body) {
    setSaving(true);
    setNotice(null);
    try {
      await updateGithubWatch(guildId, id, body);
      setEditingId(null);
      await load();
    } catch (err) {
      setNotice(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function onDelete(id) {
    if (!confirm('Remove this repo watch? Its webhook URL will stop working.')) return;
    try {
      await deleteGithubWatch(guildId, id);
      await load();
    } catch (err) {
      setNotice(err.message);
    }
  }

  async function onToggle(id) {
    try {
      await toggleGithubWatch(guildId, id);
      await load();
    } catch (err) {
      setNotice(err.message);
    }
  }

  return (
    <>
      <h1 className="v2-section-title">GitHub alerts</h1>
      <p className="v2-field-hint">
        Post GitHub activity from a repo straight to a channel — pushes, releases, issues, pull requests. Each
        repo gets its own webhook URL and secret to paste into that repo's Settings → Webhooks page.
      </p>
      {!d.dashboardUrlSet ? (
        <p className="v2-note">
          DASHBOARD_URL isn't set, so GitHub has no reachable address to send events to. Set it before adding
          a repo here.
        </p>
      ) : null}

      {notice ? <p className="v2-note">{notice}</p> : null}

      <div className="v2-group">
        <h2 className="v2-group-title">Watched repos ({d.watches.length})</h2>
        {d.watches.length === 0 ? (
          <p className="v2-note">None yet — add a repo to start posting its activity here.</p>
        ) : (
          <div className="v2-list">
            {d.watches.map((w) => (
              <div className="v2-row" key={w.id}>
                <div className="v2-row-main">
                  <h3>{w.repo}</h3>
                  <p>
                    #{d.channels.find((c) => c.id === w.channelId)?.name ?? w.channelId} · {w.events.length}{' '}
                    event type{w.events.length === 1 ? '' : 's'}
                    {w.roleId ? ` · pings @${d.roles.find((r) => r.id === w.roleId)?.name ?? w.roleId}` : ''}
                    {w.changelogPath ? ` · watching ${w.changelogPath}` : ''}
                  </p>

                  {editingId === w.id ? (
                    <WatchForm
                      initial={w}
                      channels={d.channels}
                      roles={d.roles}
                      eventTypes={d.eventTypes}
                      saving={saving}
                      onSave={(body) => onEdit(w.id, body)}
                      onCancel={() => setEditingId(null)}
                    />
                  ) : null}

                  {webhookOpenId === w.id ? (
                    <WebhookDetails
                      watch={w}
                      guildId={guildId}
                      onRegenerated={(updated) =>
                        setState((s) => ({
                          ...s,
                          data: {
                            ...s.data,
                            watches: s.data.watches.map((x) => (x.id === updated.id ? updated : x)),
                          },
                        }))
                      }
                    />
                  ) : null}
                </div>

                {editingId === w.id ? null : (
                  <div className="v2-field-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                    <span className={`v2-status-pill ${w.enabled ? 'completed' : 'pending'}`}>
                      {w.enabled ? 'on' : 'off'}
                    </span>
                    <button type="button" className="v2-btn-ghost" onClick={() => setEditingId(w.id)}>
                      Edit
                    </button>
                    <button
                      type="button"
                      className="v2-btn-ghost"
                      onClick={() => setWebhookOpenId(webhookOpenId === w.id ? null : w.id)}
                    >
                      Webhook setup
                    </button>
                    <button type="button" className="v2-btn-ghost" onClick={() => onToggle(w.id)}>
                      {w.enabled ? 'Pause' : 'Resume'}
                    </button>
                    <button type="button" className="v2-btn-ghost" onClick={() => onDelete(w.id)}>
                      Remove
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {creating ? (
        <div className="v2-group">
          <h2 className="v2-group-title">Add repository</h2>
          <WatchForm
            initial={BLANK}
            channels={d.channels}
            roles={d.roles}
            eventTypes={d.eventTypes}
            saving={saving}
            onSave={onCreate}
            onCancel={() => setCreating(false)}
          />
        </div>
      ) : (
        <button type="button" className="v2-btn-primary" onClick={() => setCreating(true)}>
          + Add repository
        </button>
      )}
    </>
  );
}
