// Starboard: highlight messages that get enough of a reaction by re-posting
// them (as an embed) into a dedicated channel. Multiple boards per guild.
//
// config shape: { boards: [ { id, name, channelId, emojis: [key], threshold,
//   multiPerUser, autoReact, autoReactFirstOnly, removeOnUnstar, repostCooldown,
//   removeOnDelete, ignoreSelfStars, removeSelfStarReactions, ignoreBotMessages,
//   removeBotReactions, minAgeMinutes, maxAgeMinutes, roleMode: 'allow'|'deny',
//   roleList: [], channelMode, channelList: [] } ] }
// `key` for an emoji is its custom id, or the unicode character. [] = any emoji.
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionsBitField,
} from 'discord.js';
import { on } from './dispatch.js';
import { runtime } from '../runtime.js';
import {
  getStarboardEntry,
  getStarboardEntryByPost,
  upsertStarboardEntry,
  setStarboardPost,
  setStarboardCount,
  deleteStarboardEntry,
} from '../db/starboard.js';

const STAR_COLOR = 0xf5c518;
const POST_COOLDOWN_MS = 60_000;

const clampInt = (v, min, max, dflt) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
};
const id = (v) => (/^\d{17,20}$/.test(v ?? '') ? v : '');
const idList = (v) => [...new Set((Array.isArray(v) ? v : [v]).filter((x) => /^\d{17,20}$/.test(x)))].slice(0, 25);

function emojiList(v) {
  return [
    ...new Set(
      (Array.isArray(v) ? v : String(v ?? '').split(/[\s,]+/))
        .map((s) => String(s).trim())
        .map((s) => {
          const m = s.match(/^<a?:\w+:(\d+)>$/);
          return m ? m[1] : s;
        })
        .filter(Boolean)
    ),
  ].slice(0, 10);
}

export function normaliseStarboard(raw = {}) {
  return {
    boards: (Array.isArray(raw.boards) ? raw.boards : []).slice(0, 10).map((b, i) => ({
      id: b.id ? String(b.id) : String(i),
      name: String(b.name ?? 'Starboard').slice(0, 60) || 'Starboard',
      channelId: id(b.channelId),
      emojis: emojiList(b.emojis),
      threshold: clampInt(b.threshold, 1, 100, 3),
      multiPerUser: Boolean(b.multiPerUser),
      autoReact: b.autoReact !== false,
      autoReactFirstOnly: Boolean(b.autoReactFirstOnly),
      removeOnUnstar: b.removeOnUnstar !== false,
      repostCooldown: Boolean(b.repostCooldown),
      removeOnDelete: b.removeOnDelete !== false,
      ignoreSelfStars: b.ignoreSelfStars !== false,
      removeSelfStarReactions: Boolean(b.removeSelfStarReactions),
      ignoreBotMessages: b.ignoreBotMessages !== false,
      removeBotReactions: Boolean(b.removeBotReactions),
      minAgeMinutes: clampInt(b.minAgeMinutes, 0, 525600, 0),
      maxAgeMinutes: clampInt(b.maxAgeMinutes, 0, 525600, 0),
      roleMode: b.roleMode === 'deny' ? 'deny' : 'allow',
      roleList: idList(b.roleList),
      channelMode: b.channelMode === 'deny' ? 'deny' : 'allow',
      channelList: idList(b.channelList),
    })),
  };
}

// --- rendering ------------------------------------------------------------

function emojiDisplay(board, guild) {
  const first = board.emojis[0];
  if (!first) return '⭐';
  if (/^\d+$/.test(first)) {
    const e = guild.emojis.cache.get(first);
    return e ? e.toString() : '⭐';
  }
  return first;
}
function reactToken(key, guild) {
  if (/^\d+$/.test(key)) {
    const e = guild.emojis.cache.get(key);
    return e ? `${e.name}:${e.id}` : null;
  }
  return key;
}

function renderPost(message, board, count, guild) {
  const embed = new EmbedBuilder()
    .setColor(STAR_COLOR)
    .setAuthor({
      name: message.member?.displayName || message.author.username,
      iconURL: message.author.displayAvatarURL(),
    })
    .setDescription(message.content ? message.content.slice(0, 3800) : '*no text*')
    .setFooter({ text: `ID ${message.id}` })
    .setTimestamp(message.createdTimestamp);

  const img =
    [...message.attachments.values()].find((a) => (a.contentType || '').startsWith('image/'))?.url ||
    message.embeds[0]?.image?.url ||
    message.embeds[0]?.thumbnail?.url ||
    null;
  if (img) embed.setImage(img);

  return {
    content: `${emojiDisplay(board, guild)} **${count}** · <#${message.channelId}>`,
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Jump to message').setURL(message.url)
      ),
    ],
    allowedMentions: { parse: [] },
  };
}

// --- star counting -----------------------------------------------------

async function computeStars(message, board, guild) {
  const matching = [...message.reactions.cache.values()].filter(
    (rx) => !board.emojis.length || board.emojis.includes(rx.emoji.id || rx.emoji.name)
  );
  if (!matching.length) return 0;

  const filterByRole = board.roleList.length > 0;
  if (board.roleMode === 'deny' && !filterByRole) return 0; // "only these roles" with none picked

  const perUser = new Map(); // userId -> matching-reaction count
  for (const rx of matching) {
    let users;
    try {
      users = await rx.users.fetch({ limit: 100 });
    } catch {
      users = rx.users.cache;
    }
    for (const [uid, user] of users) {
      if (user.bot) continue;
      if (board.ignoreSelfStars && uid === message.author?.id) continue;
      perUser.set(uid, (perUser.get(uid) ?? 0) + 1);
    }
  }

  if (filterByRole) {
    for (const uid of [...perUser.keys()]) {
      const m = guild.members.cache.get(uid) ?? (await guild.members.fetch(uid).catch(() => null));
      const has = m ? board.roleList.some((r) => m.roles.cache.has(r)) : false;
      const allowed = m && (board.roleMode === 'deny' ? has : !has);
      if (!allowed) perUser.delete(uid);
    }
  }

  if (board.multiPerUser && board.emojis.length > 1) {
    let total = 0;
    for (const c of perUser.values()) total += c;
    return total;
  }
  return perUser.size;
}

async function fetchPost(guild, channelId, msgId) {
  const ch = guild.channels.cache.get(channelId);
  if (!ch?.isTextBased() || !msgId) return null;
  return ch.messages.fetch(msgId).catch(() => null);
}

// --- backfill on save ------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Which non-thread text channels a board should look at, honouring its
// channel restriction and the bot's read permissions.
function watchedChannels(guild, board) {
  const me = guild.members.me;
  const need = [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory];
  return [...guild.channels.cache.values()].filter((c) => {
    if (!c.isTextBased?.() || (typeof c.isThread === 'function' && c.isThread())) return false;
    if (c.id === board.channelId) return false;
    if (me && !c.permissionsFor(me)?.has(need)) return false;
    if (board.channelList.length) {
      const inList = board.channelList.includes(c.id);
      if (board.channelMode === 'deny' ? !inList : inList) return false;
    }
    return true;
  });
}

/**
 * Sweep the last ~100 messages of every watched channel and post anything that
 * already clears the threshold but isn't on the board yet. Runs after a board is
 * saved so lowering the bar (or first setup) catches up on existing reactions.
 * @returns {Promise<{ scanned: number, posted: number }>}
 */
export async function rescanBoard(guild, board) {
  if (!/^\d{17,20}$/.test(board.channelId)) return { scanned: 0, posted: 0 };
  const dest = guild.channels.cache.get(board.channelId);
  if (!dest?.isTextBased()) return { scanned: 0, posted: 0 };

  const now = Date.now();
  let scanned = 0;
  let posted = 0;

  for (const ch of watchedChannels(guild, board)) {
    let msgs;
    try {
      msgs = await ch.messages.fetch({ limit: 100 });
    } catch {
      continue;
    }
    for (const message of msgs.values()) {
      scanned += 1;
      if (message.author?.bot && board.ignoreBotMessages) continue;

      const age = now - message.createdTimestamp;
      if (board.minAgeMinutes && age < board.minAgeMinutes * 60_000) continue;
      if (board.maxAgeMinutes && age > board.maxAgeMinutes * 60_000) continue;

      if (getStarboardEntry(guild.id, board.id, message.id)?.post_msg_id) continue;

      const hasMatch = [...message.reactions.cache.values()].some(
        (rx) => !board.emojis.length || board.emojis.includes(rx.emoji.id || rx.emoji.name)
      );
      if (!hasMatch) continue;

      const count = await computeStars(message, board, guild);
      if (count < board.threshold) {
        if (count > 0) {
          upsertStarboardEntry({
            guildId: guild.id,
            boardId: board.id,
            sourceMsgId: message.id,
            sourceChanId: message.channelId,
            starCount: count,
          });
        }
        continue;
      }

      const sent = await dest.send(renderPost(message, board, count, guild)).catch(() => null);
      if (!sent) continue;
      posted += 1;
      upsertStarboardEntry({
        guildId: guild.id,
        boardId: board.id,
        sourceMsgId: message.id,
        sourceChanId: message.channelId,
        starCount: count,
      });
      setStarboardPost(guild.id, board.id, message.id, sent.id, Date.now());

      if (board.autoReact) {
        const src = board.emojis.length ? board.emojis : ['⭐'];
        for (const em of board.autoReactFirstOnly ? src.slice(0, 1) : src) {
          const tok = reactToken(em, guild);
          if (tok) sent.react(tok).catch(() => {});
        }
      }
      await sleep(800); // stay well under the channel send rate limit
    }
  }
  return { scanned, posted };
}

// --- runtime state (per process) -------------------------------------

const lastPostAt = new Map(); // `${guildId}:${boardId}` -> ts  (once per minute)
const repostCd = new Map(); // `${guildId}:${boardId}:${srcMsgId}` -> { until, byUser }

// --- reaction handling ---------------------------------------------------

async function handleReaction({ reaction, user }, rawConfig, guildId, added) {
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
  const guild = message.guild;
  if (!guild) return;

  const cfg = normaliseStarboard(rawConfig);
  const key = reaction.emoji.id || reaction.emoji.name;

  for (const board of cfg.boards) {
    if (!/^\d{17,20}$/.test(board.channelId)) continue;
    if (message.channelId === board.channelId) continue;
    if (board.emojis.length && !board.emojis.includes(key)) continue;

    if (board.channelList.length) {
      const inList = board.channelList.includes(message.channelId);
      if (board.channelMode === 'deny' ? !inList : inList) continue; // deny = "only these channels"
    }

    if (message.author?.bot && board.ignoreBotMessages) {
      if (added && board.removeBotReactions) reaction.users.remove(user.id).catch(() => {});
      continue;
    }
    if (added && board.ignoreSelfStars && board.removeSelfStarReactions && user.id === message.author?.id) {
      reaction.users.remove(user.id).catch(() => {});
    }

    const age = Date.now() - message.createdTimestamp;
    if (board.minAgeMinutes && age < board.minAgeMinutes * 60_000) continue;
    if (board.maxAgeMinutes && age > board.maxAgeMinutes * 60_000) continue;

    const count = await computeStars(message, board, guild);
    const entry = getStarboardEntry(guildId, board.id, message.id);
    const boardKey = `${guildId}:${board.id}`;
    const cdKey = `${boardKey}:${message.id}`;

    if (count >= board.threshold) {
      if (entry?.post_msg_id) {
        setStarboardCount(guildId, board.id, message.id, count);
        const post = await fetchPost(guild, board.channelId, entry.post_msg_id);
        if (post) post.edit({ content: renderPost(message, board, count, guild).content }).catch(() => {});
        continue;
      }
      const cd = repostCd.get(cdKey);
      if (cd && cd.until > Date.now() && cd.byUser === user.id) continue;

      upsertStarboardEntry({
        guildId,
        boardId: board.id,
        sourceMsgId: message.id,
        sourceChanId: message.channelId,
        starCount: count,
      });

      if (Date.now() - (lastPostAt.get(boardKey) ?? 0) < POST_COOLDOWN_MS) continue; // posts on the next reaction

      const ch = guild.channels.cache.get(board.channelId);
      if (!ch?.isTextBased()) continue;
      const posted = await ch.send(renderPost(message, board, count, guild)).catch(() => null);
      if (!posted) continue;
      lastPostAt.set(boardKey, Date.now());
      setStarboardPost(guildId, board.id, message.id, posted.id, Date.now());

      if (board.autoReact) {
        const src = board.emojis.length ? board.emojis : [reaction.emoji.id || reaction.emoji.name];
        const toAdd = board.autoReactFirstOnly ? src.slice(0, 1) : src;
        for (const em of toAdd) {
          const tok = reactToken(em, guild);
          if (tok) posted.react(tok).catch(() => {});
        }
      }
    } else if (entry?.post_msg_id) {
      setStarboardCount(guildId, board.id, message.id, count);
      if (board.removeOnUnstar) {
        const post = await fetchPost(guild, board.channelId, entry.post_msg_id);
        if (post) await post.delete().catch(() => {});
        setStarboardPost(guildId, board.id, message.id, null, null);
        if (!added && board.repostCooldown) {
          repostCd.set(cdKey, { until: Date.now() + POST_COOLDOWN_MS, byUser: user.id });
        }
      } else {
        const post = await fetchPost(guild, board.channelId, entry.post_msg_id);
        if (post) post.edit({ content: renderPost(message, board, count, guild).content }).catch(() => {});
      }
    } else {
      upsertStarboardEntry({
        guildId,
        boardId: board.id,
        sourceMsgId: message.id,
        sourceChanId: message.channelId,
        starCount: count,
      });
    }
  }
}

on('starboard', 'reactionAdd', (payload, cfg, guildId) => handleReaction(payload, cfg, guildId, true));
on('starboard', 'reactionRemove', (payload, cfg, guildId) => handleReaction(payload, cfg, guildId, false));

on('starboard', 'messageDelete', async (message, rawConfig, guildId) => {
  const byPost = getStarboardEntryByPost(message.id);
  if (byPost) {
    setStarboardPost(byPost.guild_id, byPost.board_id, byPost.source_msg_id, null, null);
    return;
  }
  const cfg = normaliseStarboard(rawConfig);
  const guild = runtime.client?.guilds.cache.get(guildId);
  for (const board of cfg.boards) {
    const entry = getStarboardEntry(guildId, board.id, message.id);
    if (!entry) continue;
    if (entry.post_msg_id && board.removeOnDelete && guild) {
      const post = await fetchPost(guild, board.channelId, entry.post_msg_id);
      if (post) await post.delete().catch(() => {});
    }
    deleteStarboardEntry(guildId, board.id, message.id);
  }
});
