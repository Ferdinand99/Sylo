// App Store Connect alerts — announce in a channel what happens to the owner's apps on Apple's
// side: an App Store version changing state (waiting for review, in review, rejected, ready for
// sale ...), a TestFlight build finishing processing (or failing), and — in later phases —
// reviews, certificate expiry, TestFlight feedback and daily downloads.
//
// Owner-only: the API key lives in environment variables (APPLE_KEY_ID, APPLE_ISSUER_ID,
// APPLE_PRIVATE_KEY, see .env.example) and only the Sylo owner can enable the module in a
// server. The Apple account's data is account-wide, so one snapshot per tick feeds every
// server that has the module on.
//
// config shape: { channelId, roleId, apps: [appId...] (empty = all apps), events: {...} }
// State is kept in posted_keys (scope `apple:<kind>`, key = item id, value = last state). The
// first look at a scope records silently, so enabling the module never replays history.
import { allClientsReady, allGuilds, guildKey } from '../platform/platformOf.js';
import { EmbedBuilder } from 'discord.js';
import { config } from '../config.js';
import { isModuleEnabled, getGuildModule } from '../db/modules.js';
import { anySeen, clearScope, markSeen, seen, seenValue } from '../db/postedKeys.js';
import { createAppStoreConnect, isAppleSideFailure } from '../lib/appStoreConnect.js';
import { sendToChannel } from './lib/send.js';
import { log } from '../lib/log.js';
import { every } from './schedule.js';

export const MODULE_ID = 'apple-connect';

const POLL_MS = 5 * 60_000;
const MAX_APPS = 20;
const SCOPE_VERSIONS = 'apple:versions';
const SCOPE_BUILDS = 'apple:builds';
const SCOPE_BETA = 'apple:betareview';
const SCOPE_REVIEWS = 'apple:reviews';
const SCOPE_FEEDBACK = 'apple:feedback';
const SCOPE_EXPIRY = 'apple:expiry';
const DAY_MS = 24 * 60 * 60 * 1000;
const CREDENTIALS_EVERY_MS = 60 * 60 * 1000;

const isId = (v) => /^\d{17,20}$/.test(v ?? '');
const isAppId = (v) => /^\d{1,20}$/.test(v ?? '');
const clampInt = (v, min, max, fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const flag = (v, fallback) => (v === undefined ? fallback : Boolean(v));

/** One alert kind: `{ enabled, channelId }` (a plain boolean, the older shape, is still accepted). */
function kindConfig(v, enabledDefault) {
  const o = v !== null && typeof v === 'object' ? v : { enabled: v };
  return { enabled: flag(o.enabled, enabledDefault), channelId: isId(o.channelId) ? o.channelId : '' };
}

export function normaliseAppleConfig(raw = {}) {
  const e = raw.events ?? {};
  return {
    channelId: isId(raw.channelId) ? raw.channelId : '',
    roleId: isId(raw.roleId) ? raw.roleId : '',
    apps: [
      ...new Set(
        (Array.isArray(raw.apps) ? raw.apps : []).map((a) => String(a ?? '').trim()).filter(isAppId)
      ),
    ].slice(0, MAX_APPS),
    events: {
      versionState: kindConfig(e.versionState, true),
      build: kindConfig(e.build, true),
      betaReview: kindConfig(e.betaReview, true),
      reviews: { ...kindConfig(e.reviews, true), maxStars: clampInt(e.reviews?.maxStars, 1, 5, 5) },
      feedback: kindConfig(e.feedback, true),
      expiry: { ...kindConfig(e.expiry, true), days: clampInt(e.expiry?.days, 1, 365, 30) },
      sales: kindConfig(e.sales, false),
    },
  };
}

/** Where an alert kind posts: its own channel, else the main one ('' = nowhere, so it stays off). */
export const channelFor = (cfg, kind) => kind.channelId || cfg.channelId;

// --- states -----------------------------------------------------------------------

const COLORS = {
  bad: 0xe5484d,
  urgent: 0xf76808,
  good: 0x30a46c,
  wait: 0xf5a524,
  busy: 0x3e63dd,
  neutral: 0x8b8d98,
};

const STATE_LABELS = {
  PREPARE_FOR_SUBMISSION: 'Prepare for submission',
  READY_FOR_REVIEW: 'Ready for review',
  WAITING_FOR_REVIEW: 'Waiting for review',
  IN_REVIEW: 'In review',
  ACCEPTED: 'Accepted',
  PENDING_APPLE_RELEASE: 'Pending Apple release',
  PENDING_DEVELOPER_RELEASE: 'Pending developer release',
  PROCESSING_FOR_APP_STORE: 'Processing for the App Store',
  PROCESSING_FOR_DISTRIBUTION: 'Processing for distribution',
  READY_FOR_DISTRIBUTION: 'Ready for distribution',
  READY_FOR_SALE: 'Ready for sale',
  REJECTED: 'Rejected',
  METADATA_REJECTED: 'Metadata rejected',
  DEVELOPER_REJECTED: 'Developer rejected',
  INVALID_BINARY: 'Invalid binary',
  REMOVED_FROM_SALE: 'Removed from sale',
  DEVELOPER_REMOVED_FROM_SALE: 'Removed from sale by developer',
  REPLACED_WITH_NEW_VERSION: 'Replaced with a new version',
  WAITING_FOR_EXPORT_COMPLIANCE: 'Waiting for export compliance',
};
const BAD = new Set([
  'REJECTED',
  'METADATA_REJECTED',
  'INVALID_BINARY',
  'REMOVED_FROM_SALE',
  'DEVELOPER_REJECTED',
]);
const GOOD = new Set([
  'READY_FOR_SALE',
  'READY_FOR_DISTRIBUTION',
  'ACCEPTED',
  'PENDING_DEVELOPER_RELEASE',
  'PENDING_APPLE_RELEASE',
]);
const WAIT = new Set([
  'WAITING_FOR_REVIEW',
  'READY_FOR_REVIEW',
  'IN_REVIEW',
  'WAITING_FOR_EXPORT_COMPLIANCE',
]);
const BUSY = new Set(['PROCESSING_FOR_APP_STORE', 'PROCESSING_FOR_DISTRIBUTION']);

/** The App Store version's state. Apple replaced appStoreState with appVersionState (API 3.3). */
export function versionState(attributes = {}) {
  return attributes.appVersionState ?? attributes.appStoreState ?? 'UNKNOWN';
}

export function stateLabel(state) {
  if (STATE_LABELS[state]) return STATE_LABELS[state];
  const words = String(state ?? '')
    .toLowerCase()
    .replaceAll('_', ' ')
    .trim();
  return words ? words[0].toUpperCase() + words.slice(1) : 'Unknown';
}

export function stateColor(state) {
  if (BAD.has(state)) return COLORS.bad;
  if (GOOD.has(state)) return COLORS.good;
  if (WAIT.has(state)) return COLORS.wait;
  if (BUSY.has(state)) return COLORS.busy;
  return COLORS.neutral;
}

// --- messages ---------------------------------------------------------------------

const asc = (appId, path) => `https://appstoreconnect.apple.com/apps/${appId}/${path}`;

function withRole(embed, roleId) {
  return {
    ...(roleId ? { content: `<@&${roleId}>` } : {}),
    embeds: [embed],
    allowedMentions: { roles: roleId ? [roleId] : [] },
  };
}

const PLATFORM_LABELS = { IOS: 'iOS', MAC_OS: 'macOS', TV_OS: 'tvOS', VISION_OS: 'visionOS' };
const platformLabel = (p) => PLATFORM_LABELS[p] ?? (p ? stateLabel(p) : '');
const testflightPlatform = (p) => (PLATFORM_LABELS[p] ?? 'iOS').toLowerCase();

/** @param {{ app: {id,name}, version: {versionString,platform,state}, from: string|null, roleId?: string }} a */
export function versionPayload({ app, version, from, roleId = '' }) {
  const now = stateLabel(version.state);
  const embed = new EmbedBuilder()
    .setColor(stateColor(version.state))
    .setTitle(`📱 ${app.name} ${version.versionString ?? ''}`.trim())
    .setURL(asc(app.id, 'appstore'))
    .setDescription(from ? `${stateLabel(from)} → **${now}**` : `Now **${now}**`)
    .setTimestamp(Date.now());
  const platform = platformLabel(version.platform);
  if (platform) embed.setFooter({ text: platform });
  return withRole(embed, roleId);
}

const BUILD_TEXT = {
  VALID: ['Build processed — it is ready for TestFlight.', COLORS.good],
  INVALID: ['Build is invalid — Apple rejected it during processing.', COLORS.bad],
  FAILED: ['Build processing failed.', COLORS.bad],
};

/** @param {{ app: {id,name}, build: {...}, roleId?: string }} a */
export function buildPayload({ app, build, roleId = '' }) {
  const [text, color] = BUILD_TEXT[build.processingState] ?? [
    `Build is ${stateLabel(build.processingState)}.`,
    COLORS.neutral,
  ];
  const label = build.marketingVersion
    ? `${build.marketingVersion} (${build.version})`
    : `build ${build.version}`;
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`🛠️ ${app.name} ${label}`)
    .setURL(asc(app.id, `testflight/${testflightPlatform(build.platform)}`))
    .setDescription(text)
    .setTimestamp(Date.now());
  const platform = platformLabel(build.platform);
  if (platform) embed.setFooter({ text: platform });
  return withRole(embed, roleId);
}

const clip = (text, max) => {
  const s = String(text ?? '').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/** Whole days from `now` until `ms` (negative once it has passed). */
export const daysUntil = (ms, now = Date.now()) => Math.floor((ms - now) / DAY_MS);

const stars = (n) => '★'.repeat(Math.max(0, Math.min(5, n))) + '☆'.repeat(5 - Math.max(0, Math.min(5, n)));

/** @param {{ app: {id,name}, review: {rating,title,body,nickname,territory}, roleId?: string }} a */
export function reviewPayload({ app, review, roleId = '' }) {
  const color = review.rating >= 4 ? COLORS.good : review.rating === 3 ? COLORS.wait : COLORS.bad;
  const body = [review.title ? `**${clip(review.title, 200)}**` : '', clip(review.body, 1000)]
    .filter(Boolean)
    .join('\n');
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${review.rating}★ review — ${app.name}`)
    .setURL(`https://appstoreconnect.apple.com/apps/${app.id}`)
    .setDescription(`${stars(review.rating)}${body ? `\n${body}` : ''}`)
    .setTimestamp(Date.now());
  const by = [review.nickname, review.territory].filter(Boolean).join(' · ');
  if (by) embed.setFooter({ text: by });
  return withRole(embed, roleId);
}

const BETA_COLORS = { APPROVED: COLORS.good, REJECTED: COLORS.bad, IN_REVIEW: COLORS.wait };

/** @param {{ app, build: {version,marketingVersion,platform}, state: string, roleId?: string }} a */
export function betaReviewPayload({ app, build, state, roleId = '' }) {
  const label = build.marketingVersion
    ? `${build.marketingVersion} (${build.version})`
    : `build ${build.version}`;
  const embed = new EmbedBuilder()
    .setColor(BETA_COLORS[state] ?? COLORS.neutral)
    .setTitle(`🧪 TestFlight review — ${app.name}`)
    .setURL(asc(app.id, `testflight/${testflightPlatform(build.platform)}`))
    .setDescription(`${label}: **${stateLabel(state)}**`)
    .setTimestamp(Date.now());
  return withRole(embed, roleId);
}

/** @param {{ app, item: {kind,comment,deviceModel,osVersion,platform}, roleId?: string }} a */
export function feedbackPayload({ app, item, roleId = '' }) {
  const crash = item.kind === 'crash';
  const embed = new EmbedBuilder()
    .setColor(crash ? COLORS.bad : COLORS.busy)
    .setTitle(`${crash ? '💥 TestFlight crash' : '💬 TestFlight feedback'} — ${app.name}`)
    .setURL(asc(app.id, `testflight/${testflightPlatform(item.platform)}`))
    .setDescription(
      clip(item.comment, 1000) || (crash ? 'A tester sent a crash report.' : 'A tester sent feedback.')
    )
    .setTimestamp(Date.now());
  const fields = [
    item.deviceModel ? { name: 'Device', value: String(item.deviceModel), inline: true } : null,
    item.osVersion ? { name: 'OS', value: String(item.osVersion), inline: true } : null,
  ].filter(Boolean);
  if (fields.length) embed.addFields(fields);
  return withRole(embed, roleId);
}

/** @param {{ kind: 'certificate'|'profile', name: string, type?: string, daysLeft: number, roleId?: string }} a */
export function expiryPayload({ kind, name, type = '', daysLeft, roleId = '' }) {
  const noun = kind === 'profile' ? 'Provisioning profile' : 'Certificate';
  const gone = daysLeft < 0;
  const embed = new EmbedBuilder()
    .setColor(gone ? COLORS.bad : daysLeft <= 7 ? COLORS.urgent : COLORS.wait)
    .setTitle(
      gone ? `⏳ ${noun} expired` : `⏳ ${noun} expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`
    )
    .setURL(
      `https://developer.apple.com/account/resources/${kind === 'profile' ? 'profiles' : 'certificates'}/list`
    )
    .setDescription([name, type ? stateLabel(type) : ''].filter(Boolean).join(' — '))
    .setTimestamp(Date.now());
  return withRole(embed, roleId);
}

// --- reading the API --------------------------------------------------------------

/**
 * One account-wide snapshot: each app with its recent App Store versions and TestFlight builds.
 * An app whose calls fail is skipped (and logged) so one problem does not blind the rest.
 * @param {{ get: Function, getAll: Function }} client
 * @param {{ appIds?: string[], maxApps?: number, want?: { reviews?: boolean, feedback?: boolean, betaReview?: boolean } }} [opts]
 *   appIds empty = every app; `want` switches on the optional parts (each one only costs calls when asked for)
 */
export async function fetchSnapshot(client, { appIds = [], maxApps = MAX_APPS, want = {} } = {}) {
  const all = (await client.getAll('/v1/apps', { limit: 200 })).data;
  const wanted = appIds.length ? all.filter((a) => appIds.includes(a.id)) : all;
  const apps = [];
  for (const a of wanted.slice(0, maxApps)) {
    try {
      const versions = (
        await client.getAll(`/v1/apps/${a.id}/appStoreVersions`, { limit: 10 }, { maxPages: 1 })
      ).data.map((v) => ({
        id: v.id,
        versionString: v.attributes?.versionString ?? '',
        platform: v.attributes?.platform ?? '',
        state: versionState(v.attributes),
      }));
      const builds = await client.getAll(
        '/v1/builds',
        { 'filter[app]': a.id, sort: '-uploadedDate', limit: 10, include: 'preReleaseVersion' },
        { maxPages: 1 }
      );
      const pre = new Map(
        builds.included.filter((i) => i.type === 'preReleaseVersions').map((i) => [i.id, i.attributes ?? {}])
      );
      const builtBuilds = builds.data.map((b) => {
        const p = pre.get(b.relationships?.preReleaseVersion?.data?.id) ?? {};
        return {
          id: b.id,
          version: b.attributes?.version ?? '',
          uploadedDate: b.attributes?.uploadedDate ?? '',
          processingState: b.attributes?.processingState ?? '',
          expired: Boolean(b.attributes?.expired),
          marketingVersion: p.version ?? '',
          platform: p.platform ?? '',
        };
      });
      if (want.betaReview) await addBetaReviewStates(client, builtBuilds);
      apps.push({
        id: a.id,
        name: a.attributes?.name ?? a.id,
        bundleId: a.attributes?.bundleId ?? '',
        versions,
        builds: builtBuilds,
        // null = asked for but Apple could not be read; [] = nothing there (or not asked for)
        reviews: want.reviews ? await optional(() => fetchReviews(client, a.id), null) : [],
        feedback: want.feedback ? await optional(() => fetchFeedback(client, a.id), null) : [],
      });
    } catch (err) {
      logAppleFailure(`app ${a.id}: ${err.message}`, err);
    }
  }
  return { apps };
}

/**
 * Log an App Store Connect failure. Apple's own side (a 5xx, a timeout or a dropped connection,
 * all already retried once) is an outage over there, so it is a warning; anything else is ours
 * to look at.
 */
function logAppleFailure(message, err) {
  if (isAppleSideFailure(err)) log.warn('apple', message);
  else log.error('apple', message);
}

/** Run an optional part; a failure is logged and leaves the fallback in place. */
async function optional(fn, fallback) {
  try {
    return await fn();
  } catch (err) {
    logAppleFailure(err.message, err);
    return fallback;
  }
}

async function fetchReviews(client, appId) {
  const { data } = await client.getAll(
    `/v1/apps/${appId}/customerReviews`,
    { sort: '-createdDate', limit: 20 },
    { maxPages: 1 }
  );
  return data.map((r) => ({
    id: r.id,
    rating: Number(r.attributes?.rating) || 0,
    title: r.attributes?.title ?? '',
    body: r.attributes?.body ?? '',
    nickname: r.attributes?.reviewerNickname ?? '',
    territory: r.attributes?.territory ?? '',
    createdDate: r.attributes?.createdDate ?? '',
  }));
}

async function fetchFeedback(client, appId) {
  const kinds = [
    ['screenshot', `/v1/apps/${appId}/betaFeedbackScreenshotSubmissions`],
    ['crash', `/v1/apps/${appId}/betaFeedbackCrashSubmissions`],
  ];
  const out = [];
  for (const [kind, path] of kinds) {
    const items = await optional(
      async () => (await client.getAll(path, { limit: 50 }, { maxPages: 1 })).data,
      []
    );
    for (const f of items) {
      out.push({
        id: f.id,
        kind,
        comment: f.attributes?.comment ?? '',
        deviceModel: f.attributes?.deviceModel ?? '',
        osVersion: f.attributes?.osVersion ?? '',
        platform: f.attributes?.devicePlatform ?? f.attributes?.platform ?? '',
        createdDate: f.attributes?.createdDate ?? '',
      });
    }
  }
  return out;
}

/** TestFlight review state for the newest few live builds (one call each). */
async function addBetaReviewStates(client, builds) {
  const live = builds.filter((b) => b.processingState === 'VALID' && !b.expired).slice(0, 3);
  for (const b of builds) b.betaReviewState = '';
  for (const b of live) {
    b.betaReviewState = await optional(async () => {
      const body = await client.get(`/v1/builds/${b.id}/betaAppReviewSubmission`);
      const one = Array.isArray(body.data) ? body.data[0] : body.data;
      return one?.attributes?.betaReviewState ?? '';
    }, '');
  }
}

/**
 * Certificates and provisioning profiles with their expiry. Null when Apple refuses both
 * (an individual API key cannot read them; a team key can).
 * @returns {Promise<null | Array<{ kind: 'certificate'|'profile', id: string, name: string, type: string, expiresAt: number }>>}
 */
export async function fetchCredentials(client) {
  const sources = [
    ['certificate', '/v1/certificates', (a) => a.name ?? a.displayName ?? '', (a) => a.certificateType ?? ''],
    ['profile', '/v1/profiles', (a) => a.name ?? '', (a) => a.profileState ?? ''],
  ];
  const out = [];
  let reached = false;
  for (const [kind, path, name, type] of sources) {
    try {
      const { data } = await client.getAll(path, { limit: 200 }, { maxPages: 2 });
      reached = true;
      for (const c of data) {
        const expiresAt = Date.parse(c.attributes?.expirationDate ?? '');
        if (Number.isNaN(expiresAt)) continue;
        out.push({
          kind,
          id: c.id,
          name: name(c.attributes ?? {}),
          type: type(c.attributes ?? {}),
          expiresAt,
        });
      }
    } catch {
      /* try the other kind */
    }
  }
  return reached ? out : null;
}

// --- diffing and announcing -------------------------------------------------------

// Written once a scope has had a complete first look, so a scope that was empty then (no reviews
// yet) still counts as primed and the first real item is announced instead of swallowed.
const PRIMED_KEY = '__primed';

const BUILD_FINAL = new Set(['VALID', 'INVALID', 'FAILED']);
const BETA_ANNOUNCED = new Set(['IN_REVIEW', 'APPROVED', 'REJECTED']);

/**
 * Compare the snapshot with what this server last saw and announce the differences.
 * @param {string} guildId  guild key
 * @param {ReturnType<typeof normaliseAppleConfig>} cfg
 * @param {{ apps: any[] }} snapshot
 * @param {{ send?: (guildId: string, channelId: string, payload: object) => Promise<unknown> }} [deps]
 */
export async function processGuild(guildId, cfg, snapshot, { send = sendToChannel, now = Date.now } = {}) {
  const apps = snapshot.apps.filter((a) => !cfg.apps.length || cfg.apps.includes(a.id));

  // A switched-off kind forgets its state, so switching it on again starts with a silent look.
  if (!cfg.events.versionState.enabled) await clearScope(guildId, SCOPE_VERSIONS);
  else if (channelFor(cfg, cfg.events.versionState)) {
    const primed = await anySeen(guildId, SCOPE_VERSIONS);
    for (const app of apps) {
      for (const v of app.versions) {
        const prev = await seenValue(guildId, SCOPE_VERSIONS, v.id);
        if (prev === v.state) continue;
        await markSeen(guildId, SCOPE_VERSIONS, v.id, v.state, { upsert: true });
        if (!primed) continue;
        if (prev == null && v.state === 'PREPARE_FOR_SUBMISSION') continue; // a draft nobody has submitted
        await send(
          guildId,
          channelFor(cfg, cfg.events.versionState),
          versionPayload({ app, version: v, from: prev, roleId: cfg.roleId })
        );
      }
    }
  }

  if (!cfg.events.build.enabled) await clearScope(guildId, SCOPE_BUILDS);
  else if (channelFor(cfg, cfg.events.build)) {
    const primed = await anySeen(guildId, SCOPE_BUILDS);
    for (const app of apps) {
      for (const b of app.builds) {
        const prev = await seenValue(guildId, SCOPE_BUILDS, b.id);
        if (prev === b.processingState) continue;
        await markSeen(guildId, SCOPE_BUILDS, b.id, b.processingState, { upsert: true });
        if (!primed || !BUILD_FINAL.has(b.processingState)) continue;
        await send(
          guildId,
          channelFor(cfg, cfg.events.build),
          buildPayload({ app, build: b, roleId: cfg.roleId })
        );
      }
    }
  }

  // TestFlight beta review: announced when it starts and when it is decided.
  if (!cfg.events.betaReview.enabled) await clearScope(guildId, SCOPE_BETA);
  else if (channelFor(cfg, cfg.events.betaReview)) {
    const primed = await anySeen(guildId, SCOPE_BETA);
    for (const app of apps) {
      for (const b of app.builds) {
        if (!b.betaReviewState) continue;
        const prev = await seenValue(guildId, SCOPE_BETA, b.id);
        if (prev === b.betaReviewState) continue;
        await markSeen(guildId, SCOPE_BETA, b.id, b.betaReviewState, { upsert: true });
        if (!primed || !BETA_ANNOUNCED.has(b.betaReviewState)) continue;
        await send(
          guildId,
          channelFor(cfg, cfg.events.betaReview),
          betaReviewPayload({ app, build: b, state: b.betaReviewState, roleId: cfg.roleId })
        );
      }
    }
  }

  // New customer reviews (the rating filter only decides what is posted, not what is remembered).
  if (!cfg.events.reviews.enabled) await clearScope(guildId, SCOPE_REVIEWS);
  else if (channelFor(cfg, cfg.events.reviews)) {
    const primed = await anySeen(guildId, SCOPE_REVIEWS);
    for (const app of apps) {
      for (const r of app.reviews ?? []) {
        if (await seen(guildId, SCOPE_REVIEWS, r.id)) continue;
        await markSeen(guildId, SCOPE_REVIEWS, r.id);
        if (!primed || r.rating > cfg.events.reviews.maxStars) continue;
        await send(
          guildId,
          channelFor(cfg, cfg.events.reviews),
          reviewPayload({ app, review: r, roleId: cfg.roleId })
        );
      }
    }
    if (!primed && apps.every((a) => a.reviews != null)) await markSeen(guildId, SCOPE_REVIEWS, PRIMED_KEY);
  }

  // New TestFlight feedback and crash reports.
  if (!cfg.events.feedback.enabled) await clearScope(guildId, SCOPE_FEEDBACK);
  else if (channelFor(cfg, cfg.events.feedback)) {
    const primed = await anySeen(guildId, SCOPE_FEEDBACK);
    for (const app of apps) {
      for (const item of app.feedback ?? []) {
        if (await seen(guildId, SCOPE_FEEDBACK, item.id)) continue;
        await markSeen(guildId, SCOPE_FEEDBACK, item.id);
        if (!primed) continue;
        await send(
          guildId,
          channelFor(cfg, cfg.events.feedback),
          feedbackPayload({ app, item, roleId: cfg.roleId })
        );
      }
    }
    if (!primed && apps.every((a) => a.feedback != null)) await markSeen(guildId, SCOPE_FEEDBACK, PRIMED_KEY);
  }

  // Certificates and profiles close to (or past) their expiry. Not primed: if one is already
  // inside the window when the module is switched on, that is exactly what to hear about.
  if (cfg.events.expiry.enabled && snapshot.credentials && channelFor(cfg, cfg.events.expiry)) {
    const thresholds = [
      ...new Set([cfg.events.expiry.days, 7, 1].filter((d) => d <= cfg.events.expiry.days)),
    ].sort((a, b) => a - b);
    for (const c of snapshot.credentials) {
      const remaining = (c.expiresAt - now()) / DAY_MS;
      const bucket = remaining <= 0 ? 'expired' : thresholds.find((t) => remaining <= t);
      if (bucket == null) continue;
      const key = `${c.kind}:${c.id}:${bucket}`;
      if (await seen(guildId, SCOPE_EXPIRY, key)) continue;
      await markSeen(guildId, SCOPE_EXPIRY, key);
      await send(
        guildId,
        channelFor(cfg, cfg.events.expiry),
        expiryPayload({
          kind: c.kind,
          name: c.name,
          type: c.type,
          daysLeft: daysUntil(c.expiresAt, now()),
          roleId: cfg.roleId,
        })
      );
    }
  }
}

// --- the poll loop ----------------------------------------------------------------

let sharedClient = null;
let running = false;
let lastCredentialsAt = 0;
let credentialsWarned = false;
function appleClient() {
  if (!config.appleEnabled) return null;
  sharedClient ??= createAppStoreConnect({
    keyId: config.appleKeyId,
    issuerId: config.appleIssuerId,
    privateKey: config.applePrivateKey,
  });
  return sharedClient;
}

/** One pass: one snapshot of the account, then every server that has the module on. */
export async function runAppleTick({
  client = appleClient(),
  guilds = allGuilds(),
  send = sendToChannel,
} = {}) {
  if (!client || running) return; // a slow pass must not overlap the next one (double alerts)
  running = true;
  try {
    await pass(client, guilds, send);
  } finally {
    running = false;
  }
}

async function pass(client, guilds, send) {
  const jobs = [];
  for (const guild of guilds) {
    const key = guildKey(guild);
    if (!(await isModuleEnabled(key, MODULE_ID))) continue;
    const cfg = normaliseAppleConfig((await getGuildModule(key, MODULE_ID)).config);
    if (Object.values(cfg.events).some((kind) => kind.enabled && channelFor(cfg, kind)))
      jobs.push({ key, cfg });
  }
  if (!jobs.length) return;

  // Fetch only the apps somebody asked for (empty list = all of them).
  const everything = jobs.some((j) => !j.cfg.apps.length);
  const appIds = everything ? [] : [...new Set(jobs.flatMap((j) => j.cfg.apps))];
  const wants = (kind) =>
    jobs.some((j) => j.cfg.events[kind].enabled && channelFor(j.cfg, j.cfg.events[kind]));
  const want = {
    reviews: wants('reviews'),
    feedback: wants('feedback'),
    betaReview: wants('betaReview'),
  };
  const snapshot = await fetchSnapshot(client, { appIds, want });
  if (wants('expiry') && Date.now() - lastCredentialsAt >= CREDENTIALS_EVERY_MS) {
    lastCredentialsAt = Date.now();
    const credentials = await fetchCredentials(client);
    if (credentials) snapshot.credentials = credentials;
    else if (!credentialsWarned) {
      credentialsWarned = true;
      log.warn(
        'apple',
        'certificate expiry unavailable: Apple refused /v1/certificates and /v1/profiles (needs a team API key)'
      );
    }
  }
  for (const { key, cfg } of jobs) {
    try {
      await processGuild(key, cfg, snapshot, { send });
    } catch (err) {
      logAppleFailure(`${key}: ${err.message}`, err);
    }
  }
}

async function tick() {
  if (!config.appleEnabled || !allClientsReady()) return;
  await runAppleTick();
}

every(
  'apple-connect',
  POLL_MS,
  () => tick().catch((err) => logAppleFailure(`tick failed: ${err.message}`, err)),
  { firstDelayMs: 60_000 }
);
