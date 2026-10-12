// The account page's view-model, shared by the classic page (routes/account.js) and the
// V2 API (routes/v2Api.js).
import { identityFor } from './accountAuth.js';
import { providers } from './oauthProviders.js';

/**
 * One row per platform the person can connect, or already has connected (even if its
 * login was switched off since).
 * @param {{ identities: any[] }} account
 */
export function accountPlatforms(account) {
  return Object.values(providers)
    .filter((p) => p.enabled() || identityFor(account, p.platform))
    .map((p) => {
      const identity = identityFor(account, p.platform);
      return {
        platform: p.platform,
        label: p.label,
        connected: Boolean(identity),
        username: identity?.username ?? null,
        guildCount: identity?.guildIds.length ?? 0,
        connectHref: !identity && p.enabled() ? `/auth/connect/${p.platform}` : null,
        canDisconnect: Boolean(identity) && account.identities.length > 1,
      };
    });
}
