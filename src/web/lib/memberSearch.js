// Member search for the dashboard and the Sylo app's member picker: members of one server by name
// or by a pasted id. Looks at the members Sylo has cached; an exact id is looked up live, so a
// member who has not been seen since the last restart can still be found.

/** How many members a search returns at most unless the caller asks for fewer. */
export const MEMBER_SEARCH_LIMIT = 25;
/** The longest search text that is looked at. */
const MAX_QUERY = 100;

const isId = (v) => /^\d{17,20}$/.test(v);

/**
 * Members of `guild` matching `query`: a display name, username or tag containing the text (case
 * does not matter), or exactly the id. Bots are never returned. No text finds nobody.
 * @param {{ members: { cache: Map<string, any>, fetch: (id: string) => Promise<any> } }} guild
 * @param {unknown} query
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<{ id: string, name: string, username: string }[]>}
 */
export async function searchMembers(guild, query, { limit = MEMBER_SEARCH_LIMIT } = {}) {
  const q = (typeof query === 'string' ? query : '').trim().toLowerCase().slice(0, MAX_QUERY);
  if (!q) return [];
  const found = [];
  if (isId(q)) {
    const m = guild.members.cache.get(q) ?? (await guild.members.fetch(q).catch(() => null));
    if (m && !m.user?.bot) found.push(m);
  } else {
    for (const m of guild.members.cache.values()) {
      if (m.user?.bot) continue;
      const names = [m.displayName, m.user?.username, m.user?.tag].map((v) => String(v ?? '').toLowerCase());
      if (names.some((n) => n.includes(q))) found.push(m);
      if (found.length >= limit) break;
    }
  }
  return found.slice(0, limit).map((m) => ({
    id: m.id,
    name: m.displayName ?? m.user?.username ?? m.id,
    username: m.user?.username ?? '',
  }));
}
