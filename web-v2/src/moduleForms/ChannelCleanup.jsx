import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  getCleanupSchedules,
  createCleanupSchedule,
  updateCleanupSchedule,
  deleteCleanupSchedule,
  toggleCleanupSchedule,
  ApiError,
} from '../api.js';

function dayLabel(days, weekdays) {
  if (days.length === 7) return 'every day';
  const names = new Map(weekdays);
  return days
    .slice()
    .sort((a, b) => a - b)
    .map((n) => names.get(n))
    .join('/');
}

function ageLabel(hours) {
  return hours % 24 === 0 ? `${hours / 24}d` : `${hours}h`;
}

function ScheduleForm({ initial, channels, weekdays, maxAgeHoursCap, onSave, onCancel, saving }) {
  const [channelId, setChannelId] = useState(initial.channelId);
  const [days, setDays] = useState(new Set(initial.days));
  const [timeHhmm, setTimeHhmm] = useState(initial.timeHhmm);
  const [maxAgeHours, setMaxAgeHours] = useState(initial.maxAgeHours);
  const [skipPinned, setSkipPinned] = useState(initial.skipPinned);

  function toggleDay(n) {
    setDays((d) => {
      const next = new Set(d);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
  }

  function submit(e) {
    e.preventDefault();
    onSave({ channelId, days: [...days], timeHhmm, maxAgeHours, skipPinned });
  }

  return (
    <form onSubmit={submit} className="v2-section-gap">
      <div className="v2-field">
        <label>Channel</label>
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
        <label>Run on</label>
        <div className="v2-field-row">
          {weekdays.map(([n, label]) => (
            <label className="v2-check" key={n}>
              <input type="checkbox" checked={days.has(n)} onChange={() => toggleDay(n)} />
              {label}
            </label>
          ))}
        </div>
      </div>

      <div className="v2-field">
        <label>At (server local time)</label>
        <input
          type="time"
          value={timeHhmm}
          onChange={(e) => setTimeHhmm(e.target.value)}
          required
          style={{ maxWidth: '140px' }}
        />
      </div>

      <div className="v2-field">
        <label>
          Delete messages older than{' '}
          <span className="v2-field-hint">hours ({maxAgeHoursCap} = 90 days max)</span>
        </label>
        <input
          type="number"
          min={1}
          max={maxAgeHoursCap}
          value={maxAgeHours}
          onChange={(e) => setMaxAgeHours(Number(e.target.value))}
          required
          style={{ maxWidth: '120px' }}
        />
      </div>

      <div className="v2-field">
        <label className="v2-check">
          <input type="checkbox" checked={skipPinned} onChange={(e) => setSkipPinned(e.target.checked)} />
          Never delete pinned messages
        </label>
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

const BLANK = {
  channelId: '',
  days: [0, 1, 2, 3, 4, 5, 6],
  timeHhmm: '03:00',
  maxAgeHours: 24,
  skipPinned: true,
};

export default function ChannelCleanup() {
  const { guildId } = useParams();
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const [notice, setNotice] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);

  function load() {
    return getCleanupSchedules(guildId)
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
          `Couldn't load Channel cleanup settings (${state.error.message}).`
        )}
      </p>
    );
  }

  const d = state.data;

  async function onCreate(body) {
    setSaving(true);
    setNotice(null);
    try {
      await createCleanupSchedule(guildId, body);
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
      await updateCleanupSchedule(guildId, id, body);
      setEditingId(null);
      await load();
    } catch (err) {
      setNotice(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function onDelete(id) {
    if (!confirm('Delete this schedule?')) return;
    try {
      await deleteCleanupSchedule(guildId, id);
      await load();
    } catch (err) {
      setNotice(err.message);
    }
  }

  async function onToggle(id) {
    try {
      await toggleCleanupSchedule(guildId, id);
      await load();
    } catch (err) {
      setNotice(err.message);
    }
  }

  return (
    <>
      <h1 className="v2-section-title">Channel cleanup</h1>
      <p className="v2-field-hint">
        Auto-delete messages older than a threshold from a channel, on a weekly schedule you pick. Needs{' '}
        <strong>Manage Messages</strong> in the target channel.
      </p>

      {notice ? <p className="v2-note">{notice}</p> : null}

      <div className="v2-group">
        <h2 className="v2-group-title">Your schedules ({d.schedules.length})</h2>
        {d.schedules.length === 0 ? (
          <p className="v2-note">None yet — create one to start cleaning up a channel.</p>
        ) : (
          <div className="v2-list">
            {d.schedules.map((s) => {
              const channel = d.channels.find((c) => c.id === s.channelId);
              return (
                <div className="v2-row" key={s.id}>
                  <div className="v2-row-main">
                    <h3>#{channel ? channel.name : s.channelId}</h3>
                    <p>
                      {dayLabel(s.days, d.weekdays)} at {s.timeHhmm} · older than {ageLabel(s.maxAgeHours)}
                      {s.lastRunDate ? ` · last ran ${s.lastRunDate}` : ''}
                      {s.lastRunCount ? ` (${s.lastRunCount} deleted)` : ''}
                    </p>
                    {editingId === s.id ? (
                      <ScheduleForm
                        initial={s}
                        channels={d.channels}
                        weekdays={d.weekdays}
                        maxAgeHoursCap={d.maxAgeHoursCap}
                        saving={saving}
                        onSave={(body) => onEdit(s.id, body)}
                        onCancel={() => setEditingId(null)}
                      />
                    ) : null}
                  </div>
                  {editingId === s.id ? null : (
                    <div className="v2-field-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                      <span className={`v2-status-pill ${s.enabled ? 'completed' : 'pending'}`}>
                        {s.enabled ? 'on' : 'off'}
                      </span>
                      <button type="button" className="v2-btn-ghost" onClick={() => setEditingId(s.id)}>
                        Edit
                      </button>
                      <button type="button" className="v2-btn-ghost" onClick={() => onToggle(s.id)}>
                        {s.enabled ? 'Pause' : 'Resume'}
                      </button>
                      <button type="button" className="v2-btn-ghost" onClick={() => onDelete(s.id)}>
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {creating ? (
        <div className="v2-group">
          <h2 className="v2-group-title">New schedule</h2>
          <ScheduleForm
            initial={BLANK}
            channels={d.channels}
            weekdays={d.weekdays}
            maxAgeHoursCap={d.maxAgeHoursCap}
            saving={saving}
            onSave={onCreate}
            onCancel={() => setCreating(false)}
          />
        </div>
      ) : (
        <button type="button" className="v2-btn-primary" onClick={() => setCreating(true)}>
          + New schedule
        </button>
      )}
    </>
  );
}
