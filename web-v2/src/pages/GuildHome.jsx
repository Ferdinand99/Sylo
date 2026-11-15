import { Navigate, useParams } from 'react-router-dom';
import { useAccess } from '../access.jsx';
import Overview from './Overview.jsx';

// Where a server opens. Most people land on the overview; an Inbox-level person lands on the inbox, because
// that is what they are here for (the focused moderator view, access.jsx). Their "Show everything" choice
// brings the overview back. There is no combined inbox page, so this is the tickets, the first of the inboxes.
export default function GuildHome() {
  const { guildId } = useParams();
  const { ready, focused, guildId: accessGuildId } = useAccess();
  // Not before the level of this server is known: the previous server's level must not decide.
  if (!ready || (accessGuildId && accessGuildId !== guildId)) return <p className="v2-state">Loading…</p>;
  if (focused) return <Navigate to={`/guilds/${guildId}/tickets`} replace />;
  return <Overview />;
}
