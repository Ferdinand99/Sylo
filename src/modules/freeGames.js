// Free games notifier — announces titles that become free to claim.
// Source: the Epic Games Store promotion feed (always) plus, when an
// ITAD_API_KEY is set, IsThereAnyDeal's cross-store deals list.
//
// config shape: { channelId, roleId }
import { EmbedBuilder } from 'discord.js';
import { config } from '../config.js';
import { runtime } from '../runtime.js';
import { getGuildModule } from '../db/modules.js';
import { wasPosted, markPosted, pruneFreeGames } from '../db/freeGames.js';
import { sendToChannel } from './lib/send.js';
import { log } from '../lib/log.js';

const EPIC_URL =
  'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=en-US&country=US&allowCountries=US';
const ITAD_URL = 'https://api.isthereanydeal.com/deals/v2';
const COLOR = 0x2f2d2e;
const POLL_MS = 60 * 60 * 1000;

/** Source-agnostic dedup key so the same title from Epic and ITAD collapses. */
export function gameKey(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

// --- Epic ---------------------------------------------------------------------

const pickImage = (images = []) => {
  const byType = (t) => images.find((i) => i.type === t)?.url;
  return (
    byType('OfferImageWide') ||
    byType('DieselStoreFrontWide') ||
    byType('Thumbnail') ||
    images[0]?.url ||
    null
  );
};

const epicStoreUrl = (el) => {
  const slug =
    el.catalogNs?.mappings?.[0]?.pageSlug || el.offerMappings?.[0]?.pageSlug || el.productSlug || el.urlSlug;
  if (!slug) return 'https://store.epicgames.com/en-US/free-games';
  return `https://store.epicgames.com/en-US/p/${String(slug).replace(/\/home$/, '')}`;
};

/** Turn an Epic promotions payload into the titles that are free *right now*. */
export function parseEpicPayload(json) {
  const elements = json?.data?.Catalog?.searchStore?.elements ?? [];
  const now = Date.now();
  const out = [];

  for (const el of elements) {
    if (el?.price?.totalPrice?.discountPrice !== 0) continue;
    const windows = (el.promotions?.promotionalOffers ?? []).flatMap((p) => p.promotionalOffers ?? []);
    const active = windows.find((w) => {
      const start = Date.parse(w.startDate);
      const end = Date.parse(w.endDate);
      return (
        (w.discountSetting?.discountPercentage ?? 100) === 0 &&
        Number.isFinite(start) &&
        Number.isFinite(end) &&
        now >= start &&
        now < end
      );
    });
    if (!active) continue;

    out.push({
      key: gameKey(el.title),
      title: el.title,
      kind: 'game',
      description: (el.description || '').slice(0, 280),
      image: pickImage(el.keyImages),
      url: epicStoreUrl(el),
      store: 'Epic Games Store',
      priceText: el.price?.totalPrice?.fmtPrice?.originalPrice || null,
      endsAt: Date.parse(active.endDate),
    });
  }
  return out;
}

async function fetchEpic() {
  const res = await fetch(EPIC_URL, {
    headers: { 'User-Agent': 'Sylo-Discord-Bot' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Epic API ${res.status}`);
  return parseEpicPayload(await res.json());
}

// --- IsThereAnyDeal ---------------------------------------------------------

const money = (m) =>
  m && typeof m.amount === 'number' ? `${m.amount.toFixed(2)} ${m.currency || ''}`.trim() : null;

/** @param {any} json  @param {'game'|'dlc'} kind */
export function parseItadPayload(json, kind = 'game') {
  const list = Array.isArray(json?.list) ? json.list : Array.isArray(json) ? json : [];
  const out = [];

  for (const entry of list) {
    const deal = entry.deal ?? (Array.isArray(entry.deals) ? entry.deals[0] : null);
    if (!deal) continue;
    if (deal.cut !== 100 && deal?.price?.amount !== 0) continue; // not free
    if ((deal.regular?.amount ?? 0) < 0.5) continue; // skip demos / already-free filler
    if (/\bdemo\b/i.test(entry.title || '')) continue;

    const type = entry.type ?? 'game';
    const isDlc = type === 'dlc';
    if (kind === 'game' && isDlc) continue;
    if (kind === 'dlc' && !isDlc) continue;

    const a = entry.assets || {};
    out.push({
      key: gameKey(entry.title),
      title: entry.title,
      kind: isDlc ? 'dlc' : 'game',
      description: '',
      image: a.banner600 || a.banner400 || a.boxart || null,
      url: deal.url || `https://isthereanydeal.com/game/${entry.slug || ''}/info/`,
      store: deal.shop?.name || 'store',
      priceText: money(deal.regular),
      endsAt: deal.expiry ? Date.parse(deal.expiry) : NaN,
    });
  }
  return out;
}

async function fetchItad(kind = 'game') {
  if (!config.itadApiKey) return [];
  const url = `${ITAD_URL}?country=US&limit=200&sort=-cut&key=${encodeURIComponent(config.itadApiKey)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Sylo-Discord-Bot' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`ITAD API ${res.status}`);
  return parseItadPayload(await res.json(), kind);
}

// --- combined ------------------------------------------------------------------

/**
 * Current free games (Epic first for the nicer embed, then ITAD's extras),
 * de-duplicated by normalised title.
 * @param {{ kind?: 'game'|'dlc' }} [opts]
 */
export async function getFreeGames({ kind = 'game' } = {}) {
  const results = [];
  if (kind === 'game') {
    results.push(
      await fetchEpic().catch((err) => {
        log.error('free-games', 'Epic fetch failed:', err.message);
        return [];
      })
    );
  }
  if (config.itadApiKey) {
    results.push(
      await fetchItad(kind).catch((err) => {
        log.error('free-games', 'ITAD fetch failed:', err.message);
        return [];
      })
    );
  }

  const seen = new Set();
  const merged = [];
  for (const game of results.flat()) {
    if (!game.title || seen.has(game.key)) continue;
    seen.add(game.key);
    merged.push(game);
  }
  return merged;
}

// Kept for the existing test / /freegames — thin wrapper.
export async function fetchEpicFreeGames() {
  return fetchEpic();
}

export function gameEmbed(game) {
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`${game.kind === 'dlc' ? '[DLC] ' : ''}${game.title}`)
    .setURL(game.url)
    .setDescription(game.description || null)
    .addFields({ name: 'Store', value: game.store, inline: true });
  if (game.priceText) embed.addFields({ name: 'Was', value: game.priceText, inline: true });
  if (Number.isFinite(game.endsAt)) {
    embed.addFields({ name: 'Free until', value: `<t:${Math.floor(game.endsAt / 1000)}:D>`, inline: true });
  }
  if (game.image) embed.setImage(game.image);
  embed.setFooter({ text: 'Free to claim' }).setTimestamp(Date.now());
  return embed;
}

async function tick() {
  const client = runtime.client;
  if (!client?.isReady()) return;

  let games;
  try {
    games = await getFreeGames();
  } catch (err) {
    log.error('free-games', 'tick fetch failed:', err.message);
    return;
  }
  if (games.length === 0) return;
  pruneFreeGames();

  for (const guild of client.guilds.cache.values()) {
    const { enabled, config: cfg } = getGuildModule(guild.id, 'free-games');
    if (!enabled || !/^\d{17,20}$/.test(cfg.channelId ?? '')) continue;

    let postedThisTick = 0;
    for (const game of games) {
      if (postedThisTick >= 10) break; // don't wall the channel during a big sale
      if (wasPosted(guild.id, game.key)) continue;
      const content = /^\d{17,20}$/.test(cfg.roleId ?? '') ? `<@&${cfg.roleId}>` : undefined;
      const sent = await sendToChannel(guild.id, cfg.channelId, {
        content,
        embeds: [gameEmbed(game)],
        allowedMentions: content ? { roles: [cfg.roleId] } : { parse: [] },
      });
      if (sent) {
        markPosted(guild.id, game.key);
        postedThisTick += 1;
      }
    }
  }
}

setInterval(() => {
  tick().catch((err) => log.error('free-games', 'tick failed:', err.message));
}, POLL_MS).unref();

setTimeout(() => tick().catch(() => {}), 90_000).unref();
