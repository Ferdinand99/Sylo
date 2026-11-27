import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  acceptBridgeLink,
  bridgeLinkAction,
  cancelBridgeRequest,
  getBridge,
  requestBridgeLink,
  setBridgeOptions,
} from '../api.js';
import { notify } from '../notify.js';
import { useApiData } from '../useApiData.js';
import LoadError from '../components/LoadError.jsx';
import HowItWorks from '../components/HowItWorks.jsx';
import Callout from '../components/Callout.jsx';
import { BetaNote, BetaTag } from '../components/Beta.jsx';
import CopyButton from '../components/CopyButton.jsx';
import EmptyList from '../components/EmptyList.jsx';
import RowActions from '../components/RowActions.jsx';
import Switch from '../components/Switch.jsx';
import Meta from '../components/Meta.jsx';
import { confirmDialog } from '../components/ConfirmDialog.jsx';
import { formatDateTime } from '../formatTime.js';

const PLATFORM = { discord: 'Discord', fluxer: 'Fluxer' };
// The code is XXXX-XXXX-XXXX; a pasted one may carry spaces.
const CODE_FIELD_LENGTH = 24;

const OPTION_ROWS = [
  {
    key: 'bots',
    label: 'Share messages from bots',
    hint: 'Off by default. Messages from other bot accounts of this server cross. Webhook messages (what bridges post) and Sylo itself never cross.',
  },
  {
    key: 'joinMessages',
    label: 'Share who joins',
    hint: 'Off by default. A short "joined" line appears on the other side when someone joins this server.',
  },
  {
    key: 'uploadFiles',
    label: 'Copy files across',
    hint: 'Files up to 8 MB are re-uploaded to the other side; bigger ones, or all of them when this is off, cross as a link.',
  },
];

function statusOf(link) {
  if (link.status === 'active') return { tone: 'success', text: 'Running' };
  if (link.status === 'paused') {
    return {
      tone: 'warning',
      text: link.pausedByMe ? 'Paused by this server' : 'Paused by the other server',
    };
  }
  return { tone: 'danger', text: 'Stopped' };
}

/** One channel picker: the text channels of this server that are not in a link or a request yet. */
function ChannelSelect({ id, channels, value, onChange }) {
  const free = channels.filter((c) => !c.taken);
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Pick a channel</option>
      {free.map((c) => (
        <option key={c.id} value={c.id}>
          #{c.name}
          {c.ageRestricted ? ' (age-restricted)' : ''}
        </option>
      ))}
    </select>
  );
}

/** The two switches of a side that are off until asked for, as a small group. */
function OptionSwitches({ options, onChange, idPrefix, disabled }) {
  return (
    <div className="v2-bridge-options">
      {OPTION_ROWS.map((o) => (
        <div className="v2-bridge-option" key={o.key}>
          <Switch
            id={`${idPrefix}-${o.key}`}
            checked={options[o.key]}
            onChange={(on) => onChange({ [o.key]: on })}
            label={o.label}
            disabled={disabled}
          />
          <span>
            <label htmlFor={`${idPrefix}-${o.key}`}>{o.label}</label>
            <span className="v2-field-hint">{o.hint}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

const DEFAULT_OPTIONS = { bots: false, joinMessages: false, uploadFiles: true };

export default function Bridge() {
  const { guildId } = useParams();
  const { data, dataKey, loading, error, setData } = useApiData(() => getBridge(guildId), [guildId], guildId);
  const [busy, setBusy] = useState(false);
  // Ask the other server
  const [askChannel, setAskChannel] = useState('');
  const [askOptions, setAskOptions] = useState(DEFAULT_OPTIONS);
  const [issued, setIssued] = useState(null); // { code, expiresAt }
  // Use a code
  const [code, setCode] = useState('');
  const [useChannel, setUseChannel] = useState('');
  const [useOptions, setUseOptions] = useState(DEFAULT_OPTIONS);

  if (error) return <LoadError error={error} what="Bridge" />;
  // The previous server's page stays in `data` while the next one loads: never show or change it as this one.
  if (!data || dataKey !== guildId) return loading ? <p className="v2-state">Loading…</p> : null;

  const other = data.platform === 'fluxer' ? 'Discord' : 'Fluxer';
  const here = PLATFORM[data.platform];
  const ready = data.bothPlatforms && data.enabled;
  // Only the owner of the server can change a bridge; everyone with View access reads the status.
  const owner = data.owner === true;

  async function run(fn, done) {
    setBusy(true);
    try {
      const out = await fn();
      if (out?.overview) setData(out.overview);
      done?.(out);
    } catch (err) {
      notify(err.message);
    } finally {
      setBusy(false);
    }
  }

  const onAsk = (e) => {
    e.preventDefault();
    if (!askChannel) return notify('Pick a channel.');
    return run(
      () => requestBridgeLink(guildId, { channelId: askChannel, options: askOptions }),
      (out) => {
        setIssued({ code: out.code, expiresAt: out.expiresAt });
        setAskChannel('');
      }
    );
  };

  const onUse = (e) => {
    e.preventDefault();
    if (!code.trim()) return notify('Paste the code from the other server.');
    if (!useChannel) return notify('Pick a channel.');
    return run(
      () => acceptBridgeLink(guildId, { code: code.trim(), channelId: useChannel, options: useOptions }),
      () => {
        setCode('');
        setUseChannel('');
        notify('The bridge is on.');
      }
    );
  };

  const onOption = (link, patch) => run(() => setBridgeOptions(guildId, link.id, patch));

  async function onUnlink(link) {
    const ok = await confirmDialog({
      title: `Unlink #${link.mine.channel}?`,
      body: `Messages stop crossing to #${link.theirs.channel} in ${link.theirs.server}. Sylo deletes both webhooks and tells both channels. Messages already posted stay where they are, and deleting an original later no longer removes its copy.`,
      confirmLabel: 'Unlink',
    });
    if (ok) await run(() => bridgeLinkAction(guildId, link.id, 'unlink'));
  }

  async function onCancelRequest(request) {
    const ok = await confirmDialog({
      title: 'Cancel this request?',
      body: 'The code stops working. You can ask again.',
      confirmLabel: 'Cancel request',
      cancelLabel: 'Keep it',
    });
    if (ok) await run(() => cancelBridgeRequest(guildId, request.id));
  }

  return (
    <>
      <h1 className="v2-section-title">
        Bridge {data.beta ? <BetaTag /> : null}
      </h1>
      {data.beta ? <BetaNote /> : null}
      <p className="v2-field-hint">
        One conversation between a channel here on {here} and a channel on {other}. Members on both sides
        write as they always do, and Sylo shows each message on the other side with the author&apos;s name and
        picture.
      </p>
      {data.platform === 'discord' && data.bothPlatforms && owner ? (
        <Callout tone="info" className="v2-bridge-mirror-hint">
          <strong className="v2-callout-title">Setting up a whole Fluxer server?</strong> Use{' '}
          <Link to={`/guilds/${guildId}/mirror`}>Mirror to Fluxer</Link> to copy channels, roles and emoji and
          bridge every channel at once.
        </Callout>
      ) : null}
      <HowItWorks>
        <p>
          Both servers agree. One asks for a link and gets a code that works for 15 minutes; the owner of the
          other server uses it and picks a channel. Sylo has to be in both servers. Either side can unlink at
          any time.
        </p>
        <p>
          What crosses: messages, replies (as a short quote), files up to 8 MB (otherwise a link), custom
          emoji with the same name, stickers (as a picture link), embeds, polls (as text: the vote stays where
          the poll is) and, if you turn it on, who joins. Edits and deletes follow for 30 days.
        </p>
        <p>
          What never crosses: pings. @everyone, @here, roles and people are shown as plain text on the other
          side, and nothing the bridge posts notifies anyone. Sylo&apos;s own bridge messages are never
          relayed again, so there are no loops. Other bots are off until you turn them on. An age-restricted
          channel can only be bridged with another age-restricted channel. Both channels show a notice while a
          bridge is on.
        </p>
      </HowItWorks>

      {!data.bothPlatforms ? (
        <p className="v2-note v2-row-warn">
          This Sylo is not connected to both Discord and Fluxer, so there is nothing to bridge to.
        </p>
      ) : null}
      {data.bothPlatforms && !data.enabled ? (
        <p className="v2-note">Turn the module on above to ask for a link or use a code.</p>
      ) : null}

      <div className="v2-group v2-section-gap">
        <h2 className="v2-group-title">
          {data.links.length <= data.limits.links
            ? `Bridged channels (${data.links.length} of ${data.limits.links})`
            : `Bridged channels (${data.links.length})`}
        </h2>
        {data.links.length >= data.limits.links ? (
          <p className="v2-note v2-row-warn" data-testid="bridge-limit-note">
            {data.links.length > data.limits.links
              ? `This server has more bridged channels than the limit of ${data.limits.links}. No new link can be made until some are unlinked or the limit is raised. `
              : `This server has reached the limit of ${data.limits.links} bridged channels, so no new link can be made, and a server mirror stops linking channels. `}
            The limit is set by whoever runs this Sylo instance (the <code>BRIDGE_MAX_LINKS</code> setting;
            see the self-hosting guide); if that is not you, ask them.
          </p>
        ) : null}
        {data.links.length === 0 ? (
          <EmptyList>
            No channel is bridged yet. Ask for a link below, or use a code from the other server.
          </EmptyList>
        ) : null}
        <div className="v2-list">
          {data.links.map((link) => {
            const status = statusOf(link);
            const canResume = link.resumable ?? (link.status === 'failed' || link.pausedByMe);
            return (
              <div className="v2-row v2-bridge-row" key={link.id}>
                <div className="v2-row-main">
                  <h3>
                    #{link.mine.channel} ↔ #{link.theirs.channel}
                    <span className={`v2-status-pill is-${status.tone} v2-badge-inline`}>{status.text}</span>
                  </h3>
                  <p className="v2-field-hint">
                    <Meta
                      items={[
                        `${link.theirs.server} on ${PLATFORM[link.theirs.platform]}`,
                        link.mine.ageRestricted && 'age-restricted',
                        link.queued > 0 && `${link.queued} waiting to send`,
                        link.dropped > 0 && `${link.dropped} dropped while busy`,
                      ]}
                    />
                  </p>
                  {link.problem ? <p className="v2-note v2-row-warn">{link.problem.text}</p> : null}
                  {link.pauseNote ? <p className="v2-note v2-row-warn">{link.pauseNote}</p> : null}
                  {link.pausedByThem ? (
                    <p className="v2-note">
                      {link.theirs.server} paused this bridge. Only they can resume it.
                    </p>
                  ) : null}
                  <details className="v2-bridge-details">
                    <summary>What this server shares</summary>
                    <fieldset className="v2-access-lock" disabled={!owner}>
                      <OptionSwitches
                        idPrefix={`opt-${link.id}`}
                        options={link.options}
                        disabled={busy}
                        onChange={(patch) => onOption(link, patch)}
                      />
                    </fieldset>
                    <p className="v2-field-hint">
                      The other server decides for itself what it shares. Bot messages:{' '}
                      {link.theirOptions.bots ? 'shared' : 'not shared'}. Who joins:{' '}
                      {link.theirOptions.joinMessages ? 'shared' : 'not shared'}.
                    </p>
                  </details>
                </div>
                <RowActions
                  menuLabel={`More actions for #${link.mine.channel}`}
                  edit={
                    link.status === 'active'
                      ? {
                          label: 'Pause',
                          disabled: busy || !owner,
                          onClick: () => run(() => bridgeLinkAction(guildId, link.id, 'pause')),
                        }
                      : canResume
                        ? {
                            label: 'Resume',
                            disabled: busy || !owner,
                            onClick: () => run(() => bridgeLinkAction(guildId, link.id, 'resume')),
                          }
                        : null
                  }
                  items={
                    owner
                      ? [{ label: 'Unlink', danger: true, disabled: busy, onClick: () => onUnlink(link) }]
                      : []
                  }
                />
              </div>
            );
          })}
        </div>
      </div>

      {data.requests.length ? (
        <div className="v2-group v2-section-gap">
          <h2 className="v2-group-title">Waiting for the other server</h2>
          <div className="v2-list">
            {data.requests.map((r) => (
              <div className="v2-row" key={r.id}>
                <div className="v2-row-main">
                  <h3>#{r.channel}</h3>
                  <p className="v2-field-hint">
                    <Meta items={[`code valid until ${formatDateTime(r.expiresAt)}`, r.requestedBy]} />
                  </p>
                </div>
                <RowActions
                  menuLabel={`More actions for the request of #${r.channel}`}
                  items={
                    owner
                      ? [
                          {
                            label: 'Cancel request',
                            danger: true,
                            disabled: busy,
                            onClick: () => onCancelRequest(r),
                          },
                        ]
                      : []
                  }
                />
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {!owner ? (
        <p className="v2-note v2-access-note">
          Only the server owner can ask for a link, use a code, change what this server shares, or pause,
          resume and unlink a bridge. You can see the status here.
        </p>
      ) : null}
      <fieldset className="v2-access-lock" disabled={!owner}>
        <div className="v2-group v2-section-gap">
          <h2 className="v2-group-title">Ask the other server</h2>
          <p className="v2-field-hint">
            Pick the channel here that should be bridged. You get a one-time code to give to the owner of the{' '}
            {other} server.
          </p>
          <form onSubmit={onAsk} className="v2-bridge-form">
            <div className="v2-field">
              <label htmlFor="bridge-ask-channel">Channel here</label>
              <ChannelSelect
                id="bridge-ask-channel"
                channels={data.channels}
                value={askChannel}
                onChange={setAskChannel}
              />
            </div>
            <OptionSwitches
              idPrefix="ask"
              options={askOptions}
              disabled={!ready || busy}
              onChange={(patch) => setAskOptions((o) => ({ ...o, ...patch }))}
            />
            <button type="submit" className="v2-btn-primary" disabled={!ready || busy || !askChannel}>
              Get a code
            </button>
          </form>
          {issued ? (
            <div className="v2-bridge-code" role="status">
              <p className="v2-field-hint">
                Give this code to the {other} server. It works once, until {formatDateTime(issued.expiresAt)},
                and is not shown again.
              </p>
              <p>
                <code className="v2-bridge-code-text">{issued.code}</code>{' '}
                <CopyButton text={issued.code} what="code" />
              </p>
            </div>
          ) : null}
        </div>

        <div className="v2-group v2-section-gap">
          <h2 className="v2-group-title">Use a code</h2>
          <p className="v2-field-hint">
            Someone on {other} asked for a link and gave you a code. Pick the channel here that joins it.
          </p>
          <form onSubmit={onUse} className="v2-bridge-form">
            <div className="v2-field">
              <label htmlFor="bridge-code">Code</label>
              <input
                id="bridge-code"
                type="text"
                autoComplete="off"
                spellCheck="false"
                placeholder="XXXX-XXXX-XXXX"
                maxLength={CODE_FIELD_LENGTH}
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </div>
            <div className="v2-field">
              <label htmlFor="bridge-use-channel">Channel here</label>
              <ChannelSelect
                id="bridge-use-channel"
                channels={data.channels}
                value={useChannel}
                onChange={setUseChannel}
              />
            </div>
            <OptionSwitches
              idPrefix="use"
              options={useOptions}
              disabled={!ready || busy}
              onChange={(patch) => setUseOptions((o) => ({ ...o, ...patch }))}
            />
            <button
              type="submit"
              className="v2-btn-primary"
              disabled={!ready || busy || !code.trim() || !useChannel}
            >
              Link the channels
            </button>
          </form>
        </div>
      </fieldset>
    </>
  );
}
