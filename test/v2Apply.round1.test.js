// Fix round 1 of the review, for the web form: the pace of submitting, the limit on withdrawing, and withdrawing
// from a form that is closed. (Their own file: the dashboard's request limit per minute is nearly used up by
// v2Apply.test.js.)
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { D_GUILD, setProfiles, startOAuthApp } from './helpers/oauthApp.js';
import { session } from './helpers/v2Guarded.js';
import { fakeChannel } from './helpers/fakeIntro.js';

await startOAuthApp();

const { runtime } = await import('../src/runtime.js');
const { setGuildModule } = await import('../src/db/modules.js');
const { insertForm, getSubmission, listSubmissions, updateForm, getForm, deleteForm } =
  await import('../src/db/applications.js');
const { normaliseForm } = await import('../src/modules/lib/applicationsForm.js');
const { purgeGuild } = await import('../src/db/purge.js');
const { _resetApplications } = await import('../src/modules/applications.js');

const dGuild = runtime.clients.discord.guilds.cache.get(D_GUILD);
const PENDING_CH = '100000000000000701';
const ROLE_NEEDED = '700000000000000555';
const role = (id, name, position) => ({ id, name, position, color: 0, managed: false });
const channel = fakeChannel(PENDING_CH, 'applications');
dGuild.channels.cache.set(PENDING_CH, channel);
dGuild.roles.cache.set(ROLE_NEEDED, role(ROLE_NEEDED, 'Supporter', 3));
dGuild.members.me = {
  id: 'bot',
  permissions: { has: () => true },
  roles: { highest: { comparePositionTo: (r) => 50 - (r.position ?? 0) } },
};

let seq = 0;
let ME = '';
const channels = new Map([[dGuild, channel]]);

beforeEach(async () => {
  _resetApplications();
  await purgeGuild(D_GUILD);
  channel.store.clear();
  channel.log.sent.length = 0;
});

function memberOf(guild, id) {
  const cache = new Map();
  const member = {
    id,
    displayName: `User ${id.slice(-3)}`,
    user: {
      id,
      bot: false,
      username: `user${id.slice(-3)}`,
      createdTimestamp: Date.now() - 900 * 86_400_000,
    },
    joinedTimestamp: Date.now() - 400 * 86_400_000,
    roles: {
      cache,
      add: async (r) => cache.set(r, guild.roles.cache.get(r)),
      remove: async (r) => cache.delete(r),
    },
  };
  guild.members.cache.set(id, member);
  return member;
}

const QUESTIONS = [
  { id: 'q_text', type: 'text', label: 'Why?', required: true, long: true, minLength: 5, maxLength: 100 },
  { id: 'q_yes', type: 'yesno', label: 'Over 18?', required: true },
];
const GOOD = { q_text: 'I love trains', q_yes: 'yes' };

async function makeForm(key, over = {}) {
  const config = normaliseForm({
    name: 'Staff',
    enabled: true,
    fillMode: 'both',
    pendingChannelId: PENDING_CH,
    questions: QUESTIONS,
    ...over,
  });
  return insertForm({
    guildId: key,
    name: config.name,
    enabled: config.enabled,
    fillMode: config.fillMode,
    config,
  });
}
const enable = (key = D_GUILD, on = true) => setGuildModule(key, 'applications', { enabled: on, config: {} });
const path = (key, id) => `/apply/${encodeURIComponent(key)}/${id}`;

const sessions = new Map();
async function signedIn(group) {
  if (sessions.has(group)) {
    ME = sessions.get(group).id;
    return sessions.get(group).me;
  }
  ME = `30000000000002${String(++seq).padStart(4, '0')}`;
  setProfiles({ discordId: ME });
  const me = await session({ discordId: ME });
  sessions.set(group, { id: ME, me });
  return me;
}

// --- fix round 1 ------------------------------------------------------------------------------------------------------

test('the web form is held to the pace of starting in DM: submit, withdraw, submit again does not post and ping again', async () => {
  await enable();
  const me = await signedIn('C');
  memberOf(dGuild, ME);
  const formId = await makeForm(D_GUILD, { pingRoleIds: [ROLE_NEEDED] });
  const submit = async () => {
    const { form } = await (await me.get(path(D_GUILD, formId))).json();
    return me.post(`${path(D_GUILD, formId)}/submit`, { version: form.version, answers: GOOD });
  };
  _resetApplications();
  assert.equal((await submit()).status, 200);
  assert.equal((await me.post(`${path(D_GUILD, formId)}/withdraw`, {})).status, 200);
  const again = await submit();
  assert.equal(again.status, 400);
  const body = await again.json();
  assert.equal(body.reason, 'rate');
  assert.match(body.error, /wait \d+ seconds/i);
  assert.equal(channels.get(dGuild).log.sent.length, 1, 'no second post, so no second ping');
  assert.equal((await listSubmissions({ guildId: D_GUILD })).total, 1);
  _resetApplications(); // after the 30 seconds
  assert.equal((await submit()).status, 200);
  assert.equal(channels.get(dGuild).log.sent.length, 2);
});

test('withdrawing has its own limit per person and server', async () => {
  await enable();
  const me = await signedIn('D');
  memberOf(dGuild, ME);
  const formId = await makeForm(D_GUILD);
  const statuses = [];
  for (let i = 0; i < 8; i += 1)
    statuses.push((await me.post(`${path(D_GUILD, formId)}/withdraw`, {})).status);
  assert.deepEqual(
    statuses.slice(0, 6),
    [400, 400, 400, 400, 400, 400],
    'nothing to withdraw, but each try counts'
  );
  assert.equal(statuses[6], 429);
});

test('a member can always see and withdraw their own pending application: form closed, DM only, deleted, or the module off', async () => {
  await enable();
  const me = await signedIn('A');
  memberOf(dGuild, ME);
  for (const how of ['closed', 'discord', 'deleted', 'module']) {
    await purgeGuild(D_GUILD);
    await enable();
    _resetApplications();
    const formId = await makeForm(D_GUILD, { name: `Form ${how}` });
    const { form } = await (await me.get(path(D_GUILD, formId))).json();
    const sent = await (
      await me.post(`${path(D_GUILD, formId)}/submit`, { version: form.version, answers: GOOD })
    ).json();
    assert.equal((await getSubmission(D_GUILD, sent.id)).status, 'pending', how);
    const row = await getForm(D_GUILD, formId);
    if (how === 'closed')
      await updateForm(D_GUILD, formId, {
        name: row.name,
        enabled: false,
        fillMode: 'both',
        config: row.config,
      });
    if (how === 'discord')
      await updateForm(D_GUILD, formId, {
        name: row.name,
        enabled: true,
        fillMode: 'discord',
        config: row.config,
      });
    if (how === 'deleted') await deleteForm(D_GUILD, formId);
    if (how === 'module') await enable(D_GUILD, false);

    const page = await me.get(path(D_GUILD, formId));
    assert.equal(page.status, 200, `${how}: the page opens for the member who has a pending application`);
    const view = await page.json();
    assert.equal(view.pending.id, sent.id);
    assert.deepEqual(view.questions, [], `${how}: but there is nothing to fill in`);
    assert.ok(view.problem, how);
    const submit = await me.post(`${path(D_GUILD, formId)}/submit`, { version: form.version, answers: GOOD });
    assert.equal(submit.status, 404, `${how}: and still no way to submit`);
    const out = await me.post(`${path(D_GUILD, formId)}/withdraw`, {});
    assert.equal(out.status, 200, how);
    assert.equal((await getSubmission(D_GUILD, sent.id)).status, 'withdrawn', how);
  }
});
