import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  containsInvite,
  disallowedLink,
  exceedsCaps,
  matchWord,
  normaliseAutomodConfig,
} from '../src/modules/automod.js';

test('containsInvite: matches common invite forms', () => {
  assert.ok(containsInvite('join here discord.gg/abc123'));
  assert.ok(containsInvite('https://discord.com/invite/Xy-9'));
  assert.ok(containsInvite('discordapp.com/invite/foo'));
  assert.ok(!containsInvite('just talking about discord in general'));
});

test('disallowedLink: no allowlist flags any URL, allowlist permits listed domains + subdomains', () => {
  assert.equal(disallowedLink('see http://evil.test/x', []), 'evil.test');
  assert.equal(disallowedLink('see https://www.youtube.com/watch?v=1', ['youtube.com']), null);
  assert.equal(disallowedLink('https://cdn.youtube.com/a', ['youtube.com']), null);
  assert.equal(disallowedLink('https://twitch.tv/x', ['youtube.com']), 'twitch.tv');
  assert.equal(disallowedLink('no links here', []), null);
});

test('exceedsCaps: respects minLength and percent', () => {
  const rule = { minLength: 10, percent: 70 };
  assert.ok(exceedsCaps('THIS IS ALL SHOUTING', rule));
  assert.ok(!exceedsCaps('SHORT', rule)); // under minLength
  assert.ok(!exceedsCaps('This Is Mostly Normal Text Here', rule));
});

test('matchWord: word-boundary for alphanumeric terms, substring for phrases', () => {
  assert.equal(matchWord('you are a NOOB man', ['noob']), 'noob');
  assert.equal(matchWord('classy snoober', ['noob']), null); // not a standalone word
  assert.equal(matchWord('this is a bad phrase indeed', ['bad phrase']), 'bad phrase');
});

test('normaliseAutomodConfig: clamps and defaults', () => {
  const c = normaliseAutomodConfig({
    timeoutMinutes: 999999,
    rules: { spam: { enabled: true, action: 'nonsense', max: 1, seconds: 999 } },
  });
  assert.equal(c.timeoutMinutes, 40320);
  assert.equal(c.rules.spam.action, 'delete'); // invalid action falls back
  assert.equal(c.rules.spam.max, 2); // clamped up to min
  assert.equal(c.rules.spam.seconds, 60); // clamped down to max
  assert.deepEqual(c.exemptRoles, []);
});

test('normaliseAutomodConfig: parses domain and word lists from strings', () => {
  const c = normaliseAutomodConfig({
    rules: {
      links: { enabled: true, allowed: 'youtube.com, www.twitch.tv\nexample.org' },
      words: { enabled: true, list: 'foo, bar\nbaz' },
    },
  });
  assert.deepEqual(c.rules.links.allowed, ['youtube.com', 'twitch.tv', 'example.org']);
  assert.deepEqual(c.rules.words.list, ['foo', 'bar', 'baz']);
});
