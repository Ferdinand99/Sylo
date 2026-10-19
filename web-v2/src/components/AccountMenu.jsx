import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { getAccount, getCsrfToken } from '../api.js';
import { useApiData } from '../useApiData.js';
import { notify } from '../notify.js';
import { CHANGELOG_SEEN_EVENT, hasUnseenChangelog, initial } from '../util.js';

const SUPPORT_URL = 'https://discord.gg/GAzR9k5hhS';
const DOCS_URL = 'https://docs.sylobot.com';
const SIGN_OUT_FAILED = "Couldn't sign out. Reload the page and try again.";

// The menu at the right of the top bar: who is signed in, the account page,
// help links, What's new and Sign out. Same native <details> pattern as
// ServerSwitcher (closes on a link, a click outside and Escape). Open mode
// (no login) and a failed account lookup still get the help links and What's
// new, just without the account part.
export default function AccountMenu() {
  const { data: account, error } = useApiData(() => getAccount(), []);
  const detailsRef = useRef(null);
  const [signingOut, setSigningOut] = useState(false);
  const [unseen, setUnseen] = useState(hasUnseenChangelog);

  useEffect(() => {
    const onSeen = () => setUnseen(hasUnseenChangelog());
    window.addEventListener(CHANGELOG_SEEN_EVENT, onSeen);
    return () => window.removeEventListener(CHANGELOG_SEEN_EVENT, onSeen);
  }, []);

  function closeMenu() {
    if (detailsRef.current) detailsRef.current.open = false;
  }

  useEffect(() => {
    function onDocClick(e) {
      if (detailsRef.current?.open && !detailsRef.current.contains(e.target)) closeMenu();
    }
    function onKeyDown(e) {
      if (e.key !== 'Escape' || !detailsRef.current?.open) return;
      // Focus was on a link inside the menu that is about to be hidden: put it
      // back on the menu button instead of losing it to <body>.
      const hadFocus = detailsRef.current.contains(document.activeElement);
      closeMenu();
      if (hadFocus) detailsRef.current.querySelector('summary')?.focus();
    }
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  // Still loading: render nothing rather than a menu that changes shape.
  if (!account && !error) return null;

  const signedIn = Boolean(account && !account.open);
  const connected = signedIn ? (account.platforms ?? []).filter((p) => p.connected) : [];
  const name = connected[0]?.username || 'Your account';
  const via = connected.map((p) => p.label).join(' · ');

  // The logout route answers a redirect whether or not it accepted the CSRF
  // token, so success is checked by asking who is signed in afterwards. A
  // fresh token covers a sign-in in another tab, which rotates it.
  async function signOut() {
    setSigningOut(true);
    try {
      const token = await getCsrfToken({ fresh: true });
      if (!token) throw new Error('no csrf token');
      await fetch('/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'x-csrf-token': token },
        redirect: 'manual',
      });
      const check = await fetch('/api/v2/account', { credentials: 'same-origin' });
      const stillSignedIn = check.ok && (await check.json().catch(() => null))?.open === false;
      if (stillSignedIn) throw new Error('still signed in');
      window.location.assign('/v2/');
    } catch {
      setSigningOut(false);
      notify(SIGN_OUT_FAILED);
    }
  }

  const label = signedIn ? `Account menu for ${name}` : 'Menu';
  return (
    <details className="v2-switch v2-acct" ref={detailsRef}>
      <summary aria-label={`${label}${unseen ? ' — new release' : ''}`}>
        <span className={`v2-acct-avatar${signedIn ? '' : ' is-generic'}`} aria-hidden="true">
          {signedIn ? (
            initial(name)
          ) : (
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />
            </svg>
          )}
          {unseen ? <span className="v2-acct-dot" /> : null}
        </span>
        <span className="v2-switch-caret" aria-hidden="true">
          ▾
        </span>
      </summary>
      <div className="v2-switch-menu v2-acct-menu">
        {signedIn ? (
          <>
            <div className="v2-acct-head">
              <span className="v2-acct-avatar is-large" aria-hidden="true">
                {initial(name)}
              </span>
              <span className="v2-acct-who">
                <strong>{name}</strong>
                {via ? <span>Signed in with {via}</span> : null}
              </span>
            </div>
            <p className="v2-acct-label">Account</p>
            <Link to="/account" onClick={closeMenu}>
              <span>Account &amp; devices</span>
            </Link>
          </>
        ) : null}
        <p className="v2-acct-label">Help</p>
        <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" onClick={closeMenu}>
          <span>Docs</span>
        </a>
        <Link to="/changelog" onClick={closeMenu}>
          <span>What&apos;s new</span>
          {unseen ? <span className="v2-acct-new">New</span> : null}
        </Link>
        <a href={SUPPORT_URL} target="_blank" rel="noopener noreferrer" onClick={closeMenu}>
          <span>Support server</span>
        </a>
        {signedIn ? (
          <>
            <hr className="v2-acct-sep" />
            <button type="button" className="v2-acct-signout" onClick={signOut} disabled={signingOut}>
              <span>{signingOut ? 'Signing out…' : 'Sign out'}</span>
            </button>
          </>
        ) : null}
      </div>
    </details>
  );
}
