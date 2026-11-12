// Fix round 1 of the review: a failed delete of the old post in move mode, a decision racing the submit,
// the cooldown written with the decision, the retention batch, the pending role when an application ends in
// any way, role questions checked against the form as it is now, sessions ended per form, withdrawing from a
// closed form, the reply that holds a choice on Fluxer, an unanswerable question, and the late-answer window.
import './helpers/tmpDb.js';
import './helpers/dashboardUrl.js';
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execute as apply, autocomplete } from '../src/bot/commands/apply.js';
import { register as registerDmTickets } from '../src/bot/events/dmTickets.js';
import { _resetQuestionnaires, hasActiveQuestionnaire } from '../src/bot/lib/dmQuestionnaire.js';
import {
  clearedSubmissions,
  deleteForm,
  getCooldownUntil,
  getForm,
  getSubmission,
  pendingSubmission,
  updateForm,
} from '../src/db/applications.js';
import { setGuildModule } from '../src/db/modules.js';
import { purgeGuild } from '../src/db/purge.js';
import {
  _resetApplications,
  beginApplication,
  cancelApplicationSessions,
  cancelFormSessions,
  decideSubmission,
  deleteSubmissionWithPosts,
  forgetApplicationPosts,
  hydrateForm,
  keepReplyFor,
  loadForm,
  startDm,
  sweepApplications,
  withdrawSubmission,
} from '../src/modules/applications.js';
import { dmQuestionOf, normaliseQuestions, validateAnswers } from '../src/modules/lib/applicationsForm.js';
import { db } from '../src/db/index.js';
import {
  APP_ROLE,
  CH,
  GID,
  STAFF,
  U,
  U2,
  appMember,
  commandAs,
  dmFor,
  dropFakeClient,
  fakeAppsGuild,
  runtime,
} from './helpers/fakeApps.js';
import { missingAccess, serverError } from './helpers/fakeIntro.js';
import { enableApplications, makeForm, submitFor } from './helpers/appsSetup.js';

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
  dropFakeClient();
  runtime.clients.fluxer = null;
});

const submit = async (formId, who = member) => {
  const out = await submitFor(env, who, formId);
  assert.equal(out.ok, true, out.error);
  return getSubmission(GID, out.id);
};
const accept = (id, over = {}) =>
  decideSubmission({
    guild: env.guild,
    id,
    action: 'accept',
    by: STAFF,
    actor: { dashboard: true },
    ...over,
  });
const gate = () => {
  let release;
  let entered;
  const wait = new Promise((r) => (release = r));
  const inside = new Promise((r) => (entered = r));
  return { wait, inside, release: () => release(), enter: () => entered() };
};

// --- I1: move mode, the old post must not lose its pointer --------------------------------------------------------------

for (const [kind, error] of [
  ['a transient error', serverError],
  ['a permanent refusal', missingAccess],
]) {
  test(`move mode: ${kind} deleting the old post keeps the row on it, takes the new post back and says so`, async () => {
    const formId = await makeForm({ acceptedChannelId: CH.accepted });
    const sub = await submit(formId);
    const realDelete = env.channels.pending.messages.delete;
    env.channels.pending.messages.delete = async () => {
      throw error();
    };
    const out = await accept(sub.id);
    assert.equal(out.ok, true, 'the decision stands');
    assert.ok(
      out.warnings.some((w) => /could not delete the old post/i.test(w)),
      'the failure is reported'
    );
    const after = await getSubmission(GID, sub.id);
    assert.equal(after.status, 'accepted');
    assert.deepEqual(
      [after.channelId, after.messageId],
      [CH.pending, sub.messageId],
      'still points at the old post'
    );
    assert.equal(env.channels.accepted.store.size, 0, 'the new post was taken back');
    assert.deepEqual(
      env.channels.pending.store.get(sub.messageId).payload.components,
      [],
      'the old post shows the decision'
    );

    // because the row still points at it, /forget can delete the answers from the old post
    env.channels.pending.messages.delete = realDelete;
    assert.deepEqual(await forgetApplicationPosts(env.guild, U), { ok: true, failedIds: [] });
    assert.ok(!env.channels.pending.store.has(sub.messageId));
  });
}

test('move mode: when the new post cannot be taken back either, the row keeps its id as the copy', async () => {
  const formId = await makeForm({ acceptedChannelId: CH.accepted });
  const sub = await submit(formId);
  env.channels.pending.messages.delete = async () => {
    throw serverError();
  };
  env.channels.accepted.messages.delete = async () => {
    throw serverError();
  };
  await accept(sub.id);
  const after = await getSubmission(GID, sub.id);
  assert.equal(after.messageId, sub.messageId);
  assert.equal(after.copyChannelId, CH.accepted);
  assert.ok(
    env.channels.accepted.store.has(after.copyMessageId),
    'the new post is known, so it can be deleted later'
  );
});

test('move mode: an old post that is already gone is not a failure', async () => {
  const formId = await makeForm({ acceptedChannelId: CH.accepted });
  const sub = await submit(formId);
  env.channels.pending.store.delete(sub.messageId);
  const out = await accept(sub.id);
  assert.deepEqual(out.warnings, []);
  assert.equal((await getSubmission(GID, sub.id)).channelId, CH.accepted);
});

// --- M1: the submit's role step and a decision ------------------------------------------------------------------------------

test('a decision that comes while the submit gives the waiting role is applied after it: no waiting role is left behind', async () => {
  const formId = await makeForm({ pendingRoleId: APP_ROLE.waiting });
  const g = gate();
  const realAdd = member.roles.add;
  member.roles.add = async (id) => {
    g.enter();
    await g.wait;
    return realAdd(id);
  };
  const submitting = submitFor(env, member, formId);
  await g.inside; // the submit is giving the role, under the lock of decisions
  const row = await pendingSubmission(GID, formId, U);
  const deciding = accept(row.id);
  g.release();
  const [made, decided] = await Promise.all([submitting, deciding]);
  assert.equal(made.ok, true);
  assert.equal(decided.ok, true);
  assert.ok(!member.roles.cache.has(APP_ROLE.waiting), 'accepted without the waiting role');
  const after = await getSubmission(GID, row.id);
  assert.deepEqual(
    after.history.map((h) => h.action),
    ['submitted', 'accepted']
  );
  assert.deepEqual(after.rolesPending, []);
});

for (const withAcceptedChannel of [false, true]) {
  test(`a decision that comes before the post has its pointer wins${withAcceptedChannel ? ' (and moves the post)' : ''}: no waiting role, no live buttons, no orphan post`, async () => {
    const formId = await makeForm({
      pendingRoleId: APP_ROLE.waiting,
      ...(withAcceptedChannel && { acceptedChannelId: CH.accepted }),
    });
    const realSend = env.channels.pending.send;
    env.channels.pending.send = async (payload) => {
      const message = await realSend(payload);
      const row = await pendingSubmission(GID, formId, U);
      await accept(row.id); // staff are quick: the decision lands before the submit has stored the post
      return message;
    };
    const out = await submitFor(env, member, formId);
    assert.equal(out.ok, true);
    const after = await getSubmission(GID, out.id);
    assert.equal(after.status, 'accepted');
    assert.ok(!member.roles.cache.has(APP_ROLE.waiting));
    assert.ok(!member.roleLog.includes(`add:${APP_ROLE.waiting}`), 'the waiting role was never given');
    assert.deepEqual(after.rolesPending, []);
    const home = withAcceptedChannel ? env.channels.accepted : env.channels.pending;
    assert.ok(home.store.has(after.messageId), 'the row points at a post that exists');
    assert.deepEqual(home.store.get(after.messageId).payload.components, [], 'and it has no Accept or Deny');
    const all = [...env.channels.pending.store.values(), ...env.channels.accepted.store.values()];
    assert.equal(all.length, 1, 'there is only one post of this application');
  });
}

// --- M2: the cooldown is written with the decision ---------------------------------------------------------------------------

test('a denial starts the cooldown at once, before any platform work: no application can slip through', async () => {
  const formId = await makeForm({ pendingRoleId: APP_ROLE.waiting, cooldownHours: 24 });
  const sub = await submit(formId);
  const g = gate();
  const realRemove = member.roles.remove;
  member.roles.remove = async (id) => {
    g.enter();
    await g.wait;
    return realRemove(id);
  };
  const deciding = decideSubmission({
    guild: env.guild,
    id: sub.id,
    action: 'deny',
    by: STAFF,
    actor: { dashboard: true },
  });
  await g.inside; // the decision is in its role step: the platform work has begun
  assert.equal((await getSubmission(GID, sub.id)).status, 'denied');
  assert.ok(
    (await getCooldownUntil(GID, formId, U)) > Date.now() + 23 * 3_600_000,
    'the cooldown is already there'
  );
  const early = await submitFor(env, member, formId);
  assert.deepEqual([early.ok, early.reason], [false, 'cooldown']);
  g.release();
  await deciding;
});

// --- M3: retention does not stall ---------------------------------------------------------------------------------------------

test('a row whose post cannot be deleted leaves the batch (answers erased, ids kept) and goes to the back of the line', async () => {
  const formId = await makeForm();
  const first = await submit(formId);
  await accept(first.id);
  db.prepare('UPDATE applications_submissions SET decided_at = ? WHERE id = ?').run(
    Date.now() - 200 * DAY,
    first.id
  );
  env.channels.pending.messages.delete = async () => {
    throw serverError();
  };
  assert.deepEqual(await sweepApplications().then((r) => [r.deleted, r.cleared]), [0, 1]);
  const { decidedBeforeInGuild, guildsWithDecidedBefore } = await import('../src/db/applications.js');
  assert.deepEqual(
    await decidedBeforeInGuild(GID, Date.now(), 200),
    [],
    'cleared rows no longer fill the batch'
  );
  assert.deepEqual(await guildsWithDecidedBefore(Date.now()), []);
  const before = (await getSubmission(GID, first.id)).updatedAt;
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await sweepApplications()).cleared, 0, 'it is not cleared again');
  assert.ok(
    (await getSubmission(GID, first.id)).updatedAt > before,
    'but it is moved to the back of the line'
  );
  assert.deepEqual(
    (await clearedSubmissions()).map((s) => s.id),
    [first.id]
  );
});

// --- M6: the pending role goes whenever a pending application ends -------------------------------------------------------------

test('the pending role comes off when staff delete a pending application, and when /forget removes it', async () => {
  const formId = await makeForm({ pendingRoleId: APP_ROLE.waiting });
  const a = await submit(formId);
  assert.ok(member.roles.cache.has(APP_ROLE.waiting));
  assert.equal((await deleteSubmissionWithPosts(env.guild, a.id)).ok, true);
  assert.ok(!member.roles.cache.has(APP_ROLE.waiting), 'dashboard delete');

  await submit(formId);
  assert.ok(member.roles.cache.has(APP_ROLE.waiting));
  await forgetApplicationPosts(env.guild, U);
  assert.ok(!member.roles.cache.has(APP_ROLE.waiting), '/forget');
});

test('the pending role comes off when the form was deleted before the decision or the withdrawal', async () => {
  const formId = await makeForm({ pendingRoleId: APP_ROLE.waiting, acceptAddRoleIds: [APP_ROLE.member] });
  const a = await submit(formId);
  assert.equal(
    (await getSubmission(GID, a.id)).pendingRoleId,
    APP_ROLE.waiting,
    'the row remembers which role it was'
  );
  await deleteForm(GID, formId);
  assert.equal((await accept(a.id)).ok, true);
  assert.ok(!member.roles.cache.has(APP_ROLE.waiting), 'decided after the form was deleted');
  assert.ok(!member.roles.cache.has(APP_ROLE.member), 'and nothing else of the form is applied');

  const formB = await makeForm({ name: 'B', pendingRoleId: APP_ROLE.waiting });
  const b = await submit(formB);
  assert.ok(member.roles.cache.has(APP_ROLE.waiting));
  await deleteForm(GID, formB);
  assert.equal((await withdrawSubmission({ guild: env.guild, userId: U })).id, b.id);
  assert.ok(!member.roles.cache.has(APP_ROLE.waiting), 'withdrawn after the form was deleted');
});

// --- M7: role questions against the form as it is now ---------------------------------------------------------------------------

async function changeForm(formId, change) {
  const row = await getForm(GID, formId);
  const config = structuredClone(row.config);
  change(config);
  await updateForm(GID, formId, { name: row.name, enabled: row.enabled, fillMode: row.fillMode, config });
}

test('a role that staff took out of a role question, or a question set to give nothing, is not given on accept', async () => {
  for (const [name, change] of [
    [
      'a role removed from the question',
      (c) => (c.questions.find((q) => q.id === 'q_team').options = [{ id: APP_ROLE.chosenA }]),
    ],
    ['the question set to give nothing', (c) => (c.questions.find((q) => q.id === 'q_team').grant = 'never')],
  ]) {
    member.roles.cache.delete(APP_ROLE.chosenB);
    const formId = await makeForm({ name });
    const sub = await submit(formId); // answered chosenB, to be given on accept
    await changeForm(formId, change);
    const out = await accept(sub.id);
    assert.ok(!member.roles.cache.has(APP_ROLE.chosenB), `${name}: not given`);
    assert.ok(
      out.warnings.some((w) => /Skipped 1 role/.test(w)),
      name
    );
    assert.ok(
      (await getSubmission(GID, sub.id)).history.some((h) => h.action === 'roles_skipped'),
      name
    );
  }
});

test('a role that Sylo cannot manage any more when the application is accepted is skipped, the rest is applied', async () => {
  const formId = await makeForm({ acceptAddRoleIds: [APP_ROLE.member] });
  const sub = await submit(formId);
  env.guild.roles.cache.get(APP_ROLE.chosenB).position = 500; // now above Sylo's highest role
  const out = await accept(sub.id);
  assert.equal(out.ok, true);
  assert.ok(!member.roles.cache.has(APP_ROLE.chosenB));
  assert.ok(member.roles.cache.has(APP_ROLE.member), "the form's own roles still apply");
  assert.ok(out.warnings.some((w) => /Skipped 1 role/.test(w)));
  assert.ok(
    !out.warnings.some((w) => /could not be changed/.test(w)),
    'a skipped role is not a failure to retry'
  );
  env.guild.roles.cache.get(APP_ROLE.chosenB).position = 8;
});

// --- M8: sessions are ended per form -----------------------------------------------------------------------------------------------

test('closing or deleting one form ends only the questions of that form; the module switch ends them all', async () => {
  const a = hydrateForm(await getForm(GID, await makeForm({ name: 'A', fillMode: 'discord' })));
  const b = hydrateForm(await getForm(GID, await makeForm({ name: 'B', fillMode: 'discord' })));
  const other = appMember(env, U2, { username: 'ola' });
  dmFor(env, other);
  assert.equal((await startDm({ guild: env.guild, user: member.user, form: a })).ok, true);
  assert.equal((await startDm({ guild: env.guild, user: other.user, form: b })).ok, true);
  assert.equal(cancelFormSessions(GID, a.id), true);
  assert.equal(hasActiveQuestionnaire('discord', U), false, 'the member of the closed form is stopped');
  assert.equal(hasActiveQuestionnaire('discord', U2), true, 'the member of another form is not');
  assert.equal(cancelFormSessions(GID, a.id), false, 'nothing left of that form');
  assert.equal(cancelApplicationSessions(GID), true);
  assert.equal(hasActiveQuestionnaire('discord', U2), false);
});

// --- M9: withdrawing from a form that is closed now ------------------------------------------------------------------------------

test("/apply withdraw finds the member's own application by the form name, whatever the form's state, and with the module off", async () => {
  const closed = await makeForm({ name: 'Closed form' });
  const dmOnly = await makeForm({ name: 'Other form' });
  const a = await submit(closed);
  const b = await submit(dmOnly);
  const row = await getForm(GID, closed);
  await updateForm(GID, closed, { name: row.name, enabled: false, fillMode: 'both', config: row.config });
  const row2 = await getForm(GID, dmOnly);
  await updateForm(GID, dmOnly, { name: row2.name, enabled: true, fillMode: 'discord', config: row2.config });

  const typed = [];
  await autocomplete({
    guildId: GID,
    user: member.user,
    options: { getFocused: () => 'clo', getSubcommand: () => 'withdraw' },
    respond: async (c) => typed.push(...c),
  });
  assert.deepEqual(
    typed,
    [{ name: 'Closed form', value: String(closed) }],
    "the suggestions are the member's own pending forms"
  );

  const unnamed = commandAs(env, member, 'withdraw', {});
  await apply(unnamed);
  assert.match(unnamed.replies.at(-1).content, /more than one pending application/);
  const named = commandAs(env, member, 'withdraw', { form: 'Closed form' });
  await apply(named);
  assert.match(named.replies.at(-1).content, new RegExp(`application #${a.id} was withdrawn`));
  assert.equal((await getSubmission(GID, a.id)).status, 'withdrawn');

  await setGuildModule(GID, 'applications', { enabled: false });
  const byNumber = commandAs(env, member, 'withdraw', { form: String(dmOnly) });
  await apply(byNumber);
  assert.match(byNumber.replies.at(-1).content, new RegExp(`application #${b.id} was withdrawn`));
});

// --- M11: the reply that holds a choice stays -----------------------------------------------------------------------------------------

test('the reply with the choice between DM and web stays as long as the questions would run, where replies are short-lived', async () => {
  const formId = await makeForm({ fillMode: 'both', timeoutMinutes: 45 });
  const form = await loadForm(GID, formId);
  const out = await beginApplication({ guild: env.guild, user: member.user, form });
  assert.equal(out.holdMs, 45 * 60_000);
  const fluxerReply = { _privateTtlMs: 15_000 };
  keepReplyFor(fluxerReply, out.holdMs);
  assert.equal(fluxerReply._privateTtlMs, 45 * 60_000);
  const longer = { _privateTtlMs: 2 * 3_600_000 };
  keepReplyFor(longer, out.holdMs);
  assert.equal(longer._privateTtlMs, 2 * 3_600_000, 'a longer life is never shortened');
  const discord = {};
  keepReplyFor(discord, out.holdMs);
  assert.deepEqual(discord, {}, 'Discord has private replies and needs none of this');
  const dmForm = await beginApplication({
    guild: env.guild,
    user: member.user,
    form: { ...form, fillMode: 'discord' },
  });
  assert.equal(dmForm.holdMs, undefined, 'only the choice holds');
});

// --- M12: a required question with nothing to choose from --------------------------------------------------------------------------

test('a required choice or role question with no options counts as optional, and is marked so it cannot be saved', () => {
  const [choice, role, text] = normaliseQuestions([
    { id: 'c', type: 'choice', label: 'Pick', required: true, options: [] },
    { id: 'r', type: 'role', label: 'Team', required: true, options: [{ id: 'not-a-role' }] },
    { id: 't', type: 'text', label: 'Why', required: true },
  ]);
  for (const q of [choice, role]) {
    assert.deepEqual([q.required, q.unanswerable], [false, true]);
    assert.equal(dmQuestionOf(q).required, false, 'the DM questionnaire lets the member skip it');
    assert.deepEqual(
      validateAnswers([q], {}),
      { ok: true, answers: { [q.id]: '' } },
      'and the web form does not insist'
    );
  }
  assert.deepEqual([text.required, text.unanswerable], [true, false]);
  const withOptions = normaliseQuestions([
    { id: 'c', type: 'choice', label: 'Pick', required: true, options: [{ label: 'a' }] },
  ])[0];
  assert.deepEqual([withOptions.required, withOptions.unanswerable], [true, false]);
});

// --- M13: the late-answer window ------------------------------------------------------------------------------------------------------

function lateAnswer(minutesAgo) {
  const replies = [];
  const client = new EventEmitter();
  registerDmTickets(client);
  const old = {
    author: { id: env.client.user.id },
    content: '**Question 2 of 5 · Why do you want to join?**\nAnswer please.',
    createdTimestamp: Date.now() - minutesAgo * 60_000,
  };
  const channel = { messages: { fetch: async () => new Map([['m1', old]]) } };
  client.emit('messageCreate', {
    id: '900000000000000999',
    guild: null,
    partial: false,
    content: 'because I like hedges',
    author: Object.assign(member.user, { bot: false }),
    attachments: new Map(),
    client: env.client,
    channel,
    reply: async (p) => replies.push(typeof p === 'string' ? p : p.content),
    react: async () => {},
  });
  return new Promise((resolve) => setTimeout(() => resolve(replies), 60));
}

test('after a restart, a late answer to a long form is told so instead of becoming a ticket, up to the longest form timeout (at most 24 hours)', async () => {
  await makeForm({ fillMode: 'discord', timeoutMinutes: 120 });
  const within = await lateAnswer(40); // longer than the old fixed 30 minutes
  assert.match(within.join('\n'), /questionnaire that has ended/);
  assert.match(within.join('\n'), /apply start/);
  const beyond = await lateAnswer(3 * 60);
  assert.doesNotMatch(
    beyond.join('\n'),
    /questionnaire that has ended/,
    "past the form's own timeout it is an ordinary message again"
  );
});

test('the window is at least 30 minutes with no forms, and never more than 24 hours', async () => {
  assert.match((await lateAnswer(20)).join('\n'), /questionnaire that has ended/);
  assert.doesNotMatch((await lateAnswer(40)).join('\n'), /questionnaire that has ended/);
  await makeForm({ fillMode: 'discord', timeoutMinutes: 1440 });
  assert.match((await lateAnswer(23 * 60)).join('\n'), /questionnaire that has ended/);
  assert.doesNotMatch((await lateAnswer(25 * 60)).join('\n'), /questionnaire that has ended/);
});
