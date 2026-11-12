// The web form of an application (/apply/<server>/<form>, /api/v2/apply/<server>/<form>): who may open it
// and who gets the one 404, what it shows, that submitting goes through the very same submitApplication()
// as the DM questionnaire (checks, answers, one pending, the post), CSRF, the rate limit, the fill modes,
// the address that sends you on, and Fluxer servers.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  D_GUILD,
  F_GUILD,
  browser,
  profiles,
  setProfiles,
  signIn,
  startOAuthApp,
} from './helpers/oauthApp.js';
import { anonymous, session } from './helpers/v2Guarded.js';
import { fakeChannel } from './helpers/fakeIntro.js';

await startOAuthApp();

const { runtime } = await import('../src/runtime.js');
const { setGuildModule } = await import('../src/db/modules.js');
const { insertForm, getSubmission, listSubmissions, pendingSubmission, updateForm, getForm } =
  await import('../src/db/applications.js');
const { normaliseForm, dmQuestionOf, normaliseQuestions } =
  await import('../src/modules/lib/applicationsForm.js');
const { purgeGuild } = await import('../src/db/purge.js');
const { decideSubmission } = await import('../src/modules/applications.js');

const dGuild = runtime.clients.discord.guilds.cache.get(D_GUILD);
const fGuild = runtime.clients.fluxer.guilds.cache.get(F_GUILD);
const FKEY = `fluxer:${F_GUILD}`;
const PENDING_CH = '100000000000000701';
const ROLE_NEEDED = '700000000000000555';
const ROLE_GIVEN = '700000000000000556';
// The signed-in Discord person of a test, a new one for each (the submit limit is per person), and their
// Fluxer identity.
let seq = 0;
const nextId = (prefix) => `${prefix}${String(++seq).padStart(4, '0')}`;
let ME = nextId('30000000000001');
let FME = nextId('40000000000001');

const role = (id, name, position) => ({ id, name, position, color: 0, managed: false });
const channels = new Map();
for (const g of [dGuild, fGuild]) {
  const channel = fakeChannel(PENDING_CH, 'applications');
  channels.set(g, channel);
  g.channels.cache.set(PENDING_CH, channel);
  g.roles.cache.set(ROLE_NEEDED, role(ROLE_NEEDED, 'Supporter', 3));
  g.roles.cache.set(ROLE_GIVEN, role(ROLE_GIVEN, 'Applicant', 4));
  g.members.me = {
    id: 'bot',
    permissions: { has: () => true },
    roles: { highest: { comparePositionTo: (r) => 50 - (r.position ?? 0) } },
  };
}

beforeEach(async () => {
  await purgeGuild(D_GUILD);
  await purgeGuild(FKEY);
  for (const channel of channels.values()) {
    channel.store.clear();
    channel.log.sent.length = 0;
  }
});

/** A member of a fake server whose role changes land in their role cache. */
function memberOf(guild, id, roleIds = []) {
  const cache = new Map(roleIds.map((r) => [r, guild.roles.cache.get(r)]));
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
  {
    id: 'q_pick',
    type: 'choice',
    label: 'Colour',
    required: true,
    options: [
      { id: 'red', label: 'Red' },
      { id: 'blue', label: 'Blue' },
    ],
  },
  {
    id: 'q_multi',
    type: 'choice',
    label: 'Hobbies',
    multiple: true,
    minChoices: 1,
    maxChoices: 2,
    options: [
      { id: 'a', label: 'Chess' },
      { id: 'b', label: 'Go' },
      { id: 'c', label: 'Hiking' },
    ],
  },
  { id: 'q_team', type: 'role', label: 'Team', grant: 'accept', options: [{ id: ROLE_GIVEN }] },
  { id: 'q_yes', type: 'yesno', label: 'Over 18?', required: true },
];
const GOOD = { q_text: 'I love trains', q_pick: ['red'], q_multi: ['a'], q_team: [], q_yes: 'yes' };

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
// A signed-in person. The login is throttled per minute, so the tests that only look share two of them (A, B),
// and the submit limit is per person, so B starts afresh for the tests that submit most.
const sessions = new Map();
async function signedIn(group = null) {
  if (group && sessions.has(group)) {
    ME = sessions.get(group).id;
    return sessions.get(group).me;
  }
  ME = nextId('30000000000001');
  setProfiles({ discordId: ME });
  const me = await session({ discordId: ME });
  if (group) sessions.set(group, { id: ME, me });
  return me;
}
const path = (key, id) => `/apply/${encodeURIComponent(key)}/${id}`;

// --- who may open it ------------------------------------------------------------------------------------------

test('a signed-out visitor never reaches the form, and a signed-in person who may not use it gets the one 404', async () => {
  await enable();
  const formId = await makeForm(D_GUILD);
  const out = await anonymous().get(path(D_GUILD, formId));
  assert.ok([401, 403].includes(out.status), `signed out: ${out.status}`);

  const me = await signedIn('A');
  const stranger = await me.get(path(D_GUILD, formId)); // not a member of the server
  assert.equal(stranger.status, 404);
  const body = await stranger.text();
  assert.deepEqual(JSON.parse(body), { error: 'Not found' });

  // a server Sylo does not know, a form that does not exist, and addresses that are nothing: the same answer
  for (const p of [
    path('900000000000099999', formId),
    path(D_GUILD, 999999),
    path('not-a-server', 1),
    path('fluxer:1', 1),
    path(D_GUILD, 'abc'),
  ]) {
    const res = await me.get(p);
    assert.equal(res.status, 404, p);
    assert.equal(await res.text(), body, `${p}: same body`);
  }
  assert.equal((await me.post(`${path(D_GUILD, formId)}/submit`, { answers: GOOD })).status, 404);
});

test('a member of a server whose module is off, a form that is off or a discord-only form gets the same 404', async () => {
  const me = await signedIn('A');
  memberOf(dGuild, ME);
  const formId = await makeForm(D_GUILD);
  const same = async () => {
    const res = await me.get(path(D_GUILD, formId));
    return [res.status, await res.text()];
  };
  const never = await same(); // never switched on
  await enable(D_GUILD, false);
  const off = await same();
  await enable();
  const row = await getForm(D_GUILD, formId);
  await updateForm(D_GUILD, formId, { name: row.name, enabled: false, fillMode: 'both', config: row.config });
  const closed = await same();
  await updateForm(D_GUILD, formId, {
    name: row.name,
    enabled: true,
    fillMode: 'discord',
    config: row.config,
  });
  const discordOnly = await same();
  for (const answer of [never, off, closed, discordOnly])
    assert.deepEqual(answer, [404, JSON.stringify({ error: 'Not found' })]);
  assert.equal(
    (await me.post(`${path(D_GUILD, formId)}/submit`, { answers: GOOD, version: 1 })).status,
    404,
    'and there is no way to submit it'
  );
  // web-only and both open it
  for (const fillMode of ['web', 'both']) {
    await updateForm(D_GUILD, formId, { name: row.name, enabled: true, fillMode, config: row.config });
    assert.equal((await me.get(path(D_GUILD, formId))).status, 200, fillMode);
  }
});

test('a member sees the form and its questions, never what a role question gives', async () => {
  await enable();
  const me = await signedIn('A');
  memberOf(dGuild, ME);
  const formId = await makeForm(D_GUILD, { description: 'Join the team' });
  const res = await me.get(path(D_GUILD, formId));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  const page = await res.json();
  assert.deepEqual(
    [page.form.name, page.form.description, page.problem, page.pending],
    ['Staff', 'Join the team', null, null]
  );
  assert.match(page.form.intro, /Applying for \*\*Staff\*\*/);
  assert.equal(page.questions.length, 5);
  assert.deepEqual(page.questions[1].options, [
    { id: 'red', label: 'Red' },
    { id: 'blue', label: 'Blue' },
  ]);
  assert.deepEqual(
    page.questions[3].options,
    [{ id: ROLE_GIVEN, label: 'Applicant' }],
    'role names come from the server'
  );
  assert.ok(!('grant' in page.questions[3]));
  assert.ok(page.form.version > 0);
});

test('a member who does not meet a requirement is told why, without the questions', async () => {
  await enable();
  const me = await signedIn('A');
  const m = memberOf(dGuild, ME);
  const formId = await makeForm(D_GUILD, { requiredRoleIds: [ROLE_NEEDED] });
  const page = await (await me.get(path(D_GUILD, formId))).json();
  assert.equal(page.problem.reason, 'missing_roles');
  assert.match(page.problem.text, /required roles/);
  assert.deepEqual(page.questions, []);
  const refused = await me.post(`${path(D_GUILD, formId)}/submit`, {
    answers: GOOD,
    version: page.form.version,
  });
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).reason, 'missing_roles');
  assert.equal((await listSubmissions({ guildId: D_GUILD })).total, 0);
  m.roles.cache.set(ROLE_NEEDED, dGuild.roles.cache.get(ROLE_NEEDED));
  assert.equal((await (await me.get(path(D_GUILD, formId))).json()).problem, null);
});

// --- submitting ----------------------------------------------------------------------------------------------------

test('submitting checks the answers on the server like the DM does, and stores nothing when they are wrong', async () => {
  await enable();
  const me = await signedIn('A');
  memberOf(dGuild, ME);
  const formId = await makeForm(D_GUILD);
  const { form } = await (await me.get(path(D_GUILD, formId))).json();
  const bad = await me.post(`${path(D_GUILD, formId)}/submit`, {
    version: form.version,
    answers: { q_text: 'abc', q_pick: ['green'], q_multi: ['a', 'b', 'c'], q_yes: 'maybe' },
  });
  assert.equal(bad.status, 400);
  const { errors, reason } = await bad.json();
  assert.equal(reason, 'invalid');
  assert.deepEqual(Object.keys(errors).sort(), ['q_multi', 'q_pick', 'q_text', 'q_yes']);
  // the very same messages the DM questionnaire gives for the same answers
  const [text, , multi, , yes] = normaliseQuestions(QUESTIONS);
  assert.equal(errors.q_text, dmQuestionOf(text).normalise('abc').error);
  assert.equal(errors.q_multi, dmQuestionOf(multi).normalise('1,2,3').error);
  assert.equal(errors.q_yes, dmQuestionOf(yes).normalise('maybe').error);
  assert.equal((await listSubmissions({ guildId: D_GUILD })).total, 0, 'nothing was stored');
  assert.equal(channels.get(dGuild).log.sent.length, 0, 'nothing was posted');
});

test('a good submission is stored as a web submission and posted for staff; a second one is refused', async () => {
  await enable();
  const me = await signedIn('A');
  memberOf(dGuild, ME);
  const formId = await makeForm(D_GUILD, { pendingRoleId: ROLE_NEEDED });
  const { form } = await (await me.get(path(D_GUILD, formId))).json();
  const ok = await me.post(`${path(D_GUILD, formId)}/submit`, { version: form.version, answers: GOOD });
  assert.equal(ok.status, 200);
  const out = await ok.json();
  assert.equal(out.ok, true);
  assert.equal(out.view.pending.id, out.id, 'the page now shows the waiting application');

  const sub = await getSubmission(D_GUILD, out.id);
  assert.equal(sub.source, 'web');
  assert.deepEqual(sub.answers, {
    q_text: 'I love trains',
    q_pick: 'red',
    q_multi: 'a',
    q_team: '',
    q_yes: 'yes',
  });
  assert.equal(sub.questions.length, 5);
  assert.equal(
    sub.dmNote,
    'completed',
    'the confirmation DM could not be sent (no DMs in this fake), and staff can see that'
  );
  const posted = channels.get(dGuild).log.sent;
  assert.equal(posted.length, 1);
  assert.deepEqual(
    posted[0].components[0].toJSON().components.map((c) => c.custom_id),
    [`apps:accept:${out.id}`, `apps:deny:${out.id}`]
  );
  assert.ok(dGuild.members.cache.get(ME).roles.cache.has(ROLE_NEEDED), 'the waiting role was given');

  const again = await me.post(`${path(D_GUILD, formId)}/submit`, { version: form.version, answers: GOOD });
  assert.equal(again.status, 400);
  assert.equal((await again.json()).reason, 'pending');
  assert.equal((await listSubmissions({ guildId: D_GUILD })).total, 1);
});

test('a form that was changed while it was open is refused with the new version, and nothing is lost', async () => {
  await enable();
  const me = await signedIn('B');
  memberOf(dGuild, ME);
  const formId = await makeForm(D_GUILD);
  const { form } = await (await me.get(path(D_GUILD, formId))).json();
  const row = await getForm(D_GUILD, formId);
  await updateForm(D_GUILD, formId, {
    name: 'Staff v2',
    enabled: true,
    fillMode: 'both',
    config: { ...row.config, name: 'Staff v2' },
  });
  const res = await me.post(`${path(D_GUILD, formId)}/submit`, { version: form.version, answers: GOOD });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.reason, 'form_changed');
  assert.equal(body.view.form.name, 'Staff v2');
  assert.ok(body.view.form.version > form.version);
  assert.equal((await listSubmissions({ guildId: D_GUILD })).total, 0);
  // with the new version it goes through; a request with no version never does
  assert.equal((await me.post(`${path(D_GUILD, formId)}/submit`, { answers: GOOD })).status, 409);
  assert.equal(
    (await me.post(`${path(D_GUILD, formId)}/submit`, { version: body.view.form.version, answers: GOOD }))
      .status,
    200
  );
});

test('the web form can be withdrawn, and the member can apply again after a decision', async () => {
  await enable();
  const me = await signedIn('B');
  memberOf(dGuild, ME);
  const formId = await makeForm(D_GUILD);
  const version = () =>
    me
      .get(path(D_GUILD, formId))
      .then((r) => r.json())
      .then((p) => p.form.version);
  const sent = await (
    await me.post(`${path(D_GUILD, formId)}/submit`, { version: await version(), answers: GOOD })
  ).json();
  const out = await me.post(`${path(D_GUILD, formId)}/withdraw`, {});
  assert.equal(out.status, 200);
  assert.equal((await out.json()).view.pending, null);
  assert.equal((await getSubmission(D_GUILD, sent.id)).status, 'withdrawn');
  assert.equal(
    (await me.post(`${path(D_GUILD, formId)}/withdraw`, {})).status,
    400,
    'nothing left to withdraw'
  );

  const second = await (
    await me.post(`${path(D_GUILD, formId)}/submit`, { version: await version(), answers: GOOD })
  ).json();
  await decideSubmission({ guild: dGuild, id: second.id, action: 'accept', actor: { dashboard: true } });
  assert.equal(
    (await me.post(`${path(D_GUILD, formId)}/submit`, { version: await version(), answers: GOOD })).status,
    200
  );
});

test('submitting needs the CSRF token, and a stranger cannot submit', async () => {
  await enable();
  ME = nextId('30000000000001');
  setProfiles({ discordId: ME });
  const b = browser();
  await signIn(b, 'discord');
  memberOf(dGuild, ME);
  const formId = await makeForm(D_GUILD);
  const headers = { accept: 'application/json', 'content-type': 'application/json' };
  const url = `/api/v2${path(D_GUILD, formId)}`;
  const version = (await (await b.get(url, { headers })).json()).form.version;
  const noToken = await b.get(`${url}/submit`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ answers: GOOD, version }),
  });
  assert.equal(noToken.status, 403);
  assert.equal((await listSubmissions({ guildId: D_GUILD })).total, 0);
  const token = (await (await b.get('/api/v2/csrf', { headers })).json()).token;
  const ok = await b.get(`${url}/submit`, {
    method: 'POST',
    headers: { ...headers, 'x-csrf-token': token },
    body: JSON.stringify({ answers: GOOD, version }),
  });
  assert.equal(ok.status, 200);
  const other = await session({ discordId: '300000000000000888' });
  assert.equal((await other.post(path(D_GUILD, formId) + '/submit', { answers: GOOD, version })).status, 404);
  assert.equal((await listSubmissions({ guildId: D_GUILD })).total, 1, 'only the member submitted');
});

test('submitting has its own rate limit per person and server', async () => {
  await enable();
  const me = await signedIn();
  memberOf(dGuild, ME);
  const formId = await makeForm(D_GUILD);
  const { form } = await (await me.get(path(D_GUILD, formId))).json();
  const statuses = [];
  for (let i = 0; i < 12; i += 1) {
    statuses.push(
      (await me.post(`${path(D_GUILD, formId)}/submit`, { version: form.version, answers: { q_text: 'x' } }))
        .status
    );
  }
  assert.equal(
    statuses.slice(0, 10).every((s) => s === 400),
    true
  );
  assert.equal(statuses[10], 429);
  assert.equal((await listSubmissions({ guildId: D_GUILD })).total, 0);
});

test('the address /apply/<server>/<form> sends a signed-in visitor on to the page, and a signed-out one to the login', async () => {
  const b = browser();
  const anon = await b.get(`/apply/${D_GUILD}/1`);
  assert.ok([301, 302, 303, 307].includes(anon.status));
  assert.match(anon.headers.get('location'), /login|auth/);
  setProfiles({ discordId: ME });
  await signIn(b, 'discord');
  const on = await b.get(`/apply/${D_GUILD}/7`, { headers: { accept: 'text/html' } });
  assert.equal(on.status, 302);
  assert.equal(on.headers.get('location'), `/v2/apply/${D_GUILD}/7`);
  const odd = await b.get('/apply/%2e%2e%2fadmin/1', { headers: { accept: 'text/html' } });
  assert.equal(odd.headers.get('location'), '/v2');
  const oddForm = await b.get(`/apply/${D_GUILD}/x`, { headers: { accept: 'text/html' } });
  assert.equal(oddForm.headers.get('location'), '/v2');
});

test('a Fluxer server works with the Fluxer login, and a Discord login is not looked up there', async () => {
  await enable(FKEY);
  const formId = await makeForm(FKEY);
  ME = nextId('30000000000001');
  FME = nextId('40000000000001');
  setProfiles({ discordId: ME, fluxerId: FME });
  const b = browser();
  await signIn(b, 'fluxer');
  const token = (await (await b.get('/api/v2/csrf', { headers: { accept: 'application/json' } })).json())
    .token;
  const headers = { accept: 'application/json', 'content-type': 'application/json', 'x-csrf-token': token };
  const url = `/api/v2${path(FKEY, formId)}`;

  assert.equal((await b.get(url, { headers })).status, 404, 'not a member yet');
  memberOf(fGuild, FME);
  const page = await (await b.get(url, { headers })).json();
  assert.equal(page.guild.id, FKEY);
  const sent = await b.get(`${url}/submit`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ answers: GOOD, version: page.form.version }),
  });
  assert.equal(sent.status, 200);
  assert.equal((await pendingSubmission(FKEY, formId, FME)).source, 'web');

  // a Discord-only person whose Discord id happens to be in the Fluxer member list is still refused
  memberOf(fGuild, ME);
  const discordOnly = await session({ discordId: ME });
  assert.equal((await discordOnly.get(path(FKEY, formId))).status, 404);
  assert.equal(profiles.discord.id, ME);
});
