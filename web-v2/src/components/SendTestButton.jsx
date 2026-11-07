import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { sendModuleTest } from '../api.js';
import { notify } from '../notify.js';
import { useOverview } from '../OverviewContext.jsx';

/** "Posts a sample message to #general.": says what is posted and where, as far as the page knows. */
export function postsTo(sample, channelName, note = '') {
  const what = sample || 'a sample message';
  const where = channelName ? `#${channelName}` : 'the channel set above';
  return `Posts ${what} to ${where}${note ? ` (${note})` : ''}.`;
}

/**
 * "Send test message" for a module that posts to one configured channel (the
 * server's TESTABLE set in src/bot/lib/moduleTest.js). The server sends from
 * the SAVED config, so pass `disabled` while the form has unsaved edits.
 * `sample` says what is sent and `channelName` where (and `note` anything else worth knowing),
 * for the line next to the button. It only shows while the module is on (read from the shared overview).
 */
export default function SendTestButton({
  moduleId,
  disabled = false,
  sample = '',
  channelName = '',
  note = '',
}) {
  const { guildId } = useParams();
  const overview = useOverview();
  const [sending, setSending] = useState(false);

  const card = (overview?.data?.groups ?? []).flatMap((g) => g.cards).find((c) => c.id === moduleId);
  if (card?.enabled !== true) return null;

  const send = async () => {
    setSending(true);
    try {
      const r = await sendModuleTest(guildId, moduleId);
      if (r.ok) notify(`Test sent to #${r.channelName}`, 'info');
      else if (r.reason === 'no-channel') notify('Set a channel for this module first.');
      else notify('Send failed — check the bot has access to that channel.');
    } catch (err) {
      notify(err.message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="v2-send-test">
      <button type="button" className="v2-btn-ghost" disabled={disabled || sending} onClick={send}>
        {sending ? 'Sending…' : 'Send test message'}
      </button>
      <span className="v2-field-hint">
        {disabled ? 'Save your changes first.' : postsTo(sample, channelName, note)}
      </span>
    </div>
  );
}
