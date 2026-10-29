// Every limit a module declares in its LIMITS must be enforced by that module's normaliser: a
// no case below fails the "every limit is covered" test, so a new LIMITS entry cannot go untested.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { MODULE_LIMITS } from '../src/modules/limits.js';
import { EMBED_LIMITS, normaliseEmbedSpec } from '../src/modules/welcomeChannel.js';
import { normaliseWelcomeConfig } from '../src/modules/welcome.js';
import { normaliseStickyConfig } from '../src/modules/sticky.js';
import { normalisePollsConfig } from '../src/modules/polls.js';
import { normaliseAppealsConfig } from '../src/modules/appeals.js';
import { normaliseAppleConfig } from '../src/modules/appleConnect.js';
import { normaliseAutoReact } from '../src/modules/autoReact.js';
import { normaliseAutomodConfig } from '../src/modules/automod.js';
import { normaliseAutoresponder } from '../src/modules/autoresponder.js';
import { normaliseCountingConfig, validCount } from '../src/modules/counting.js';
import { clampWinners } from '../src/modules/giveaways.js';
import { normaliseHoneypotConfig } from '../src/modules/honeypot.js';
import { normaliseInviteTrackerConfig } from '../src/modules/inviteTracker.js';
import { normaliseKickConfig } from '../src/modules/kickAlerts.js';
import { normaliseLevelingConfig, validXp } from '../src/modules/leveling.js';
import { normaliseModerationConfig } from '../src/modules/moderation.js';
import { normaliseServerStats } from '../src/modules/serverStats.js';
import { normaliseTicketsConfig } from '../src/modules/tickets.js';
import { normaliseTwitchConfig } from '../src/modules/twitchAlerts.js';
import { normaliseYoutubeConfig } from '../src/modules/youtubeAlerts.js';
import { normaliseRssConfig } from '../src/modules/rss.js';
import { normaliseVerificationConfig } from '../src/modules/verification.js';
import { normaliseWelcomeChannelConfig } from '../src/modules/welcomeChannel.js';

const CHANNEL = '123456789012345678';
const roleId = (i) => String(100000000000000000n + BigInt(i));

/** Copy `base` and put `value` at `path`; `[]` stands for the first item of an array. */
function withValue(base, path, value) {
  const out = structuredClone(base);
  const parts = path.replace(/\[\]/g, '.0').split('.');
  let node = out;
  for (const part of parts.slice(0, -1)) node = node[part];
  node[parts.at(-1)] = value;
  return out;
}
function readPath(obj, path) {
  return path
    .replace(/\[\]/g, '.0')
    .split('.')
    .reduce((node, part) => node?.[part], obj);
}

const text = (n) => 'a'.repeat(n);
const items = (n, make) => Array.from({ length: n }, (_, i) => make(i));

// Per module: the normaliser, a valid request body to start from, and per limited path how to build a
// value of size n (text/list) or a number. Where a value past a limit is dropped or replaced by a
// default instead of being cut or clamped, `under` (one below a min) or `over` (one past a max, a
// length or a count) say what to expect: `{ input?, check(out) }`.
const cases = {
  welcome: {
    normalise: normaliseWelcomeConfig,
    base: { joinEnabled: true, leaveEnabled: true, dmEnabled: true },
    value: { cardBackground: (n) => `https://${text(n - 8)}` },
  },
  sticky: {
    normalise: normaliseStickyConfig,
    base: { stickies: [{ channelId: CHANNEL, content: 'x' }] },
    value: {
      stickies: (n) => Array.from({ length: n }, () => ({ channelId: CHANNEL, content: 'x' })),
    },
  },
  polls: {
    normalise: normalisePollsConfig,
    base: { pollMessage: {}, resultsMessage: {} },
    value: { voteRoles: (n) => Array.from({ length: n }, (_, i) => roleId(i)) },
  },
  appeals: {
    normalise: normaliseAppealsConfig,
    base: { questions: ['q'] },
    value: {
      questions: (n) => items(n, () => 'q'),
      'questions[]': text,
      appealServerInvite: (n) => `https://discord.gg/${text(n - 19)}`,
    },
  },
  'apple-connect': {
    normalise: normaliseAppleConfig,
    base: { events: { reviews: {}, expiry: {} } },
    value: { apps: (n) => items(n, (i) => String(i + 1)) },
  },
  'auto-react': {
    normalise: normaliseAutoReact,
    base: { rules: [{ targetUsers: [roleId(1)], emojis: ['x'] }] },
    value: {
      rules: (n) => items(n, () => ({ targetUsers: [roleId(1)], emojis: ['x'] })),
      'rules[].targetUsers': (n) => items(n, roleId),
      'rules[].targetRoles': (n) => items(n, roleId),
      'rules[].emojis': (n) => items(n, (i) => `e${i}`),
    },
  },
  automod: {
    normalise: normaliseAutomodConfig,
    base: { rules: { links: {}, spam: {}, mentions: {}, caps: {}, words: {}, emojis: {}, spoilers: {} } },
    value: {
      'rules.links.allowed': (n) => items(n, (i) => `d${i}.com`),
      'rules.words.list': (n) => items(n, (i) => `w${i}`),
    },
  },
  autoresponder: {
    normalise: normaliseAutoresponder,
    base: { responders: [{ trigger: 't', response: 'r' }] },
    value: {
      responders: (n) => items(n, () => ({ trigger: 't', response: 'r' })),
      'responders[].trigger': text,
      'responders[].response': text,
    },
  },
  counting: {
    normalise: (raw) => ({ ...normaliseCountingConfig(raw), count: validCount(raw.count) }),
    base: { count: 0 },
    // a penalty below 1 minute falls back to the 15 minute default
    under: {
      penaltyMinutes: { check: (out) => out.penaltyMinutes === 15 },
      count: { check: (out) => out.count === null },
    },
    over: { count: { check: (out) => out.count === null } },
  },
  giveaways: {
    normalise: (raw) => ({ winners: clampWinners(raw.winners) }),
    base: { winners: 1 },
  },
  honeypot: {
    normalise: normaliseHoneypotConfig,
    base: { channels: [{ channelId: CHANNEL }], messages: [{ channelId: CHANNEL }] },
    value: {
      channels: (n) => items(n, (i) => ({ channelId: roleId(i) })),
      messages: (n) => items(n, (i) => ({ channelId: roleId(i) })),
      'messages[].bait': text,
    },
  },
  'invite-tracker': {
    normalise: normaliseInviteTrackerConfig,
    base: {},
  },
  'kick-alerts': {
    normalise: normaliseKickConfig,
    base: { alerts: [{ slug: 'xqc', channelId: CHANNEL }] },
    value: { alerts: (n) => items(n, (i) => ({ slug: `s${i}x`, channelId: CHANNEL })) },
    // a slug past the limit is not a Kick username: the alert is dropped
    over: { 'alerts[].slug': { check: (out) => out.alerts.length === 0 } },
  },
  leveling: {
    normalise: (raw) => ({ ...normaliseLevelingConfig(raw), xp: validXp(raw.xp) }),
    base: {
      multipliers: [{ type: 'role', id: roleId(1), factor: 1 }],
      rewards: [{ level: 5, roleId: roleId(1) }],
      xp: 0,
    },
    value: {
      multipliers: (n) => items(n, () => ({ type: 'role', id: roleId(1), factor: 1 })),
      rewards: (n) => items(n, () => ({ level: 5, roleId: roleId(1) })),
    },
    // a reward level outside 1..1000 is dropped, an XP value outside the limits is refused
    under: {
      'rewards[].level': { check: (out) => out.rewards.length === 0 },
      xp: { check: (out) => out.xp === null },
    },
    over: {
      'rewards[].level': { check: (out) => out.rewards.length === 0 },
      xp: { check: (out) => out.xp === null },
    },
  },
  moderation: {
    normalise: normaliseModerationConfig,
    base: { warnThresholds: [{ count: 1, action: 'timeout' }] },
    // a threshold below warning 1 is dropped; a duration below 1 minute is raised to 1
    under: {
      'warnThresholds[].count': { check: (out) => out.warnThresholds.length === 0 },
      'warnThresholds[].durationMinutes': {
        input: -5,
        check: (out) => out.warnThresholds[0].durationMinutes === 1,
      },
    },
  },
  'server-stats': {
    normalise: normaliseServerStats,
    base: { channels: [{ channelId: CHANNEL, type: 'members', template: '{count}' }] },
    value: {
      channels: (n) => items(n, () => ({ channelId: CHANNEL, type: 'members', template: '{count}' })),
      'channels[].template': (n) => `{count}${text(n - 7)}`,
    },
  },
  tickets: {
    normalise: normaliseTicketsConfig,
    base: {},
  },
  'twitch-alerts': {
    normalise: normaliseTwitchConfig,
    base: { alerts: [{ login: 'ninja', channelId: CHANNEL }] },
    value: { alerts: (n) => items(n, (i) => ({ login: `l${i}x`, channelId: CHANNEL })) },
    // a login past the limit is not a Twitch username: the alert is dropped
    over: { 'alerts[].login': { check: (out) => out.alerts.length === 0 } },
  },
  'youtube-alerts': {
    normalise: normaliseYoutubeConfig,
    base: { alerts: [{ ytChannelId: `UC${'a'.repeat(22)}`, discordChannelId: CHANNEL }] },
    value: {
      alerts: (n) =>
        items(n, (i) => ({ ytChannelId: `UC${String(i).padStart(22, '0')}`, discordChannelId: CHANNEL })),
    },
  },
  rss: {
    normalise: normaliseRssConfig,
    base: { feeds: [{ type: 'url', url: 'https://a.com/feed', channelId: CHANNEL }] },
    value: {
      feeds: (n) => items(n, (i) => ({ type: 'url', url: `https://a.com/${i}`, channelId: CHANNEL })),
      'feeds[].ref': (n) => `https://a.com/${text(n - 14)}`,
      'feeds[].url': (n) => `https://a.com/${text(n - 14)}`,
    },
  },
  verification: {
    normalise: normaliseVerificationConfig,
    base: {},
  },
  'welcome-channel': {
    normalise: normaliseWelcomeChannelConfig,
    base: { spec: { content: 'x', embeds: [{}] } },
    value: { 'spec.embeds': (n) => items(n, () => ({})) },
  },
  _embed: {
    normalise: (raw) => ({ spec: normaliseEmbedSpec(raw.spec) }),
    base: { spec: { fields: [{ name: 'n', value: 'v' }] } },
    // the embed's own paths are relative to the spec
    prefix: 'spec.',
    value: {
      fields: (n) => Array.from({ length: n }, () => ({ name: 'n', value: 'v' })),
    },
  },
};

const size = (v) => (Array.isArray(v) || typeof v === 'string' ? v.length : v);

for (const [moduleId, c] of Object.entries(cases)) {
  const limits = MODULE_LIMITS[moduleId];
  test(`${moduleId}: declares only known limit keys`, () => {
    assert.ok(limits && Object.keys(limits).length > 0, `${moduleId} declares limits`);
    for (const [path, limit] of Object.entries(limits)) {
      assert.ok(
        Object.keys(limit).every((k) => ['maxLength', 'min', 'max', 'maxItems'].includes(k)),
        `${path}: only known limit keys`
      );
    }
  });

  for (const [path, limit] of Object.entries(limits)) {
    const prefix = c.prefix ?? '';
    const make = c.value?.[path];
    const kinds = ['maxLength', 'maxItems', 'min', 'max'].filter((k) => limit[k] !== undefined);
    for (const kind of kinds) {
      test(`${moduleId}: ${path} ${kind} ${limit[kind]} is enforced`, () => {
        const n = limit[kind];
        const build = make ?? (kind === 'maxItems' ? null : kind === 'maxLength' ? text : (v) => v);
        assert.ok(build, `${moduleId}.${path}: add a value builder to this test`);
        const run = (value) => {
          const out = c.normalise(withValue(c.base, prefix + path, value));
          return size(readPath(out, prefix + path));
        };
        const special = (kind === 'min' ? c.under : c.over)?.[path];
        const outside = kind === 'min' ? n - 1 : n + 1;
        assert.equal(run(build(n)), n, kind === 'min' ? 'at the minimum: kept' : 'at the limit: kept');
        if (special) {
          const input = special.input ?? build(outside);
          const out = c.normalise(withValue(c.base, prefix + path, input));
          assert.ok(special.check(out), `${path}: a value past the limit is dropped or replaced as stated`);
        } else if (kind === 'min') {
          assert.equal(run(build(outside)), n, 'below the minimum: clamped up');
        } else {
          assert.equal(run(build(outside)), n, 'one past the limit: cut or clamped down');
        }
      });
    }
  }
}

test('embed fields keep their own text limits', () => {
  const f = EMBED_LIMITS;
  const out = normaliseEmbedSpec({
    title: text(f.title.maxLength + 1),
    description: text(f.description.maxLength + 1),
    authorName: text(f.authorName.maxLength + 1),
    footerText: text(f.footerText.maxLength + 1),
    fields: [
      { name: text(f['fields[].name'].maxLength + 1), value: text(f['fields[].value'].maxLength + 1) },
    ],
  });
  assert.equal(out.title.length, f.title.maxLength);
  assert.equal(out.description.length, f.description.maxLength);
  assert.equal(out.authorName.length, f.authorName.maxLength);
  assert.equal(out.footerText.length, f.footerText.maxLength);
  assert.equal(out.fields[0].name.length, f['fields[].name'].maxLength);
  assert.equal(out.fields[0].value.length, f['fields[].value'].maxLength);
});

test('MODULE_LIMITS holds no limit that is not a number', () => {
  for (const [moduleId, limits] of Object.entries(MODULE_LIMITS)) {
    for (const [path, limit] of Object.entries(limits)) {
      for (const [k, v] of Object.entries(limit)) {
        assert.ok(Number.isFinite(v) && v >= 0, `${moduleId}.${path}.${k} is a non-negative number`);
      }
    }
  }
});

test('welcome keeps its legacy behaviour: messages and channels are dropped while the switch is off', () => {
  const out = normaliseWelcomeConfig({
    joinEnabled: false,
    joinChannel: CHANNEL,
    joinMessage: 'hi',
    cardBackground: 'http://insecure.example/x.png',
    autoroleEnabled: 1,
  });
  assert.equal(out.joinChannel, '');
  assert.equal(out.joinMessage, '');
  assert.equal(out.cardBackground, '');
  assert.equal(out.autoroleEnabled, true);
});
