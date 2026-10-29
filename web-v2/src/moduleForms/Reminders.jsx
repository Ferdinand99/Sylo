import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  getReminders,
  createReminder,
  updateReminder,
  deleteReminder,
  toggleReminder,
  testReminder,
  setReminderPings,
} from '../api.js';
import { notify } from '../notify.js';
import LoadError from '../components/LoadError.jsx';
import { limitOf, useModuleLimits } from '../components/useModuleLimits.js';
import { confirmDialog } from '../components/ConfirmDialog.jsx';
import EmbedEditor from '../components/EmbedEditor.jsx';

function msToLocalInput(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function scheduleLabel(r, schedulePresets, weekdays) {
  if (r.mode === 'single') {
    return r.runAt ? `once, at ${new Date(r.runAt).toLocaleString()}` : 'once — no time set';
  }
  const preset = schedulePresets.find(([mins]) => Number(mins) === r.intervalMinutes);
  const every = preset ? preset[1].toLowerCase() : `every ${r.intervalMinutes}m`;
  const names = new Map(weekdays);
  const days =
    r.days.length === 7
      ? ''
      : ` · ${r.days
          .slice()
          .sort((a, b) => a - b)
          .map((n) => names.get(n))
          .join('/')}`;
  return `${every}${days}`;
}

function ReminderForm({
  initial,
  guildId,
  channels,
  schedulePresets,
  weekdays,
  minIntervalMinutes,
  maxIntervalMinutes,
  onSave,
  onCancel,
  saving,
}) {
  const limits = useModuleLimits('reminders');
  const embed0 = initial.spec?.embeds?.[0] || null;
  const [name, setName] = useState(initial.name);
  const [channelId, setChannelId] = useState(initial.channelId);
  const [msgType, setMsgType] = useState(embed0 ? 'embed' : 'text');
  const [content, setContent] = useState(embed0 ? '' : initial.spec?.content || '');
  const [embedSpec, setEmbedSpec] = useState(() => ({
    ...(embed0 || {}),
    content: embed0 ? initial.spec?.content || '' : '',
  }));
  const [mode, setMode] = useState(initial.mode === 'single' ? 'single' : 'multiple');
  const [runAt, setRunAt] = useState(msToLocalInput(initial.runAt));
  const [intervalMinutes, setIntervalMinutes] = useState(initial.intervalMinutes);
  const [enableStart, setEnableStart] = useState(Boolean(initial.startAt));
  const [startAt, setStartAt] = useState(msToLocalInput(initial.startAt));
  const [enableEnd, setEnableEnd] = useState(Boolean(initial.endAt));
  const [endAt, setEndAt] = useState(msToLocalInput(initial.endAt));
  const [days, setDays] = useState(new Set(initial.days.length ? initial.days : [0, 1, 2, 3, 4, 5, 6]));
  const [testing, setTesting] = useState(false);

  function toggleDay(n) {
    setDays((d) => {
      const next = new Set(d);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
  }

  function body() {
    return {
      name,
      channelId,
      msgType,
      content,
      embedSpec,
      mode,
      runAt,
      intervalMinutes,
      enableStart,
      startAt,
      enableEnd,
      endAt,
      days: [...days],
    };
  }

  function submit(e) {
    e.preventDefault();
    onSave(body());
  }

  async function onTest() {
    setTesting(true);
    try {
      await testReminder(guildId, body());
      notify('Test message sent to the channel.', 'info');
    } catch (err) {
      notify(err.message);
    } finally {
      setTesting(false);
    }
  }

  return (
    <form onSubmit={submit} className="v2-section-gap">
      <div className="v2-field">
        <label>
          Name <span className="v2-field-hint">— shown on the dashboard only</span>
        </label>
        <input
          type="text"
          maxLength={limitOf(limits, 'name').maxLength}
          placeholder="my new reminder"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

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
        <label>Message</label>
        <div className="v2-tabs">
          <button
            type="button"
            className={`v2-tab${msgType === 'text' ? ' is-active' : ''}`}
            onClick={() => setMsgType('text')}
          >
            Text message
          </button>
          <button
            type="button"
            className={`v2-tab${msgType === 'embed' ? ' is-active' : ''}`}
            onClick={() => setMsgType('embed')}
          >
            Embed message
          </button>
        </div>

        {msgType === 'text' ? (
          <textarea
            rows={3}
            maxLength={limitOf(limits, 'content').maxLength}
            placeholder="Hey, I'm a reminder!"
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
        ) : (
          <EmbedEditor
            spec={embedSpec}
            onChange={setEmbedSpec}
            content
            limits={{ content: limitOf(limits, 'content') }}
            placeholders={{ content: 'Optional message above the embed…', title: 'Title' }}
          />
        )}

        <div className="v2-field-row u-mt-2">
          <button type="button" className="v2-btn-ghost" onClick={onTest} disabled={testing || !channelId}>
            {testing ? 'Sending…' : 'Send test message'}
          </button>
        </div>
      </div>

      <div className="v2-field">
        <label>Reminder</label>
        <div className="v2-tabs">
          <button
            type="button"
            className={`v2-tab${mode === 'single' ? ' is-active' : ''}`}
            onClick={() => setMode('single')}
          >
            Single
          </button>
          <button
            type="button"
            className={`v2-tab${mode === 'multiple' ? ' is-active' : ''}`}
            onClick={() => setMode('multiple')}
          >
            Multiple
          </button>
        </div>

        {mode === 'single' ? (
          <div className="v2-field u-mt-2">
            <label>Send once at</label>
            <input
              type="datetime-local"
              value={runAt}
              onChange={(e) => setRunAt(e.target.value)}
              style={{ maxWidth: '220px' }}
            />
          </div>
        ) : (
          <div className="u-mt-2">
            <div className="v2-field">
              <label>Every</label>
              <select
                value={intervalMinutes}
                onChange={(e) => setIntervalMinutes(Number(e.target.value))}
                style={{ maxWidth: '180px' }}
              >
                {schedulePresets.map(([mins, label]) => (
                  <option key={mins} value={mins}>
                    {label}
                  </option>
                ))}
              </select>
              <p className="v2-field-hint">
                {minIntervalMinutes}–{maxIntervalMinutes} minutes.
              </p>
            </div>

            <div className="v2-field-row">
              <label className="v2-check">
                <input
                  type="checkbox"
                  checked={enableStart}
                  onChange={(e) => setEnableStart(e.target.checked)}
                />
                Add start time
              </label>
              <input
                type="datetime-local"
                value={startAt}
                disabled={!enableStart}
                onChange={(e) => setStartAt(e.target.value)}
                style={{ maxWidth: '220px' }}
              />
            </div>
            <div className="v2-field-row">
              <label className="v2-check">
                <input type="checkbox" checked={enableEnd} onChange={(e) => setEnableEnd(e.target.checked)} />
                Add end time
              </label>
              <input
                type="datetime-local"
                value={endAt}
                disabled={!enableEnd}
                onChange={(e) => setEndAt(e.target.value)}
                style={{ maxWidth: '220px' }}
              />
            </div>

            <div className="v2-field">
              <label>Day of the week</label>
              <div className="v2-field-row">
                {weekdays.map(([n, label]) => (
                  <label className="v2-check" key={n}>
                    <input type="checkbox" checked={days.has(n)} onChange={() => toggleDay(n)} />
                    {label}
                  </label>
                ))}
              </div>
            </div>
          </div>
        )}
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
  name: '',
  channelId: '',
  spec: { content: '', embeds: [] },
  mode: 'multiple',
  intervalMinutes: 60,
  days: [0, 1, 2, 3, 4, 5, 6],
  startAt: null,
  endAt: null,
  runAt: null,
};

export default function Reminders() {
  const { guildId } = useParams();
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const [editingId, setEditingId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);

  function load() {
    return getReminders(guildId)
      .then((data) => setState({ loading: false, data, error: null }))
      .catch((error) => setState({ loading: false, data: null, error }));
  }

  useEffect(() => {
    load();
  }, [guildId]);

  if (state.error) return <LoadError error={state.error} what="Reminders" />;
  if (state.loading) return <p className="v2-state">Loading…</p>;

  const d = state.data;

  async function onCreate(body) {
    setSaving(true);
    try {
      await createReminder(guildId, body);
      setCreating(false);
      await load();
    } catch (err) {
      notify(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function onEdit(id, body) {
    setSaving(true);
    try {
      await updateReminder(guildId, id, body);
      setEditingId(null);
      await load();
    } catch (err) {
      notify(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function onPings(allowPings) {
    try {
      await setReminderPings(guildId, allowPings);
      await load();
    } catch (err) {
      notify(err.message);
    }
  }

  async function onDelete(id) {
    const ok = await confirmDialog({
      title: 'Delete this reminder?',
      body: "It won't be posted again. This can't be undone.",
      confirmLabel: 'Delete reminder',
    });
    if (!ok) return;
    try {
      await deleteReminder(guildId, id);
      await load();
    } catch (err) {
      notify(err.message);
    }
  }

  async function onToggle(id) {
    try {
      await toggleReminder(guildId, id);
      await load();
    } catch (err) {
      notify(err.message);
    }
  }

  const formProps = {
    guildId,
    channels: d.channels,
    schedulePresets: d.schedulePresets,
    weekdays: d.weekdays,
    minIntervalMinutes: d.minIntervalMinutes,
    maxIntervalMinutes: d.maxIntervalMinutes,
    saving,
  };

  return (
    <>
      <h1 className="v2-section-title">Reminders</h1>
      <p className="v2-field-hint">
        Post a text or embed message to a channel — once, or on a repeating schedule.
      </p>

      <div className="v2-group">
        <h2 className="v2-group-title">Pings</h2>
        <div className="v2-field-row">
          <label className="v2-check">
            <input
              type="checkbox"
              checked={d.allowPings === true}
              onChange={(e) => onPings(e.target.checked)}
            />
            Let reminders ping @everyone, @here and roles
          </label>
        </div>
        <p className="v2-field-hint">
          When off, mentions in a reminder are shown but nobody is notified. It is off for new servers. Only
          the server owner or someone with Manage Server can change this.
        </p>
      </div>

      <div className="v2-group">
        <h2 className="v2-group-title">Your reminders ({d.reminders.length})</h2>
        {d.reminders.length === 0 ? (
          <p className="v2-note">None yet — create one below.</p>
        ) : (
          <div className="v2-list">
            {d.reminders.map((r) => {
              const channel = d.channels.find((c) => c.id === r.channelId);
              return (
                <div className="v2-row" key={r.id}>
                  <div className="v2-row-main">
                    <h3>{r.name}</h3>
                    <p>
                      #{channel ? channel.name : r.channelId} ·{' '}
                      {scheduleLabel(r, d.schedulePresets, d.weekdays)}
                    </p>
                    {editingId === r.id ? (
                      <ReminderForm
                        initial={r}
                        {...formProps}
                        onSave={(body) => onEdit(r.id, body)}
                        onCancel={() => setEditingId(null)}
                      />
                    ) : null}
                  </div>
                  {editingId === r.id ? null : (
                    <div className="v2-field-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                      <span className={`v2-status-pill ${r.enabled ? 'completed' : 'pending'}`}>
                        {r.enabled ? 'on' : 'off'}
                      </span>
                      <button type="button" className="v2-btn-ghost" onClick={() => setEditingId(r.id)}>
                        Edit
                      </button>
                      <button type="button" className="v2-btn-ghost" onClick={() => onToggle(r.id)}>
                        {r.enabled ? 'Pause' : 'Resume'}
                      </button>
                      <button
                        type="button"
                        className="v2-btn-danger v2-danger-sep"
                        onClick={() => onDelete(r.id)}
                      >
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
          <h2 className="v2-group-title">New reminder</h2>
          <ReminderForm
            initial={BLANK}
            {...formProps}
            onSave={onCreate}
            onCancel={() => setCreating(false)}
          />
        </div>
      ) : (
        <button type="button" className="v2-btn-primary" onClick={() => setCreating(true)}>
          + New reminder
        </button>
      )}
    </>
  );
}
