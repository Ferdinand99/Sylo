import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { getMemberData, forgetMemberData } from '../api.js';
import { useApiData } from '../useApiData.js';
import { notify } from '../notify.js';
import LoadError from '../components/LoadError.jsx';
import Breadcrumb from '../components/Breadcrumb.jsx';
import Field from '../components/Field.jsx';
import { confirmDialog } from '../components/ConfirmDialog.jsx';
import { copyIdHint, formatCount } from '../util.js';
import { usePlatformInfo } from '../usePlatformInfo.js';
import Reveal from '../components/Reveal.jsx';
import MemberPicker, { parseMemberIds } from '../components/MemberPicker.jsx';
import '../styles/wp1-members.css';

// Look up what Sylo stores about one member in this server and delete it on request.
// Moderation cases and other safety records are kept.
export default function MemberData() {
  const { guildId } = useParams();
  const { info } = usePlatformInfo(guildId);
  const [params, setParams] = useSearchParams();
  const user = params.get('user') ?? '';
  const { data, error, setData } = useApiData(
    () => (user ? getMemberData(guildId, user) : Promise.resolve({ lookup: null })),
    [guildId, user]
  );

  // The picker holds a member id; an older link may carry an @mention, which is the same member.
  const picked = parseMemberIds(user)[0] ?? '';

  function onPick(id) {
    // Same page, other search: the window stays where it is instead of jumping to the top.
    setParams(id ? { user: id } : {}, { preventScrollReset: true });
  }

  return (
    <Reveal>
      <Breadcrumb
        parents={[{ label: 'Members & moderation', to: `/guilds/${guildId}/moderation` }]}
        current="Member data"
      />
      <h1 className="v2-section-title">Member data</h1>
      <p className="v2-field-hint">
        Look up what Sylo has stored about a member in this server and delete it on request (for example a
        data-erasure request). Deletion is permanent, and Sylo DMs the member a confirmation of exactly what
        was removed.
      </p>

      <div className="v2-field v2-member-data-picker v2-section-gap" role="search">
        <label htmlFor="member-data-member">Member</label>
        <MemberPicker
          id="member-data-member"
          value={picked}
          onChange={onPick}
          placeholder="Search by name, or paste an ID"
          clearLabel="Look up another member"
        />
        <p className="v2-field-hint" id="member-id-hint">
          Type two letters of the name. For a member who has left, paste the user ID.{' '}
          {copyIdHint(info.platform)}
        </p>
      </div>

      {error ? (
        error.status === 400 ? (
          <p className="v2-note v2-break v2-section-gap">{error.message}</p>
        ) : (
          <LoadError error={error} what="the member's data" />
        )
      ) : !data ? (
        <p className="v2-state">Loading…</p>
      ) : data.lookup ? (
        <Lookup
          key={data.lookup.profile.id}
          guildId={guildId}
          lookup={data.lookup}
          onForgotten={(lookup) => setData((d) => ({ ...d, lookup }))}
        />
      ) : null}
    </Reveal>
  );
}

function Lookup({ guildId, lookup, onForgotten }) {
  const { profile, data } = lookup;
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const name = profile.tag || profile.id;
  const rows = data.items.filter((i) => i.count > 0);

  async function onForget() {
    const ok = await confirmDialog({
      title: `Delete ${name}’s data?`,
      body:
        'Everything Sylo stores about this member in this server is permanently deleted, and Sylo DMs ' +
        'them a confirmation. Moderation cases and other safety records are kept.',
      confirmLabel: 'Delete data',
      cancelLabel: 'Keep it',
      tone: 'danger',
      typeToConfirm: 'DELETE',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await forgetMemberData(guildId, profile.id, reason);
      notify(
        r.dmDelivered
          ? 'Member data deleted. Sylo DM’d the member a confirmation of what was removed.'
          : 'Member data deleted, but Sylo could not DM the member (no shared server or their DMs are closed). Let them know directly.',
        'info'
      );
      setReason('');
      onForgotten((await getMemberData(guildId, profile.id)).lookup);
    } catch (err) {
      notify(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="v2-group v2-section-gap">
      <div className="v2-member-data-head">
        {profile.avatar ? <img className="v2-member-data-avatar" src={profile.avatar} alt="" /> : null}
        <div className="v2-row-main">
          <h2 className="v2-member-data-name v2-break">{profile.tag || 'Unknown user'}</h2>
          <p className="v2-field-hint v2-break">{profile.id}</p>
        </div>
      </div>

      {data.total === 0 ? (
        <p className="v2-state">Sylo has no stored data for this member in this server.</p>
      ) : (
        <>
          <div className="v2-list">
            {rows.map((i) => (
              <div className="v2-row" key={i.key}>
                <div className="v2-row-main">
                  <p className="is-wrap v2-break">{i.label}</p>
                </div>
                <span className="v2-field-hint v2-row-time">{formatCount(i.count)}</span>
              </div>
            ))}
          </div>
          <p className="v2-field-hint v2-section-gap-sm">
            Not shown here: messages already posted to channels, a completed giveaway’s winner list, and the
            config-change log (which records a display name, not an ID). Deleting also anonymises this member
            as an inviter and as “last counter” where applicable. Safety records (moderation cases, a
            temporary ban, honeypot catches, a counting penalty) are kept; remove a case on the{' '}
            <Link to={`/guilds/${guildId}/moderation`}>Moderation</Link> page if it should go.
          </p>

          <div className="v2-section-gap">
            <Field label="Note to the member" labelNote="— optional, added to the DM">
              <textarea
                rows={2}
                maxLength={500}
                placeholder="e.g. Processed at your request."
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
            <button type="button" className="v2-btn-danger" disabled={busy} onClick={onForget}>
              {busy ? 'Deleting…' : 'Delete this member’s data'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
