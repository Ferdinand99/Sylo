// Starting and answering an application: /apply and the panel, the DM questionnaire for every question
// type (skip, cancel, start over, timeout, submit), the fill modes, the requirements at start and at
// submit, one pending per form, withdraw, a member who leaves, and DMs never opening a ticket meanwhile.
// mock.timers is experimental until Node 23.1 but works on the Node 22 this project requires.
/* eslint-disable n/no-unsupported-features/node-builtins */
import './helpers/tmpDb.js';
import './helpers/dashboardUrl.js';
import test, { afterEach, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execute as apply, autocomplete } from '../src/bot/commands/apply.js';
import { register as registerDmTickets } from '../src/bot/events/dmTickets.js';
import { _resetQuestionnaires, hasActiveQuestionnaire } from '../src/bot/lib/dmQuestionnaire.js';
import { routeComponent } from '../src/bot/lib/components.js';
import { dispatch } from '../src/modules/dispatch.js';
import {
  getForm,
  getSubmission,
  insertSubmission,
  isUniqueViolation,
  listSubmissions,
  pendingSubmission,
  setCooldownUntil,
  updateForm,
} from '../src/db/applications.js';
import { setGuildModule } from '../src/db/modules.js';
import { getOpenTicket } from '../src/db/tickets.js';
import { purgeGuild } from '../src/db/purge.js';
import {
  _resetApplications,
  cancelApplicationSessions,
  decideSubmission,
  hydrateForm,
  publishPanel,
  startDm,
  unpublishPanel,
} from '../src/modules/applications.js';
import {
  APP_ROLE,
  CH,
  GID,
  U,
  U2,
  appMember,
  commandAs,
  dmFor,
  dropFakeClient,
  fakeAppsGuild,
  pressAs,
  runtime,
} from './helpers/fakeApps.js';
import { enableApplications, makeForm, submitFor } from './helpers/appsSetup.js';

let env;
let member;
let dm;
beforeEach(async () => {
  _resetQuestionnaires();
  _resetApplications();
  await purgeGuild(GID);
  env = fakeAppsGuild();
  await enableApplications();
  member = appMember(env, U, { username: 'mira' });
  dm = dmFor(env, member);
});
afterEach(() => {
  mock.timers.reset();
  dropFakeClient();
  runtime.clients.fluxer = null;
});

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
};
const buttonId = (payload, index) => payload.components[0].toJSON().components[index].custom_id;
const start = async (name = 'Staff', who = member) => {
  const cmd = commandAs(env, who, 'start', { form: name });
  await apply(cmd);
  return cmd.replies.at(-1).content;
};
const lastDm = () => dm.sent.at(-1).content;

// --- every question type, in DM -----------------------------------------------------------------------------------

test('/apply start asks every question type in DM, shows a preview, and Submit posts it for staff', async () => {
  const formId = await makeForm({ fillMode: 'discord', pingRoleIds: [APP_ROLE.ping] });
  assert.equal(await start(), 'Check your DMs.');
  assert.match(dm.sent[0].content, /Applying for \*\*Staff\*\* in \*\*Hedgerow HQ\*\*/, 'the start message');
  assert.match(dm.sent[0].content, /Question 1 of 5 · Why do you want to join\?/);
  assert.equal(hasActiveQuestionnaire('discord', U), true);

  await dm.say('I love trains and hedges');
  assert.match(lastDm(), /Question 2 of 5 · Favourite colour/);
  assert.match(lastDm(), /\*\*1\.\*\* Red/);
  assert.match(lastDm(), /\*\*2\.\*\* Blue/);
  await dm.say('1');
  assert.match(lastDm(), /Question 3 of 5 · Hobbies/);
  assert.match(lastDm(), /\*\*3\.\*\* Hiking/);
  await dm.say('1, 3');
  assert.match(lastDm(), /Question 4 of 5 · Team\*\* \(optional\)/);
  assert.match(lastDm(), /\*\*2\.\*\* Blue team/, 'a role option shows the role name');
  await dm.say('2');
  assert.match(lastDm(), /Question 5 of 5 · Over 18\?/);
  await dm.say('YES');

  const preview = dm.sent.at(-1);
  const fields = preview.embeds[0].toJSON().fields;
  assert.deepEqual(
    fields.map((f) => [f.name, f.value]),
    [
      ['Why do you want to join?', 'I love trains and hedges'],
      ['Favourite colour', 'Red'],
      ['Hobbies', 'Chess, Hiking'],
      ['Team', 'Blue team'],
      ['Over 18?', 'Yes'],
    ]
  );
  assert.equal(env.channels.pending.log.sent.length, 0, 'nothing is posted before Submit');
  assert.equal(await pendingSubmission(GID, formId, U), null);

  const { interaction, log } = pressAs(env, buttonId(preview, 0), member);
  await routeComponent(interaction);
  const sub = await pendingSubmission(GID, formId, U);
  assert.deepEqual(sub.answers, {
    q_text: 'I love trains and hedges',
    q_pick: 'red',
    q_multi: 'chess,hike',
    q_team: APP_ROLE.chosenB,
    q_yes: 'yes',
  });
  assert.equal(sub.source, 'dm');
  assert.equal(sub.questions.length, 5, 'the questions as they were asked are stored');
  assert.equal(sub.formName, 'Staff');
  assert.match(log.edits.at(-1).content, /was submitted/, 'the applicant is told it was submitted');

  const sent = env.channels.pending.log.sent[0];
  assert.equal(sent.content, `<@&${APP_ROLE.ping}>`, 'only the ping role is mentioned');
  assert.deepEqual(sent.allowedMentions, { parse: [], roles: [APP_ROLE.ping] });
  assert.deepEqual(
    sent.components[0].toJSON().components.map((b) => b.custom_id),
    [`apps:accept:${sub.id}`, `apps:deny:${sub.id}`]
  );
  assert.equal(sub.messageId, [...env.channels.pending.store.keys()][0]);
  assert.equal(hasActiveQuestionnaire('discord', U), false, 'the session is over');
});

test('answers that do not fit are refused and the question is asked again; skip only works for optional questions', async () => {
  await makeForm({ fillMode: 'discord' });
  await start();
  await dm.say('skip');
  assert.match(lastDm(), /required, so it cannot be skipped/);
  await dm.say('abc');
  assert.match(lastDm(), /at least 5 are needed/);
  await dm.say('x'.repeat(201));
  assert.match(lastDm(), /limit is 200/);
  await dm.say('a good reason');

  await dm.say('3');
  assert.match(lastDm(), /There is no option 3/);
  await dm.say('0');
  assert.match(lastDm(), /There is no option 0/);
  await dm.say('red');
  assert.match(lastDm(), /Answer with the numbers/);
  await dm.say('1,2');
  assert.match(lastDm(), /only one/i);
  await dm.say('2');

  await dm.say('1,2,3');
  assert.match(lastDm(), /at most 2/);
  await dm.say('skip');
  assert.match(lastDm(), /required|cannot/i, 'hobbies are required to have at least one');
  await dm.say('2');

  await dm.say('skip');
  assert.match(lastDm(), /Question 5 of 5/, 'the role question is optional, so it can be skipped');
  await dm.say('maybe');
  assert.match(lastDm(), /yes or no/i);
  await dm.say('n');
  const fields = dm.sent.at(-1).embeds[0].toJSON().fields;
  assert.equal(fields.find((f) => f.name === 'Over 18?').value, 'No');
  assert.equal(fields.find((f) => f.name === 'Team').value, '—', 'a skipped question is shown as empty');
});

test('cancel stops it and stores nothing; starting over offers the earlier answers, in words, to keep', async () => {
  const formId = await makeForm({ fillMode: 'discord' });
  await start();
  await dm.say('cancel');
  assert.match(lastDm(), /Cancelled/);
  assert.equal(hasActiveQuestionnaire('discord', U), false);
  assert.equal((await listSubmissions({ guildId: GID })).total, 0);

  // wait out the rate limit of the start, as a member would
  _resetApplications();
  await start();
  await dm.say('first try at this');
  await dm.say('2');
  await dm.say('2');
  await dm.say('skip');
  await dm.say('no');
  const preview = dm.sent.at(-1);
  const { interaction, log } = pressAs(env, buttonId(preview, 1), member);
  await routeComponent(interaction);
  assert.match(log.updates[0].content, /Starting over/);
  assert.match(lastDm(), /Question 1 of 5/);
  assert.match(lastDm(), /Current:\n> first try at this/);
  await dm.say('keep');
  assert.match(lastDm(), /Current:\n> Blue/, 'a choice is offered as its label, not its id');
  await dm.say('keep');
  assert.match(lastDm(), /Current:\n> Go/);
  await dm.say('keep');
  await dm.say('skip');
  await dm.say('keep');
  const again = dm.sent.at(-1).embeds[0].toJSON().fields;
  assert.equal(again[0].value, 'first try at this');
  assert.equal(again[1].value, 'Blue');
  assert.equal(await pendingSubmission(GID, formId, U), null, 'still nothing stored');
});

test('the session times out per form: after the minutes the form sets, nothing is stored', async () => {
  const formId = await makeForm({ fillMode: 'discord', timeoutMinutes: 5 });
  assert.equal(hydrateForm(await getForm(GID, formId)).timeoutMinutes, 5);
  assert.equal(
    hydrateForm(await getForm(GID, await makeForm({ name: 'Default', fillMode: 'discord' }))).timeoutMinutes,
    30,
    'the default is 30 minutes'
  );
  mock.timers.enable({ apis: ['setTimeout'] });
  await start('Staff');
  mock.timers.tick(4 * 60_000);
  assert.equal(hasActiveQuestionnaire('discord', U), true, 'still going after 4 minutes');
  mock.timers.tick(2 * 60_000);
  await flush();
  assert.equal(hasActiveQuestionnaire('discord', U), false);
  assert.match(lastDm(), /That took too long/);
  assert.equal(await pendingSubmission(GID, formId, U), null);
});

test('while a session runs the DMs are answers and never open a ticket, on any question', async () => {
  await setGuildModule(GID, 'tickets', { enabled: true, config: {} });
  await makeForm({ fillMode: 'discord' });
  const client = new EventEmitter();
  registerDmTickets(client);
  const say = async (content) => {
    const replies = [];
    const reactions = [];
    client.emit('messageCreate', {
      guild: null,
      partial: false,
      content,
      author: Object.assign(member.user, { bot: false }),
      attachments: new Map(),
      client: env.client,
      channel: dm.channel,
      reply: async (p) => replies.push(p),
      react: async (e) => reactions.push(e),
    });
    await flush();
    return { replies, reactions };
  };
  await start();
  for (const answer of ['I need help with my account', '1', '2', 'skip', 'yes']) {
    const out = await say(answer);
    assert.deepEqual(out.replies, [], `no ticket reply for ${answer}`);
    assert.deepEqual(out.reactions, [], `no ticket checkmark for ${answer}`);
  }
  assert.ok(!(await getOpenTicket(GID, U)), 'no modmail ticket was opened');
  assert.match(lastDm(), /Happy with this/, 'the answers went to the questionnaire');
  assert.equal((await say('cancel')).reactions.length, 0);
  assert.equal(hasActiveQuestionnaire('discord', U), false);
  assert.deepEqual((await say('hello staff')).reactions, ['✅'], 'afterwards a DM is modmail again');
});

// --- fill modes ----------------------------------------------------------------------------------------------------------

test('the reply depends on the fill mode: DM, a link, or both', async () => {
  const web = await makeForm({ name: 'WebForm', fillMode: 'web' });
  await makeForm({ name: 'DmForm', fillMode: 'discord' });
  const both = await makeForm({ name: 'BothForm', fillMode: 'both' });

  const w = commandAs(env, member, 'start', { form: 'WebForm' });
  await apply(w);
  assert.equal(
    w.replies.at(-1).content,
    `Fill in **WebForm** on the web: https://sylo.example.test/apply/${GID}/${web}`
  );
  assert.equal(dm.sent.length, 0, 'a web form asks nothing in DM');

  _resetApplications();
  assert.equal(await start('DmForm'), 'Check your DMs.');
  _resetQuestionnaires();
  _resetApplications();

  const b = commandAs(env, member, 'start', { form: 'BothForm' });
  await apply(b);
  const reply = b.replies.at(-1);
  const row = reply.components[0].toJSON().components;
  assert.deepEqual(
    row.map((c) => c.label),
    ['Answer in DMs', 'Open on the web']
  );
  assert.equal(row[0].custom_id, `apps:dm:${both}`);
  assert.equal(row[1].url, `https://sylo.example.test/apply/${GID}/${both}`);
  assert.equal(hasActiveQuestionnaire('discord', U), false, 'nothing starts until the member chooses');
  const { interaction, log } = pressAs(env, `apps:dm:${both}`, member);
  await routeComponent(interaction);
  assert.equal(log.replies.at(-1).content, 'Check your DMs.');
  assert.equal(hasActiveQuestionnaire('discord', U), true);
});

test('a discord-only form has no web submission and a web-only form has no DM', async () => {
  const dmOnly = await makeForm({ name: 'DmOnly', fillMode: 'discord' });
  const webOnly = await makeForm({ name: 'WebOnly', fillMode: 'web' });
  const viaWeb = await submitFor(env, member, dmOnly, { source: 'web' });
  assert.deepEqual([viaWeb.ok, viaWeb.reason], [false, 'wrong_mode']);
  const viaDm = await submitFor(env, member, webOnly, { source: 'dm' });
  assert.deepEqual([viaDm.ok, viaDm.reason], [false, 'wrong_mode']);
  const form = hydrateForm(await getForm(GID, webOnly));
  assert.match(
    (await startDm({ guild: env.guild, user: member.user, form })).message,
    /filled in on the web/
  );
  assert.equal(dm.sent.length, 0);
  assert.equal((await submitFor(env, member, webOnly, { source: 'web' })).ok, true);
  assert.equal((await submitFor(env, appMember(env, U2), dmOnly, { source: 'dm' })).ok, true);
});

test('with one open form /apply start needs no name; with several it asks which', async () => {
  const only = await makeForm({ fillMode: 'discord' });
  assert.equal(await start(''), 'Check your DMs.');
  assert.equal(hasActiveQuestionnaire('discord', U), true);
  _resetQuestionnaires();
  _resetApplications();
  await makeForm({ name: 'Moderator', fillMode: 'discord' });
  assert.match(await start(''), /Which form\? \*\*Staff\*\*, \*\*Moderator\*\*/);
  assert.match(await start('Nope'), /no open form with that name/);
  assert.equal(
    await start(String(only)),
    'Check your DMs.',
    'the number works too (what the suggestions send)'
  );

  const typed = [];
  await autocomplete({
    guildId: GID,
    options: { getFocused: () => 'mod' },
    respond: async (c) => typed.push(...c),
  });
  assert.deepEqual(typed, [{ name: 'Moderator', value: String(only + 1) }]);
});

test('with the module off the command, the panel and the submit refuse', async () => {
  const formId = await makeForm({ fillMode: 'discord' });
  await setGuildModule(GID, 'applications', { enabled: false });
  assert.match(await start(), /module is off/);
  assert.equal((await submitFor(env, member, formId)).reason, 'module_off');
});

// --- requirements: at start, and again at submit ------------------------------------------------------------------------------

const role = (id) => env.guild.roles.cache.get(id);
const DAYS = 86_400_000;
const REQUIREMENTS = [
  [
    'required roles (all)',
    { requiredRoleIds: [APP_ROLE.member, APP_ROLE.tourist] },
    (m) => {
      m.roles.cache.set(APP_ROLE.member, role(APP_ROLE.member));
      m.roles.cache.set(APP_ROLE.tourist, role(APP_ROLE.tourist));
    },
    (m) => m.roles.cache.delete(APP_ROLE.tourist),
    /all of the required roles/,
  ],
  [
    'required roles (any)',
    { requiredRoleIds: [APP_ROLE.member, APP_ROLE.tourist], requiredRolesMode: 'any' },
    (m) => m.roles.cache.set(APP_ROLE.tourist, role(APP_ROLE.tourist)),
    (m) => m.roles.cache.delete(APP_ROLE.tourist),
    /at least one of the required roles/,
  ],
  [
    'restricted roles (any)',
    { restrictedRoleIds: [APP_ROLE.sorry, APP_ROLE.tourist] },
    (m) => m.roles.cache.delete(APP_ROLE.sorry),
    (m) => m.roles.cache.set(APP_ROLE.sorry, role(APP_ROLE.sorry)),
    /cannot apply/,
  ],
  [
    'restricted roles (all)',
    { restrictedRoleIds: [APP_ROLE.sorry, APP_ROLE.tourist], restrictedRolesMode: 'all' },
    (m) => {
      m.roles.cache.set(APP_ROLE.sorry, role(APP_ROLE.sorry));
      m.roles.cache.delete(APP_ROLE.tourist);
    },
    (m) => {
      m.roles.cache.set(APP_ROLE.sorry, role(APP_ROLE.sorry));
      m.roles.cache.set(APP_ROLE.tourist, role(APP_ROLE.tourist));
    },
    /cannot apply/,
  ],
  [
    'account age',
    { minAccountDays: 30 },
    (m) => {
      m.user.createdTimestamp = Date.now() - 100 * DAYS;
    },
    (m) => {
      m.user.createdTimestamp = Date.now() - DAYS;
    },
    /account must be at least 30 days old/,
  ],
  [
    'time on the server',
    { minServerDays: 30 },
    (m) => {
      m.joinedTimestamp = Date.now() - 100 * DAYS;
    },
    (m) => {
      m.joinedTimestamp = Date.now() - DAYS;
    },
    /in this server for at least 30 days/,
  ],
];

for (const [name, config, satisfy, break_, message] of REQUIREMENTS) {
  test(`requirement: ${name}, checked when the member starts and again when they submit`, async () => {
    const formId = await makeForm({ fillMode: 'discord', ...config });
    break_(member);
    assert.match(await start(), message, 'refused at the start, with the reason');
    assert.equal(dm.sent.length, 0);

    // fine at the start, no longer fine by the time they submit
    satisfy(member);
    _resetApplications();
    assert.equal(await start(), 'Check your DMs.');
    for (const answer of ['a good reason', '1', '1', 'skip', 'yes']) await dm.say(answer);
    const preview = dm.sent.at(-1);
    break_(member);
    const { interaction, log } = pressAs(env, buttonId(preview, 0), member);
    await routeComponent(interaction);
    assert.match(log.edits.at(-1).content, message);
    assert.equal(await pendingSubmission(GID, formId, U), null, 'nothing was stored');
    assert.equal(hasActiveQuestionnaire('discord', U), false, 'the session ended: trying again cannot help');
    assert.equal(env.channels.pending.log.sent.length, 0);
  });
}

test('requirement: the cooldown after a denial, checked at the start and at the submit', async () => {
  const formId = await makeForm({ fillMode: 'discord', cooldownHours: 24 });
  await setCooldownUntil(GID, formId, U, Date.now() + 5 * 3_600_000);
  assert.match(await start(), /apply again in 5 hours/);
  await setCooldownUntil(GID, formId, U, 0);
  _resetApplications();
  assert.equal(await start(), 'Check your DMs.');
  for (const answer of ['a good reason', '1', '1', 'skip', 'yes']) await dm.say(answer);
  await setCooldownUntil(GID, formId, U, Date.now() + 2 * 3_600_000);
  const { interaction, log } = pressAs(env, buttonId(dm.sent.at(-1), 0), member);
  await routeComponent(interaction);
  assert.match(log.edits.at(-1).content, /apply again in 2 hours/);
});

test('requirement: the form must be open and the module on, at the submit too', async () => {
  const formId = await makeForm({ fillMode: 'discord' });
  assert.equal(await start(), 'Check your DMs.');
  for (const answer of ['a good reason', '1', '1', 'skip', 'yes']) await dm.say(answer);
  const row = await getForm(GID, formId);
  await updateForm(GID, formId, {
    name: row.name,
    enabled: false,
    fillMode: row.fillMode,
    config: row.config,
  });
  const { interaction, log } = pressAs(env, buttonId(dm.sent.at(-1), 0), member);
  await routeComponent(interaction);
  assert.match(log.edits.at(-1).content, /not open for applications/);
  assert.equal(await pendingSubmission(GID, formId, U), null);
});

// --- one pending per form ------------------------------------------------------------------------------------------------------

test('only one submission per form and member can be pending: the check, and the database itself', async () => {
  const a = await makeForm({ name: 'A', fillMode: 'discord' });
  const b = await makeForm({ name: 'B', fillMode: 'discord' });
  const first = await submitFor(env, member, a);
  assert.equal(first.ok, true);
  const second = await submitFor(env, member, a);
  assert.deepEqual([second.ok, second.reason], [false, 'pending']);
  assert.match(await start('A'), /already have an application/);
  assert.equal((await submitFor(env, member, b)).ok, true, 'another form is fine');
  assert.equal((await submitFor(env, appMember(env, U2), a)).ok, true, 'and another member');

  // whatever the code does, the index refuses a second pending row
  const row = { guildId: GID, formId: a, formName: 'A', userId: U, source: 'dm', questions: [], answers: {} };
  await assert.rejects(insertSubmission(row), (err) => isUniqueViolation(err));

  // after a decision the member may apply again
  await decideSubmission({ guild: env.guild, id: first.id, action: 'deny', actor: { dashboard: true } });
  assert.equal((await submitFor(env, member, a)).ok, true);
});

test('two submits at the same moment store one', async () => {
  const formId = await makeForm({ fillMode: 'discord' });
  const results = await Promise.all([
    submitFor(env, member, formId),
    submitFor(env, member, formId),
    submitFor(env, member, formId),
  ]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal((await listSubmissions({ guildId: GID, formId })).total, 1);
  assert.equal(env.channels.pending.log.sent.length, 1, 'posted once');
});

test('a submission whose post fails is not stored, so the answers can be sent again', async () => {
  const formId = await makeForm({ fillMode: 'discord' });
  env.channels.pending.send = async () => {
    throw new Error('boom');
  };
  const out = await submitFor(env, member, formId);
  assert.deepEqual([out.ok, out.reason], [false, 'post_failed']);
  assert.equal(await pendingSubmission(GID, formId, U), null);
  delete env.channels.pending.send;
});

// --- withdraw, leaving ----------------------------------------------------------------------------------------------------------

test('/apply withdraw takes a pending application back: status, post and the waiting role', async () => {
  const formId = await makeForm({ fillMode: 'discord', pendingRoleId: APP_ROLE.waiting });
  const out = await submitFor(env, member, formId);
  assert.ok(member.roles.cache.has(APP_ROLE.waiting));
  const cmd = commandAs(env, member, 'withdraw', {});
  await apply(cmd);
  assert.match(cmd.replies.at(-1).content, new RegExp(`application #${out.id} was withdrawn`));
  const sub = await getSubmission(GID, out.id);
  assert.equal(sub.status, 'withdrawn');
  assert.ok(!member.roles.cache.has(APP_ROLE.waiting));
  assert.deepEqual(
    env.channels.pending.store.get(sub.messageId).payload.components,
    [],
    'no buttons on a withdrawn application'
  );
  const again = commandAs(env, member, 'withdraw', {});
  await apply(again);
  assert.match(again.replies.at(-1).content, /no pending application/);
  assert.equal((await submitFor(env, member, formId)).ok, true, 'and they can apply again');
});

test('a member who leaves: the form says whether the pending application is kept or denied', async () => {
  const keep = await makeForm({
    name: 'Keep',
    fillMode: 'discord',
    onLeave: 'keep',
    pendingRoleId: APP_ROLE.waiting,
  });
  const deny = await makeForm({
    name: 'Deny',
    fillMode: 'discord',
    onLeave: 'deny',
    pendingRoleId: APP_ROLE.waiting,
  });
  const a = await submitFor(env, member, keep);
  const b = await submitFor(env, member, deny);
  const dmsBefore = dm.sent.length;
  const logBefore = member.roleLog.length;
  await dispatch('guildMemberRemove', GID, { id: U, user: { id: U } });
  assert.equal((await getSubmission(GID, a.id)).status, 'pending', 'kept');
  const denied = await getSubmission(GID, b.id);
  assert.equal(denied.status, 'denied');
  assert.equal(denied.reason, 'Left the server');
  assert.equal(denied.decidedBy, null);
  assert.equal(dm.sent.length, dmsBefore, 'nobody is messaged who left');
  assert.equal(member.roleLog.length, logBefore, 'no role change for someone who is gone');
  assert.deepEqual(env.channels.pending.store.get(denied.messageId).payload.components, []);
});

test('a member who leaves in the middle of the questions is not asked any more', async () => {
  await makeForm({ fillMode: 'discord' });
  await start();
  assert.equal(hasActiveQuestionnaire('discord', U), true);
  await dispatch('guildMemberRemove', GID, { id: U });
  assert.equal(hasActiveQuestionnaire('discord', U), false);
});

test('switching the module off ends the questions that are running', async () => {
  await makeForm({ fillMode: 'discord' });
  await start();
  assert.equal(cancelApplicationSessions(GID), true);
  assert.equal(hasActiveQuestionnaire('discord', U), false);
  assert.match(lastDm(), /stopped/);
});

// --- the panel ----------------------------------------------------------------------------------------------------------------

test('the panel has a button for each open form, a menu from the sixth, and republishing deletes the old one by id', async () => {
  const ids = [];
  for (let i = 1; i <= 3; i += 1) ids.push(await makeForm({ name: `Form ${i}`, fillMode: 'discord' }));
  await makeForm({ name: 'Closed', enabled: false });
  const first = await publishPanel(env.guild, { channelId: CH.panel, text: 'Apply!' }, {});
  assert.equal(first.ok, true);
  const sent = env.channels.panel.log.sent[0];
  assert.equal(sent.content, 'Apply!');
  assert.deepEqual(
    sent.components[0].toJSON().components.map((c) => c.custom_id),
    ids.map((id) => `appp:f:${id}`)
  );

  const { interaction, log } = pressAs(env, `appp:f:${ids[1]}`, member);
  await routeComponent(interaction);
  assert.equal(log.replies.at(-1).content, 'Check your DMs.');
  assert.match(dm.sent[0].content, /Applying for \*\*Form 2\*\*/);

  // more than five: a menu
  for (let i = 4; i <= 7; i += 1) ids.push(await makeForm({ name: `Form ${i}`, fillMode: 'discord' }));
  const second = await publishPanel(
    env.guild,
    { channelId: CH.panel, text: 'Apply!' },
    { panelChannelId: first.channelId, panelMessageId: first.messageId }
  );
  assert.equal(second.ok, true);
  assert.ok(!env.channels.panel.store.has(first.messageId), 'the old panel was deleted by its id');
  const menu = env.channels.panel.log.sent[1].components[0].toJSON().components[0];
  assert.equal(menu.custom_id, 'appp:select');
  assert.equal(menu.options.length, 7);
  _resetQuestionnaires();
  _resetApplications();
  const press = pressAs(env, 'appp:select', member, { values: [String(ids[4])] });
  await routeComponent(press.interaction);
  assert.equal(press.log.replies.at(-1).content, 'Check your DMs.');

  assert.deepEqual(
    await unpublishPanel(env.guild, { panelChannelId: second.channelId, panelMessageId: second.messageId }),
    { ok: true }
  );
  assert.ok(!env.channels.panel.store.has(second.messageId));
  assert.deepEqual(
    await unpublishPanel(env.guild, { panelChannelId: second.channelId, panelMessageId: second.messageId }),
    { ok: true },
    'already gone is fine'
  );
});

test('a panel with no open form is not published, and a press on a form that was closed says so', async () => {
  await makeForm({ enabled: false });
  assert.equal((await publishPanel(env.guild, { channelId: CH.panel }, {})).ok, false);
  const formId = await makeForm({ name: 'Later', fillMode: 'discord' });
  const sent = await publishPanel(env.guild, { channelId: CH.panel }, {});
  assert.equal(sent.ok, true);
  const row = await getForm(GID, formId);
  await updateForm(GID, formId, {
    name: row.name,
    enabled: false,
    fillMode: row.fillMode,
    config: row.config,
  });
  const { interaction, log } = pressAs(env, `appp:f:${formId}`, member);
  await routeComponent(interaction);
  assert.match(log.replies.at(-1).content, /not open/);
});
