// Polls: members create polls with /poll and vote by reacting with the letter
// emoji for their choice. A background loop closes polls at their end time; a
// results embed is posted when a poll ends (via the loop, /poll-end, or hitting
// the max-votes cap).
//
// config shape:
//   { voteRoleMode: 'allow' | 'deny', voteRoles: [],
//     pollMessage:    { content, title, color, footer, image },
//     resultsMessage: { content, title, color, footer, image } }
// pollMessage placeholders:    {question} {choices} {ends} {mode}
// resultsMessage placeholders: {question} {results} {total} {winner} {mode}
import { allClientsReady, guildByKey, guildKey } from '../platform/platformOf.js';
import { EmbedBuilder } from 'discord.js';
import { on } from './dispatch.js';
import { isModuleEnabled, getGuildModule } from '../db/modules.js';
import { getPoll, duePolls, deletePoll } from '../db/polls.js';
import { log } from '../lib/log.js';
import { every } from './schedule.js';

// Regional-indicator A … T — one per option, up to 20.
export const LETTERS = Array.from({ length: 20 }, (_, i) => String.fromCodePoint(0x1f1e6 + i));
export const MAX_OPTIONS = LETTERS.length;
export const MIN_OPTIONS = 2;
const DEFAULT_COLOR = '#5b7cfa';
const isId = (v) => /^\d{17,20}$/.test(v ?? '');
const hex = (v) => (/^#?[0-9a-f]{6}$/i.test(v ?? '') ? `#${String(v).replace('#', '')}` : '');
const httpUrl = (v) => (/^https?:\/\/\S+$/i.test(v ?? '') ? String(v) : '');

/** Setting limits, served to the dashboard (modules/limits.js). Both messages share the same ones. */
export const LIMITS = {
  voteRoles: { maxItems: 25 },
  'pollMessage.content': { maxLength: 1500 },
  'pollMessage.title': { maxLength: 200 },
  'pollMessage.footer': { maxLength: 300 },
  'resultsMessage.content': { maxLength: 1500 },
  'resultsMessage.title': { maxLength: 200 },
  'resultsMessage.footer': { maxLength: 300 },
};

export const POLL_PLACEHOLDERS = ['{question}', '{choices}', '{ends}', '{mode}'];
export const RESULTS_PLACEHOLDERS = ['{question}', '{results}', '{total}', '{winner}', '{mode}'];

function normMsg(m = {}, legacyColor, key) {
  return {
    content: String(m.content ?? '').slice(0, LIMITS[`${key}.content`].maxLength),
    title: String(m.title ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, LIMITS[`${key}.title`].maxLength),
    color: hex(m.color) || hex(legacyColor) || DEFAULT_COLOR,
    footer: String(m.footer ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, LIMITS[`${key}.footer`].maxLength),
    image: httpUrl(m.image),
  };
}

export function normalisePollsConfig(raw = {}) {
  return {
    voteRoleMode: raw.voteRoleMode === 'deny' ? 'deny' : 'allow',
    voteRoles: [...new Set((Array.isArray(raw.voteRoles) ? raw.voteRoles : []).filter(isId))].slice(
      0,
      LIMITS.voteRoles.maxItems
    ),
    pollMessage: normMsg(raw.pollMessage, raw.color, 'pollMessage'),
    resultsMessage: normMsg(raw.resultsMessage, raw.color, 'resultsMessage'),
  };
}

/** Split a raw "choices" string into a clean list ( `|`, else newline, else comma ). */
export function parseChoices(raw) {
  const s = String(raw ?? '');
  const sep = s.includes('|') ? /\s*\|\s*/ : s.includes('\n') ? /\s*\n\s*/ : /\s*,\s*/;
  const seen = new Set();
  return s
    .split(sep)
    .map((c) => c.trim().slice(0, 80))
    .filter((c) => {
      if (!c || seen.has(c.toLowerCase())) return false;
      seen.add(c.toLowerCase());
      return true;
    })
    .slice(0, MAX_OPTIONS);
}

// --- rendering ----------------------------------------------------------

const colorInt = (c) => parseInt((c || DEFAULT_COLOR).replace('#', ''), 16);
const subst = (str, vars) =>
  String(str ?? '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

function bar(pct) {
  const filled = Math.round(pct / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

function modeText(poll) {
  const parts = [poll.multiple ? 'Multiple choices allowed' : 'One vote each'];
  if (poll.max_votes) parts.push(`closes at ${poll.max_votes} votes`);
  return parts.join(' · ');
}

/** Message payload for a live poll. Honours config.pollMessage overrides. */
export function buildPollPayload(poll, config) {
  const pm = normalisePollsConfig(config).pollMessage;
  const vars = {
    question: poll.question,
    choices: poll.options.map((o, i) => `${LETTERS[i]}  ${o}`).join('\n\n'),
    ends: poll.ends_at ? `Ends <t:${Math.floor(poll.ends_at / 1000)}:R>` : 'No time limit',
    mode: modeText(poll),
  };

  const embed = new EmbedBuilder()
    .setColor(colorInt(pm.color))
    .setTitle(subst(pm.title || '📊 {question}', vars).slice(0, 256))
    .setDescription(vars.choices)
    .setFooter({ text: subst(pm.footer || `${vars.ends} · {mode}`, vars).slice(0, 2048) })
    .setTimestamp(poll.created_at || Date.now());
  if (pm.image) embed.setImage(pm.image);

  const payload = { embeds: [embed], allowedMentions: { parse: [] } };
  if (pm.content) payload.content = subst(pm.content, vars).slice(0, 2000);
  return payload;
}

/** Message payload announcing a poll's results. Honours config.resultsMessage. */
export function buildResultsPayload(poll, tally, config) {
  const rm = normalisePollsConfig(config).resultsMessage;
  const total = tally.reduce((n, t) => n + (t?.count ?? 0), 0);
  const results = poll.options
    .map((opt, i) => {
      const count = tally[i]?.count ?? 0;
      const pct = total ? (count / total) * 100 : 0;
      return `${LETTERS[i]}  **${opt}**\n${bar(pct)}  ${pct.toFixed(1)}% · ${count} vote${count === 1 ? '' : 's'}`;
    })
    .join('\n\n');
  const winner = total
    ? poll.options[tally.reduce((bi, t, i, a) => ((t?.count ?? 0) > (a[bi]?.count ?? 0) ? i : bi), 0)]
    : '—';
  const vars = { question: poll.question, results, total, winner, mode: modeText(poll) };

  const embed = new EmbedBuilder()
    .setColor(colorInt(rm.color))
    .setTitle(subst(rm.title || '📊 Results — {question}', vars).slice(0, 256))
    .setDescription(results || '*No votes were cast.*')
    .setFooter({
      text: subst(
        rm.footer || (total ? 'Winner: {winner} · {total} total votes' : 'No votes were cast'),
        vars
      ).slice(0, 2048),
    })
    .setTimestamp(Date.now());
  if (rm.image) embed.setImage(rm.image);

  const payload = { embeds: [embed], allowedMentions: { parse: [] } };
  if (rm.content) payload.content = subst(rm.content, vars).slice(0, 2000);
  return payload;
}

// --- vote counting ----------------------------------------------------

function allowedToVote(member, config) {
  if (!config.voteRoles.length) return true;
  const has = member?.roles?.cache?.hasAny(...config.voteRoles) ?? false;
  return config.voteRoleMode === 'deny' ? !has : has;
}

const MAX_VOTERS_PER_OPTION = 5000; // 50 pages: a bound on the API calls one tally makes
const MAX_VOTER_PAGES = 60; // hard bound on pages read for one option, whatever the source returns

/**
 * Everyone who reacted, page by page (the API gives 100 at a time), up to `cap`. Stops when a
 * page adds nobody new (a source that ignores the cursor) and after MAX_VOTER_PAGES. Falls back
 * to the cache when fetching fails.
 * @returns {Promise<Map<string, object>>}
 */
export async function reactors(rx, cap = MAX_VOTERS_PER_OPTION) {
  const all = new Map();
  let after;
  try {
    for (let pages = 0; pages < MAX_VOTER_PAGES && all.size < cap; pages += 1) {
      const page = await rx.users.fetch({ limit: 100, ...(after ? { after } : {}) });
      const before = all.size;
      for (const [id, user] of page) if (all.size < cap) all.set(id, user);
      if (page.size < 100) break;
      const next = [...page.keys()].at(-1);
      if (all.size === before || next === after) break; // no progress: the cursor was ignored
      after = next;
    }
  } catch {
    if (all.size === 0) return rx.users.cache;
  }
  return all;
}

// A member lookup that found nobody (they left) is remembered for a minute, so a poll that is
// tallied again and again does not ask the API about the same departed user each time.
const NO_MEMBER_TTL_MS = 60_000;
const NO_MEMBER_MAX = 5000;
const noMember = new Map(); // `${guildId}:${userId}` -> expiry (ms)

/** The guild member for `uid`, or null. `memo` makes it one lookup per user within a tally. */
async function memberOf(guild, uid, memo) {
  if (memo.has(uid)) return memo.get(uid);
  let member = guild.members.cache.get(uid) ?? null;
  if (!member) {
    const key = `${guildKey(guild)}:${uid}`;
    if ((noMember.get(key) ?? 0) <= Date.now()) {
      member = await guild.members.fetch(uid).catch(() => null);
      if (member) noMember.delete(key);
      else {
        if (noMember.size >= NO_MEMBER_MAX) noMember.clear();
        noMember.set(key, Date.now() + NO_MEMBER_TTL_MS);
      }
    }
  }
  memo.set(uid, member);
  return member;
}

/**
 * Count the votes on a poll message. With `strict`, a reactor who can no longer be found in the
 * server (they left) is not an eligible voter — used for the early-close check, so reactions from
 * accounts that have gone cannot keep it busy.
 */
async function tally(message, poll, config, { strict = false } = {}) {
  const out = poll.options.map(() => ({ count: 0, voters: new Set() }));
  const members = new Map(); // one lookup per distinct user across all options
  for (let i = 0; i < poll.options.length; i += 1) {
    const rx = message.reactions.cache.get(LETTERS[i]);
    if (!rx) continue;
    const users = await reactors(rx);
    for (const [uid, user] of users) {
      if (user.bot) continue;
      const member = await memberOf(message.guild, uid, members);
      if (strict && !member) continue;
      if (!allowedToVote(member, config)) continue;
      out[i].voters.add(uid);
      out[i].count += 1;
    }
  }
  return out;
}

// --- max-votes early close ----------------------------------------------

// Every qualifying reaction used to run a full tally, and the gateway does not wait for handlers,
// so a burst of reactions ran many tallies at once. Now one check runs per poll at a time, at most
// one every MAX_VOTES_CHECK_MS, and reactions that arrive meanwhile share a single trailing check.
let maxVotesCheckMs = 5000;
const maxVotesChecks = new Map(); // messageId -> { running, dirty, timer, last }

/** For tests. */
export const _setMaxVotesCheckMs = (ms) => {
  maxVotesCheckMs = ms;
};

async function closeIfMaxVotes(messageId, message, config) {
  const poll = await getPoll(messageId);
  if (!poll?.max_votes) return false;
  const counts = await tally(message, poll, config, { strict: true });
  const voters = new Set();
  counts.forEach((c) => c.voters.forEach((v) => voters.add(v)));
  if (voters.size < poll.max_votes) return false;
  await endPoll(messageId);
  return true;
}

function checkMaxVotes(message, config) {
  const id = message.id;
  let st = maxVotesChecks.get(id);
  if (!st) {
    if (maxVotesChecks.size >= 2000) {
      for (const [k, v] of maxVotesChecks) if (!v.running && !v.timer) maxVotesChecks.delete(k);
    }
    st = { running: false, dirty: false, timer: null, last: 0 };
    maxVotesChecks.set(id, st);
  }
  const state = st;
  if (state.running || state.timer) {
    state.dirty = true; // fold into the check that is running or waiting
    return Promise.resolve();
  }

  const start = async () => {
    state.timer = null;
    state.running = true;
    state.dirty = false;
    let closed = false;
    try {
      closed = await closeIfMaxVotes(id, message, config);
    } catch (err) {
      log.error('module:polls', 'max-votes check failed:', err.message);
    } finally {
      state.running = false;
      state.last = Date.now();
    }
    if (closed || !state.dirty) return;
    state.timer = setTimeout(start, maxVotesCheckMs);
    state.timer.unref?.();
  };

  const wait = state.last + maxVotesCheckMs - Date.now();
  if (wait <= 0) return start();
  state.dirty = true;
  state.timer = setTimeout(start, wait);
  state.timer.unref?.();
  return Promise.resolve();
}

// --- ending ----------------------------------------------------------

/** Close a poll: tally, post results, tidy up. Safe to call more than once. */
export async function endPoll(messageId) {
  const poll = await getPoll(messageId);
  if (!poll) return;
  await deletePoll(messageId); // claim it first so the loop / a race can't double-post
  maxVotesChecks.delete(messageId);

  const guild = guildByKey(poll.guild_id);
  const channel = guild?.channels.cache.get(poll.channel_id);
  if (!channel?.isTextBased()) return;

  const config = normalisePollsConfig((await getGuildModule(poll.guild_id, 'polls')).config);

  const message = await channel.messages.fetch(messageId).catch(() => null);
  const counts = message ? await tally(message, poll, config) : poll.options.map(() => ({ count: 0 }));

  await channel.send(buildResultsPayload(poll, counts, config)).catch(() => {});

  if (message) {
    const closed = buildPollPayload(poll, config);
    closed.embeds[0].setFooter({ text: '🔒 Poll closed' });
    await message.edit({ content: closed.content ?? '', embeds: closed.embeds }).catch(() => {});
    await message.reactions.removeAll().catch(() => {});
  }
}

// --- reaction handling ---------------------------------------------------

on('polls', 'reactionAdd', async ({ reaction, user }, rawConfig, _guildId) => {
  if (!user || user.bot) return;
  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch {
      return;
    }
  }
  const message = reaction.message;
  if (message.partial) {
    try {
      await message.fetch();
    } catch {
      return;
    }
  }

  const poll = await getPoll(message.id);
  if (!poll) return;

  const key = reaction.emoji.name;
  const idx = LETTERS.indexOf(key);
  const config = normalisePollsConfig(rawConfig);

  // Not one of this poll's option letters — clear it to keep the tally clean.
  if (idx === -1 || idx >= poll.options.length) {
    reaction.users.remove(user.id).catch(() => {});
    return;
  }

  // Role restriction.
  const member =
    message.guild.members.cache.get(user.id) ??
    (await message.guild.members.fetch(user.id).catch(() => null));
  if (!allowedToVote(member, config)) {
    reaction.users.remove(user.id).catch(() => {});
    return;
  }

  // Single-vote mode: drop this user's other option reactions.
  if (!poll.multiple) {
    for (let i = 0; i < poll.options.length; i += 1) {
      if (i === idx) continue;
      const other = message.reactions.cache.get(LETTERS[i]);
      if (other?.users.cache.has(user.id)) other.users.remove(user.id).catch(() => {});
    }
  }

  // Max-votes cap → close early. The reaction counts are an upper bound on the voters (they
  // include the bot's own and anyone ineligible), so a full tally only runs once it could be met.
  if (poll.max_votes) {
    let upperBound = 0;
    for (let i = 0; i < poll.options.length; i += 1) {
      const rx = message.reactions.cache.get(LETTERS[i]);
      if (!rx) continue;
      if (typeof rx.count !== 'number') {
        upperBound = Infinity; // no count on this platform: tally to be sure
        break;
      }
      upperBound += Math.max(0, rx.count - (rx.me ? 1 : 0));
    }
    if (upperBound < poll.max_votes) return;
    await checkMaxVotes(message, config);
  }
});

// --- expiry loop -------------------------------------------------------

const TICK_MS = 15_000;
every('polls', TICK_MS, async () => {
  if (!allClientsReady()) return;
  for (const poll of await duePolls(Date.now())) {
    if ((await isModuleEnabled(poll.guild_id, 'polls')) && Boolean(guildByKey(poll.guild_id))) {
      endPoll(poll.message_id).catch((err) => log.error('module:polls', 'end failed:', err.message));
    } else {
      await deletePoll(poll.message_id); // module off or bot gone — just clear it
    }
  }
});
