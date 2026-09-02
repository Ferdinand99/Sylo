import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AutoModerationRuleTriggerType as T,
  AutoModerationActionType as A,
  AutoModerationRuleKeywordPresetType as P,
} from 'discord.js';
import {
  desiredRules,
  planSync,
  payloadsDiffer,
  isSyloRule,
  RULE_NAMES,
} from '../src/bot/lib/automodSync.js';
import { normaliseAutomodConfig } from '../src/modules/automod.js';

/** Build a normalised config with the given native block + a couple of rules on. */
function cfg(native, rules) {
  return normaliseAutomodConfig({
    timeoutMinutes: 15,
    exemptRoles: ['100000000000000001'],
    exemptChannels: ['200000000000000002'],
    native,
    rules: {
      words: { enabled: true, action: 'delete', list: ['foo', 'bar baz'] },
      mentions: { enabled: true, action: 'timeout', max: 7 },
      spam: { enabled: true, action: 'delete', max: 5, seconds: 5 },
      ...rules,
    },
  });
}

test('desiredRules is empty when native enforcement is off', () => {
  assert.equal(desiredRules(cfg({ enabled: false, words: true })).size, 0);
});

test('desiredRules: words -> a Keyword rule with substring wildcards', () => {
  const d = desiredRules(cfg({ enabled: true, words: true }));
  assert.deepEqual([...d.keys()], ['words']);
  const rule = d.get('words');
  assert.equal(rule.name, RULE_NAMES.words);
  assert.equal(rule.triggerType, T.Keyword);
  assert.deepEqual(rule.triggerMetadata.keywordFilter, ['*foo*', '*bar baz*']);
  assert.deepEqual(rule.exemptRoles, ['100000000000000001']);
  assert.equal(rule.actions[0].type, A.BlockMessage);
});

test('desiredRules: an over-long term is dropped from the keyword filter', () => {
  const long = 'x'.repeat(70);
  const d = desiredRules(
    cfg({ enabled: true, words: true }, { words: { enabled: true, list: ['ok', long] } })
  );
  assert.deepEqual(d.get('words').triggerMetadata.keywordFilter, ['*ok*']);
});

test('desiredRules: a words rule with an empty list produces nothing', () => {
  const d = desiredRules(cfg({ enabled: true, words: true }, { words: { enabled: true, list: [] } }));
  assert.equal(d.has('words'), false);
});

test('desiredRules: mentions -> MentionSpam with the total limit, plus a Timeout action', () => {
  const d = desiredRules(cfg({ enabled: true, mentions: true }));
  const rule = d.get('mentions');
  assert.equal(rule.triggerType, T.MentionSpam);
  assert.equal(rule.triggerMetadata.mentionTotalLimit, 7);
  // rules.mentions.action is 'timeout' -> Timeout action at timeoutMinutes (15) * 60
  const timeout = rule.actions.find((a) => a.type === A.Timeout);
  assert.ok(timeout);
  assert.equal(timeout.metadata.durationSeconds, 900);
});

test('desiredRules: spam trigger never carries a Timeout action', () => {
  const d = desiredRules(cfg({ enabled: true, spam: true }, { spam: { enabled: true, action: 'timeout' } }));
  const rule = d.get('spam');
  assert.equal(rule.triggerType, T.Spam);
  assert.equal(
    rule.actions.some((a) => a.type === A.Timeout),
    false
  );
});

test('desiredRules: mention limit is clamped to Discord max 50', () => {
  const d = desiredRules(cfg({ enabled: true, mentions: true }, { mentions: { enabled: true, max: 999 } }));
  assert.equal(d.get('mentions').triggerMetadata.mentionTotalLimit, 50);
});

test('desiredRules: a rule whose in-process check is off is not pushed', () => {
  const d = desiredRules(cfg({ enabled: true, spam: true }, { spam: { enabled: false } }));
  assert.equal(d.has('spam'), false);
});

test('desiredRules: presets -> one KeywordPreset rule with the mapped enums', () => {
  const d = desiredRules(cfg({ enabled: true, presets: ['profanity', 'slurs', 'bogus'] }));
  const rule = d.get('preset');
  assert.equal(rule.triggerType, T.KeywordPreset);
  assert.deepEqual(rule.triggerMetadata.presets.sort(), [P.Profanity, P.Slurs].sort());
});

test('isSyloRule only matches the Sylo: prefix', () => {
  assert.equal(isSyloRule({ name: 'Sylo: bad words' }), true);
  assert.equal(isSyloRule({ name: 'Bad words' }), false);
  assert.equal(isSyloRule({}), false);
});

// --- planSync -------------------------------------------------------------

const fakeRule = (payload) => ({
  ...payload,
  edit: () => {},
  delete: () => {},
});

test('planSync: nothing exists yet -> everything is a create', () => {
  const desired = desiredRules(cfg({ enabled: true, words: true, mentions: true }));
  const plan = planSync(desired, []);
  assert.equal(plan.create.length, 2);
  assert.equal(plan.edit.length, 0);
  assert.equal(plan.remove.length, 0);
});

test('planSync: an identical existing rule is left alone', () => {
  const desired = desiredRules(cfg({ enabled: true, words: true }));
  const existing = [fakeRule(desired.get('words'))];
  const plan = planSync(desired, existing);
  assert.deepEqual([plan.create.length, plan.edit.length, plan.remove.length], [0, 0, 0]);
});

test('planSync: a drifted existing rule becomes an edit', () => {
  const desired = desiredRules(cfg({ enabled: true, words: true }));
  const stale = fakeRule({ ...desired.get('words'), triggerMetadata: { keywordFilter: ['*old*'] } });
  const plan = planSync(desired, [stale]);
  assert.equal(plan.edit.length, 1);
  assert.equal(plan.edit[0].rule, stale);
});

test('planSync: a Sylo rule no longer desired is a remove', () => {
  const desired = desiredRules(cfg({ enabled: true, words: true }));
  const orphan = fakeRule({ name: RULE_NAMES.spam, triggerMetadata: {}, actions: [] });
  const plan = planSync(desired, [fakeRule(desired.get('words')), orphan]);
  assert.equal(plan.remove.length, 1);
  assert.equal(plan.remove[0], orphan);
});

test('planSync: turning native off removes every Sylo rule', () => {
  const existing = [
    fakeRule({ name: RULE_NAMES.words, triggerMetadata: { keywordFilter: ['*x*'] }, actions: [] }),
    fakeRule({ name: RULE_NAMES.mentions, triggerMetadata: { mentionTotalLimit: 5 }, actions: [] }),
  ];
  const plan = planSync(desiredRules(cfg({ enabled: false })), existing);
  assert.equal(plan.remove.length, 2);
  assert.equal(plan.create.length, 0);
});

test('payloadsDiffer ignores action ordering', () => {
  const desired = desiredRules(cfg({ enabled: true, mentions: true })).get('mentions');
  const reordered = { ...desired, actions: [...desired.actions].reverse() };
  assert.equal(payloadsDiffer(reordered, desired), false);
});
