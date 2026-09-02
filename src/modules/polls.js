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
import { EmbedBuilder } from 'discord.js';
import { on } from './dispatch.js';
import { runtime } from '../runtime.js';
import { isModuleEnabled, getGuildModule } from '../db/modules.js';
import { getPoll, duePolls, deletePoll } from '../db/polls.js';
import { log } from '../lib/log.js';

// Regional-indicator A … T — one per option, up to 20.
export const LETTERS = Array.from({ length: 20 }, (_, i) => String.fromCodePoint(0x1f1e6 + i));
export const MAX_OPTIONS = LETTERS.length;
export const MIN_OPTIONS = 2;
const DEFAULT_COLOR = '#5b7cfa';
const isId = (v) => /^\d{17,20}$/.test(v ?? '');
const hex = (v) => (/^#?[0-9a-f]{6}$/i.test(v ?? '') ? `#${String(v).replace('#', '')}` : '');
const httpUrl = (v) => (/^https?:\/\/\S+$/i.test(v ?? '') ? String(v) : '');

export const POLL_PLACEHOLDERS = ['{question}', '{choices}', '{ends}', '{mode}'];
export const RESULTS_PLACEHOLDERS = ['{question}', '{results}', '{total}', '{winner}', '{mode}'];

function normMsg(m = {}, legacyColor) {
  return {
    content: String(m.content ?? '').slice(0, 1500),
    title: String(m.title ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200),
    color: hex(m.color) || hex(legacyColor) || DEFAULT_COLOR,
    footer: String(m.footer ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300),
    image: httpUrl(m.image),
  };
}

export function normalisePollsConfig(raw = {}) {
  return {
    voteRoleMode: raw.voteRoleMode === 'deny' ? 'deny' : 'allow',
    voteRoles: [...new Set((Array.isArray(raw.voteRoles) ? raw.voteRoles : []).filter(isId))].slice(0, 25),
    pollMessage: normMsg(raw.pollMessage, raw.color),
    resultsMessage: normMsg(raw.resultsMessage, raw.color),
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

/**
 * Count reactions on a poll message.
 * @returns {Promise<Array<{ count: number, voters: Set<string> }>>} one entry per option
 */
async function tally(message, poll, config) {
  const out = poll.options.map(() => ({ count: 0, voters: new Set() }));
  for (let i = 0; i < poll.options.length; i += 1) {
    const rx = message.reactions.cache.get(LETTERS[i]);
    if (!rx) continue;
    let users;
    try {
      users = await rx.users.fetch({ limit: 100 });
    } catch {
      users = rx.users.cache;
    }
    for (const [uid, user] of users) {
      if (user.bot) continue;
      const member =
        message.guild.members.cache.get(uid) ?? (await message.guild.members.fetch(uid).catch(() => null));
      if (!allowedToVote(member, config)) continue;
      out[i].voters.add(uid);
      out[i].count += 1;
    }
  }
  return out;
}

// --- ending ----------------------------------------------------------

/** Close a poll: tally, post results, tidy up. Safe to call more than once. */
export async function endPoll(messageId) {
  const poll = getPoll(messageId);
  if (!poll) return;
  deletePoll(messageId); // claim it first so the loop / a race can't double-post

  const guild = runtime.client?.guilds.cache.get(poll.guild_id);
  const channel = guild?.channels.cache.get(poll.channel_id);
  if (!channel?.isTextBased()) return;

  const config = normalisePollsConfig(getGuildModule(poll.guild_id, 'polls').config);

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

  const poll = getPoll(message.id);
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

  // Max-votes cap → close early.
  if (poll.max_votes) {
    const counts = await tally(message, poll, config);
    const voters = new Set();
    counts.forEach((c) => c.voters.forEach((v) => voters.add(v)));
    if (voters.size >= poll.max_votes) await endPoll(message.id);
  }
});

// --- expiry loop -------------------------------------------------------

const TICK_MS = 15_000;
const timer = setInterval(() => {
  if (!runtime.client?.isReady()) return;
  for (const poll of duePolls(Date.now())) {
    if (isModuleEnabled(poll.guild_id, 'polls') && runtime.client.guilds.cache.has(poll.guild_id)) {
      endPoll(poll.message_id).catch((err) => log.error('module:polls', 'end failed:', err.message));
    } else {
      deletePoll(poll.message_id); // module off or bot gone — just clear it
    }
  }
}, TICK_MS);
timer.unref();
