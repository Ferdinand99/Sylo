// Deciding on an application: the buttons, the command and the dashboard, who may, a decision that is
// made once whatever the number of clickers, the roles (submit, accept, deny, a failure that can be retried,
// the check that Sylo can manage them), and where the post goes (moved, copied, a message that is gone).
import './helpers/tmpDb.js';
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execute as applicationCommand } from '../src/bot/commands/application.js';
import { _resetQuestionnaires } from '../src/bot/lib/dmQuestionnaire.js';
import { routeComponent } from '../src/bot/lib/components.js';
import {
  getCooldownUntil,
  getSubmission,
  pendingSubmission,
  submissionByMessage,
} from '../src/db/applications.js';
import { purgeGuild } from '../src/db/purge.js';
import { _resetApplications, decideSubmission, retryRoles } from '../src/modules/applications.js';
import {
  APP_ROLE,
  CH,
  GID,
  STAFF,
  U,
  U2,
  appMember,
  commandAs,
  dropFakeClient,
  dmFor,
  fakeAppsGuild,
  manageServer,
  pressAs,
  runtime,
} from './helpers/fakeApps.js';
import { QUESTIONS, enableApplications, makeForm, submitFor } from './helpers/appsSetup.js';
import { serverError } from './helpers/fakeIntro.js';

let env;
let member;
let dm;
let staff;
beforeEach(async () => {
  _resetQuestionnaires();
  _resetApplications();
  await purgeGuild(GID);
  env = fakeAppsGuild();
  await enableApplications();
  member = appMember(env, U, { username: 'mira' });
  dm = dmFor(env, member);
  staff = appMember(env, STAFF, { username: 'sam', roleIds: [APP_ROLE.manager] });
});
afterEach(() => {
  dropFakeClient();
  runtime.clients.fluxer = null;
});

const submit = async (formId, opts) => {
  const out = await submitFor(env, member, formId, opts);
  assert.equal(out.ok, true, out.error);
  return getSubmission(GID, out.id);
};
const text = (payload) =>
  [payload.content, ...(payload.embeds ?? []).map((e) => JSON.stringify(e.toJSON()))].join('\n');

// --- who may decide ---------------------------------------------------------------------------------------

test('the Accept and Deny buttons decide at once; a manager role of the form is enough', async () => {
  const formId = await makeForm({ managerRoleIds: [APP_ROLE.manager], acceptAddRoleIds: [APP_ROLE.member] });
  const sub = await submit(formId);
  assert.equal(env.channels.pending.log.sent.length, 1, 'posted in the channel for new applications');
  const buttons = env.channels.pending.log.sent[0].components[0].toJSON().components;
  assert.deepEqual(
    buttons.map((b) => b.custom_id),
    [`apps:accept:${sub.id}`, `apps:deny:${sub.id}`]
  );

  const { interaction, log } = pressAs(env, `apps:accept:${sub.id}`, staff);
  assert.equal(await routeComponent(interaction), true);
  const after = await getSubmission(GID, sub.id);
  assert.equal(after.status, 'accepted');
  assert.equal(after.decidedBy, STAFF);
  assert.equal(log.deferred, 1, 'the press was acknowledged before the work');
  assert.ok(member.roles.cache.has(APP_ROLE.member), 'the role of the form was given');
  assert.match(dm.sent.at(-1).content, /accepted/i, 'the applicant was told');
});

test('without a manager role or Manage Server nobody can decide: not by button, command or function', async () => {
  const formId = await makeForm({ managerRoleIds: [APP_ROLE.manager] });
  const sub = await submit(formId);
  const nobody = appMember(env, U2, { username: 'nobody' });

  const { interaction, log } = pressAs(env, `apps:accept:${sub.id}`, nobody);
  await routeComponent(interaction);
  assert.match(log.replies[0].content, /Only staff/);
  assert.equal(log.deferred, 0);

  const cmd = commandAs(env, nobody, 'deny', { id: sub.id, reason: 'no' });
  await applicationCommand(cmd);
  assert.match(cmd.replies.at(-1).content, /Only staff/);

  const direct = await decideSubmission({
    guild: env.guild,
    id: sub.id,
    action: 'accept',
    by: U2,
    actor: { member: nobody, permissions: nobody.permissions },
  });
  assert.equal(direct.code, 'forbidden');
  assert.equal(
    await decideSubmission({ guild: env.guild, id: sub.id, action: 'accept', actor: {} }).then((r) => r.code),
    'forbidden'
  );
  assert.equal((await getSubmission(GID, sub.id)).status, 'pending');

  // Manage Server is the fallback
  const admin = appMember(env, '700000000000000099', { username: 'admin' });
  const ok = await decideSubmission({
    guild: env.guild,
    id: sub.id,
    action: 'deny',
    by: admin.id,
    actor: { member: admin, permissions: manageServer },
  });
  assert.equal(ok.ok, true);
});

test('/application accept and deny take a reason, which goes on the post and to the applicant', async () => {
  const formId = await makeForm({ managerRoleIds: [APP_ROLE.manager], cooldownHours: 24 });
  const sub = await submit(formId);
  const cmd = commandAs(env, staff, 'deny', { id: sub.id, reason: 'Needs more detail' });
  await applicationCommand(cmd);
  assert.match(cmd.replies.at(-1).content, /now denied/);
  const after = await getSubmission(GID, sub.id);
  assert.equal(after.status, 'denied');
  assert.equal(after.reason, 'Needs more detail');
  assert.match(dm.sent.at(-1).content, /Needs more detail/);
  assert.match(text(env.channels.pending.store.get(after.messageId).payload), /Needs more detail/);
  const until = await getCooldownUntil(GID, formId, U);
  assert.ok(
    until > Date.now() + 23 * 3_600_000 && until < Date.now() + 25 * 3_600_000,
    'a denial starts the cooldown'
  );
  // the same one cannot be decided again, by anyone
  const again = commandAs(env, staff, 'accept', { id: sub.id });
  await applicationCommand(again);
  assert.match(again.replies.at(-1).content, /already denied/);
  assert.equal((await getSubmission(GID, sub.id)).status, 'denied');
});

test('the dashboard decides through the same function, without a member', async () => {
  const sub = await submit(await makeForm());
  const out = await decideSubmission({
    guild: env.guild,
    id: sub.id,
    action: 'accept',
    reason: 'Welcome',
    by: null,
    actor: { dashboard: true },
  });
  assert.equal(out.ok, true);
  assert.equal((await getSubmission(GID, sub.id)).decidedBy, null);
  assert.equal(
    (await decideSubmission({ guild: env.guild, id: 9999, action: 'accept', actor: { dashboard: true } }))
      .code,
    'missing'
  );
});

// --- once, whatever the number of clickers -----------------------------------------------------------------------

test('a double click, or two staff at the same moment, decide it only once', async () => {
  const formId = await makeForm({ managerRoleIds: [APP_ROLE.manager], acceptAddRoleIds: [APP_ROLE.member] });
  const sub = await submit(formId);
  const staff2 = appMember(env, '700000000000000002', { username: 'kim', roleIds: [APP_ROLE.manager] });
  const dmsBefore = dm.sent.length;
  const presses = [
    pressAs(env, `apps:accept:${sub.id}`, staff),
    pressAs(env, `apps:accept:${sub.id}`, staff),
    pressAs(env, `apps:deny:${sub.id}`, staff2),
  ];
  await Promise.all(presses.map((p) => routeComponent(p.interaction)));
  const after = await getSubmission(GID, sub.id);
  assert.ok(['accepted', 'denied'].includes(after.status));
  assert.equal(
    after.history.filter((h) => ['accepted', 'denied'].includes(h.action)).length,
    1,
    'one decision in the history'
  );
  assert.equal(dm.sent.length - dmsBefore, 1, 'the applicant was told once');
  // the press that decided says nothing; the others are told it was already decided
  const told = (p) => [...p.log.followUps, ...p.log.replies].some((r) => /already/.test(r.content));
  assert.equal(presses.filter((p) => !told(p)).length, 1, 'exactly one press decided');
  if (after.status === 'accepted')
    assert.equal(
      member.roleLog.filter((r) => r === `add:${APP_ROLE.member}`).length,
      1,
      'the role was given once'
    );
  else assert.equal(member.roleLog.filter((r) => r === `add:${APP_ROLE.member}`).length, 0);
});

test('a button for an application of another server, or one that is gone, does nothing', async () => {
  const { interaction, log } = pressAs(env, 'apps:accept:424242', staff);
  await routeComponent(interaction);
  assert.match(log.replies[0].content, /no longer exists/);
});

// --- roles ---------------------------------------------------------------------------------------------------------

const ROLES = {
  pendingRoleId: APP_ROLE.waiting,
  removeOnSubmitRoleIds: [APP_ROLE.tourist],
  acceptAddRoleIds: [APP_ROLE.member],
  acceptRemoveRoleIds: [APP_ROLE.sorry],
  denyAddRoleIds: [APP_ROLE.sorry],
  denyRemoveRoleIds: [APP_ROLE.member],
};

test('roles: a waiting role and removals on submit, the chosen role and the accept roles on accept', async () => {
  member.roles.cache.set(APP_ROLE.tourist, env.guild.roles.cache.get(APP_ROLE.tourist));
  member.roles.cache.set(APP_ROLE.sorry, env.guild.roles.cache.get(APP_ROLE.sorry));
  const formId = await makeForm({
    ...ROLES,
    questions: [
      ...QUESTIONS.slice(0, 3),
      {
        id: 'q_team',
        type: 'role',
        label: 'Team',
        grant: 'submit',
        options: [{ id: APP_ROLE.chosenA }, { id: APP_ROLE.chosenB }],
      },
      { id: 'q_yes', type: 'yesno', label: 'Over 18?', required: true },
    ],
  });
  const sub = await submit(formId);
  assert.ok(member.roles.cache.has(APP_ROLE.waiting), 'waiting role given on submit');
  assert.ok(!member.roles.cache.has(APP_ROLE.tourist), 'removed on submit');
  assert.ok(member.roles.cache.has(APP_ROLE.chosenB), 'the role question gives its role on submit');

  await decideSubmission({
    guild: env.guild,
    id: sub.id,
    action: 'accept',
    by: STAFF,
    actor: { dashboard: true },
  });
  assert.ok(!member.roles.cache.has(APP_ROLE.waiting), 'waiting role taken off on the decision');
  assert.ok(member.roles.cache.has(APP_ROLE.member), 'accept role given');
  assert.ok(!member.roles.cache.has(APP_ROLE.sorry), 'accept removal done');
});

test('roles: a role question can give its role on accept instead, and deny uses the deny roles', async () => {
  const a = await makeForm({ ...ROLES });
  const sub = await submit(a);
  assert.ok(!member.roles.cache.has(APP_ROLE.chosenB), 'not before the decision');
  await decideSubmission({ guild: env.guild, id: sub.id, action: 'accept', actor: { dashboard: true } });
  assert.ok(member.roles.cache.has(APP_ROLE.chosenB), 'given on accept');

  const other = appMember(env, U2, { username: 'ola', roleIds: [APP_ROLE.member] });
  const out = await submitFor(env, other, a, {});
  assert.equal(out.ok, true);
  await decideSubmission({ guild: env.guild, id: out.id, action: 'deny', actor: { dashboard: true } });
  assert.ok(!other.roles.cache.has(APP_ROLE.waiting));
  assert.ok(other.roles.cache.has(APP_ROLE.sorry), 'deny role given');
  assert.ok(!other.roles.cache.has(APP_ROLE.member), 'deny removal done');
  assert.ok(!other.roles.cache.has(APP_ROLE.chosenB), 'a denied member gets no chosen role');
});

test('a role change that fails does not undo the decision: the post warns, a retry applies it once', async () => {
  const sub = await submit(await makeForm({ ...ROLES }));
  member.failRoles.add(APP_ROLE.member);
  const out = await decideSubmission({
    guild: env.guild,
    id: sub.id,
    action: 'accept',
    actor: { dashboard: true },
  });
  assert.equal(out.ok, true, 'the decision stands');
  assert.ok(out.warnings.some((w) => /roles/i.test(w)));
  const after = await getSubmission(GID, sub.id);
  assert.equal(after.status, 'accepted');
  assert.deepEqual(
    after.rolesPending.map((p) => `${p.op}:${p.roleId}`),
    [`add:${APP_ROLE.member}`]
  );
  assert.match(
    text(env.channels.pending.store.get(after.messageId)?.payload ?? env.channels.pending.log.sent.at(-1)),
    /could not change some roles/
  );
  assert.ok(!member.roles.cache.has(APP_ROLE.member));
  assert.ok(!member.roles.cache.has(APP_ROLE.waiting), 'the changes that worked were made');

  // still failing: kept; fixed: applied
  const still = await retryRoles({ guild: env.guild, id: sub.id });
  assert.equal(still.remaining, 1);
  member.failRoles.clear();
  const done = await retryRoles({ guild: env.guild, id: sub.id });
  assert.deepEqual([done.remaining, done.applied], [0, 1]);
  assert.ok(member.roles.cache.has(APP_ROLE.member));
  assert.deepEqual((await getSubmission(GID, sub.id)).rolesPending, []);
  const adds = member.roleLog.filter((r) => r === `add:${APP_ROLE.member}`).length;
  await retryRoles({ guild: env.guild, id: sub.id });
  assert.equal(
    member.roleLog.filter((r) => r === `add:${APP_ROLE.member}`).length,
    adds,
    'a retry with nothing left does nothing twice'
  );
  assert.doesNotMatch(
    text(env.channels.pending.store.get(after.messageId)?.payload ?? {}),
    /could not change some roles/,
    'the warning is gone from the post'
  );
});

test('a role change that failed on submit is replaced by the decision, not applied afterwards', async () => {
  member.failRoles.add(APP_ROLE.waiting);
  const sub = await submit(await makeForm({ ...ROLES }));
  assert.equal(
    (await getSubmission(GID, sub.id)).rolesPending.length,
    1,
    'the submission stands with a role waiting'
  );
  member.failRoles.clear();
  await decideSubmission({ guild: env.guild, id: sub.id, action: 'deny', actor: { dashboard: true } });
  assert.deepEqual((await getSubmission(GID, sub.id)).rolesPending, []);
  assert.ok(!member.roles.cache.has(APP_ROLE.waiting), 'the waiting role is not there after the decision');
});

test('Sylo checks it can manage the roles before a member starts and again when they submit', async () => {
  const { execute } = await import('../src/bot/commands/apply.js');
  const formId = await makeForm({ ...ROLES, fillMode: 'discord', acceptAddRoleIds: [APP_ROLE.tooHigh] });
  const cmd = commandAs(env, member, 'start', { form: 'Staff' });
  await execute(cmd);
  assert.match(cmd.replies.at(-1).content, /cannot be used right now/);
  assert.equal(dm.sent.length, 0, 'no question was asked');
  const out = await submitFor(env, member, formId);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'roles');
  assert.equal(await pendingSubmission(GID, formId, U), null, 'nothing was stored');

  // Sylo without Manage Roles
  const ok = await makeForm({ name: 'Plain', ...ROLES });
  env.guild.members.me.permissions = { has: (p) => p !== 'ManageRoles' };
  assert.equal((await submitFor(env, member, ok)).reason, 'roles');
  // a form that changes no roles does not care
  const none = await makeForm({ name: 'NoRoles', questions: [{ id: 'q', type: 'text', label: 'Why' }] });
  assert.equal((await submitFor(env, member, none, { answers: { q: 'because' } })).ok, true);
});

// --- the post: moved, copied, gone ---------------------------------------------------------------------------------------

test('a decided post is moved to the accepted or denied channel, and the old one is deleted by its id', async () => {
  const formId = await makeForm({ acceptedChannelId: CH.accepted, deniedChannelId: CH.denied });
  const a = await submit(formId);
  const oldId = a.messageId;
  await decideSubmission({ guild: env.guild, id: a.id, action: 'accept', actor: { dashboard: true } });
  const moved = await getSubmission(GID, a.id);
  assert.equal(moved.channelId, CH.accepted);
  assert.ok(env.channels.accepted.store.has(moved.messageId));
  assert.ok(!env.channels.pending.store.has(oldId), 'the old post was deleted');
  assert.deepEqual(env.channels.accepted.log.sent[0].components, [], 'no buttons any more');
  assert.equal(text(env.channels.accepted.log.sent[0]).includes('Accepted'), true);

  member.roles.cache.clear();
  const b = await submit(formId, {
    answers: { ...{ q_text: 'a second try, honestly', q_pick: ['blue'], q_multi: ['go'], q_yes: 'no' } },
  });
  await decideSubmission({ guild: env.guild, id: b.id, action: 'deny', actor: { dashboard: true } });
  assert.equal((await getSubmission(GID, b.id)).channelId, CH.denied);
});

test('copy mode keeps the original (edited, no buttons) and posts a copy in the other channel', async () => {
  const formId = await makeForm({ acceptedChannelId: CH.accepted, decidedPost: 'copy' });
  const sub = await submit(formId);
  await decideSubmission({ guild: env.guild, id: sub.id, action: 'accept', actor: { dashboard: true } });
  const after = await getSubmission(GID, sub.id);
  assert.equal(after.channelId, CH.pending);
  assert.ok(env.channels.pending.store.has(after.messageId), 'the original stays');
  assert.deepEqual(env.channels.pending.store.get(after.messageId).payload.components, []);
  assert.equal(after.copyChannelId, CH.accepted);
  assert.ok(env.channels.accepted.store.has(after.copyMessageId));
});

test('a post that staff already deleted is not an error: the decision stands and the pointer is dropped (isMessageGone)', async () => {
  const sub = await submit(await makeForm());
  env.channels.pending.store.delete(sub.messageId);
  const out = await decideSubmission({
    guild: env.guild,
    id: sub.id,
    action: 'accept',
    actor: { dashboard: true },
  });
  assert.equal(out.ok, true);
  assert.equal((await getSubmission(GID, sub.id)).messageId, null);

  // and when there is an accepted channel, the decided post is posted there afresh
  const formId = await makeForm({ name: 'Moves', acceptedChannelId: CH.accepted });
  member.roles.cache.clear();
  const other = await submit(formId);
  env.channels.pending.store.delete(other.messageId);
  await decideSubmission({ guild: env.guild, id: other.id, action: 'accept', actor: { dashboard: true } });
  assert.ok(env.channels.accepted.store.has((await getSubmission(GID, other.id)).messageId));
});

test('a platform error that is not "gone" keeps the pointer and says so, and a missing channel falls back in place', async () => {
  const sub = await submit(await makeForm());
  env.channels.pending.failWith = serverError();
  const out = await decideSubmission({
    guild: env.guild,
    id: sub.id,
    action: 'accept',
    actor: { dashboard: true },
  });
  assert.equal(out.ok, true, 'the decision stands');
  assert.ok(out.warnings.some((w) => /could not update the post/i.test(w)));
  assert.equal(
    (await getSubmission(GID, sub.id)).messageId,
    sub.messageId,
    'the post is still there, so the pointer stays'
  );
  env.channels.pending.failWith = null;

  // the accepted channel cannot be written to: the post stays where it is
  const formId = await makeForm({ name: 'Blocked', acceptedChannelId: CH.accepted });
  member.roles.cache.clear();
  const other = await submit(formId);
  env.channels.accepted.send = async () => {
    throw serverError();
  };
  const moved = await decideSubmission({
    guild: env.guild,
    id: other.id,
    action: 'accept',
    actor: { dashboard: true },
  });
  assert.ok(moved.warnings.some((w) => /accepted or denied channel/.test(w)));
  assert.equal((await getSubmission(GID, other.id)).channelId, CH.pending);
});

test('a post deleted by staff is forgotten by its message id', async () => {
  const { dispatch } = await import('../src/modules/dispatch.js');
  const sub = await submit(await makeForm());
  assert.equal((await submissionByMessage(GID, sub.messageId)).id, sub.id);
  await dispatch('messageDelete', GID, { id: sub.messageId });
  assert.equal((await getSubmission(GID, sub.id)).messageId, null);
  assert.equal(await submissionByMessage(GID, sub.messageId), null);
});

test('the post pings only the ping roles, and never what an applicant wrote', async () => {
  const formId = await makeForm({ pingRoleIds: [APP_ROLE.ping] });
  await submit(formId, {
    answers: {
      q_text: '@everyone <@&123456789012345678> look at me',
      q_pick: ['red'],
      q_multi: ['go'],
      q_yes: 'yes',
    },
  });
  const sent = env.channels.pending.log.sent[0];
  assert.equal(sent.content, `<@&${APP_ROLE.ping}>`);
  assert.deepEqual(sent.allowedMentions, { parse: [], roles: [APP_ROLE.ping] });
  const stored = (await pendingSubmission(GID, formId, U)).answers.q_text;
  assert.equal(stored, 'look at me', 'what was written is cleaned of mentions before it is stored');
});
