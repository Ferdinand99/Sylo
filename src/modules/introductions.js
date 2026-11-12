// Introductions: a member answers a few questions in DM and Sylo posts a "server membership card"
// for them in the introductions channel. One card per member per server; running /intro again
// re-asks the questions (with the old answers offered) and edits the card in place.
//
// The questions are asked by the shared DM questionnaire (bot/lib/dmQuestionnaire.js). This file
// owns what is specific to introductions: the settings and their normaliser, the card, posting and
// editing it, keeping it current when the member's roles change, and removing it.
//
// config shape:
//   { channelId, questions: [{ id, label, prompt, required, maxLength, inline }],
//     roleGroups: [{ name, roleIds, hideWhenEmpty }], showRoles, colorMode, color, description,
//     footer, deleteOnLeave, promptText, promptChannelId, promptMessageId }
//
// Safety: answers are stored with @everyone, @here and role mentions removed, and are escaped when
// the card is built, so an answer is always plain text. Cards are posted with allowedMentions set
// to none. Answers are never logged.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } from 'discord.js';
import { randomBytes } from 'node:crypto';
import { on } from './dispatch.js';
import { getGuildModule, isModuleEnabled } from '../db/modules.js';
import { guildEmbedColor } from '../db/guildSettings.js';
import {
  answersOf,
  clearIntroductionMessage,
  deleteIntroduction,
  getIntroduction,
  getIntroductionByMessage,
  saveIntroduction,
} from '../db/introductions.js';
import { guildByKey, guildKey, platformOfGuild, rawGuildId } from '../platform/platformOf.js';
import { startQuestionnaire } from '../bot/lib/dmQuestionnaire.js';
import { registerComponent } from '../bot/lib/components.js';
import { idList } from '../web/lib/idList.js';
import { sweepMap } from '../lib/sweepMap.js';
import { log } from '../lib/log.js';
import { jumpUrl } from './quoteBoard.js';

/** Setting limits, served to the dashboard (modules/limits.js). */
export const LIMITS = {
  questions: { maxItems: 8 },
  'questions[].label': { maxLength: 45 },
  'questions[].prompt': { maxLength: 300 },
  'questions[].maxLength': { min: 1, max: 1024 },
  roleGroups: { maxItems: 10 },
  'roleGroups[].name': { maxLength: 45 },
  'roleGroups[].roleIds': { maxItems: 25 },
  description: { maxLength: 1000 },
  footer: { maxLength: 200 },
  promptText: { maxLength: 500 },
};

export const INTRO_PLACEHOLDERS = ['{user}', '{user.name}', '{server}', '{rolegroup:<name>}'];

const DEFAULT_PROMPT_TEXT =
  'Introduce yourself! Press the button and Sylo asks you a few questions in DM, then posts your card here.';
const DEFAULT_MAX_LENGTH = 500;
const CREATE_BUTTON_ID = 'intro:create';

/** The questions a server gets when it switches the module on and has not changed them. */
export const DEFAULT_QUESTIONS = Object.freeze([
  {
    id: 'about',
    label: 'About me',
    prompt: 'Tell us a little about yourself.',
    required: true,
    maxLength: 500,
    inline: false,
  },
  {
    id: 'likes',
    label: 'Likes',
    prompt: 'What do you like? Hobbies, games, music, anything.',
    required: false,
    maxLength: 300,
    inline: false,
  },
  {
    id: 'dislikes',
    label: 'Dislikes',
    prompt: 'Anything you do not like?',
    required: false,
    maxLength: 300,
    inline: false,
  },
  {
    id: 'pronouns',
    label: 'Pronouns',
    prompt: 'Which pronouns do you use?',
    required: false,
    maxLength: 40,
    inline: true,
  },
  {
    id: 'dms',
    label: 'DMs',
    prompt: 'Are your DMs open, closed, or ask first?',
    required: false,
    maxLength: 40,
    inline: true,
  },
]);

// --- text helpers ----------------------------------------------------------------------------------

/** Cut to `max` UTF-16 units, ending in "…", without half an emoji or half an escape at the end. */
export function cut(value, max) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  let out = text.slice(0, Math.max(0, max - 1));
  if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
  const trailing = /\\+$/.exec(out)?.[0].length ?? 0;
  if (trailing % 2 === 1) out = out.slice(0, -1);
  return `${out}…`;
}

/** Cut without an ellipsis (settings: a limit is a limit, not a hint). */
const clip = (value, max) => {
  const out = String(value ?? '').slice(0, max);
  return /[\uD800-\uDBFF]$/.test(out) ? out.slice(0, -1) : out;
};

// Zero-width non-joiner and joiner: format characters that emoji sequences and some scripts need.
const JOINERS = String.fromCharCode(0x200c, 0x200d);

/** Remove @everyone, @here and role mentions, and control characters, from an answer. */
export function cleanAnswer(value) {
  return (
    String(value ?? '')
      .replace(/@(?:everyone|here)\b/gi, '')
      .replace(/<@&\d+>/g, '')
      // control characters (a line break and a tab stay) ...
      .replace(/[^\P{Cc}\n\t]/gu, '')
      // ... and invisible or direction-changing format characters, except the joiners that emoji and
      // some scripts need
      .replace(/\p{Cf}/gu, (c) => (JOINERS.includes(c) ? c : ''))
      .trim()
  );
}

/** Escape what would turn plain text into formatting, mentions or links in an embed. */
export function escapeMarkdown(value) {
  return String(value ?? '')
    .replace(/([\\`*_~|[\]<>])/g, '\\$1')
    .replace(/^([ \t]*)([#>-])/gm, '$1\\$2');
}

const hex = (v) => (/^#?[0-9a-fA-F]{6}$/.test(v ?? '') ? `#${String(v).replace('#', '').toLowerCase()}` : '');
const snowflake = (v) => (/^\d{17,20}$/.test(v ?? '') ? v : '');
const newQuestionId = () => `q${randomBytes(4).toString('hex')}`;

// --- settings --------------------------------------------------------------------------------------

function normaliseQuestions(raw) {
  if (!Array.isArray(raw)) return DEFAULT_QUESTIONS.map((q) => ({ ...q }));
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (out.length >= LIMITS.questions.maxItems) break;
    const label = clip(String(item?.label ?? '').trim(), LIMITS['questions[].label'].maxLength);
    if (!label) continue;
    let id = /^[A-Za-z0-9_-]{1,24}$/.test(item?.id ?? '') ? item.id : '';
    if (!id || seen.has(id)) id = newQuestionId();
    seen.add(id);
    const { min, max } = LIMITS['questions[].maxLength'];
    const n = Number(item.maxLength);
    const hasLength = item.maxLength !== null && item.maxLength !== undefined && item.maxLength !== '';
    out.push({
      id,
      label,
      prompt: clip(String(item.prompt ?? '').trim(), LIMITS['questions[].prompt'].maxLength),
      required: item.required === true,
      maxLength:
        hasLength && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : DEFAULT_MAX_LENGTH,
      inline: item.inline === true,
    });
  }
  return out;
}

function normaliseRoleGroups(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (out.length >= LIMITS.roleGroups.maxItems) break;
    // A name sits inside {rolegroup:<name>}, so braces cannot be part of it.
    const name = clip(
      String(item?.name ?? '')
        .replace(/[{}]/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
      LIMITS['roleGroups[].name'].maxLength
    );
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({
      name,
      roleIds: idList(item.roleIds, LIMITS['roleGroups[].roleIds'].maxItems),
      hideWhenEmpty: item.hideWhenEmpty === true,
    });
  }
  return out;
}

/** Coerce a submitted introductions config into the canonical shape. */
export function normaliseIntroductionsConfig(raw = {}) {
  return {
    channelId: snowflake(raw.channelId),
    questions: normaliseQuestions(raw.questions),
    roleGroups: normaliseRoleGroups(raw.roleGroups),
    showRoles: raw.showRoles === true,
    colorMode: raw.colorMode === 'role' ? 'role' : 'fixed',
    color: hex(raw.color),
    description: clip(String(raw.description ?? '').trim(), LIMITS.description.maxLength),
    footer: clip(String(raw.footer ?? '').trim(), LIMITS.footer.maxLength),
    deleteOnLeave: raw.deleteOnLeave !== false,
    promptText: clip(String(raw.promptText ?? '').trim(), LIMITS.promptText.maxLength),
    promptChannelId: snowflake(raw.promptChannelId),
    promptMessageId: snowflake(raw.promptMessageId),
  };
}

/** The introductions settings of a server (the stored config, cleaned). */
export async function introConfig(key) {
  return normaliseIntroductionsConfig((await getGuildModule(key, 'introductions')).config);
}

/**
 * What `{intro}` stands for in a welcome message: a mention of the introductions channel while the
 * module is on and has a channel, otherwise nothing.
 */
export async function introChannelMention(key) {
  const mod = await getGuildModule(key, 'introductions');
  if (!mod.enabled) return '';
  const { channelId } = normaliseIntroductionsConfig(mod.config);
  return channelId ? `<#${channelId}>` : '';
}

// --- the card --------------------------------------------------------------------------------------

const EMBED_BUDGET = 5800; // Discord's total is 6000 characters; leave room for the rest
const SHRINK_FLOOR = 80;
const NO_ROLES = '—';

const rolesOf = (member) => [...(member?.roles?.cache?.values?.() ?? [])];
const displayNameOf = (member) =>
  member.displayName ?? member.user?.globalName ?? member.user?.username ?? member.id;

/** The roles of a member that belong to a group, highest first, by name. */
function groupRoles(group, memberRoles) {
  const ids = new Set(group.roleIds);
  return memberRoles
    .filter((r) => ids.has(r.id))
    .sort((a, b) => b.position - a.position)
    .map((r) => String(r.name));
}

/** The colour of the member's highest role that has one, or null. */
function topRoleColor(memberRoles) {
  const top = memberRoles.filter((r) => Number(r.color) > 0).sort((a, b) => b.position - a.position)[0];
  return top ? Number(top.color) : null;
}

/**
 * The card of a member, as a message payload. Pure: everything comes in as arguments.
 * @param {{ guild: any, member: any, cfg: ReturnType<typeof normaliseIntroductionsConfig>,
 *   answers: Record<string, string>, defaultColor: number }} args
 */
export function buildIntroCard({ guild, member, cfg, answers, defaultColor }) {
  const roles = rolesOf(member);
  const everyoneId = rawGuildId(guild);
  const name = displayNameOf(member);
  const username = member.user?.username ?? name;

  // Role groups: the member's roles of each group, by name.
  const groups = cfg.roleGroups.map((group) => ({ group, names: groupRoles(group, roles) }));
  const grouped = new Set(cfg.roleGroups.flatMap((g) => g.roleIds));

  // Placeholders are filled in one pass, so a value (a display name such as "{server}") is never
  // expanded again. The description is markdown: names are escaped and {user} is a mention. The
  // footer is plain text (an embed footer shows neither markdown nor mentions): names as they are,
  // and {user} is the display name.
  const fill = (template, { plain = false } = {}) => {
    const text = (value) => (plain ? String(value) : escapeMarkdown(value));
    return template.replace(/\{(?:(user\.name|user|server)|rolegroup:([^}]*))\}/gi, (_, simple, wanted) => {
      if (wanted !== undefined) {
        const found = groups.find((g) => g.group.name.toLowerCase() === wanted.trim().toLowerCase());
        return found ? text(found.names.join(', ') || NO_ROLES) : '';
      }
      switch (simple.toLowerCase()) {
        case 'user.name':
          return text(name);
        case 'user':
          return plain ? name : `<@${member.id}>`;
        default:
          return text(guild.name);
      }
    });
  };

  const fields = [];
  for (const q of cfg.questions) {
    const text = escapeMarkdown(cleanAnswer(answers?.[q.id]));
    if (!text) continue;
    fields.push({ name: escapeMarkdown(q.label), value: cut(text, 1024), inline: q.inline, shrink: true });
  }
  for (const { group, names } of groups) {
    if (!names.length && group.hideWhenEmpty) continue;
    fields.push({
      name: escapeMarkdown(group.name),
      value: cut(escapeMarkdown(names.join(', ') || NO_ROLES), 1024),
      inline: true,
    });
  }
  const joined = member.joinedTimestamp ?? member.joinedAt?.getTime?.();
  if (joined) {
    fields.push({ name: 'Member since', value: `<t:${Math.floor(joined / 1000)}:R>`, inline: true });
  }
  if (cfg.showRoles) {
    const others = roles
      .filter((r) => r.id !== everyoneId && !r.managed && !grouped.has(r.id))
      .sort((a, b) => b.position - a.position)
      .slice(0, 10)
      .map((r) => escapeMarkdown(r.name));
    if (others.length) fields.push({ name: 'Roles', value: cut(others.join(', '), 1024), inline: false });
  }

  const card = {
    title: cut(
      name === username ? escapeMarkdown(name) : `${escapeMarkdown(name)} (@${escapeMarkdown(username)})`,
      256
    ),
    description: cfg.description ? cut(fill(cfg.description), 4096) : '',
    footer: cfg.footer ? cut(fill(cfg.footer, { plain: true }), 2048) : '',
  };
  fitEmbed(card, fields);

  const color =
    (cfg.colorMode === 'role' ? topRoleColor(roles) : null) ??
    (cfg.color ? parseInt(cfg.color.slice(1), 16) : defaultColor);
  const embed = new EmbedBuilder().setColor(color).setTitle(card.title);
  const avatar =
    member.displayAvatarURL?.({ extension: 'png', size: 256 }) ?? member.user?.displayAvatarURL?.() ?? null;
  if (avatar) embed.setThumbnail(avatar);
  if (card.description) embed.setDescription(card.description);
  if (card.footer) embed.setFooter({ text: card.footer });
  if (fields.length)
    embed.addFields(fields.map(({ name: n, value, inline }) => ({ name: n, value, inline })));
  return { embeds: [embed], allowedMentions: { parse: [] } };
}

/**
 * Make the card fit Discord's total of 6000 characters. The answers and the description give way
 * first, all to the same length (the longest ones shrink, short ones are left alone); if that is not
 * enough, fields are dropped from the end.
 */
function fitEmbed(card, fields) {
  const total = () =>
    card.title.length +
    card.description.length +
    card.footer.length +
    fields.reduce((sum, f) => sum + f.name.length + f.value.length, 0);
  if (total() <= EMBED_BUDGET) return;

  const shrinkable = [
    ...fields.filter((f) => f.shrink).map((f) => ({ get: () => f.value, set: (v) => (f.value = v) })),
    { get: () => card.description, set: (v) => (card.description = v) },
  ];
  const lengths = () => shrinkable.map((s) => s.get().length);
  const fixed = total() - lengths().reduce((a, b) => a + b, 0);
  const room = EMBED_BUDGET - fixed;
  const used = (cap) => lengths().reduce((sum, n) => sum + Math.min(n, cap), 0);
  let cap = Math.max(...lengths());
  while (cap > SHRINK_FLOOR && used(cap) > room) {
    cap -= Math.max(1, Math.ceil((used(cap) - room) / shrinkable.length));
  }
  cap = Math.max(cap, SHRINK_FLOOR);
  for (const s of shrinkable) if (s.get().length > cap) s.set(cut(s.get(), cap));

  while (total() > EMBED_BUDGET && fields.length) fields.pop();
}

// --- members and channels ---------------------------------------------------------------------------

async function fetchMember(guild, userId) {
  return guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
}

async function textChannel(guild, channelId) {
  if (!channelId) return null;
  const channel =
    guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
  return channel?.isTextBased?.() ? channel : null;
}

const missingPermission = (guild, channel) => {
  const me = guild.members.me;
  return me && !channel.permissionsFor(me)?.has(['ViewChannel', 'SendMessages', 'EmbedLinks']);
};

/** One change per member at a time: a post, an edit and a refresh must not interleave. */
const chains = new Map();
async function withLock(key, fn) {
  const previous = chains.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.catch(() => {});
  chains.set(key, tail);
  try {
    return await run;
  } finally {
    if (chains.get(key) === tail) chains.delete(key);
  }
}

// What each card last looked like, so a member update that changes nothing on the card edits nothing.
const lastLook = new Map();
const rememberLook = (key, userId, payload) => {
  if (lastLook.size >= 5000) lastLook.clear();
  lastLook.set(`${key}|${userId}`, JSON.stringify(payload.embeds.map((e) => e.toJSON())));
};

/** Tests only. */
export function _resetIntroductions() {
  chains.clear();
  lastLook.clear();
  rates.clear();
  for (const timer of pendingRefresh.values()) clearTimeout(timer);
  pendingRefresh.clear();
}

/** Keep only the answers of the questions the server asks now, cleaned. */
function cleanAnswers(cfg, answers) {
  const out = {};
  for (const q of cfg.questions) {
    const text = cleanAnswer(answers?.[q.id]);
    if (text) out[q.id] = cut(text, q.maxLength);
  }
  return out;
}

async function cardPayload(guild, member, cfg, answers) {
  const defaultColor = await guildEmbedColor(guildKey(guild));
  return buildIntroCard({ guild, member, cfg, answers, defaultColor });
}

// --- post, edit, remove -------------------------------------------------------------------------------

/**
 * Post a member's card, or edit the one they already have. If the old message is gone, a new one is
 * posted. Stores the answers.
 * @returns {Promise<{ ok: true, edited: boolean, channelId: string, messageId: string } | { ok: false, error: string }>}
 */
export async function postIntroduction({ guild, userId, answers }) {
  const key = guildKey(guild);
  return withLock(`${key}|${userId}`, async () => {
    // The module may have been switched off while the member was answering.
    if (!(await isModuleEnabled(key, 'introductions'))) {
      return { ok: false, error: 'Introductions are off in this server.' };
    }
    const cfg = await introConfig(key);
    if (!cfg.channelId)
      return { ok: false, error: 'The introductions channel is not set up yet. Ask a server admin.' };
    const member = await fetchMember(guild, userId);
    if (!member) return { ok: false, error: 'I could not find you in that server any more.' };

    const clean = cleanAnswers(cfg, answers);
    const payload = await cardPayload(guild, member, cfg, clean);
    const existing = await getIntroduction(key, userId);

    if (existing?.message_id) {
      const old = await textChannel(guild, existing.channel_id);
      const message = old ? await old.messages.fetch(existing.message_id).catch(() => null) : null;
      if (message) {
        try {
          await message.edit(payload);
        } catch {
          return {
            ok: false,
            error: 'I could not edit your card. Ask a server admin to check my permissions.',
          };
        }
        await saveIntroduction({
          guildId: key,
          userId,
          channelId: existing.channel_id,
          messageId: existing.message_id,
          answers: clean,
        });
        rememberLook(key, userId, payload);
        return { ok: true, edited: true, channelId: existing.channel_id, messageId: existing.message_id };
      }
      // The card message is gone (deleted by staff or by the member): post a fresh one below.
    }

    const channel = await textChannel(guild, cfg.channelId);
    if (!channel)
      return { ok: false, error: 'The introductions channel no longer exists. Ask a server admin.' };
    if (missingPermission(guild, channel)) {
      return {
        ok: false,
        error: 'I cannot post in the introductions channel. Ask a server admin to check my permissions.',
      };
    }
    let sent;
    try {
      sent = await channel.send(payload);
    } catch {
      return { ok: false, error: 'I could not post your card. Please try again later.' };
    }
    await saveIntroduction({
      guildId: key,
      userId,
      channelId: channel.id,
      messageId: sent.id,
      answers: clean,
    });
    rememberLook(key, userId, payload);
    return { ok: true, edited: false, channelId: channel.id, messageId: sent.id };
  });
}

/** Delete a card message, best-effort. */
async function deleteCardMessage(guild, row) {
  if (!row?.message_id) return;
  const channel = await textChannel(guild, row.channel_id);
  const message = channel ? await channel.messages.fetch(row.message_id).catch(() => null) : null;
  if (message) await message.delete().catch(() => {});
}

/** Remove a member's card and answers. @returns {Promise<boolean>} whether there was anything */
export async function removeIntroduction(guild, userId) {
  const key = guildKey(guild);
  return withLock(`${key}|${userId}`, async () => {
    const row = await getIntroduction(key, userId);
    if (!row) return false;
    // The row goes first: the message-delete event this causes then finds nothing to clear.
    await deleteIntroduction(key, userId);
    lastLook.delete(`${key}|${userId}`);
    await deleteCardMessage(guild, row);
    return true;
  });
}

/**
 * Delete the card message of a member before /forget deletes their row (the message is found
 * through the row). Never throws: erasing the data must not fail because of a missing channel.
 */
export async function forgetIntroductionCard(guild, userId) {
  try {
    await deleteCardMessage(guild, await getIntroduction(guildKey(guild), userId));
  } catch (err) {
    log.warn('module:introductions', `could not delete a card message: ${err.message}`);
  }
}

/** The card of a member as it would be posted now, from their stored answers; null if they have none. */
export async function viewIntroduction(guild, userId) {
  const key = guildKey(guild);
  const row = await getIntroduction(key, userId);
  if (!row) return null;
  const member = await fetchMember(guild, userId);
  if (!member) return null;
  const cfg = await introConfig(key);
  return { row, ...(await cardPayload(guild, member, cfg, answersOf(row))) };
}

// --- running the questionnaire -------------------------------------------------------------------------

const RATE_MS = 30_000;
/** @type {Map<string, number>} */
const rates = new Map();
sweepMap(rates, (at, now) => now - at > RATE_MS);

/** Seconds until this member may start again, or 0 (and the attempt is counted). One start per 30 s. */
export function introRateLeft(platform, userId, now = Date.now()) {
  const key = `${platform}:${userId}`;
  const last = rates.get(key);
  if (last && now - last < RATE_MS) return Math.ceil((RATE_MS - (now - last)) / 1000);
  rates.set(key, now);
  return 0;
}

/**
 * Start (or restart) a member's introduction: ask the questions in DM. Used by /intro and by the
 * "Create my intro" button.
 * @returns {Promise<{ ok: boolean, message: string }>} what to tell the member where they asked
 */
export async function beginIntroduction({ guild, user }) {
  const key = guildKey(guild);
  const platform = platformOfGuild(guild);
  const cfg = await introConfig(key);
  if (!cfg.channelId) return { ok: false, message: 'Introductions are not set up in this server yet.' };
  const member = await fetchMember(guild, user.id);
  if (!member) return { ok: false, message: 'I could not find you in this server.' };

  const existing = await getIntroduction(key, user.id);
  const finish = async (answers) => {
    const result = await postIntroduction({ guild, userId: user.id, answers });
    if (!result.ok) return { ok: false, message: result.error };
    const link = jumpUrl(key, result.channelId, result.messageId);
    return {
      ok: true,
      message: result.edited
        ? `Your introduction was updated: ${link}`
        : `Your introduction is posted: ${link}`,
    };
  };

  // A server with no questions has nothing to ask: the card is just the member's profile.
  if (cfg.questions.length === 0) return finish({});

  const started = await startQuestionnaire({
    user,
    platform,
    questions: cfg.questions,
    prefill: existing ? answersOf(existing) : {},
    header: `Introduction for **${guild.name}**${existing ? '. You already have a card, so I will update it.' : '.'}`,
    review: async (answers) => cardPayload(guild, member, cfg, cleanAnswers(cfg, answers)),
    confirmLabel: 'Post',
    restartLabel: 'Start over',
    normalise: cleanAnswer,
    onComplete: async (answers) => {
      const done = await finish(answers);
      // A failure keeps the member's answers: the questionnaire offers Post again.
      return done.ok ? done.message : { ok: false, message: done.message };
    },
  });
  if (started.ok) return { ok: true, message: 'Check your DMs.' };
  if (started.reason === 'busy') {
    return {
      ok: false,
      message: 'You are already answering questions in your DMs. Finish there (or type `cancel`) first.',
    };
  }
  if (started.reason === 'dm_closed') {
    return { ok: false, message: 'I could not DM you. Open your DMs from server members and try again.' };
  }
  return { ok: false, message: 'There is nothing to ask right now.' };
}

// --- the prompt message ----------------------------------------------------------------------------------

/**
 * Publish (or update) the pinned "Introduce yourself" message with the Create my intro button in the
 * introductions channel. On Fluxer the button becomes a reaction.
 * @returns {Promise<{ ok: true, channelId: string, messageId: string } | { ok: false, error: string }>}
 */
export async function publishPrompt(guild, cfg) {
  const channel = await textChannel(guild, cfg.channelId);
  if (!channel) return { ok: false, error: 'Pick the introductions channel first.' };
  if (missingPermission(guild, channel)) {
    return { ok: false, error: 'Sylo needs View Channel, Send Messages and Embed Links in that channel.' };
  }
  const payload = {
    content: cfg.promptText || DEFAULT_PROMPT_TEXT,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(CREATE_BUTTON_ID)
          .setLabel('Create my intro')
          .setEmoji('📝')
          .setStyle(ButtonStyle.Primary)
      ),
    ],
    allowedMentions: { parse: [] },
  };
  try {
    if (cfg.promptMessageId && cfg.promptChannelId === channel.id) {
      const old = await channel.messages.fetch(cfg.promptMessageId).catch(() => null);
      if (old) {
        await old.edit(payload);
        return { ok: true, channelId: channel.id, messageId: old.id };
      }
    }
    const sent = await channel.send(payload);
    await sent.pin?.().catch(() => {}); // needs Pin Messages / Manage Messages; the prompt works unpinned too
    return { ok: true, channelId: channel.id, messageId: sent.id };
  } catch (err) {
    return { ok: false, error: err.message || 'Publishing failed.' };
  }
}

/** Delete the published prompt message, best-effort. */
export async function unpublishPrompt(guild, cfg) {
  if (!cfg.promptMessageId) return;
  const channel = await textChannel(guild, cfg.promptChannelId);
  const message = channel ? await channel.messages.fetch(cfg.promptMessageId).catch(() => null) : null;
  if (message) await message.delete().catch(() => {});
}

registerComponent('introductions', CREATE_BUTTON_ID, async (interaction) => {
  const reply = (content) =>
    interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  const guild = interaction.guild;
  if (!guild) return;
  if (!(await isModuleEnabled(guildKey(guild), 'introductions'))) {
    return reply('Introductions are off in this server.');
  }
  const wait = introRateLeft(platformOfGuild(guild), interaction.user.id);
  if (wait) return reply(`Please wait ${wait} seconds before you start again.`);
  // Looking up the member and sending the first DM can take longer than Discord waits for a reply.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await beginIntroduction({ guild, user: interaction.user });
  return interaction.editReply({ content: result.message, allowedMentions: { parse: [] } });
});

// --- keeping cards true -------------------------------------------------------------------------------------

const REFRESH_DELAY_MS = 30_000;
/** @type {Map<string, NodeJS.Timeout>} */
const pendingRefresh = new Map();

const roleKey = (member) => [...(member?.roles?.cache?.keys?.() ?? [])].sort().join(',');

/** Rebuild a member's card from their stored answers and edit the message, if the card changed. */
export async function refreshIntroduction(key, userId) {
  const guild = guildByKey(key);
  if (!guild) return;
  await withLock(`${key}|${userId}`, async () => {
    const row = await getIntroduction(key, userId);
    if (!row?.message_id) return;
    const member = await fetchMember(guild, userId);
    if (!member) return;
    const cfg = await introConfig(key);
    const payload = await cardPayload(guild, member, cfg, answersOf(row));
    const look = JSON.stringify(payload.embeds.map((e) => e.toJSON()));
    if (lastLook.get(`${key}|${userId}`) === look) return;
    const channel = await textChannel(guild, row.channel_id);
    const message = channel ? await channel.messages.fetch(row.message_id).catch(() => null) : null;
    if (!message) return; // gone: the message-delete event forgets it
    await message.edit(payload);
    rememberLook(key, userId, payload);
  });
}

/** Refresh a member's card in about 30 seconds; more changes in that time ride along. */
export function scheduleRefresh(key, userId, delayMs = REFRESH_DELAY_MS) {
  const id = `${key}|${userId}`;
  if (pendingRefresh.has(id)) return;
  const timer = setTimeout(() => {
    pendingRefresh.delete(id);
    refreshIntroduction(key, userId).catch((err) =>
      log.warn('module:introductions', `could not refresh a card: ${err.message}`)
    );
  }, delayMs);
  timer.unref?.();
  pendingRefresh.set(id, timer);
}

on('introductions', 'guildMemberUpdate', async ({ old: before, new: after }, _config, key) => {
  if (!after?.id) return;
  // Fluxer may send no "before": then every update counts. Otherwise only a role change does.
  const known = before && before !== after && !before.partial && before.roles?.cache;
  if (known && roleKey(before) === roleKey(after)) return;
  const row = await getIntroduction(key, after.id);
  if (row?.message_id) scheduleRefresh(key, after.id);
});

on('introductions', 'guildMemberRemove', async (member, config, key) => {
  const userId = member.id ?? member.user?.id;
  if (!userId || normaliseIntroductionsConfig(config).deleteOnLeave === false) return;
  const guild = guildByKey(key);
  if (guild) await removeIntroduction(guild, userId);
});

async function forgetMessage(key, messageId) {
  const row = await getIntroductionByMessage(key, messageId);
  if (row) await clearIntroductionMessage(key, row.user_id);
}

// A deleted card is forgotten, but the answers stay, so /intro can post it again.
on('introductions', 'messageDelete', (message, _config, key) => forgetMessage(key, message.id));
on('introductions', 'messageDeleteBulk', async ({ messages }, _config, key) => {
  for (const id of messages?.keys?.() ?? []) await forgetMessage(key, id);
});
