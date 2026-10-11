// Free games notifier — announces titles that become free to claim.
// Sources: Epic Games Store and Steam giveaways via GamerPower (no key), plus, when an
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
const STEAM_URL = 'https://www.gamerpower.com/api/giveaways?platform=steam&type=game';
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
      key:
        deal.shop?.name?.toLowerCase() === 'steam' ? `steam:${gameKey(entry.title)}` : gameKey(entry.title),
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

// --- Steam (GamerPower's public, attributed API) -------------------------------

const gamerPowerUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      url.hostname === 'www.gamerpower.com' &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
};

/** Permanent Steam giveaways only, not third-party key tasks or free weekends. */
export function parseSteamPayload(json, now = Date.now()) {
  if (!Array.isArray(json)) return [];
  const out = [];
  for (const entry of json) {
    if (!entry || entry.type !== 'Game' || entry.status !== 'Active') continue;
    if (
      !String(entry.platforms || '')
        .split(',')
        .some((p) => p.trim() === 'Steam')
    )
      continue;
    const title = String(entry.title || '').trim();
    const details = `${title} ${entry.description || ''} ${entry.instructions || ''}`;
    if (!title || /\b(?:demo|beta|playtest|free[- ]weekend|free[- ]to[- ]play|trial)\b/i.test(details))
      continue;
    if (/\b(?:keys?|ARP)\b|activate a product|alienware/i.test(details)) continue;
    // Fail closed: require evidence that the giveaway is redeemed on Steam itself.
    if (!/(?:directly (?:via|on|from) Steam|free on Steam|free (?:on|via) Steam|Steam store)/i.test(details))
      continue;
    const url = gamerPowerUrl(entry.open_giveaway_url || entry.open_giveaway);
    const sourceUrl = gamerPowerUrl(entry.gamerpower_url);
    if (!url || !sourceUrl) continue;
    const cleanTitle = title.replace(/\s*\(Steam\)\s*Giveaway\s*$/i, '').trim();
    if (!cleanTitle) continue;
    // GamerPower's dates have no documented timezone. Show the calendar date
    // rather than inventing an exact deadline or interpreting the host's timezone.
    const endsOn = String(entry.end_date || '').match(/^(\d{4}-\d{2}-\d{2}) [\d:]+$/)?.[1] || null;
    if (endsOn && endsOn < new Date(now).toISOString().slice(0, 10)) continue;
    out.push({
      key: `steam:${gameKey(cleanTitle)}`,
      title: cleanTitle,
      kind: 'game',
      description: 'Odbierz grę na Steam i zachowaj ją na stałe.',
      image: gamerPowerUrl(entry.image) || gamerPowerUrl(entry.thumbnail),
      url,
      sourceUrl,
      store: 'Steam',
      priceText: /^\$\d+(?:\.\d{2})?$/.test(entry.worth || '') ? entry.worth : null,
      endsAt: NaN,
      endsOn,
    });
  }
  return out;
}

async function fetchSteam() {
  const res = await fetch(STEAM_URL, {
    headers: { 'User-Agent': 'Sylo-Discord-Bot' },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 201) return [];
  if (!res.ok) throw new Error(`GamerPower API ${res.status}`);
  const json = await res.json();
  if (!Array.isArray(json)) throw new Error('Unexpected GamerPower response');
  return parseSteamPayload(json);
}

// --- combined ------------------------------------------------------------------

/**
 * Current free games from Epic, Steam, then ITAD's extras.
 * Steam has a separate dedup key so an Epic claim does not hide a Steam offer.
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
    results.push(
      await fetchSteam().catch((err) => {
        log.error('free-games', 'Steam fetch failed:', err.message);
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
    .addFields({ name: 'Sklep', value: game.store, inline: true });
  if (game.priceText) embed.addFields({ name: 'Poprzednia cena', value: game.priceText, inline: true });
  if (Number.isFinite(game.endsAt)) {
    embed.addFields({ name: 'Darmowa do', value: `<t:${Math.floor(game.endsAt / 1000)}:D>`, inline: true });
  }
  if (game.endsOn) embed.addFields({ name: 'Termin według źródła', value: game.endsOn, inline: true });
  if (game.sourceUrl) embed.addFields({ name: 'Źródło', value: `[GamerPower](${game.sourceUrl})` });
  if (game.image) embed.setImage(game.image);
  embed.setFooter({ text: 'Do odebrania za darmo' }).setTimestamp(Date.now());
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
  await pruneFreeGames();

  for (const guild of client.guilds.cache.values()) {
    const { enabled, config: cfg } = await getGuildModule(guild.id, 'free-games');
    if (!enabled || !/^\d{17,20}$/.test(cfg.channelId ?? '')) continue;

    let postedThisTick = 0;
    for (const game of games) {
      if (postedThisTick >= 10) break; // don't wall the channel during a big sale
      if (await wasPosted(guild.id, game.key)) continue;
      const content = /^\d{17,20}$/.test(cfg.roleId ?? '') ? `<@&${cfg.roleId}>` : undefined;
      const sent = await sendToChannel(guild.id, cfg.channelId, {
        content,
        embeds: [gameEmbed(game)],
        allowedMentions: content ? { roles: [cfg.roleId] } : { parse: [] },
      });
      if (sent) {
        await markPosted(guild.id, game.key);
        postedThisTick += 1;
      }
    }
  }
}

setInterval(() => {
  tick().catch((err) => log.error('free-games', 'tick failed:', err.message));
}, POLL_MS).unref();

setTimeout(() => tick().catch(() => {}), 90_000).unref();
