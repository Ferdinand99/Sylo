import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { getAccount, getCsrfToken } from '../api.js';
import { useApiData } from '../useApiData.js';
import { notify } from '../notify.js';
import { CHANGELOG_SEEN_EVENT, hasUnseenChangelog, initial } from '../util.js';

const SUPPORT_URL = 'https://discord.gg/GAzR9k5hhS';
const DOCS_URL = 'https://docs.sylobot.com';

// The signed-in person's menu at the right of the top bar: who is signed in,
// the account page, help links and Sign out. Same native <details> pattern
// as ServerSwitcher (closes on a link, a click outside and Escape). Open mode
// has no account, so there is nothing to show.
export default function AccountMenu() {
  const { data: account } = useApiData(() => getAccount(), []);
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
      if (e.key === 'Escape') closeMenu();
    }
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  if (!account || account.open) return null;

  const connected = (account.platforms ?? []).filter((p) => p.connected);
  const name = connected[0]?.username || 'Your account';
  const via = connected.map((p) => p.label).join(' · ');

  // POST with the CSRF header (the logout route refuses anything else), then
  // leave the SPA: the session is gone, so the sign-in page takes over.
  async function signOut() {
    setSigningOut(true);
    try {
      const token = await getCsrfToken();
      await fetch('/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: token ? { 'x-csrf-token': token } : {},
        redirect: 'manual',
      });
      window.location.assign('/');
    } catch {
      setSigningOut(false);
      notify("Couldn't sign out. Check your connection and try again.");
    }
  }

  return (
    <details className="v2-switch v2-acct" ref={detailsRef}>
      <summary aria-label={`Account menu for ${name}${unseen ? ' — new release' : ''}`}>
        <span className="v2-acct-avatar" aria-hidden="true">
          {initial(name)}
          {unseen ? <span className="v2-acct-dot" /> : null}
        </span>
        <span className="v2-switch-caret" aria-hidden="true">
          ▾
        </span>
      </summary>
      <div className="v2-switch-menu v2-acct-menu">
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
        <hr className="v2-acct-sep" />
        <button type="button" className="v2-acct-signout" onClick={signOut} disabled={signingOut}>
          <span>{signingOut ? 'Signing out…' : 'Sign out'}</span>
        </button>
      </div>
    </details>
  );
}
