// Auto threads: the config normaliser, LIMITS, and the pure rules that decide which posts a rule takes.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIMITS,
  hasLink,
  isStaffMember,
  matchRule,
  normaliseAutoThreadsConfig,
  renderFirstMessage,
  ruleSkipReason,
} from '../src/modules/autoThreads.js';
import { MODULE_LIMITS } from '../src/modules/limits.js';
import { getModule } from '../src/modules/registry.js';

const CH = '100000000000000001';
const CH2 = '100000000000000002';
const ROLE = '100000000000000700';

test('LIMITS are registered for the dashboard and hold the stated numbers', () => {
  assert.equal(MODULE_LIMITS['auto-threads'], LIMITS);
  assert.deepEqual(LIMITS, {
    rules: { maxItems: 25 },
    'rules[].nameTemplate': { maxLength: 100 },
    'rules[].staffRoleIds': { maxItems: 25 },
    'rules[].firstMessage': { maxLength: 2000 },
    'rules[].slowmodeSeconds': { min: 0, max: 21600 },
  });
});

test('the module is a beta that needs the Message Content intent', () => {
  const mod = getModule('auto-threads');
  assert.equal(mod.beta, true);
  assert.equal(mod.defaultEnabled, false);
  assert.deepEqual(mod.requiredIntents, ['MessageContent']);
});

test('normalise: nothing in, no rules out', () => {
  assert.deepEqual(normaliseAutoThreadsConfig(), { rules: [] });
  assert.deepEqual(normaliseAutoThreadsConfig({}), { rules: [] });
  assert.deepEqual(normaliseAutoThreadsConfig({ rules: 'x' }), { rules: [] });
  assert.deepEqual(normaliseAutoThreadsConfig(null), { rules: [] });
});

test('normalise: a bare rule gets the defaults', () => {
  assert.deepEqual(normaliseAutoThreadsConfig({ rules: [{ channelId: CH }] }).rules, [
    {
      id: 'r1',
      channelId: CH,
      nameTemplate: '{words}',
      archiveMinutes: 1440,
      onlyWithAttachments: false,
      onlyWithLinks: false,
      skipBots: true,
      skipStaff: false,
      staffRoleIds: [],
      firstMessage: '',
      slowmodeSeconds: 0,
    },
  ]);
});

test('normalise: every field is kept when valid, and re-normalising changes nothing', () => {
  const rule = {
    id: 'news',
    channelId: CH,
    nameTemplate: '{author} {date}',
    archiveMinutes: 10080,
    onlyWithAttachments: true,
    onlyWithLinks: true,
    skipBots: false,
    skipStaff: true,
    staffRoleIds: [ROLE],
    firstMessage: 'Hi {author}',
    slowmodeSeconds: 30,
  };
  const once = normaliseAutoThreadsConfig({ rules: [rule] });
  assert.deepEqual(once.rules[0], rule);
  assert.deepEqual(normaliseAutoThreadsConfig(once), once);
});

test('normalise: rules without a valid channel, and junk rows, are dropped', () => {
  const out = normaliseAutoThreadsConfig({
    rules: [{ channelId: 'nope' }, { channelId: '' }, {}, null, 'x', 7, { channelId: CH2 }],
  });
  assert.deepEqual(
    out.rules.map((r) => r.channelId),
    [CH2]
  );
});

test('normalise: only 60, 1440, 4320 and 10080 are archive choices', () => {
  const archive = (v) =>
    normaliseAutoThreadsConfig({ rules: [{ channelId: CH, archiveMinutes: v }] }).rules[0].archiveMinutes;
  for (const ok of [60, 1440, 4320, 10080, '4320']) assert.equal(archive(ok), Number(ok));
  for (const bad of [0, 30, 61, 2880, 20160, -1, 'week', null, undefined, NaN]) {
    assert.equal(archive(bad), 1440, String(bad));
  }
});

test('normalise: the template is trimmed and cut at 100; empty means {words}', () => {
  const tpl = (v) =>
    normaliseAutoThreadsConfig({ rules: [{ channelId: CH, nameTemplate: v }] }).rules[0].nameTemplate;
  assert.equal(tpl('  {author}  '), '{author}');
  assert.equal(tpl('a'.repeat(100)).length, 100);
  assert.equal(tpl('a'.repeat(101)).length, 100);
  assert.equal(tpl(''), '{words}');
  assert.equal(tpl('   '), '{words}');
  assert.equal(tpl(null), '{words}');
});

test('normalise: first message cut at 2000, slowmode clamped to 0..21600', () => {
  const one = (extra) => normaliseAutoThreadsConfig({ rules: [{ channelId: CH, ...extra }] }).rules[0];
  assert.equal(one({ firstMessage: 'a'.repeat(2001) }).firstMessage.length, 2000);
  assert.equal(one({ firstMessage: '  hi  ' }).firstMessage, 'hi');
  assert.equal(one({ slowmodeSeconds: 21601 }).slowmodeSeconds, 21600);
  assert.equal(one({ slowmodeSeconds: 21600 }).slowmodeSeconds, 21600);
  assert.equal(one({ slowmodeSeconds: -5 }).slowmodeSeconds, 0);
  assert.equal(one({ slowmodeSeconds: 'abc' }).slowmodeSeconds, 0);
  assert.equal(one({ slowmodeSeconds: 12.9 }).slowmodeSeconds, 12);
});

test('normalise: flags are strict booleans; skipBots defaults on, the rest off', () => {
  const one = (extra) => normaliseAutoThreadsConfig({ rules: [{ channelId: CH, ...extra }] }).rules[0];
  assert.equal(one({ skipBots: false }).skipBots, false);
  assert.equal(one({ skipBots: 0 }).skipBots, true);
  assert.equal(one({ skipStaff: 'yes' }).skipStaff, false);
  assert.equal(one({ onlyWithLinks: 1 }).onlyWithLinks, false);
  assert.equal(one({ onlyWithAttachments: true }).onlyWithAttachments, true);
});

test('normalise: staff roles are ids, unique and capped at 25', () => {
  const roles = Array.from({ length: 30 }, (_, i) => String(100000000000000800n + BigInt(i)));
  const out = normaliseAutoThreadsConfig({
    rules: [{ channelId: CH, staffRoleIds: [...roles, roles[0], 'junk', 5] }],
  }).rules[0].staffRoleIds;
  assert.equal(out.length, 25);
  assert.equal(new Set(out).size, 25);
});

test('normalise: at most 25 rules; ids stay unique', () => {
  const many = Array.from({ length: 30 }, () => ({ channelId: CH, id: 'same' }));
  const out = normaliseAutoThreadsConfig({ rules: many }).rules;
  assert.equal(out.length, 25);
  assert.equal(new Set(out.map((r) => r.id)).size, 25);
  assert.equal(normaliseAutoThreadsConfig({ rules: [{ channelId: CH, id: 'a b!c' }] }).rules[0].id, 'abc');
});

// --- which posts a rule takes -----------------------------------------------------------------------

const member = ({ perms = [], roles = [] } = {}) => ({
  permissions: { has: (p) => perms.includes(p) },
  roles: { cache: new Set(roles) },
});
const post = (over = {}) => ({
  channelId: CH,
  content: 'hello',
  author: { id: '1', bot: false },
  webhookId: null,
  attachments: { size: 0 },
  member: member(),
  ...over,
});
const rule = (extra = {}) => normaliseAutoThreadsConfig({ rules: [{ channelId: CH, ...extra }] }).rules[0];

test('hasLink needs http:// or https://', () => {
  assert.equal(hasLink('see https://example.com/x'), true);
  assert.equal(hasLink('HTTP://EXAMPLE.COM'), true);
  assert.equal(hasLink('example.com'), false);
  assert.equal(hasLink('ftp://example.com'), false);
  assert.equal(hasLink(undefined), false);
});

test('skip bots: a bot, an app or a webhook is skipped only while skipBots is on', () => {
  const bot = post({ author: { id: '2', bot: true } });
  const hook = post({ webhookId: '99' });
  assert.equal(ruleSkipReason(rule(), bot), 'bot');
  assert.equal(ruleSkipReason(rule(), hook), 'bot');
  assert.equal(ruleSkipReason(rule({ skipBots: false }), bot), null);
  assert.equal(ruleSkipReason(rule({ skipBots: false }), hook), null);
  assert.equal(ruleSkipReason(rule(), post()), null);
});

test('skip staff: Administrator, Manage Server and the staff roles, only while skipStaff is on', () => {
  const r = rule({ skipStaff: true, staffRoleIds: [ROLE] });
  assert.equal(ruleSkipReason(r, post({ member: member({ perms: ['Administrator'] }) })), 'staff');
  assert.equal(ruleSkipReason(r, post({ member: member({ perms: ['ManageGuild'] }) })), 'staff');
  assert.equal(ruleSkipReason(r, post({ member: member({ roles: [ROLE] }) })), 'staff');
  assert.equal(
    ruleSkipReason(r, post({ member: member({ perms: ['ManageMessages'] }) })),
    null,
    'Manage Messages alone is not staff'
  );
  assert.equal(ruleSkipReason(r, post({ member: member({ roles: ['other'] }) })), null);
  assert.equal(ruleSkipReason(r, post({ member: null })), null, 'an unknown member is not staff');
  assert.equal(
    ruleSkipReason(rule({ staffRoleIds: [ROLE] }), post({ member: member({ roles: [ROLE] }) })),
    null,
    'off: staff get threads'
  );
  assert.equal(isStaffMember(member({ perms: ['ManageGuild'] }), { staffRoleIds: [] }), true);
});

test('only with attachments, only with links, and both (either one is enough)', () => {
  const file = post({ attachments: { size: 2 } });
  const link = post({ content: 'look https://example.com' });
  const plain = post();
  const att = rule({ onlyWithAttachments: true });
  assert.equal(ruleSkipReason(att, file), null);
  assert.equal(ruleSkipReason(att, link), 'no-attachment-or-link');
  assert.equal(ruleSkipReason(att, plain), 'no-attachment-or-link');
  const lnk = rule({ onlyWithLinks: true });
  assert.equal(ruleSkipReason(lnk, link), null);
  assert.equal(ruleSkipReason(lnk, file), 'no-attachment-or-link');
  assert.equal(ruleSkipReason(lnk, plain), 'no-attachment-or-link');
  const both = rule({ onlyWithAttachments: true, onlyWithLinks: true });
  assert.equal(ruleSkipReason(both, file), null);
  assert.equal(ruleSkipReason(both, link), null);
  assert.equal(ruleSkipReason(both, plain), 'no-attachment-or-link');
  assert.equal(ruleSkipReason(rule(), plain), null, 'no filter: every post');
});

test('matchRule: the channel decides, and the first rule that takes the post wins', () => {
  const rules = normaliseAutoThreadsConfig({
    rules: [
      { id: 'pics', channelId: CH, onlyWithAttachments: true, nameTemplate: 'pic {author}' },
      { id: 'rest', channelId: CH, nameTemplate: '{words}' },
      { id: 'other', channelId: CH2 },
    ],
  }).rules;
  assert.equal(matchRule(rules, post({ attachments: { size: 1 } })).id, 'pics');
  assert.equal(matchRule(rules, post()).id, 'rest');
  assert.equal(matchRule(rules, post({ channelId: CH2 })).id, 'other');
  assert.equal(matchRule(rules, post({ channelId: '100000000000000009' })), null);
  assert.equal(matchRule(rules, post({ author: { id: '2', bot: true } })), null, 'every rule skips bots');
});

test('renderFirstMessage: {author} is a mention; only that placeholder; cut at 2000', () => {
  assert.equal(renderFirstMessage('Hi {author}, {words} {date}', '123'), 'Hi <@123>, {words} {date}');
  assert.equal(renderFirstMessage('{AUTHOR}{author}', '9'), '<@9><@9>');
  assert.equal(renderFirstMessage('a'.repeat(2500), '9').length, 2000);
});
