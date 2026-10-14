import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPayload,
  channelFor,
  fetchSnapshot,
  normaliseAppleConfig,
  processGuild,
  stateColor,
  stateLabel,
  versionPayload,
  versionState,
} from '../src/modules/appleConnect.js';

const G = '900000000000000300';

test('normaliseAppleConfig: defaults, channel/role ids, app ids and clamped numbers', () => {
  const d = normaliseAppleConfig({});
  assert.equal(d.channelId, '');
  assert.deepEqual(d.apps, []);
  assert.deepEqual(d.events.versionState, { enabled: true, channelId: '' });
  assert.equal(d.events.build.enabled, true);
  assert.equal(d.events.sales.enabled, false);

  const c = normaliseAppleConfig({
    channelId: '123456789012345678',
    roleId: 'nope',
    apps: ['6446998023', ' 6446998023 ', 'abc', '', 42],
    events: {
      versionState: false,
      reviews: { enabled: true, maxStars: 99 },
      expiry: { enabled: true, days: 0 },
    },
  });
  assert.equal(c.channelId, '123456789012345678');
  assert.equal(c.roleId, '');
  assert.deepEqual(c.apps, ['6446998023', '42']);
  assert.equal(c.events.versionState.enabled, false);
  assert.equal(c.events.reviews.maxStars, 5);
  assert.equal(c.events.expiry.days, 1);
});

test('normaliseAppleConfig: each kind can have its own channel, falling back to the main one', () => {
  const c = normaliseAppleConfig({
    channelId: '123456789012345678',
    events: {
      versionState: { enabled: true, channelId: '223456789012345678' },
      feedback: { enabled: true, channelId: 'not-an-id' },
      reviews: { enabled: true, maxStars: 3, channelId: '323456789012345678' },
      expiry: { channelId: '423456789012345678' },
    },
  });
  assert.equal(c.events.versionState.channelId, '223456789012345678');
  assert.equal(c.events.feedback.channelId, '');
  assert.deepEqual(c.events.reviews, { enabled: true, maxStars: 3, channelId: '323456789012345678' });
  assert.equal(c.events.expiry.enabled, true);
  assert.equal(c.events.expiry.channelId, '423456789012345678');
  assert.equal(channelFor(c, c.events.versionState), '223456789012345678');
  assert.equal(channelFor(c, c.events.build), '123456789012345678');
});

test('versionState prefers the newer appVersionState, falls back to appStoreState', () => {
  assert.equal(
    versionState({ appVersionState: 'IN_REVIEW', appStoreState: 'WAITING_FOR_REVIEW' }),
    'IN_REVIEW'
  );
  assert.equal(versionState({ appStoreState: 'READY_FOR_SALE' }), 'READY_FOR_SALE');
  assert.equal(versionState({}), 'UNKNOWN');
});

test('stateLabel / stateColor: known states, and a readable fallback for new ones', () => {
  assert.equal(stateLabel('WAITING_FOR_REVIEW'), 'Waiting for review');
  assert.equal(stateLabel('READY_FOR_SALE'), 'Ready for sale');
  assert.equal(stateLabel('SOME_FUTURE_STATE'), 'Some future state');
  assert.equal(stateColor('REJECTED'), stateColor('METADATA_REJECTED'));
  assert.notEqual(stateColor('REJECTED'), stateColor('READY_FOR_SALE'));
  assert.equal(typeof stateColor('SOME_FUTURE_STATE'), 'number');
});

test('versionPayload: names the app, version and the state change, and links to App Store Connect', () => {
  const p = versionPayload({
    app: { id: '6446998023', name: 'My App' },
    version: { versionString: '1.2.0', platform: 'IOS', state: 'REJECTED' },
    from: 'IN_REVIEW',
    roleId: '123456789012345678',
  });
  const embed = p.embeds[0].toJSON();
  assert.match(embed.title, /My App/);
  assert.match(embed.title, /1\.2\.0/);
  assert.match(embed.description, /In review/);
  assert.match(embed.description, /Rejected/);
  assert.equal(embed.url, 'https://appstoreconnect.apple.com/apps/6446998023/appstore');
  assert.equal(embed.color, stateColor('REJECTED'));
  assert.equal(p.content, '<@&123456789012345678>');
  assert.deepEqual(p.allowedMentions, { roles: ['123456789012345678'] });

  const first = versionPayload({
    app: { id: '1', name: 'A' },
    version: { versionString: '2.0', platform: 'IOS', state: 'WAITING_FOR_REVIEW' },
    from: null,
  });
  assert.equal(first.content, undefined);
  assert.match(first.embeds[0].toJSON().description, /Waiting for review/);
});

test('buildPayload: processed, invalid and failed builds', () => {
  const ok = buildPayload({
    app: { id: '1', name: 'A' },
    build: { version: '57', marketingVersion: '1.2.0', platform: 'IOS', processingState: 'VALID' },
  }).embeds[0].toJSON();
  assert.match(ok.title, /1\.2\.0 \(57\)/);
  assert.match(ok.description, /processed/i);
  assert.equal(ok.url, 'https://appstoreconnect.apple.com/apps/1/testflight/ios');

  const bad = buildPayload({
    app: { id: '1', name: 'A' },
    build: { version: '58', processingState: 'INVALID' },
  }).embeds[0].toJSON();
  assert.match(bad.description, /invalid/i);
  assert.notEqual(bad.color, ok.color);
});

// --- reading the API ------------------------------------------------------------

function fakeClient(routes) {
  const calls = [];
  const answer = (path, query) => {
    calls.push([path, query]);
    const hit = routes[path];
    if (hit === undefined) throw new Error(`unexpected ${path}`);
    return typeof hit === 'function' ? hit(query) : hit;
  };
  return {
    calls,
    get: async (path, query) => answer(path, query),
    getAll: async (path, query) => {
      const b = answer(path, query);
      return { data: b.data ?? [], included: b.included ?? [] };
    },
  };
}

test('fetchSnapshot: apps with their App Store versions and recent builds', async () => {
  const client = fakeClient({
    '/v1/apps': { data: [{ id: '10', attributes: { name: 'My App', bundleId: 'com.x.app' } }] },
    '/v1/apps/10/appStoreVersions': {
      data: [
        {
          id: 'v1',
          attributes: {
            versionString: '1.2.0',
            platform: 'IOS',
            appStoreState: 'IN_REVIEW',
            createdDate: 'x',
          },
        },
        {
          id: 'v0',
          attributes: { versionString: '1.1.0', platform: 'IOS', appVersionState: 'READY_FOR_SALE' },
        },
      ],
    },
    '/v1/builds': {
      data: [
        {
          id: 'b1',
          attributes: {
            version: '57',
            uploadedDate: '2026-10-01T10:00:00Z',
            processingState: 'VALID',
            expired: false,
          },
          relationships: { preReleaseVersion: { data: { type: 'preReleaseVersions', id: 'p1' } } },
        },
      ],
      included: [{ type: 'preReleaseVersions', id: 'p1', attributes: { version: '1.2.0', platform: 'IOS' } }],
    },
  });
  const snap = await fetchSnapshot(client);
  assert.equal(snap.apps.length, 1);
  const app = snap.apps[0];
  assert.deepEqual({ id: app.id, name: app.name }, { id: '10', name: 'My App' });
  assert.deepEqual(
    app.versions.map((v) => [v.id, v.versionString, v.state]),
    [
      ['v1', '1.2.0', 'IN_REVIEW'],
      ['v0', '1.1.0', 'READY_FOR_SALE'],
    ]
  );
  assert.deepEqual(app.builds[0], {
    id: 'b1',
    version: '57',
    uploadedDate: '2026-10-01T10:00:00Z',
    processingState: 'VALID',
    expired: false,
    marketingVersion: '1.2.0',
    platform: 'IOS',
  });
  const buildCall = client.calls.find(([p]) => p === '/v1/builds');
  assert.equal(buildCall[1]['filter[app]'], '10');
  assert.equal(buildCall[1].include, 'preReleaseVersion');
});

test('fetchSnapshot: only the requested apps, and one broken app does not drop the rest', async () => {
  const client = fakeClient({
    '/v1/apps': {
      data: [
        { id: '10', attributes: { name: 'A' } },
        { id: '20', attributes: { name: 'B' } },
      ],
    },
    '/v1/apps/10/appStoreVersions': () => {
      throw new Error('boom');
    },
    '/v1/apps/20/appStoreVersions': { data: [] },
    '/v1/builds': { data: [] },
  });
  const snap = await fetchSnapshot(client, { appIds: ['10', '20'] });
  assert.deepEqual(
    snap.apps.map((a) => a.id),
    ['20']
  );
  const only = await fetchSnapshot(client, { appIds: ['20'] });
  assert.deepEqual(
    only.apps.map((a) => a.id),
    ['20']
  );
});

// --- diffing against what we last saw -------------------------------------------

const app = { id: '10', name: 'My App' };
const snapshotWith = ({ versions = [], builds = [] } = {}) => ({ apps: [{ ...app, versions, builds }] });
const version = (id, state, versionString = '1.2.0') => ({ id, versionString, platform: 'IOS', state });
const build = (id, processingState, v = '57') => ({
  id,
  version: v,
  processingState,
  expired: false,
  marketingVersion: '1.2.0',
  platform: 'IOS',
  uploadedDate: 'x',
});
const cfg = (over = {}) => normaliseAppleConfig({ channelId: '123456789012345678', ...over });
const collector = () => {
  const sent = [];
  return { sent, send: async (guild, channel, payload) => (sent.push({ guild, channel, payload }), true) };
};

test('processGuild: the first look records everything and announces nothing', async () => {
  const { sent, send } = collector();
  await processGuild(
    G,
    cfg(),
    snapshotWith({ versions: [version('v1', 'IN_REVIEW')], builds: [build('b1', 'VALID')] }),
    { send }
  );
  assert.deepEqual(sent, []);
});

test('processGuild: a version changing state is announced once, with the previous state', async () => {
  const first = collector();
  await processGuild(
    'g-ver',
    cfg(),
    snapshotWith({ versions: [version('v1', 'WAITING_FOR_REVIEW')] }),
    first
  );
  const { sent, send } = collector();
  const next = snapshotWith({ versions: [version('v1', 'IN_REVIEW')] });
  await processGuild('g-ver', cfg(), next, { send });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, '123456789012345678');
  assert.match(sent[0].payload.embeds[0].toJSON().description, /Waiting for review.*In review/s);
  await processGuild('g-ver', cfg(), next, { send });
  assert.equal(sent.length, 1, 'the same state is not announced again');
});

test('processGuild: a new version is announced unless it is still being prepared', async () => {
  const seed = collector();
  await processGuild(
    'g-new',
    cfg(),
    snapshotWith({ versions: [version('v1', 'READY_FOR_SALE', '1.1.0')] }),
    seed
  );
  const { sent, send } = collector();
  await processGuild(
    'g-new',
    cfg(),
    snapshotWith({
      versions: [version('v1', 'READY_FOR_SALE', '1.1.0'), version('v2', 'PREPARE_FOR_SUBMISSION', '1.3.0')],
    }),
    { send }
  );
  assert.deepEqual(sent, [], 'a draft version is recorded silently');
  await processGuild(
    'g-new',
    cfg(),
    snapshotWith({
      versions: [version('v1', 'READY_FOR_SALE', '1.1.0'), version('v2', 'WAITING_FOR_REVIEW', '1.3.0')],
    }),
    { send }
  );
  assert.equal(sent.length, 1);
});

test('processGuild: a build is announced when it reaches a final state, not while it processes', async () => {
  const seed = collector();
  await processGuild('g-b', cfg(), snapshotWith({ builds: [build('b0', 'VALID', '56')] }), seed);
  const { sent, send } = collector();
  await processGuild(
    'g-b',
    cfg(),
    snapshotWith({ builds: [build('b1', 'PROCESSING'), build('b0', 'VALID', '56')] }),
    { send }
  );
  assert.deepEqual(sent, [], 'still processing');
  await processGuild(
    'g-b',
    cfg(),
    snapshotWith({ builds: [build('b1', 'VALID'), build('b0', 'VALID', '56')] }),
    { send }
  );
  assert.equal(sent.length, 1);
  assert.match(sent[0].payload.embeds[0].toJSON().description, /processed/i);
  await processGuild(
    'g-b',
    cfg(),
    snapshotWith({ builds: [build('b1', 'FAILED'), build('b0', 'VALID', '56')] }),
    { send }
  );
  assert.equal(sent.length, 2, 'a later change to another final state is announced too');
});

test('processGuild: respects the app filter and the per-event switches', async () => {
  const seed = collector();
  const two = (state) => ({
    apps: [
      { id: '10', name: 'A', versions: [version('a1', state)], builds: [] },
      { id: '20', name: 'B', versions: [version('b1', state)], builds: [] },
    ],
  });
  const only10 = cfg({ apps: ['10'] });
  await processGuild('g-f', only10, two('WAITING_FOR_REVIEW'), seed);
  const { sent, send } = collector();
  await processGuild('g-f', only10, two('IN_REVIEW'), { send });
  assert.equal(sent.length, 1);
  assert.match(sent[0].payload.embeds[0].toJSON().title, /^.*A/);

  const off = collector();
  const noVersions = cfg({ events: { versionState: false } });
  await processGuild('g-off', noVersions, two('WAITING_FOR_REVIEW'), off);
  await processGuild('g-off', noVersions, two('IN_REVIEW'), off);
  assert.deepEqual(off.sent, []);
});

test('processGuild: without a channel nothing is sent and nothing is recorded', async () => {
  const { sent, send } = collector();
  const noChannel = normaliseAppleConfig({});
  await processGuild('g-nc', noChannel, snapshotWith({ versions: [version('v1', 'IN_REVIEW')] }), { send });
  await processGuild('g-nc', noChannel, snapshotWith({ versions: [version('v1', 'REJECTED')] }), { send });
  assert.deepEqual(sent, []);
  // Once a channel is set, the first look still primes silently instead of replaying history.
  await processGuild('g-nc', cfg(), snapshotWith({ versions: [version('v1', 'REJECTED')] }), { send });
  assert.deepEqual(sent, []);
});

test('processGuild: a kind with its own channel posts there, the rest in the main channel', async () => {
  const { sent, send } = collector();
  const split = cfg({ events: { versionState: { channelId: '223456789012345678' } } });
  await processGuild(
    'g-split',
    split,
    snapshotWith({ versions: [version('v1', 'WAITING_FOR_REVIEW')], builds: [build('b1', 'PROCESSING')] }),
    { send }
  );
  await processGuild(
    'g-split',
    split,
    snapshotWith({ versions: [version('v1', 'IN_REVIEW')], builds: [build('b1', 'VALID')] }),
    { send }
  );
  const byChannel = Object.fromEntries(sent.map((s) => [s.channel, s.payload.embeds[0].toJSON().title]));
  assert.match(byChannel['223456789012345678'], /1\.2\.0/);
  assert.match(byChannel['123456789012345678'], /57/);
});

test('processGuild: with no main channel only the kinds that have their own channel run', async () => {
  const { sent, send } = collector();
  const onlyVersions = normaliseAppleConfig({
    events: { versionState: { enabled: true, channelId: '223456789012345678' } },
  });
  const snap = (vs, bs) => snapshotWith({ versions: [version('v1', vs)], builds: [build('b1', bs)] });
  await processGuild('g-only', onlyVersions, snap('WAITING_FOR_REVIEW', 'PROCESSING'), { send });
  await processGuild('g-only', onlyVersions, snap('IN_REVIEW', 'VALID'), { send });
  assert.equal(sent.length, 1, 'the build kind has no channel, so it stays silent');
  assert.equal(sent[0].channel, '223456789012345678');
});
