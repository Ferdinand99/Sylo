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
