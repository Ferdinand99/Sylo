import { useEffect, useId, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getAuditChange, getAuditLog, getMemberNames, undoAuditChange } from '../api.js';
import { useOverview } from '../OverviewContext.jsx';
import Breadcrumb, { peopleCrumb } from '../components/Breadcrumb.jsx';
import Callout from '../components/Callout.jsx';
import ConfigDiff from '../components/ConfigDiff.jsx';
import LoadError from '../components/LoadError.jsx';
import { confirmDialog } from '../components/ConfirmDialog.jsx';
import { labelFor } from '../configDiff.js';
import { notify } from '../notify.js';
import { formatCount } from '../util.js';
import Reveal from '../components/Reveal.jsx';
import Time from '../components/Time.jsx';

// Plain names for the action keys that are not "module:<id>".
const ACTION_LABELS = {
  'settings:server': 'Server settings',
  'moderation:lockdown': 'Lockdown',
  'moderation:unlock': 'Channel unlocked',
  'moderation:warn-clear': 'Warnings cleared',
  'moderation:case-reason': 'Case reason edited',
  'personalizer:identity': 'Bot name and avatar',
  'personalizer:presence': 'Bot status',
  'personalizer:announcement': 'Announcement',
  'leveling:vanity': 'Leaderboard link',
  'leveling:setxp': 'XP changed',
  'leveling:reset': 'XP reset',
  'leveling:leaderboard': 'Leaderboard',
  'counting:unbench': 'Counting access restored',
  'counting:set': 'Count set',
  'counting:reset': 'Count reset',
  'privacy:member-data': 'Member data',
  warned: 'Warning',
};

const words = (text) => {
  const s = String(text)
    .replace(/[:_-]+/g, ' ')
    .trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
};

/**
 * A readable name for an audit action key: "module:starboard" -> "Starboard" (the module's name from
 * `moduleNames`, a Map of id -> name), "settings:server" -> "Server settings". The key itself is shown as the
 * hover title. Unknown keys fall back to the key with its punctuation turned into spaces.
 */
export function auditActionLabel(action, moduleNames = new Map()) {
  const key = String(action ?? '');
  if (ACTION_LABELS[key]) return ACTION_LABELS[key];
  if (key.startsWith('module:')) {
    const id = key.slice('module:'.length);
    if (id === 'bulk') return 'Several modules';
    return moduleNames.get(id) || words(id);
  }
  if (key.startsWith('appeal:')) return `Appeal ${key.slice('appeal:'.length)}`;
  if (key.startsWith('moderation:case-')) return `Case ${key.slice('moderation:case-'.length)}`;
  if (key.startsWith('command:')) return `Command ${key.slice('command:'.length)}`;
  return words(key) || key;
}

// Where a member id stands in an audit line: after "for", "of", "to", "released" or "removed" ("add 5 for <id>",
// "gave a badge to <id>", "released <id>") or before "bonus →" ("<id> bonus → 3"). Any other long number is not a
// member: a channel id, a count, a name made of digits (a stored name is followed by "(…1234)", the end of its id).
const MEMBER_ID = /\b(for|of|to|released|removed) (\d{17,20})\b(?! \(…)|\b(\d{17,20}) bonus →/g;
const ID_CHUNK = 20;

/** A member id with no name to show for it: the end of the id, so two of them can still be told apart. */
const unnamed = (id) => `member …${id.slice(-4)}`;

/**
 * An audit line with the member ids in it turned into names: `names` is a Map of id -> name (an id that
 * is not in it reads "member …1234"). Only a member's place in the line counts (see MEMBER_ID); the actor is
 * always a name ("Alice (dashboard)"), so it is not read for ids at all.
 */
export function withNames(text, names) {
  return String(text ?? '').replace(MEMBER_ID, (whole, word, id, bonusId) => {
    const found = id ?? bonusId;
    const shown = names.get(found) ?? unnamed(found);
    return word ? `${word} ${shown}` : `${shown} bonus →`;
  });
}

/** The member ids that appear in the entries' details (new entries store the name, older ones the id). */
export function idsInEntries(entries) {
  const ids = new Set();
  for (const e of entries) {
    for (const m of String(e.detail ?? '').matchAll(MEMBER_ID)) ids.add(m[2] ?? m[3]);
  }
  return [...ids];
}

// The names behind the ids in the loaded entries, asked for once per id and kept while the page is open.
function useEntryNames(guildId, entries) {
  const known = useRef({ guildId, map: new Map() }); // id -> name | null (asked, not found)
  if (known.current.guildId !== guildId) known.current = { guildId, map: new Map() };
  const [, bump] = useState(0);
  const ids = idsInEntries(entries);
  const key = ids.join(',');
  useEffect(() => {
    const cache = known.current.map;
    const missing = ids.filter((id) => !cache.has(id));
    if (!missing.length) return undefined;
    let live = true;
    (async () => {
      for (let i = 0; i < missing.length; i += ID_CHUNK) {
        const chunk = missing.slice(i, i + ID_CHUNK);
        try {
          const res = await getMemberNames(guildId, chunk);
          for (const id of chunk) cache.set(id, res?.names?.[id] ?? null);
        } catch {
          // Not remembered: the lines read "member …1234" and the next load asks again.
        }
      }
      if (live) bump((n) => n + 1);
    })();
    return () => {
      live = false;
    };
    // `key` is the content of `ids`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guildId, key]);
  const names = new Map();
  for (const [id, name] of known.current.map) if (name) names.set(id, name);
  return names;
}

// "Show changes" under an entry that kept what it changed: the difference (changed fields only), and
// "Undo this change" where the settings can be put back. The change is loaded when the entry is opened.
function EntryChange({ guildId, entry, onUndone }) {
  const [open, setOpen] = useState(false);
  const [load, setLoad] = useState({ status: 'idle', data: null, error: '' });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const regionId = useId();

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (!next || load.status === 'loading' || load.status === 'ready') return;
    setLoad({ status: 'loading', data: null, error: '' });
    try {
      setLoad({ status: 'ready', data: await getAuditChange(guildId, entry.id), error: '' });
    } catch (err) {
      setLoad({ status: 'error', data: null, error: err.message || 'Could not load the change.' });
    }
  }

  // Settings changed again since this entry: say which, and ask before they are lost.
  const confirmLoss = (later) =>
    confirmDialog({
      title: 'Undo this change?',
      body: (
        <>
          <p>
            These settings were changed again after this entry
            {later?.length ? <>: {later.map(labelFor).join(', ')}</> : null}. Undoing it puts the earlier
            values back and the later changes will be lost.
          </p>
          <p>The undo is written to the audit log, so it can be undone too.</p>
        </>
      ),
      confirmLabel: 'Undo and lose later changes',
    });

  async function undo() {
    const state = load.data.undo;
    let confirm = false;
    if (state.state === 'changed') {
      if (!(await confirmLoss(state.laterChanges))) return;
      confirm = true;
    }
    setBusy(true);
    setProblem('');
    try {
      let res;
      try {
        res = await undoAuditChange(guildId, entry.id, { confirm });
      } catch (err) {
        // Changed again since the page loaded: the server asks for the confirmation the page did not know about.
        if (err.code !== 'changed-since' || confirm) throw err;
        if (!(await confirmLoss(err.laterChanges))) return;
        res = await undoAuditChange(guildId, entry.id, { confirm: true });
      }
      notify(
        res.adjusted?.length
          ? `Change undone. Some settings now follow today's limits: ${res.adjusted.map(labelFor).join(', ')}.`
          : 'Change undone.',
        'info'
      );
      onUndone();
    } catch (err) {
      setProblem(err.message || 'Could not undo the change.');
    } finally {
      setBusy(false);
    }
  }

  const data = load.data;
  const later = data?.undo?.laterChanges ?? [];
  return (
    <div className="v2-history">
      <button
        type="button"
        className="v2-btn-ghost v2-history-toggle"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={toggle}
      >
        {open ? 'Hide changes' : 'Show changes'}
      </button>
      <div id={regionId} role="region" aria-label="What this entry changed" hidden={!open}>
        {open && load.status === 'loading' ? <p className="v2-field-hint">Loading…</p> : null}
        {open && load.status === 'error' ? (
          <p className="v2-field-error" role="alert">
            {load.error}
          </p>
        ) : null}
        {open && load.status === 'ready' ? (
          <>
            {data.tooLarge ? (
              <p className="v2-field-hint">{data.undo.reason}</p>
            ) : (
              <ConfigDiff before={data.before} after={data.after} names={data.names} />
            )}
            {data.undo.state === 'changed' && data.undo.available ? (
              <Callout tone="warning">
                <p>
                  These settings were changed again after this entry
                  {later.length ? <>: {later.map(labelFor).join(', ')}</> : null}. Undoing it will lose those
                  later changes.
                </p>
              </Callout>
            ) : null}
            <div className="v2-history-actions">
              {data.undo.available ? (
                <button type="button" className="v2-btn-ghost" disabled={busy} onClick={undo}>
                  {busy ? 'Undoing…' : 'Undo this change'}
                </button>
              ) : data.undo.reason && !data.tooLarge ? (
                <p className="v2-field-hint">{data.undo.reason}</p>
              ) : null}
              {problem ? (
                <span className="v2-field-error" role="alert">
                  {problem}
                </span>
              ) : null}
            </div>
            {!data.tooLarge ? (
              <p className="v2-field-hint">
                Undo restores this module&apos;s settings. Lists kept on their own (reminders, shop items and
                the like) are not part of it and are not restored.
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

// The server's config-change history: a filter by kind of change, and 50 entries at a time.
export default function AuditLog() {
  const { guildId } = useParams();
  const overview = useOverview();
  const [action, setAction] = useState('');
  const [page, setPage] = useState({ entries: [], hasMore: false, actions: [], kept: 0, loaded: false });
  const [error, setError] = useState(null);
  const [more, setMore] = useState({ busy: false, error: '' });
  // Bumped after an undo: the list is read again from the top, so the new entry shows.
  const [reloads, setReloads] = useState(0);
  const seq = useRef(0);

  // The first page, again whenever the server or the filter changes. An answer that arrives after a newer
  // request was made is dropped.
  useEffect(() => {
    const mine = ++seq.current;
    setError(null);
    getAuditLog(guildId, { action })
      .then((res) => {
        if (seq.current !== mine) return;
        setPage({
          entries: res.entries ?? [],
          hasMore: Boolean(res.hasMore),
          actions: res.actions ?? [],
          kept: res.kept ?? 0,
          loaded: true,
        });
        setMore({ busy: false, error: '' });
      })
      .catch((err) => {
        if (seq.current === mine) setError(err);
      });
  }, [guildId, action, reloads]);

  async function showMore() {
    const last = page.entries[page.entries.length - 1];
    if (!last || more.busy) return;
    const mine = seq.current;
    setMore({ busy: true, error: '' });
    try {
      const res = await getAuditLog(guildId, { action, before: last.id });
      if (seq.current !== mine) return;
      setPage((p) => ({
        ...p,
        entries: [...p.entries, ...(res.entries ?? [])],
        hasMore: Boolean(res.hasMore),
      }));
      setMore({ busy: false, error: '' });
    } catch (err) {
      if (seq.current === mine) setMore({ busy: false, error: err.message || 'Could not load more.' });
    }
  }

  const names = useEntryNames(guildId, page.entries);

  if (error) return <LoadError error={error} what="the audit log" />;
  if (!page.loaded) return <p className="v2-state">Loading…</p>;

  const moduleNames = new Map(
    (overview?.data?.groups ?? []).flatMap((g) => g.cards).map((c) => [c.id, c.name])
  );
  const total = page.actions.reduce((sum, a) => sum + a.count, 0);
  const showFilter = page.actions.length > 1 || action !== '';

  return (
    <Reveal>
      <Breadcrumb parents={[peopleCrumb(guildId)]} current="Audit log" />
      <h1 className="v2-section-title">Audit log</h1>
      <p className="v2-field-hint">
        Configuration changes made from the dashboard. Keeps the most recent {formatCount(page.kept)} per
        server. Open an entry to see what it changed and, for settings, undo it.
      </p>

      {showFilter ? (
        <div className="v2-field v2-audit-filter">
          <label htmlFor="audit-action">Show</label>
          <select id="audit-action" value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">All changes{total ? ` (${formatCount(total)})` : ''}</option>
            {page.actions.map((a) => (
              <option key={a.action} value={a.action}>
                {auditActionLabel(a.action, moduleNames)} ({formatCount(a.count)})
              </option>
            ))}
            {action && !page.actions.some((a) => a.action === action) ? (
              <option value={action}>{auditActionLabel(action, moduleNames)}</option>
            ) : null}
          </select>
        </div>
      ) : null}

      {page.entries.length ? (
        <div className="v2-group v2-section-gap">
          <p className="v2-field-hint">{formatCount(page.entries.length)} shown, newest first.</p>
          <div className="v2-list">
            {page.entries.map((a) => (
              <div className="v2-row v2-row-stack" key={a.id}>
                <div className="v2-row-main">
                  <h3 className="v2-audit-action v2-break" title={a.action}>
                    {auditActionLabel(a.action, moduleNames)}
                  </h3>
                  <p className="is-wrap v2-break">
                    {withNames(a.actor, names)}
                    {a.detail ? ` — ${withNames(a.detail, names)}` : ''}
                    <span className="v2-audit-ago-inline">
                      {' · '}
                      <Time value={a.at} relative fallback={a.ago} />
                    </span>
                  </p>
                  {a.hasChange ? (
                    <EntryChange
                      key={reloads}
                      guildId={guildId}
                      entry={a}
                      onUndone={() => setReloads((n) => n + 1)}
                    />
                  ) : null}
                </div>
                <Time className="v2-field-hint v2-row-time" value={a.at} relative fallback={a.ago} />
              </div>
            ))}
          </div>
          {page.hasMore ? (
            <p className="v2-audit-more">
              <button type="button" className="v2-btn-ghost" disabled={more.busy} onClick={showMore}>
                {more.busy ? 'Loading…' : 'Show 50 more'}
              </button>
              {more.error ? (
                <span className="v2-field-error" role="alert">
                  {more.error}
                </span>
              ) : null}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="v2-state">
          {action ? 'Nothing recorded for this kind of change.' : 'Nothing recorded yet.'}
        </p>
      )}
    </Reveal>
  );
}
