import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getMemberNames } from './api.js';
import { parseMentions } from './mentions.js';

// Names of members seen so far, per server, kept for the whole session: a saved <@id> shows as the member's
// name instead of "@member" after a reload, and the same id is never asked twice. An id the server could not
// resolve is remembered as unknown, so it is not asked again either.
const known = new Map(); // `${guildId}:${id}` -> name | null
const subscribers = new Set();
const MAX_PER_REQUEST = 20;

/** Remember a name found elsewhere (a picked suggestion), so the chips and the preview can show it. */
export function rememberMember(guildId, id, name) {
  known.set(`${guildId}:${id}`, name);
  for (const fn of subscribers) fn();
}

/** The member ids mentioned in the given texts, in order of first appearance. */
export function memberIdsIn(...texts) {
  const ids = new Set();
  for (const text of texts) for (const p of parseMentions(text)) if (p.type === 'user') ids.add(p.id);
  return [...ids];
}

/**
 * A Map of id -> name for the members mentioned in the texts, as far as the server can tell. The names
 * arrive after the first render; until then (and for an unknown member) a mention reads "@member".
 */
export function useMemberNames(...texts) {
  const { guildId } = useParams();
  const ids = memberIdsIn(...texts);
  const key = ids.join(',');
  const [, bump] = useState(0);

  useEffect(() => {
    const fn = () => bump((n) => n + 1);
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }, []);

  useEffect(() => {
    if (!guildId) return undefined;
    const missing = ids.filter((id) => !known.has(`${guildId}:${id}`)).slice(0, MAX_PER_REQUEST);
    if (!missing.length) return undefined;
    // Marked as asked at once, so two fields mentioning the same member send one request.
    for (const id of missing) known.set(`${guildId}:${id}`, null);
    Promise.resolve()
      .then(() => getMemberNames(guildId, missing))
      .then((res) => {
        for (const id of missing) known.set(`${guildId}:${id}`, res?.names?.[id] ?? null);
        for (const fn of subscribers) fn();
      })
      .catch(() => {
        // Asked again next time; until then the mention reads "@member".
        for (const id of missing) known.delete(`${guildId}:${id}`);
      });
    return undefined;
    // `key` is the content of `ids`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guildId, key]);

  const map = new Map();
  for (const id of ids) {
    const name = known.get(`${guildId}:${id}`);
    if (name) map.set(id, name);
  }
  return map;
}

/** For tests: forget everything. */
export function resetMemberNames() {
  known.clear();
}
