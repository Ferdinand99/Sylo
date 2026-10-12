// Turns the raw user/channel/role references parser.js leaves in place
// ("<@123…>", "<#123…>", "<@&123…>", or a bare id) into real objects.
// Mentions and ids only — no name search.
import { ApplicationCommandOptionType as T } from 'discord.js';
import { ParseError } from './parser.js';

const PATTERNS = {
  user: /^<@!?(\d{17,20})>$/,
  channel: /^<#(\d{17,20})>$/,
  role: /^<@&(\d{17,20})>$/,
};

function idFrom(raw, kind) {
  const m = PATTERNS[kind].exec(raw);
  if (m) return m[1];
  return /^\d{17,20}$/.test(raw) ? raw : null;
}

// Cache first; fetch only when the SDK's manager has a fetch() — Fluxer's
// channel/role managers may not.
async function lookup(manager, id) {
  const cached = manager?.cache?.get(id);
  if (cached) return cached;
  if (typeof manager?.fetch !== 'function') return null;
  return (await manager.fetch(id).catch(() => null)) ?? null;
}

// A user the SDK has only seen by id (from a ban, a leave, a voice state) sits in the cache
// without a username, which shows up as "undefined" in every embed; fetch the full one.
async function lookupUser(users, id) {
  const cached = users?.cache?.get(id);
  if (cached?.username !== undefined || typeof users?.fetch !== 'function') return cached ?? null;
  return (await users.fetch(id, { force: true }).catch(() => null)) ?? cached;
}

async function resolveUser(raw, name, { client, guild }) {
  const id = idFrom(raw, 'user');
  const user = id ? ((await lookupUser(client?.users, id)) ?? (await lookup(client?.users, id))) : null;
  if (!user) throw new ParseError(`Could not find a user for "${name}" (use a mention or an id).`);
  return { user, member: guild ? await lookup(guild.members, id) : null };
}

async function resolveIn(manager, raw, kind, name, label) {
  const id = idFrom(raw, kind);
  const found = id ? await lookup(manager, id) : null;
  if (!found) throw new ParseError(`Could not find a ${label} for "${name}" (use a mention or an id).`);
  return found;
}

/**
 * @param {Record<string, { type: number, value: unknown }>} values  from parseArgs()
 * @param {{ client: any, guild?: any }} ctx
 * @returns {Promise<Record<string, any>>}  only the entity options, keyed by option name
 * @throws {ParseError}
 */
export async function resolveOptions(values, { client, guild }) {
  const out = {};
  for (const [name, { type, value }] of Object.entries(values)) {
    if (type === T.User) out[name] = await resolveUser(value, name, { client, guild });
    else if (type === T.Channel)
      out[name] = await resolveIn(guild?.channels, value, 'channel', name, 'channel');
    else if (type === T.Role) out[name] = await resolveIn(guild?.roles, value, 'role', name, 'role');
    else if (type === T.Mentionable) {
      out[name] = PATTERNS.role.test(value)
        ? await resolveIn(guild?.roles, value, 'role', name, 'role')
        : await resolveUser(value, name, { client, guild });
    }
  }
  return out;
}
