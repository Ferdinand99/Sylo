// The Economy module's settings: their limits, the normaliser that clamps every value, and the
// helpers that print and read amounts. Kept apart from modules/economy.js so the money API
// (modules/lib/economy.js) can read the settings without importing the module that imports it.
//
// config shape (see normaliseEconomyConfig):
//   { currencyName, currencyEmoji,
//     messageEnabled, messageMin, messageMax, messageCooldownSeconds, messageMinLength,
//     ignoredChannels: [], ignoredRoles: [],
//     voiceEnabled, voiceAmount,
//     dailyBase, dailyStreakBonus,
//     workMin, workMax, workCooldownMinutes,
//     bankEnabled, payEnabled, payTaxPercent,
//     robEnabled, robChancePercent, robMinPercent, robMaxPercent, robFinePercent, robFineMin,
//     robCooldownHours, robVictimMinCash, robNewMemberHours, robProtectionMinutes,
//     startingBalance, publicLeaderboard, logChannelId,
//     webShop, shopChannelId, collectibleChannelId, collectionPublic }
import { idList } from '../../web/lib/idList.js';

/** No member can hold more than this in cash + bank together, so every number stays safe. */
export const MAX_BALANCE = 1_000_000_000;
/** A streak counts at most this many days towards the daily bonus. */
export const DAILY_STREAK_CAP = 7;
/** A daily can be claimed once per this long. */
export const DAILY_COOLDOWN_MS = 24 * 3_600_000;
/** A streak breaks when more than this passes between two claims. */
export const DAILY_STREAK_BREAK_MS = 48 * 3_600_000;
/** Voice pays once per this much time in voice. */
export const VOICE_BLOCK_MS = 5 * 60_000;

/** Setting limits, served to the dashboard (modules/limits.js). */
export const LIMITS = {
  currencyName: { maxLength: 20 },
  currencyEmoji: { maxLength: 64 },
  messageMin: { min: 1, max: 1000 },
  messageMax: { min: 1, max: 1000 },
  messageCooldownSeconds: { min: 0, max: 3600 },
  messageMinLength: { min: 0, max: 100 },
  ignoredChannels: { maxItems: 100 },
  ignoredRoles: { maxItems: 100 },
  voiceAmount: { min: 1, max: 1000 },
  dailyBase: { min: 1, max: 100_000 },
  dailyStreakBonus: { min: 0, max: 10_000 },
  workMin: { min: 1, max: 100_000 },
  workMax: { min: 1, max: 100_000 },
  workCooldownMinutes: { min: 1, max: 1440 },
  payTaxPercent: { min: 0, max: 50 },
  robChancePercent: { min: 1, max: 99 },
  robMinPercent: { min: 1, max: 100 },
  robMaxPercent: { min: 1, max: 100 },
  robFinePercent: { min: 0, max: 100 },
  robFineMin: { min: 0, max: 100_000 },
  robCooldownHours: { min: 1, max: 168 },
  robVictimMinCash: { min: 0, max: 1_000_000 },
  robNewMemberHours: { min: 0, max: 720 },
  robProtectionMinutes: { min: 0, max: 1440 },
  startingBalance: { min: 0, max: 1_000_000 },
  // The shop (see modules/lib/shop.js normaliseItem)
  itemName: { maxLength: 60 },
  itemDescription: { maxLength: 300 },
  itemEmoji: { maxLength: 64 },
  itemPrice: { min: 1, max: MAX_BALANCE },
  itemStock: { min: 0, max: 1_000_000 },
  itemDurationHours: { min: 1, max: 8760 },
  itemPerMemberLimit: { min: 1, max: 1000 },
  itemRequiredRoles: { maxItems: 10 },
  // What staff can enter in the dashboard or /eco for one member in one go.
  amount: { min: 0, max: MAX_BALANCE },
  reason: { maxLength: 200 },
};

/** The shop's four kinds of item. */
export const ITEM_TYPES = ['temp_role', 'role', 'custom', 'collectible'];

/** The two kinds of item that give a role. The others (custom, collectible) never touch a role. */
export const isRoleItemType = (type) => type === 'temp_role' || type === 'role';

/**
 * The fixed rarity tiers of a collectible, lowest first, with the colour of each (a Discord embed colour).
 * A collectible has none of them or exactly one; staff cannot invent others.
 */
export const RARITIES = Object.freeze([
  { key: 'common', label: 'Common', color: 0x95a5a6 },
  { key: 'uncommon', label: 'Uncommon', color: 0x2ecc71 },
  { key: 'rare', label: 'Rare', color: 0x3498db },
  { key: 'epic', label: 'Epic', color: 0x9b59b6 },
  { key: 'legendary', label: 'Legendary', color: 0xf1c40f },
]);

/** The tier for a key, or null. */
export const rarityOf = (key) => RARITIES.find((r) => r.key === key) ?? null;

export const DEFAULT_CURRENCY_NAME = 'coins';
export const DEFAULT_CURRENCY_EMOJI = '🪙';

const clampInt = (v, field, dflt) => {
  const { min, max } = LIMITS[field];
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
};

// Control characters and line breaks never belong in a currency name or emoji.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;
const cleanText = (v, max) =>
  String(v ?? '')
    .replace(CONTROL, '')
    .trim()
    .slice(0, max);

const isId = (v) => /^\d{17,20}$/.test(String(v ?? ''));

/**
 * One shop item from a request body, with every value clamped (the dashboard sends hours, the
 * database keeps milliseconds). Never throws; use {@link itemProblem} for what is still missing.
 * `stock` is null for unlimited. The role only counts for the two role types. The rarity and the announce
 * switch only count for a collectible (a rarity that is not one of the fixed tiers is none). The picture is
 * never part of this: it only comes from an upload (routes/v2Shop.js), so it is not in the request body.
 */
export function normaliseItem(raw = {}) {
  const clamp = (v, field, dflt) => {
    const { min, max } = LIMITS[field];
    const n = Math.floor(Number(v));
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
  };
  const blank = (v) => v === null || v === undefined || v === '' || v === 'unlimited';
  const type = ITEM_TYPES.includes(raw.type) ? raw.type : 'custom';
  const roleType = isRoleItemType(type);
  const collectible = type === 'collectible';
  return {
    name: cleanText(raw.name, LIMITS.itemName.maxLength),
    description: cleanText(raw.description, LIMITS.itemDescription.maxLength),
    emoji: cleanText(raw.emoji, LIMITS.itemEmoji.maxLength),
    type,
    roleId: roleType && isId(raw.roleId) ? String(raw.roleId) : null,
    durationMs: type === 'temp_role' ? clamp(raw.durationHours, 'itemDurationHours', 24) * 3_600_000 : null,
    price: clamp(raw.price, 'itemPrice', 1),
    stock: blank(raw.stock) ? null : clamp(raw.stock, 'itemStock', 0),
    requiredRoles: idList(raw.requiredRoles, LIMITS.itemRequiredRoles.maxItems),
    perMemberLimit: blank(raw.perMemberLimit) ? null : clamp(raw.perMemberLimit, 'itemPerMemberLimit', 1),
    enabled: raw.enabled !== false,
    rarity: collectible && rarityOf(raw.rarity) ? raw.rarity : null,
    announce: collectible && raw.announce === true,
  };
}

/** What is still wrong with an item that has been through {@link normaliseItem}, or null. */
export function itemProblem(item) {
  if (!item.name) return 'Give the item a name.';
  if (isRoleItemType(item.type) && !item.roleId) return 'Pick the role this item gives.';
  return null;
}

/** The reason staff give for a change: one line of text, cut to its limit. */
export const normaliseReason = (v) => cleanText(v, LIMITS.reason.maxLength);

/** An amount staff enter, as a whole number inside the limits (0 when it is not a number). */
export function clampAmount(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(LIMITS.amount.min, Math.min(LIMITS.amount.max, n)) : 0;
}

export function normaliseEconomyConfig(raw = {}) {
  const messageMin = clampInt(raw.messageMin, 'messageMin', 5);
  const workMin = clampInt(raw.workMin, 'workMin', 50);
  const robMin = clampInt(raw.robMinPercent, 'robMinPercent', 10);
  return {
    currencyName: cleanText(raw.currencyName, LIMITS.currencyName.maxLength) || DEFAULT_CURRENCY_NAME,
    currencyEmoji: cleanText(raw.currencyEmoji, LIMITS.currencyEmoji.maxLength) || DEFAULT_CURRENCY_EMOJI,
    messageEnabled: raw.messageEnabled !== false,
    messageMin,
    messageMax: Math.max(messageMin, clampInt(raw.messageMax, 'messageMax', 15)),
    messageCooldownSeconds: clampInt(raw.messageCooldownSeconds, 'messageCooldownSeconds', 60),
    messageMinLength: clampInt(raw.messageMinLength, 'messageMinLength', 3),
    ignoredChannels: idList(raw.ignoredChannels, LIMITS.ignoredChannels.maxItems),
    ignoredRoles: idList(raw.ignoredRoles, LIMITS.ignoredRoles.maxItems),
    voiceEnabled: Boolean(raw.voiceEnabled),
    voiceAmount: clampInt(raw.voiceAmount, 'voiceAmount', 10),
    dailyBase: clampInt(raw.dailyBase, 'dailyBase', 100),
    dailyStreakBonus: clampInt(raw.dailyStreakBonus, 'dailyStreakBonus', 10),
    workMin,
    workMax: Math.max(workMin, clampInt(raw.workMax, 'workMax', 150)),
    workCooldownMinutes: clampInt(raw.workCooldownMinutes, 'workCooldownMinutes', 60),
    bankEnabled: raw.bankEnabled !== false,
    payEnabled: raw.payEnabled !== false,
    payTaxPercent: clampInt(raw.payTaxPercent, 'payTaxPercent', 0),
    robEnabled: raw.robEnabled === true,
    robChancePercent: clampInt(raw.robChancePercent, 'robChancePercent', 40),
    robMinPercent: robMin,
    robMaxPercent: Math.max(robMin, clampInt(raw.robMaxPercent, 'robMaxPercent', 30)),
    robFinePercent: clampInt(raw.robFinePercent, 'robFinePercent', 10),
    robFineMin: clampInt(raw.robFineMin, 'robFineMin', 25),
    robCooldownHours: clampInt(raw.robCooldownHours, 'robCooldownHours', 4),
    robVictimMinCash: clampInt(raw.robVictimMinCash, 'robVictimMinCash', 100),
    robNewMemberHours: clampInt(raw.robNewMemberHours, 'robNewMemberHours', 24),
    robProtectionMinutes: clampInt(raw.robProtectionMinutes, 'robProtectionMinutes', 60),
    startingBalance: clampInt(raw.startingBalance, 'startingBalance', 0),
    publicLeaderboard: raw.publicLeaderboard !== false,
    logChannelId: isId(raw.logChannelId) ? String(raw.logChannelId) : '',
    // The web shop page (/shop/<server>) is off until staff switch it on. Custom items post their
    // "please fulfil this" notice in shopChannelId, when one is set.
    webShop: raw.webShop === true,
    shopChannelId: isId(raw.shopChannelId) ? String(raw.shopChannelId) : '',
    // Collectibles: where a purchase of an item with "Announce purchases" is announced (none: nowhere), and
    // whether members may show their collection to others with /collection (off: only their own, privately).
    collectibleChannelId: isId(raw.collectibleChannelId) ? String(raw.collectibleChannelId) : '',
    collectionPublic: raw.collectionPublic === true,
  };
}

/** Whole number with thousands separators: 1234567 -> "1,234,567". */
export const formatNumber = (n) => Math.trunc(Number(n) || 0).toLocaleString('en-US');

/** An amount as members see it: "🪙 1,234 coins". */
export function formatMoney(amount, config) {
  const cfg = config ?? normaliseEconomyConfig({});
  return `${cfg.currencyEmoji} ${formatNumber(amount)} ${cfg.currencyName}`;
}

/**
 * Read an amount a member typed: a whole number (with spaces, commas or underscores as thousands
 * separators) or the word "all". Anything else, zero and negatives are null. `max` caps it.
 * @returns {{ all: true } | number | null}
 */
export function parseAmount(text, { allowAll = true, max = MAX_BALANCE } = {}) {
  const s = String(text ?? '')
    .trim()
    .toLowerCase();
  if (allowAll && s === 'all') return { all: true };
  if (!/^\d[\d,_ ]*$/.test(s)) return null;
  const n = Number(s.replace(/[,_ ]/g, ''));
  return Number.isSafeInteger(n) && n >= 1 && n <= max ? n : null;
}

/** The lines /work picks from; {amount} is the formatted pay. */
export const WORK_LINES = Object.freeze([
  'You fixed a server rack and earned {amount}.',
  'You debugged a stubborn script for a client and earned {amount}.',
  'You delivered packages across town and earned {amount}.',
  'You moderated a very busy chat all afternoon and earned {amount}.',
  'You designed a logo for a small shop and earned {amount}.',
  'You baked a batch of cookies for the market and earned {amount}.',
  'You walked the neighbours’ dogs and earned {amount}.',
  'You tuned a guitar for a street musician and earned {amount}.',
  'You translated a short manual overnight and earned {amount}.',
  'You repaired a bicycle in the park and earned {amount}.',
]);
