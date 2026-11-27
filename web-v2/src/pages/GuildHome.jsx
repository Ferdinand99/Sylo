import { Navigate, useParams } from 'react-router-dom';
import { useAccess } from '../access.jsx';
import { useOverview } from '../OverviewContext.jsx';
import { focusedLanding } from '../overviewModel.js';
import Overview from './Overview.jsx';

// Where a server opens. Most people land on the overview; an Inbox-level person lands on the first inbox
// that is switched on (the focused moderator view, access.jsx; there is no combined inbox page). Their
// "Show everything" choice brings the overview back.
export default function GuildHome() {
  const { guildId } = useParams();
  const { ready, focused, hintLevel, guildId: accessGuildId } = useAccess();
  const overview = useOverview();
  const loading = <p className="v2-state">Loading…</p>;

  // Not before the level of this server is known: the previous server's level must not decide.
  if (accessGuildId && accessGuildId !== guildId) return loading;
  if (!ready) {
    // The server list already says View or Edit: neither can be focused, so the overview need not wait.
    return hintLevel === 'view' || hintLevel === 'edit' ? <Overview /> : loading;
  }
  if (!focused) return <Overview />;

  // The landing depends on which modules are on, so wait for this server's overview (or its failure).
  const mine = overview?.dataGuildId === guildId;
  if (overview && !mine && (overview.loading || !overview.error)) return loading;
  return <Navigate to={focusedLanding(guildId, mine ? overview.data : null)} replace />;
}
