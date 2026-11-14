import { useState } from 'react';
import { Link } from 'react-router-dom';
import '../styles/setup-wizard.css';

const key = (guildId) => `sylo-setup-offer-dismissed:${guildId}`;

// "Not now" is remembered per server in this browser. Storage can be blocked or full: the offer then
// simply comes back on the next visit.
function dismissed(guildId) {
  try {
    return localStorage.getItem(key(guildId)) === '1';
  } catch {
    return false;
  }
}

/**
 * The offer on the overview of a server with little set up: one calm card with a button that starts the
 * setup wizard. "Not now" hides it for this server (the wizard stays in Server settings).
 */
export default function SetupOffer({ guildId }) {
  const [hidden, setHidden] = useState(() => dismissed(guildId));
  if (hidden) return null;

  function dismiss() {
    try {
      localStorage.setItem(key(guildId), '1');
    } catch {
      // Not remembered; hidden for this visit only.
    }
    setHidden(true);
  }

  return (
    <section className="v2-setup-offer" aria-labelledby="v2-setup-offer-title">
      <div className="v2-setup-offer-text">
        <strong id="v2-setup-offer-title">New here? Set up Sylo in a few minutes</strong>
        <span>
          Pick what you want, and Sylo proposes the channels and roles. Nothing is created without your tick.
        </span>
      </div>
      <div className="v2-setup-offer-actions">
        <Link className="v2-btn-primary" to={`/guilds/${guildId}/setup`}>
          Set up Sylo
        </Link>
        <button type="button" className="v2-btn-ghost" onClick={dismiss}>
          Not now
        </button>
      </div>
    </section>
  );
}
