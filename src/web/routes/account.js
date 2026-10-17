// /account — the signed-in person's own page: which platforms their dashboard account is
// connected to, with "Connect" for the ones that are not and "Disconnect" for the ones that are,
// and the Sylo app devices signed in to it, each with "Revoke".
import { Router } from 'express';
import { config } from '../../config.js';
import { deleteAccount, unlinkIdentity } from '../../db/accounts.js';
import { revokeApiToken } from '../../db/apiTokens.js';
import { accountDevices, accountPlatforms } from '../lib/accountView.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { timeAgo } from '../lib/format.js';

const router = Router();

const MESSAGES = {
  connected: { kind: 'ok', text: 'Account connected.' },
  disconnected: { kind: 'ok', text: 'Account disconnected.' },
  last: { kind: 'bad', text: "You can't disconnect your only sign-in — connect another account first." },
  revoked: { kind: 'ok', text: 'Device signed out.' },
  'no-device': { kind: 'bad', text: 'That device was already signed out.' },
  'delete-unconfirmed': { kind: 'bad', text: 'Tick the box to confirm that the account should be deleted.' },
};

router.get(
  '/',
  asyncHandler(async (req, res) => {
    if (!config.authEnabled || !req.account) return res.redirect('/');
    const platforms = accountPlatforms(req.account);
    const devices = (await accountDevices(req.account)).map((d) => ({
      ...d,
      lastUsed: timeAgo(d.lastUsedAt),
    }));
    const flash = MESSAGES[req.query.msg];
    res.render('account', {
      title: 'Account',
      platforms,
      devices,
      flash: flash
        ? { ...flash, text: req.query.msg === 'connected' && req.query.p ? flash.text : flash.text }
        : null,
    });
  })
);

// Sign out one Sylo app device. Only the account's own devices: another account's id is a no-op.
router.post(
  '/devices/:id/revoke',
  asyncHandler(async (req, res) => {
    if (!config.authEnabled || !req.account) return res.redirect('/');
    const ok = await revokeApiToken(req.account.id, req.params.id);
    res.redirect(`/account?msg=${ok ? 'revoked' : 'no-device'}`);
  })
);

router.post(
  '/disconnect/:platform',
  asyncHandler(async (req, res) => {
    if (!config.authEnabled || !req.account) return res.redirect('/');
    const ok = await unlinkIdentity(req.account.id, req.params.platform, { keepSession: req.session?.sid });
    res.redirect(`/account?msg=${ok ? 'disconnected' : 'last'}`);
  })
);

// Delete the whole dashboard account (sign-ins, sessions, app devices, preferences).
router.post(
  '/delete',
  asyncHandler(async (req, res) => {
    if (!config.authEnabled || !req.account) return res.redirect('/');
    if (req.body?.confirm !== 'on') return res.redirect('/account?msg=delete-unconfirmed');
    await deleteAccount(req.account.id);
    req.session = null;
    res.redirect('/');
  })
);

export default router;
