// Where the Fluxer instance Sylo talks to keeps its web app and invite links. Hosted Fluxer
// uses fluxer.gg for invites and web.fluxer.app for the web app; a self-hosted instance
// publishes its own in /.well-known/fluxer (stored here at startup by startFluxerBot).
import { config } from '../config.js';
import { platformOfGuild } from './platformOf.js';

let instance = null;

/** @param {{ endpoints?: Record<string, string> } & Record<string, string> | null | undefined} doc  the discovery document, or the two-origin fallback */
export function setFluxerInstance(doc) {
  instance = doc ?? null;
}

/** The instance's endpoints, with hosted Fluxer's as the default. */
export function fluxerEndpoints() {
  const e = instance?.endpoints ?? instance ?? {};
  return {
    webapp: e.webapp ?? config.fluxerWebUrl ?? 'https://web.fluxer.app',
    invite: e.invite ?? 'https://fluxer.gg',
  };
}

/** The public link for an invite code on the platform a guild belongs to. */
export function inviteUrl(guild, code) {
  return platformOfGuild(guild) === 'fluxer'
    ? `${fluxerEndpoints().invite}/${code}`
    : `https://discord.gg/${code}`;
}

/**
 * Where the connected instance's invite links live, as "host/path" prefixes, for the
 * link detectors: its invite host (e.g. "fluxer.opland.net/invite" or "fluxer.gg") and
 * "<web app host>/invite". Empty-safe: an unparsable endpoint is skipped.
 * @returns {string[]}
 */
export function instanceInvitePrefixes() {
  const { invite, webapp } = fluxerEndpoints();
  const prefix = (url, extra = '') => {
    try {
      const u = new URL(url);
      return `${u.host}${u.pathname.replace(/\/+$/, '')}${extra}`.toLowerCase();
    } catch {
      return null;
    }
  };
  return [...new Set([prefix(invite), prefix(webapp, '/invite')].filter(Boolean))];
}
