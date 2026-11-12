// Applications on Fluxer, where buttons and menus become reactions (platform/components.js): the
// Accept and Deny buttons of a post, the panel (buttons, or a menu with at most 10 choices) and the choice
// between DM and web are all reachable as reactions that carry the same custom ids as on Discord.
import './helpers/tmpDb.js';
import './helpers/dashboardUrl.js';
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { planComponents } from '../src/platform/components.js';
import { purgeGuild } from '../src/db/purge.js';
import { _resetQuestionnaires } from '../src/bot/lib/dmQuestionnaire.js';
import { MAX_FORMS } from '../src/modules/lib/applicationsForm.js';
import {
  _resetApplications,
  beginApplication,
  hydrateForm,
  postPayload,
  publishPanel,
} from '../src/modules/applications.js';
import { getForm } from '../src/db/applications.js';
import { modulePlatformNote } from '../src/platform/modulePlatformNotes.js';
import { CH, GID, U, appMember, dmFor, dropFakeClient, fakeAppsGuild, runtime } from './helpers/fakeApps.js';
import { enableApplications, makeForm } from './helpers/appsSetup.js';

let env;
beforeEach(async () => {
  _resetQuestionnaires();
  _resetApplications();
  await purgeGuild(GID);
  env = fakeAppsGuild();
  await enableApplications();
});
afterEach(() => {
  dropFakeClient();
  runtime.clients.fluxer = null;
});

const pending = (id = 5) => ({
  id,
  userId: U,
  status: 'pending',
  formName: 'Staff',
  source: 'dm',
  createdAt: Date.now(),
  questions: [],
  answers: {},
  reason: '',
  dmNote: '',
  decidedBy: null,
  rolesPending: [],
});

test('Accept and Deny are the reactions ✅ and ❌ with the same custom ids as the buttons', () => {
  const plan = planComponents(postPayload(pending(5)).components);
  assert.deepEqual(
    plan.actions.map((a) => [a.emoji, a.customId, a.label]),
    [
      ['✅', 'apps:accept:5', 'Accept'],
      ['❌', 'apps:deny:5', 'Deny'],
    ]
  );
  assert.match(plan.text, /✅ Accept\n❌ Deny/);
  assert.deepEqual(
    planComponents(postPayload({ ...pending(5), status: 'accepted' }).components).actions,
    [],
    'nothing to press after a decision'
  );
});

test('the panel is reactions on Fluxer: a button for each form up to five, a menu of at most 10 above that', async () => {
  const ids = [];
  for (let i = 1; i <= 4; i += 1) ids.push(await makeForm({ name: `Form ${i}`, fillMode: 'discord' }));
  await publishPanel(env.guild, { channelId: CH.panel }, {});
  const few = planComponents(env.channels.panel.log.sent[0].components);
  assert.deepEqual(
    few.actions.map((a) => a.customId),
    ids.map((id) => `appp:f:${id}`)
  );
  assert.ok(
    few.actions.every((a) => a.emoji),
    'every choice has its own reaction'
  );
  assert.equal(new Set(few.actions.map((a) => a.emoji)).size, 4);

  for (let i = 5; i <= MAX_FORMS; i += 1)
    ids.push(await makeForm({ name: `Form ${i}`, fillMode: 'discord' }));
  assert.equal(ids.length, MAX_FORMS);
  await publishPanel(env.guild, { channelId: CH.panel }, {});
  const many = planComponents(env.channels.panel.log.sent[1].components);
  assert.equal(many.actions.length, 10, 'a form can be chosen by each of the ten reactions');
  assert.deepEqual(
    many.actions.map((a) => a.value),
    ids.map(String)
  );
  assert.ok(many.actions.every((a) => a.customId === 'appp:select'));
});

test('a form that takes both ways offers Answer in DMs as a reaction and the web address as a link', async () => {
  const formId = await makeForm({ fillMode: 'both' });
  const member = appMember(env, U, { username: 'mira' });
  dmFor(env, member);
  const form = hydrateForm(await getForm(GID, formId));
  const out = await beginApplication({ guild: env.guild, user: member.user, form });
  const plan = planComponents(out.components);
  assert.deepEqual(
    plan.actions.map((a) => [a.customId, a.label]),
    [[`apps:dm:${formId}`, 'Answer in DMs']]
  );
  assert.deepEqual(plan.links, [
    { label: 'Open on the web', url: `https://sylo.example.test/apply/${GID}/${formId}` },
  ]);
});

test('the Fluxer note names the chat commands, the numbered options and what is missing', () => {
  const note = modulePlatformNote('fluxer', 'applications');
  assert.match(note, /apply start <form>/);
  assert.match(note, /application deny <id> <reason>/);
  assert.match(note, /numbered options/);
  assert.match(note, /at most 10/);
  assert.match(note, /no threads|No staff thread/);
  assert.equal(modulePlatformNote('discord', 'applications'), null);
});
