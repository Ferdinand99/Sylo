// /account — the signed-in person's own page: which platforms their dashboard account is
// connected to, with "Connect" for the ones that are not and "Disconnect" for the ones that are.
import { Router } from 'express';
import { config } from '../../config.js';
import { unlinkIdentity } from '../../db/accounts.js';
import { identityFor } from '../lib/accountAuth.js';
import { providers } from '../lib/oauthProviders.js';
import { asyncHandler } from '../lib/asyncHandler.js';

const router = Router();

const MESSAGES = {
  connected: { kind: 'ok', text: 'Account connected.' },
  disconnected: { kind: 'ok', text: 'Account disconnected.' },
  last: { kind: 'bad', text: "You can't disconnect your only sign-in — connect another account first." },
};

router.get('/', (req, res) => {
  if (!config.authEnabled || !req.account) return res.redirect('/');
  const { identities } = req.account;
  const platforms = Object.values(providers)
    // A platform shows when it can be connected, or when it already is (even if its login was switched off since).
    .filter((p) => p.enabled() || identityFor(req.account, p.platform))
    .map((p) => {
      const identity = identityFor(req.account, p.platform);
      return {
        platform: p.platform,
        label: p.label,
        identity,
        guildCount: identity?.guildIds.length ?? 0,
        connectHref: p.enabled() ? `/auth/connect/${p.platform}` : null,
        canDisconnect: Boolean(identity) && identities.length > 1,
      };
    });
  const flash = MESSAGES[req.query.msg];
  res.render('account', {
    title: 'Account',
    platforms,
    flash: flash
      ? { ...flash, text: req.query.msg === 'connected' && req.query.p ? flash.text : flash.text }
      : null,
  });
});

router.post(
  '/disconnect/:platform',
  asyncHandler(async (req, res) => {
    if (!config.authEnabled || !req.account) return res.redirect('/');
    const ok = await unlinkIdentity(req.account.id, req.params.platform);
    res.redirect(`/account?msg=${ok ? 'disconnected' : 'last'}`);
  })
);

export default router;
