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
import { anySeen, clearScope, markSeen, seenValue } from '../db/postedKeys.js';
import { createAppStoreConnect } from '../lib/appStoreConnect.js';
import { sendToChannel } from './lib/send.js';
import { log } from '../lib/log.js';

export const MODULE_ID = 'apple-connect';

const POLL_MS = 5 * 60_000;
const MAX_APPS = 20;
const SCOPE_VERSIONS = 'apple:versions';
const SCOPE_BUILDS = 'apple:builds';

const isId = (v) => /^\d{17,20}$/.test(v ?? '');
const isAppId = (v) => /^\d{1,20}$/.test(v ?? '');
const clampInt = (v, min, max, fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const flag = (v, fallback) => (v === undefined ? fallback : Boolean(v));

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
      versionState: flag(e.versionState, true),
      build: flag(e.build, true),
      betaReview: flag(e.betaReview, true),
      reviews: { enabled: flag(e.reviews?.enabled, true), maxStars: clampInt(e.reviews?.maxStars, 1, 5, 5) },
      feedback: flag(e.feedback, true),
      expiry: { enabled: flag(e.expiry?.enabled, true), days: clampInt(e.expiry?.days, 1, 365, 30) },
      sales: flag(e.sales, false),
    },
  };
}

// --- states -----------------------------------------------------------------------

const COLORS = { bad: 0xe5484d, good: 0x30a46c, wait: 0xf5a524, busy: 0x3e63dd, neutral: 0x8b8d98 };

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

// --- reading the API --------------------------------------------------------------

/**
 * One account-wide snapshot: each app with its recent App Store versions and TestFlight builds.
 * An app whose calls fail is skipped (and logged) so one problem does not blind the rest.
 * @param {{ get: Function, getAll: Function }} client
 * @param {{ appIds?: string[], maxApps?: number }} [opts]  appIds empty = every app
 */
export async function fetchSnapshot(client, { appIds = [], maxApps = MAX_APPS } = {}) {
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
      apps.push({
        id: a.id,
        name: a.attributes?.name ?? a.id,
        bundleId: a.attributes?.bundleId ?? '',
        versions,
        builds: builds.data.map((b) => {
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
        }),
      });
    } catch (err) {
      log.error('apple', `app ${a.id}: ${err.message}`);
    }
  }
  return { apps };
}

// --- diffing and announcing -------------------------------------------------------

const BUILD_FINAL = new Set(['VALID', 'INVALID', 'FAILED']);

/**
 * Compare the snapshot with what this server last saw and announce the differences.
 * @param {string} guildId  guild key
 * @param {ReturnType<typeof normaliseAppleConfig>} cfg
 * @param {{ apps: any[] }} snapshot
 * @param {{ send?: (guildId: string, channelId: string, payload: object) => Promise<unknown> }} [deps]
 */
export async function processGuild(guildId, cfg, snapshot, { send = sendToChannel } = {}) {
  if (!cfg.channelId) return;
  const apps = snapshot.apps.filter((a) => !cfg.apps.length || cfg.apps.includes(a.id));

  // A switched-off kind forgets its state, so switching it on again starts with a silent look.
  if (!cfg.events.versionState) await clearScope(guildId, SCOPE_VERSIONS);
  else {
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
          cfg.channelId,
          versionPayload({ app, version: v, from: prev, roleId: cfg.roleId })
        );
      }
    }
  }

  if (!cfg.events.build) await clearScope(guildId, SCOPE_BUILDS);
  else {
    const primed = await anySeen(guildId, SCOPE_BUILDS);
    for (const app of apps) {
      for (const b of app.builds) {
        const prev = await seenValue(guildId, SCOPE_BUILDS, b.id);
        if (prev === b.processingState) continue;
        await markSeen(guildId, SCOPE_BUILDS, b.id, b.processingState, { upsert: true });
        if (!primed || !BUILD_FINAL.has(b.processingState)) continue;
        await send(guildId, cfg.channelId, buildPayload({ app, build: b, roleId: cfg.roleId }));
      }
    }
  }
}

// --- the poll loop ----------------------------------------------------------------

let sharedClient = null;
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
  if (!client) return;
  const jobs = [];
  for (const guild of guilds) {
    const key = guildKey(guild);
    if (!(await isModuleEnabled(key, MODULE_ID))) continue;
    const cfg = normaliseAppleConfig((await getGuildModule(key, MODULE_ID)).config);
    if (cfg.channelId) jobs.push({ key, cfg });
  }
  if (!jobs.length) return;

  // Fetch only the apps somebody asked for (empty list = all of them).
  const everything = jobs.some((j) => !j.cfg.apps.length);
  const appIds = everything ? [] : [...new Set(jobs.flatMap((j) => j.cfg.apps))];
  const snapshot = await fetchSnapshot(client, { appIds });
  for (const { key, cfg } of jobs) {
    try {
      await processGuild(key, cfg, snapshot, { send });
    } catch (err) {
      log.error('apple', `${key}: ${err.message}`);
    }
  }
}

async function tick() {
  if (!config.appleEnabled || !allClientsReady()) return;
  await runAppleTick();
}

const timer = setInterval(() => {
  tick().catch((err) => log.error('apple', 'tick failed:', err.message));
}, POLL_MS);
timer.unref();
setTimeout(
  () => tick().catch((err) => log.error('apple', 'first tick failed:', err.message)),
  60_000
).unref();
