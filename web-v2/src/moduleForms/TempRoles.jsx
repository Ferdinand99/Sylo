import { useEffect, useRef, useState } from 'react';
import { useCmd } from '../platformContext.jsx';
import { addTempRole, getTempRoles, removeTempRole, searchTempRoleMembers } from '../api.js';
import { notify } from '../notify.js';
import LoadError from '../components/LoadError.jsx';
import SaveBar from '../components/SaveBar.jsx';
import ChipPicker from '../components/ChipPicker.jsx';
import { useModuleForm } from '../components/useModuleForm.js';
import { limitOf, useModuleLimits } from '../components/useModuleLimits.js';
import { confirmDialog } from '../components/ConfirmDialog.jsx';

const when = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

/** Pick a member by typing part of the name (or pasting the id); shows the matches to click. */
function MemberPicker({ guildId, value, onChange }) {
  const [text, setText] = useState('');
  const [found, setFound] = useState([]);
  const latest = useRef('');

  useEffect(() => {
    const q = text.trim();
    latest.current = q;
    if (!q || value) {
      setFound([]);
      return undefined;
    }
    const timer = setTimeout(() => {
      searchTempRoleMembers(guildId, q)
        .then(({ members }) => latest.current === q && setFound(members))
        .catch(() => latest.current === q && setFound([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [guildId, text, value]);

  if (value) {
    return (
      <span className="v2-chip">
        <span className="v2-chip-name">{value.name}</span>
        <button
          type="button"
          className="v2-chip-x"
          aria-label={`Clear ${value.name}`}
          onClick={() => {
            onChange(null);
            setText('');
          }}
        >
          &times;
        </button>
      </span>
    );
  }
  return (
    <>
      <input
        id="tr-member"
        type="text"
        autoComplete="off"
        placeholder="Type a name or paste a member ID"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {found.length ? (
        <div className="v2-chip-row" role="listbox" aria-label="Matching members">
          {found.map((m) => (
            <button
              key={m.id}
              type="button"
              role="option"
              aria-selected="false"
              className="v2-btn-ghost"
              onClick={() => onChange(m)}
            >
              {m.name}
              {m.username && m.username !== m.name ? ` (${m.username})` : ''}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}

export default function TempRoles() {
  const cmd = useCmd();
  const limits = useModuleLimits('temp-roles');
  const { guildId, data, setData, form, set, status, error, dirty, saving, save, reset } =
    useModuleForm('temp-roles');
  const [filterText, setFilterText] = useState('');
  const [filterRole, setFilterRole] = useState('');
  const [busy, setBusy] = useState(false);
  // The Add form
  const [member, setMember] = useState(null);
  const [roleId, setRoleId] = useState('');
  const [duration, setDuration] = useState(null);
  const [reason, setReason] = useState('');
  // The filter the list on screen was fetched with; the config answer comes with the default one.
  const shown = useRef('/');

  useEffect(() => {
    if (shown.current === `${filterText}/${filterRole}`) return undefined;
    shown.current = `${filterText}/${filterRole}`;
    let live = true;
    const timer = setTimeout(() => {
      getTempRoles(guildId, { q: filterText, roleId: filterRole })
        .then(({ list }) => live && setData((d) => ({ ...d, list })))
        .catch((err) => notify(err.message));
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [guildId, filterText, filterRole, setData]);

  if (status === 'error') return <LoadError error={error} what="Temporary roles" />;
  if (status === 'loading') return <p className="v2-state">Loading…</p>;

  const filter = { q: filterText, roleId: filterRole };
  const reasonLimit = limitOf(limits, 'reason').maxLength;

  async function onAdd(e) {
    e.preventDefault();
    if (!member) return notify('Pick a member.');
    if (!roleId) return notify('Pick a role.');
    setBusy(true);
    try {
      const out = await addTempRole(guildId, {
        userId: member.id,
        roleId,
        duration: duration ?? form.defaultDuration,
        reason,
        filter,
      });
      setData((d) => ({ ...d, list: out.list }));
      notify(
        `${member.name} has the role until ${when(out.expiresAt)}${out.replaced ? ' (replaced the earlier time)' : ''}.`
      );
      setMember(null);
      setReason('');
    } catch (err) {
      notify(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function onRemove(row) {
    const ok = await confirmDialog({
      title: `Take ${row.role} back from ${row.member}?`,
      body: 'Sylo removes the role now instead of at the end time.',
      confirmLabel: 'Remove',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const out = await removeTempRole(guildId, { userId: row.userId, roleId: row.roleId, filter });
      setData((d) => ({ ...d, list: out.list }));
      if (out.warning) notify(out.warning);
    } catch (err) {
      notify(err.message);
    } finally {
      setBusy(false);
    }
  }

  const { list } = data;

  return (
    <>
      <h1 className="v2-section-title">Temporary roles</h1>
      <p className="v2-field-hint">
        Give a member a role for a set time with <code>{cmd('/temprole add')}</code> or below. Sylo takes it
        back by itself and writes the mod log. <code>{cmd('/temprole remove')}</code> ends one early,{' '}
        <code>{cmd('/temprole list')}</code> shows them. Adding the same member and role again replaces the
        end time.
      </p>

      <form onSubmit={save} data-savebar>
        <div className="v2-field">
          <label>
            Staff roles <span className="v2-field-hint">— may use the commands without Manage Roles</span>
          </label>
          <ChipPicker
            kind="role"
            items={data.roles}
            value={form.staffRoles}
            onChange={(staffRoles) => set({ staffRoles })}
          />
          <p className="v2-field-hint">They still cannot hand out a role above their own highest role.</p>
        </div>

        <div className="v2-field">
          <label className="v2-check">
            <input
              type="checkbox"
              checked={form.dmMember}
              onChange={(e) => set({ dmMember: e.target.checked })}
            />
            Send the member a DM
          </label>
          <p className="v2-field-hint">
            When they get the role, when it is taken back early and when it ends. Members with DMs closed are
            skipped quietly.
          </p>
        </div>

        <div className="v2-field">
          <label htmlFor="defaultDuration">Default duration</label>
          <input
            id="defaultDuration"
            type="text"
            value={form.defaultDuration}
            onChange={(e) => set({ defaultDuration: e.target.value })}
          />
          <p className="v2-field-hint">
            What the Add form below starts with. Like 30m, 12h, 7d, 2w or 1d12h; from 1 minute to 365 days.
          </p>
        </div>
      </form>

      <form className="v2-group v2-section-gap" onSubmit={onAdd}>
        <h2 className="v2-group-title">Give a temporary role</h2>
        <div className="v2-field">
          <label htmlFor="tr-member">Member</label>
          <MemberPicker guildId={guildId} value={member} onChange={setMember} />
        </div>
        <div className="v2-field-row">
          <div className="v2-field">
            <label htmlFor="tr-role">Role</label>
            <select id="tr-role" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
              <option value="">— pick a role —</option>
              {data.roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>
          <div className="v2-field">
            <label htmlFor="tr-duration">For how long</label>
            <input
              id="tr-duration"
              type="text"
              value={duration ?? form.defaultDuration}
              onChange={(e) => setDuration(e.target.value)}
            />
          </div>
        </div>
        <div className="v2-field">
          <label htmlFor="tr-reason">
            Reason <span className="v2-field-hint">— optional, kept in the mod log</span>
          </label>
          <input
            id="tr-reason"
            type="text"
            maxLength={reasonLimit}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <button type="submit" className="v2-btn-primary" disabled={busy}>
          Give role
        </button>
      </form>

      <div className="v2-group v2-section-gap">
        <h2 className="v2-group-title">
          Active temporary roles (
          {list.matching === list.total ? list.total : `${list.matching} of ${list.total}`})
        </h2>
        <div className="v2-field-row">
          <div className="v2-field">
            <label htmlFor="tr-filter">Search</label>
            <input
              id="tr-filter"
              type="text"
              placeholder="Member, role or reason"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
            />
          </div>
          <div className="v2-field">
            <label htmlFor="tr-filter-role">Role</label>
            <select id="tr-filter-role" value={filterRole} onChange={(e) => setFilterRole(e.target.value)}>
              <option value="">All roles</option>
              {data.roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        {list.rows.length === 0 ? <p className="v2-note">Nothing here.</p> : null}
        <div className="v2-list">
          {list.rows.map((row) => (
            <div className="v2-row" key={`${row.userId}:${row.roleId}`}>
              <div className="v2-row-main">
                <h3>
                  {row.member} <span className="v2-field-hint">— {row.role}</span>
                </h3>
                <p className="v2-field-hint">
                  Ends {when(row.expiresAt)}
                  {row.addedByName ? ` · set by ${row.addedByName}` : ''}
                  {row.reason ? ` · ${row.reason}` : ''}
                </p>
              </div>
              <div className="v2-field-row">
                <button type="button" className="v2-btn-danger" disabled={busy} onClick={() => onRemove(row)}>
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
        {list.matching > list.rows.length ? (
          <p className="v2-note">
            Showing the first {list.rows.length} of {list.matching}. Narrow the search to see the rest.
          </p>
        ) : null}
      </div>
      <SaveBar dirty={dirty} saving={saving} onSave={save} onReset={reset} />
    </>
  );
}
