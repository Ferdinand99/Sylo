import { useContext } from 'react';
import { PlatformContext } from '../platformContext.jsx';

/**
 * The small tag next to the bot's name in a message preview: "APP" like Discord shows for an app
 * (the old "BOT" tag is gone there). The dashboard can't tell whether this instance is the
 * official, verified Sylo, so it never claims the checkmark. Fluxer still labels bots "BOT".
 * Use it in every preview that draws the name row (.v2-msg-head-text).
 */
export default function AppTag() {
  const { platform } = useContext(PlatformContext);
  return <span className="v2-msg-botbadge">{platform === 'fluxer' ? 'BOT' : 'APP'}</span>;
}
