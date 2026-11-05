import { useEffect, useState } from 'react';
import { getAccount } from './api.js';

// Whether the signed-in person runs this Sylo (OWNER_IDS), read once from /account. Used to show
// setup details (environment variable names) only to the bot owner. Unknown or failing counts as
// "not the owner". On a Sylo without logins (open mode) everyone is the operator.
let cached = null;
// One request shared by every component that mounts before the answer is in.
let pending = null;

export function resetOperatorCache() {
  cached = null;
  pending = null;
}

function loadOperator() {
  pending ??= Promise.resolve()
    .then(() => getAccount())
    .then((account) => Boolean(account?.open || account?.operator))
    // Not signed in, or the call failed: the plain wording is the safe default, and it is
    // remembered so the page doesn't ask again for every hint it shows.
    .catch(() => false)
    .then((value) => {
      cached = value;
      return value;
    });
  return pending;
}

export function useOperator() {
  const [operator, setOperator] = useState(cached ?? false);

  useEffect(() => {
    if (cached !== null) return undefined;
    let live = true;
    loadOperator().then((value) => {
      if (live) setOperator(value);
    });
    return () => {
      live = false;
    };
  }, []);

  return operator;
}
