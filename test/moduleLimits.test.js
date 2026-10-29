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
// value of size n (text/list) or a number. `url` marks a text that must look like a https URL.
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
        if (kind === 'min') {
          assert.equal(run(build(n)), n, 'at the minimum: kept');
          assert.equal(run(build(n - 1)), n, 'below the minimum: clamped up');
        } else {
          assert.equal(run(build(n)), n, 'at the limit: kept');
          assert.equal(run(build(n + 1)), n, 'one past the limit: cut or clamped down');
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
        assert.ok(Number.isInteger(v) && v >= 0, `${moduleId}.${path}.${k} is a whole number`);
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
