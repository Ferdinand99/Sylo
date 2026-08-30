import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  containsInvite,
  disallowedLink,
  exceedsCaps,
  matchWord,
  normaliseAutomodConfig,
  countEmojis,
  countSpoilers,
  isZalgo,
  isRepeatedText,
} from '../src/modules/automod.js';

test('countEmojis / countSpoilers: count unicode + custom emoji and spoiler tags', () => {
  assert.equal(countEmojis('hi 😀😀 <:blob:123> ❤️'), 4);
  assert.equal(countEmojis('no emoji here'), 0);
  assert.equal(countSpoilers('||one|| plain ||two||'), 2);
});

test('isZalgo / isRepeatedText: flag corrupted and repetitive text', () => {
  assert.equal(isZalgo('normal sentence, nothing weird'), false);
  assert.equal(isZalgo('z̸̢̛a̵l̶g̷o̴ ̶t̸e̵x̷t̶ ̸h̴e̵r̶e̸ ̴n̵o̶w̷'), true);
  assert.equal(isRepeatedText('aaaaaaaaaaaaaa'), true);
  assert.equal(isRepeatedText('spam spam spam spam spam spam'), true);
  assert.equal(isRepeatedText('this is a perfectly normal message'), false);
});

test('normaliseAutomodConfig: includes the new rules with clamped params', () => {
  const c = normaliseAutomodConfig({
    rules: {
      emojis: { enabled: true, action: 'timeout', max: 999 },
      spoilers: { enabled: true, max: 0 },
      zalgo: { enabled: true, action: 'warn' },
      repeat: { enabled: true },
    },
  });
  assert.equal(c.rules.emojis.enabled, true);
  assert.equal(c.rules.emojis.action, 'timeout');
  assert.equal(c.rules.emojis.max, 50);
  assert.equal(c.rules.spoilers.max, 1);
  assert.equal(c.rules.zalgo.action, 'warn');
  assert.equal(c.rules.repeat.enabled, true);
});

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
