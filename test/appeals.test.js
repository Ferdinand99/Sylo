import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseAppealsConfig,
  signAppealToken,
  verifyAppealToken,
  cooldownRemainingMs,
  DEFAULT_QUESTIONS,
} from '../src/modules/appeals.js';
import {
  createAppeal,
  getOpenAppeal,
  getLatestAppeal,
  decideAppeal,
  listAppeals,
  countOpenAppeals,
} from '../src/db/appeals.js';

const G = '111111111111111111';
const U = '222222222222222222';

test('normaliseAppealsConfig: defaults, question cap, clamps', () => {
  const c = normaliseAppealsConfig({});
  assert.deepEqual(c.questions, DEFAULT_QUESTIONS);
  assert.equal(c.autoUnbanOnAccept, true);
  assert.equal(c.cooldownDays, 7);

  const c2 = normaliseAppealsConfig({
    questions: ['a', '  ', 'b', 'c', 'd', 'e', 'f'],
    autoUnbanOnAccept: false,
    reviewChannelId: 'nope',
    cooldownDays: 999,
    appealServerInvite: 'https://discord.gg/abc123',
  });
  assert.deepEqual(c2.questions, ['a', 'b', 'c', 'd', 'e']); // blanks dropped, capped at 5
  assert.equal(c2.autoUnbanOnAccept, false);
  assert.equal(c2.reviewChannelId, '');
  assert.equal(c2.cooldownDays, 90);
  assert.equal(c2.appealServerInvite, 'https://discord.gg/abc123');
});

test('normaliseAppealsConfig: rejects non-invite URLs in appealServerInvite', () => {
  assert.equal(normaliseAppealsConfig({ appealServerInvite: 'https://evil.example/x' }).appealServerInvite, '');
  assert.equal(normaliseAppealsConfig({ appealServerInvite: 'discord.gg/x' }).appealServerInvite, '');
  assert.equal(
    normaliseAppealsConfig({ appealServerInvite: 'https://discord.com/invite/Ab-9' }).appealServerInvite,
    'https://discord.com/invite/Ab-9'
  );
});

test('appeal token: round-trips guild + user, rejects tampering', () => {
  const token = signAppealToken(G, U);
  assert.deepEqual(verifyAppealToken(token), { guildId: G, userId: U });
  assert.equal(verifyAppealToken(token.slice(0, -3) + 'zzz'), null);
  assert.equal(verifyAppealToken('garbage'), null);
  assert.equal(verifyAppealToken(''), null);
});

test('cooldownRemainingMs: only denied appeals within the window block', () => {
  assert.equal(cooldownRemainingMs(null, 7), 0);
  assert.equal(cooldownRemainingMs({ status: 'accepted', decided_at: Date.now() }, 7), 0);
  assert.equal(cooldownRemainingMs({ status: 'denied', decided_at: Date.now() }, 0), 0);
  assert.ok(cooldownRemainingMs({ status: 'denied', decided_at: Date.now() }, 7) > 0);
  const old = Date.now() - 8 * 86_400_000;
  assert.equal(cooldownRemainingMs({ status: 'denied', decided_at: old }, 7), 0);
});

test('db: one open appeal per user, decide closes it', () => {
  const answers = [{ q: 'Why?', a: 'Mistake' }];
  const id = createAppeal(G, { userId: U, userTag: 'foo#0', banReason: 'spam', answers });
  assert.ok(id > 0);

  // Second insert while one is open is rejected.
  assert.equal(createAppeal(G, { userId: U, answers }), null);
  assert.equal(countOpenAppeals(G), 1);
  assert.equal(getOpenAppeal(G, U).id, id);

  assert.equal(decideAppeal(G, id, { status: 'denied', decidedBy: 'mod', reason: 'no' }), true);
  assert.equal(countOpenAppeals(G), 0);
  assert.equal(getOpenAppeal(G, U), undefined);
  assert.equal(getLatestAppeal(G, U).status, 'denied');

  // Deciding an already-closed appeal is a no-op.
  assert.equal(decideAppeal(G, id, { status: 'accepted', decidedBy: 'mod', reason: 'x' }), false);

  // A fresh appeal can now be opened.
  const id2 = createAppeal(G, { userId: U, answers });
  assert.ok(id2 > id);
  assert.equal(listAppeals(G, 10).length, 2);
});
