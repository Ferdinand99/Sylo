import { useContext } from 'react';
import { useParams } from 'react-router-dom';
import { PlatformContext } from '../platformContext.jsx';

/**
 * The small tag next to the bot's name in a message preview: "APP" like Discord shows for an app
 * (the old "BOT" tag is gone there). The dashboard can't tell whether this instance is the
 * official, verified Sylo, so it never claims the checkmark. Fluxer still labels bots "BOT": the
 * platform comes from the module page's context, or, on pages outside one (the Message Creator),
 * from the server id in the address ("fluxer:123…").
 * Use it in every preview that draws the name row (.v2-msg-head-text).
 */
export default function AppTag() {
  const { platform } = useContext(PlatformContext);
  const { guildId } = useParams();
  const fluxer = platform === 'fluxer' || String(guildId ?? '').startsWith('fluxer:');
  return <span className="v2-msg-botbadge">{fluxer ? 'BOT' : 'APP'}</span>;
}
