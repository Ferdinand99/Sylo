// Applications and privacy: /forget deletes a member's submissions and their posts (and keeps only the
// ids, without answers, when a post cannot be deleted), the member's export has them, a server purge takes
// every table, decided submissions are deleted after the retention (pending ones never), and no log line
// ever holds an answer.
import './helpers/tmpDb.js';
import test, { afterEach, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/index.js';
import {
  clearedSubmissions,
  getCooldownUntil,
  getSubmission,
  listForms,
  listSubmissions,
  setCooldownUntil,
} from '../src/db/applications.js';
import { describeUserData, exportUserData, forgetUser, purgeGuild } from '../src/db/purge.js';
import { log } from '../src/lib/log.js';
import { _resetQuestionnaires } from '../src/bot/lib/dmQuestionnaire.js';
import {
  _resetApplications,
  decideSubmission,
  forgetApplicationPosts,
  sweepApplications,
} from '../src/modules/applications.js';
import {
  APP_ROLE,
  CH,
  GID,
  STAFF,
  U,
  U2,
  appMember,
  dmFor,
  dropFakeClient,
  fakeAppsGuild,
  runtime,
} from './helpers/fakeApps.js';
import { serverError } from './helpers/fakeIntro.js';
import { GOOD, enableApplications, makeForm, submitFor } from './helpers/appsSetup.js';

const SECRET = 'SECRETWORD123 my private story';
const DAY = 86_400_000;

let env;
let member;
beforeEach(async () => {
  _resetQuestionnaires();
  _resetApplications();
  await purgeGuild(GID);
  env = fakeAppsGuild();
  await enableApplications();
  member = appMember(env, U, { username: 'mira' });
  dmFor(env, member);
});
afterEach(() => {
  mock.restoreAll();
  dropFakeClient();
  runtime.clients.fluxer = null;
});

const answers = (over = {}) => ({ ...GOOD, q_text: SECRET, ...over });
const submit = async (formId, who = member, over) => {
  const out = await submitFor(env, who, formId, { answers: answers(over) });
  assert.equal(out.ok, true, out.error);
  return getSubmission(GID, out.id);
};
const ageDecision = (id, days) =>
  db
    .prepare('UPDATE applications_submissions SET decided_at = ? WHERE id = ?')
    .run(Date.now() - days * DAY, id);

// --- /forget -----------------------------------------------------------------------------------------------

test("/forget deletes the member's submissions and their posts; other members and the cooldown are untouched", async () => {
  const formId = await makeForm({
    acceptedChannelId: CH.accepted,
    decidedPost: 'copy',
    cooldownHours: 24,
    managerRoleIds: [APP_ROLE.manager],
  });
  const mine = await submit(formId);
  const other = appMember(env, U2, { username: 'ola' });
  const theirs = await submit(formId, other);
  await decideSubmission({
    guild: env.guild,
    id: mine.id,
    action: 'deny',
    by: STAFF,
    actor: { dashboard: true },
  });
  const decided = await getSubmission(GID, mine.id);
  assert.ok(env.channels.pending.store.has(decided.messageId));
  assert.ok((await getCooldownUntil(GID, formId, U)) > Date.now());

  const posts = await forgetApplicationPosts(env.guild, U);
  assert.deepEqual(posts, { ok: true, failedIds: [] });
  assert.ok(!env.channels.pending.store.has(decided.messageId), 'the post was deleted');
  const result = await forgetUser(GID, U, { keepApplicationIds: posts.failedIds });
  assert.equal(result.applications, 1);
  assert.equal(await getSubmission(GID, mine.id), null);
  assert.ok(await getSubmission(GID, theirs.id), 'another member keeps theirs');
  assert.ok(env.channels.pending.store.has(theirs.messageId), 'and their post');
  assert.ok(
    (await getCooldownUntil(GID, formId, U)) > Date.now(),
    '/forget cannot be used to skip the cooldown'
  );
});

test('/forget with a post that cannot be deleted erases the answers but keeps the ids, so the post can still be removed', async () => {
  const formId = await makeForm();
  const mine = await submit(formId);
  env.channels.pending.failWith = serverError();
  const posts = await forgetApplicationPosts(env.guild, U);
  assert.deepEqual(posts, { ok: false, failedIds: [mine.id] });
  await forgetUser(GID, U, { keepApplicationIds: posts.failedIds });
  const kept = await getSubmission(GID, mine.id);
  assert.deepEqual([kept.answers, kept.questions, kept.cleared], [{}, [], true], 'no answers any more');
  assert.equal(kept.messageId, mine.messageId, 'the id of the post is what is kept');
  assert.equal(JSON.stringify(await exportUserData(GID, U)).includes('SECRETWORD123'), false);
  assert.deepEqual(
    (await clearedSubmissions()).map((s) => s.id),
    [mine.id]
  );

  // the sweep deletes the post once Sylo can reach it, and then the row
  await sweepApplications();
  assert.ok(env.channels.pending.store.has(mine.messageId), 'still unreachable: kept');
  env.channels.pending.failWith = null;
  await sweepApplications();
  assert.equal(await getSubmission(GID, mine.id), null);
  assert.ok(!env.channels.pending.store.has(mine.messageId));
});

test('/forget also anonymises the staff side: who decided is dropped, the application stays', async () => {
  const formId = await makeForm();
  const mine = await submit(formId);
  await decideSubmission({
    guild: env.guild,
    id: mine.id,
    action: 'accept',
    by: STAFF,
    actor: { dashboard: true },
  });
  const result = await forgetUser(GID, STAFF);
  assert.equal(result.applicationsDecided, 1);
  assert.equal((await getSubmission(GID, mine.id)).decidedBy, null);
});

// --- export and the member's data ------------------------------------------------------------------------------

test("the member's data export has their applications (answers included) and says the cooldown is kept", async () => {
  const formId = await makeForm({ cooldownHours: 24 });
  const mine = await submit(formId);
  await decideSubmission({
    guild: env.guild,
    id: mine.id,
    action: 'deny',
    reason: 'later',
    by: STAFF,
    actor: { dashboard: true },
  });
  await decideSubmission({
    guild: env.guild,
    id: (await submit(formId, appMember(env, U2))).id,
    action: 'accept',
    by: STAFF,
    actor: { dashboard: true },
  });

  const data = await exportUserData(GID, U);
  assert.equal(data.data.applications.length, 1);
  assert.match(
    JSON.stringify(data.data.applications[0]),
    /SECRETWORD123/,
    'their own answers are in their own export'
  );
  assert.equal(data.data.applications[0].status, 'denied');
  assert.equal(data.data.applicationsCooldowns.length, 1);
  const summary = await describeUserData(GID, U);
  const item = (key) => summary.items.find((i) => i.key === key);
  assert.equal(item('applications').count, 1);
  assert.equal(item('applicationsCooldowns').kept, true);
  assert.equal(item('applications').kept, false);
  // the member's export holds nobody else's answers
  assert.doesNotMatch(JSON.stringify(data), new RegExp(U2));
  const staff = await describeUserData(GID, STAFF);
  assert.equal(staff.items.find((i) => i.key === 'applicationsDecided').count, 2);
});

test('removing a server removes its forms, submissions and cooldowns', async () => {
  const formId = await makeForm({ cooldownHours: 1 });
  await submit(formId);
  await setCooldownUntil(GID, formId, U2, Date.now() + DAY);
  await purgeGuild(GID);
  assert.deepEqual(await listForms(GID), []);
  assert.equal((await listSubmissions({ guildId: GID })).total, 0);
  assert.equal(await getCooldownUntil(GID, formId, U2), 0);
});

// --- retention -------------------------------------------------------------------------------------------------------

test('decided submissions are deleted with their posts after the retention (180 days by default); pending ones never', async () => {
  const formId = await makeForm({ acceptedChannelId: CH.accepted });
  const old = await submit(formId);
  const young = await submit(formId, appMember(env, U2, { username: 'ola' }));
  const waiting = await submit(formId, appMember(env, '700000000000000012', { username: 'kim' }));
  for (const s of [old, young])
    await decideSubmission({
      guild: env.guild,
      id: s.id,
      action: 'accept',
      by: STAFF,
      actor: { dashboard: true },
    });
  ageDecision(old.id, 181);
  ageDecision(young.id, 179);
  db.prepare('UPDATE applications_submissions SET created_at = ? WHERE id = ?').run(
    Date.now() - 400 * DAY,
    waiting.id
  );
  const oldPost = (await getSubmission(GID, old.id)).messageId;

  const out = await sweepApplications();
  assert.equal(out.deleted, 1);
  assert.equal(await getSubmission(GID, old.id), null);
  assert.ok(!env.channels.accepted.store.has(oldPost), 'its post was deleted too');
  assert.ok(await getSubmission(GID, young.id), 'inside the retention');
  assert.equal((await getSubmission(GID, waiting.id)).status, 'pending', 'a pending one is kept however old');
});

test('the retention is a setting, never under 7 days, and a post that cannot be deleted costs the row its answers', async () => {
  await enableApplications({ retentionDays: 1 }); // below the minimum: 7
  const formId = await makeForm();
  const six = await submit(formId);
  const eight = await submit(formId, appMember(env, U2));
  for (const s of [six, eight])
    await decideSubmission({
      guild: env.guild,
      id: s.id,
      action: 'deny',
      by: STAFF,
      actor: { dashboard: true },
    });
  ageDecision(six.id, 6);
  ageDecision(eight.id, 8);
  env.channels.pending.failWith = serverError();
  const out = await sweepApplications();
  assert.deepEqual([out.deleted, out.cleared], [0, 1]);
  const kept = await getSubmission(GID, eight.id);
  assert.deepEqual(
    [kept.answers, kept.cleared],
    [{}, true],
    'the answers are gone, the row stays for the post'
  );
  assert.ok((await getSubmission(GID, six.id)).answers.q_text, 'a younger one is not touched');
  env.channels.pending.failWith = null;
  assert.equal((await sweepApplications()).deleted, 1);
  assert.equal(await getSubmission(GID, eight.id), null);
});

test('the sweep drops cooldowns that have run out and keeps the ones that have not', async () => {
  const formId = await makeForm();
  await setCooldownUntil(GID, formId, U, Date.now() - 1000);
  await setCooldownUntil(GID, formId, U2, Date.now() + DAY);
  assert.equal((await sweepApplications()).cooldowns, 1);
  assert.equal(await getCooldownUntil(GID, formId, U), 0);
  assert.ok((await getCooldownUntil(GID, formId, U2)) > 0);
});

// --- no answers in logs --------------------------------------------------------------------------------------------------

test('an answer never reaches a log line, whatever fails', async () => {
  const lines = [];
  for (const level of ['debug', 'info', 'warn', 'error']) {
    mock.method(log, level, (...args) =>
      lines.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
    );
  }
  const formId = await makeForm({
    acceptedChannelId: CH.accepted,
    pendingRoleId: APP_ROLE.waiting,
    acceptAddRoleIds: [APP_ROLE.member],
  });
  member.failRoles.add(APP_ROLE.waiting);
  const mine = await submit(formId); // a failed role on submit
  member.failRoles.clear();
  member.failRoles.add(APP_ROLE.member);
  env.channels.pending.failWith = serverError(); // a post that cannot be edited
  await decideSubmission({
    guild: env.guild,
    id: mine.id,
    action: 'accept',
    reason: 'fine',
    by: STAFF,
    actor: { dashboard: true },
  });
  env.channels.pending.failWith = null;
  env.channels.accepted.send = async () => {
    throw serverError();
  };
  await submit(formId, appMember(env, U2)); // another: a channel that cannot be written to
  env.channels.pending.failWith = serverError();
  await forgetApplicationPosts(env.guild, U); // a post that cannot be deleted
  await sweepApplications();
  assert.ok(lines.length > 0, 'the failures were logged');
  assert.deepEqual(
    lines.filter((l) => l.includes('SECRETWORD123') || l.includes('private story')),
    []
  );
});
