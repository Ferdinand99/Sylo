// Phase 3 of the App Store Connect module: reviews, TestFlight beta review, TestFlight feedback
// and certificate / profile expiry.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  expiryPayload,
  feedbackPayload,
  fetchCredentials,
  fetchSnapshot,
  normaliseAppleConfig,
  processGuild,
  reviewPayload,
  betaReviewPayload,
  daysUntil,
} from '../src/modules/appleConnect.js';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const day = 24 * 60 * 60 * 1000;
const cfg = (events = {}, extra = {}) =>
  normaliseAppleConfig({ channelId: '123456789012345678', events, ...extra });
const collector = () => {
  const sent = [];
  return { sent, send: async (guild, channel, payload) => (sent.push({ guild, channel, payload }), true) };
};
const embedOf = (entry) => entry.payload.embeds[0].toJSON();
const app = { id: '10', name: 'My App' };
const withApp = (extra) => ({
  apps: [{ ...app, versions: [], builds: [], reviews: [], feedback: [], ...extra }],
});

// --- payloads -------------------------------------------------------------------------

test('reviewPayload: stars, title, text, reviewer and country', () => {
  const p = reviewPayload({
    app,
    review: {
      id: 'r1',
      rating: 2,
      title: 'Crashes',
      body: 'It crashes on launch.',
      nickname: 'sam',
      territory: 'NOR',
    },
    roleId: '123456789012345678',
  });
  const e = p.embeds[0].toJSON();
  assert.match(e.title, /2/);
  assert.match(e.title, /My App/);
  assert.match(e.description, /Crashes/);
  assert.match(e.description, /It crashes on launch\./);
  assert.match(e.footer.text, /sam/);
  assert.match(e.footer.text, /NOR/);
  assert.equal(p.content, '<@&123456789012345678>');
  const good = reviewPayload({
    app,
    review: { id: 'r2', rating: 5, title: '', body: '' },
  }).embeds[0].toJSON();
  assert.notEqual(good.color, e.color);
  const long = reviewPayload({
    app,
    review: { id: 'r3', rating: 1, title: 'x', body: 'y'.repeat(5000) },
  }).embeds[0].toJSON();
  assert.ok(long.description.length <= 1500, 'a long review is cut short');
});

test('betaReviewPayload: names the build and the TestFlight review state', () => {
  const e = betaReviewPayload({
    app,
    build: { version: '57', marketingVersion: '1.2.0', platform: 'IOS' },
    state: 'REJECTED',
  }).embeds[0].toJSON();
  assert.match(e.title, /TestFlight/);
  assert.match(e.description, /1\.2\.0 \(57\)/);
  assert.match(e.description, /Rejected/);
});

test('feedbackPayload: screenshot and crash feedback with device details', () => {
  const s = feedbackPayload({
    app,
    item: {
      id: 'f1',
      kind: 'screenshot',
      comment: 'Button is cut off',
      deviceModel: 'iPhone16,2',
      osVersion: '19.0',
    },
  }).embeds[0].toJSON();
  assert.match(s.title, /feedback/i);
  assert.match(s.description, /Button is cut off/);
  assert.match(JSON.stringify(s.fields), /iPhone16,2/);
  const c = feedbackPayload({ app, item: { id: 'f2', kind: 'crash', comment: '' } }).embeds[0].toJSON();
  assert.match(c.title, /crash/i);
});

test('daysUntil / expiryPayload: days left, or already expired', () => {
  assert.equal(daysUntil(NOW + 10 * day + 1000, NOW), 10);
  assert.equal(daysUntil(NOW - 2 * day, NOW), -2);
  const soon = expiryPayload({
    kind: 'certificate',
    name: 'Apple Distribution',
    type: 'DISTRIBUTION',
    daysLeft: 6,
  }).embeds[0].toJSON();
  assert.match(soon.title, /6 days/);
  assert.match(soon.description, /Apple Distribution/);
  const gone = expiryPayload({ kind: 'profile', name: 'Ad Hoc', daysLeft: -1 }).embeds[0].toJSON();
  assert.match(gone.title, /expired/i);
  assert.notEqual(soon.color, gone.color);
});

// --- reading the API -------------------------------------------------------------------

function fakeClient(routes) {
  const answer = (path, query) => {
    const hit = routes[path];
    if (hit === undefined) throw Object.assign(new Error(`unexpected ${path}`), { status: 404 });
    return typeof hit === 'function' ? hit(query) : hit;
  };
  return {
    get: async (path, query) => answer(path, query),
    getAll: async (path, query) => {
      const b = answer(path, query);
      return { data: b.data ?? [], included: b.included ?? [] };
    },
  };
}

const baseRoutes = {
  '/v1/apps': { data: [{ id: '10', attributes: { name: 'My App' } }] },
  '/v1/apps/10/appStoreVersions': { data: [] },
  '/v1/builds': {
    data: [
      { id: 'b1', attributes: { version: '57', processingState: 'VALID', expired: false } },
      { id: 'b0', attributes: { version: '56', processingState: 'VALID', expired: true } },
    ],
  },
};

test('fetchSnapshot with want: reviews, feedback and the beta review state of live builds', async () => {
  const client = fakeClient({
    ...baseRoutes,
    '/v1/apps/10/customerReviews': {
      data: [
        {
          id: 'r1',
          attributes: {
            rating: 4,
            title: 'Nice',
            body: 'Works',
            reviewerNickname: 'sam',
            createdDate: 'd',
            territory: 'NOR',
          },
        },
      ],
    },
    '/v1/apps/10/betaFeedbackScreenshotSubmissions': {
      data: [
        {
          id: 'f1',
          attributes: { comment: 'cut off', deviceModel: 'iPhone', osVersion: '19', createdDate: 'd1' },
        },
      ],
    },
    '/v1/apps/10/betaFeedbackCrashSubmissions': {
      data: [{ id: 'f2', attributes: { comment: '', deviceModel: 'iPad', createdDate: 'd2' } }],
    },
    '/v1/builds/b1/betaAppReviewSubmission': {
      data: { id: 's1', attributes: { betaReviewState: 'IN_REVIEW' } },
    },
  });
  const snap = await fetchSnapshot(client, { want: { reviews: true, feedback: true, betaReview: true } });
  const a = snap.apps[0];
  assert.deepEqual(a.reviews, [
    {
      id: 'r1',
      rating: 4,
      title: 'Nice',
      body: 'Works',
      nickname: 'sam',
      territory: 'NOR',
      createdDate: 'd',
    },
  ]);
  assert.deepEqual(
    a.feedback.map((f) => [f.id, f.kind]),
    [
      ['f1', 'screenshot'],
      ['f2', 'crash'],
    ]
  );
  assert.equal(a.feedback[0].deviceModel, 'iPhone');
  assert.equal(a.builds[0].betaReviewState, 'IN_REVIEW');
  assert.equal(a.builds[1].betaReviewState, '', 'an expired build is not asked about');
});

test('fetchSnapshot: a failing optional part is left empty and does not drop the rest', async () => {
  const client = fakeClient({
    ...baseRoutes,
    '/v1/apps/10/betaFeedbackScreenshotSubmissions': { data: [{ id: 'f1', attributes: {} }] },
    // customerReviews, the crash feedback and the beta review answer 404
  });
  const snap = await fetchSnapshot(client, { want: { reviews: true, feedback: true, betaReview: true } });
  const a = snap.apps[0];
  assert.equal(a.reviews, null, 'null means "could not be read", unlike an empty list');
  assert.deepEqual(
    a.feedback.map((f) => f.id),
    ['f1']
  );
  assert.equal(a.builds[0].betaReviewState, '');
});

test('fetchCredentials: certificates and profiles with their expiry, and null when Apple refuses', async () => {
  const client = fakeClient({
    '/v1/certificates': {
      data: [
        {
          id: 'c1',
          attributes: {
            name: 'Apple Distribution',
            certificateType: 'DISTRIBUTION',
            expirationDate: '2027-10-13T14:15:16.000+00:00',
          },
        },
      ],
    },
    '/v1/profiles': {
      data: [
        {
          id: 'p1',
          attributes: {
            name: 'Store profile',
            profileState: 'ACTIVE',
            expirationDate: '2026-11-01T00:00:00.000+00:00',
          },
        },
      ],
    },
  });
  const list = await fetchCredentials(client);
  assert.deepEqual(
    list.map((c) => [c.kind, c.id, c.name]),
    [
      ['certificate', 'c1', 'Apple Distribution'],
      ['profile', 'p1', 'Store profile'],
    ]
  );
  assert.equal(list[1].expiresAt, Date.parse('2026-11-01T00:00:00Z'));

  const refused = fakeClient({});
  assert.equal(await fetchCredentials(refused), null);
});

// --- announcing ------------------------------------------------------------------------

const review = (id, rating, title = 't') => ({
  id,
  rating,
  title,
  body: 'b',
  nickname: 'n',
  territory: 'NOR',
  createdDate: 'd',
});

test('processGuild: new reviews are announced once, the first look is silent, and maxStars filters', async () => {
  const seed = collector();
  await processGuild('g-r', cfg(), withApp({ reviews: [review('r1', 5)] }), seed);
  assert.deepEqual(seed.sent, []);
  const { sent, send } = collector();
  const next = withApp({ reviews: [review('r2', 1), review('r1', 5)] });
  await processGuild('g-r', cfg(), next, { send });
  assert.equal(sent.length, 1);
  assert.match(embedOf(sent[0]).title, /1/);
  await processGuild('g-r', cfg(), next, { send });
  assert.equal(sent.length, 1);

  const low = collector();
  const lowCfg = cfg({ reviews: { enabled: true, maxStars: 2 } });
  await processGuild('g-r2', lowCfg, withApp({ reviews: [review('a', 3)] }), low);
  await processGuild(
    'g-r2',
    lowCfg,
    withApp({ reviews: [review('b', 5), review('c', 2), review('a', 3)] }),
    low
  );
  assert.equal(low.sent.length, 1, 'only the 2-star review passes a maxStars of 2');
  assert.match(embedOf(low.sent[0]).title, /2/);
});

test('processGuild: a TestFlight beta review is announced when it starts, is approved or rejected', async () => {
  const b = (state) => ({
    id: 'b1',
    version: '57',
    processingState: 'VALID',
    marketingVersion: '1.2.0',
    platform: 'IOS',
    expired: false,
    betaReviewState: state,
  });
  const seed = collector();
  await processGuild('g-br', cfg(), withApp({ builds: [b('WAITING_FOR_REVIEW')] }), seed);
  const { sent, send } = collector();
  await processGuild('g-br', cfg(), withApp({ builds: [b('WAITING_FOR_REVIEW')] }), { send });
  assert.equal(sent.length, 0);
  await processGuild('g-br', cfg(), withApp({ builds: [b('IN_REVIEW')] }), { send });
  await processGuild('g-br', cfg(), withApp({ builds: [b('APPROVED')] }), { send });
  assert.equal(sent.length, 2);
  assert.match(embedOf(sent[1]).description, /Approved/);
});

test('processGuild: TestFlight feedback and crashes are announced once', async () => {
  const fb = (id, kind) => ({
    id,
    kind,
    comment: 'c',
    deviceModel: 'iPhone',
    osVersion: '19',
    createdDate: 'd',
  });
  const seed = collector();
  await processGuild('g-fb', cfg(), withApp({ feedback: [fb('f1', 'screenshot')] }), seed);
  const { sent, send } = collector();
  const next = withApp({ feedback: [fb('f2', 'crash'), fb('f1', 'screenshot')] });
  await processGuild('g-fb', cfg(), next, { send });
  await processGuild('g-fb', cfg(), next, { send });
  assert.equal(sent.length, 1);
  assert.match(embedOf(sent[0]).title, /crash/i);
});

test('processGuild: certificates warn at the configured days, again at 7 and 1, and when expired', async () => {
  const cred = (daysLeft) => ({
    credentials: [
      { kind: 'certificate', id: 'c1', name: 'Dist', type: 'DISTRIBUTION', expiresAt: NOW + daysLeft * day },
    ],
  });
  const { sent, send } = collector();
  const run = (daysLeft) =>
    processGuild(
      'g-ex',
      cfg({ expiry: { enabled: true, days: 30 } }),
      { apps: [], ...cred(daysLeft) },
      { send, now: () => NOW }
    );
  await run(90);
  assert.equal(sent.length, 0, 'far from expiry');
  await run(29);
  assert.equal(sent.length, 1);
  await run(20);
  assert.equal(sent.length, 1, 'same threshold, no repeat');
  await run(6);
  assert.equal(sent.length, 2, 'the 7 day mark');
  await run(0.5);
  assert.equal(sent.length, 3, 'the last day');
  await run(-1);
  assert.equal(sent.length, 4, 'expired');
  await run(-5);
  assert.equal(sent.length, 4, 'only announced once');
});

test('processGuild: each alert kind goes to its own channel when one is set', async () => {
  const { sent, send } = collector();
  const per = cfg({
    reviews: { enabled: true, maxStars: 5, channelId: '523456789012345678' },
    feedback: { enabled: true, channelId: '623456789012345678' },
    expiry: { enabled: true, days: 30, channelId: '723456789012345678' },
  });
  const first = withApp({
    reviews: [review('r0', 5)],
    feedback: [{ id: 'f0', kind: 'crash', comment: 'old' }],
  });
  first.credentials = [];
  await processGuild('g-ch', per, first, { send, now: () => NOW });
  const next = withApp({
    reviews: [review('r9', 2), review('r0', 5)],
    feedback: [
      { id: 'f9', kind: 'crash', comment: 'x' },
      { id: 'f0', kind: 'crash', comment: 'old' },
    ],
  });
  next.credentials = [
    { kind: 'certificate', id: 'c1', name: 'Dist', type: 'DISTRIBUTION', expiresAt: NOW + 3 * day },
  ];
  await processGuild('g-ch', per, next, { send, now: () => NOW });
  assert.deepEqual(sent.map((s) => s.channel).sort(), [
    '523456789012345678',
    '623456789012345678',
    '723456789012345678',
  ]);
});

test('processGuild: switched-off kinds announce nothing', async () => {
  const off = cfg({
    reviews: { enabled: false },
    feedback: false,
    betaReview: false,
    expiry: { enabled: false },
  });
  const { sent, send } = collector();
  const snap = withApp({ reviews: [review('r1', 1)], feedback: [{ id: 'f', kind: 'crash' }] });
  snap.credentials = [{ kind: 'certificate', id: 'c', name: 'x', expiresAt: NOW - day }];
  await processGuild('g-offs', off, snap, { send, now: () => NOW });
  await processGuild('g-offs', off, snap, { send, now: () => NOW });
  assert.deepEqual(sent, []);
});

test('processGuild: the first review and feedback are announced even when the first look found none', async () => {
  const first = collector();
  await processGuild('g-empty', cfg(), withApp(), first);
  assert.deepEqual(first.sent, []);
  const { sent, send } = collector();
  const crash = { id: 'f1', kind: 'crash', comment: 'boom', deviceModel: '', osVersion: '', platform: 'IOS' };
  await processGuild('g-empty', cfg(), withApp({ reviews: [review('r1', 1)], feedback: [crash] }), { send });
  assert.equal(sent.length, 2, 'the review and the crash are both news, not history');
});

test('processGuild: a part that could not be read does not count as a first look', async () => {
  const s = collector();
  await processGuild('g-null', cfg(), withApp({ reviews: null, feedback: null }), s);
  // Apple answers properly now: what it lists is old, so it is recorded silently.
  await processGuild('g-null', cfg(), withApp({ reviews: [review('old', 1)] }), s);
  assert.deepEqual(s.sent, []);
  await processGuild('g-null', cfg(), withApp({ reviews: [review('new', 1), review('old', 1)] }), s);
  assert.equal(s.sent.length, 1);
});
