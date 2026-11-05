import { useEffect, useState } from 'react';
import { getAccount } from './api.js';

// Whether the signed-in person runs this Sylo (OWNER_IDS), read once from /account. Used to show
// setup details (environment variable names) only to the bot owner. Unknown or failing counts as
// "not the owner". On a Sylo without logins (open mode) everyone is the operator.
let cached = null;

export function resetOperatorCache() {
  cached = null;
}

export function useOperator() {
  const [operator, setOperator] = useState(cached ?? false);

  useEffect(() => {
    if (cached !== null) return undefined;
    let live = true;
    (async () => {
      try {
        const account = await getAccount();
        cached = Boolean(account?.open || account?.operator);
        if (live) setOperator(cached);
      } catch {
        // Not signed in, or the call failed: the plain wording is the safe default.
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  return operator;
}
