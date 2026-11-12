// The Applications page of the dashboard: settings, forms (create, edit, limits, order, delete), the
// panel message, the submissions (filters, detail, decide, delete), a member's history and the export
// (answers only, staff only, logged), through /api/v2 with the stored rows and audit entries asserted. Who
// may call these routes is in v2.permissions*.test.js (helpers/v2Guarded.js lists them).
import { startWebApp } from './helpers/webApp.js';
import { v2Open, auditRows } from './helpers/v2Open.js';
import { GID, CH, ROLE, MEMBER_ID } from './helpers/fakeGuild.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getGuildModule, setGuildModule } from '../src/db/modules.js';
import {
  claimDecision,
  getSubmission,
  insertSubmission,
  listForms,
  setSubmissionPost,
} from '../src/db/applications.js';
import { normaliseQuestions } from '../src/modules/lib/applicationsForm.js';
import { MAX_FORMS } from '../src/modules/lib/applicationsForm.js';

let app;
let api;
let nextId = 800000000000000001n;
test.before(async () => {
  app = await startWebApp();
  api = v2Open(app, GID);
  await setGuildModule(GID, 'applications', { enabled: true, config: {} });
  // The channels send with ids shaped like a platform's (the panel's message id is stored as one).
  for (const channel of [app.guild.channels.cache.get(CH.general), app.guild.channels.cache.get(CH.bots)]) {
    channel.send = async (payload) => {
      app.sink.messages.push({ channel: channel.id, payload });
      return { id: String(nextId++), edit: async () => {}, delete: async () => {} };
    };
  }
});
test.after(() => app.close());

const json = async (res) => res.json();
const FORM = {
  name: 'Staff',
  description: 'Join the team',
  enabled: true,
  fillMode: 'both',
  pendingChannelId: CH.general,
  managerRoleIds: [ROLE.admin],
  questions: [
    { label: 'Why do you want to join?', type: 'text', required: true, long: true },
    { label: 'Pick one', type: 'choice', options: [{ label: 'Red' }, { label: 'Blue' }] },
  ],
};

async function makeForm(over = {}) {
  const res = await api.post('/applications/forms', { ...FORM, ...over });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  return (await json(res)).form;
}

async function makeSubmission(form, { userId = MEMBER_ID, status = 'pending', answers } = {}) {
  const questions = normaliseQuestions(form.config?.questions ?? form.questions);
  const id = await insertSubmission({
    guildId: GID,
    formId: form.id,
    formName: form.name,
    userId,
    source: 'web',
    questions,
    answers: answers ?? {
      [questions[0].id]: 'because of =trains',
      [questions[1].id]: questions[1].options[0].id,
    },
  });
  await setSubmissionPost(GID, id, CH.general, `msg-${id}`);
  if (status !== 'pending') {
    await claimDecision(GID, id, { status, by: null, reason: '', history: [] });
  }
  return id;
}

test('GET config: no forms yet, the limits and lists the page needs', async () => {
  const res = await api.get('/modules/applications/config');
  assert.equal(res.status, 200);
  const data = await json(res);
  assert.deepEqual(data.forms, []);
  assert.equal(data.maxForms, MAX_FORMS);
  assert.equal(data.shortTextMax, 1024);
  assert.equal(data.config.retentionDays, 180);
  assert.ok(data.channels.some((c) => c.id === CH.general));
  assert.ok(data.roles.some((r) => r.id === ROLE.member));
  assert.deepEqual(data.placeholders, ['{user}', '{server}', '{form}', '{reason}']);
  assert.ok(data.defaultMessages.accepted);
});

test('creating a form: a name is required, an open form needs questions and a channel, then it is stored', async () => {
  assert.equal((await api.post('/applications/forms', { ...FORM, name: '  ' })).status, 400);
  const noQuestions = await api.post('/applications/forms', { ...FORM, questions: [] });
  assert.equal(noQuestions.status, 400);
  assert.match((await json(noQuestions)).error, /no questions/);
  const noChannel = await api.post('/applications/forms', { ...FORM, pendingChannelId: '' });
  assert.match((await json(noChannel)).error, /channel/);
  assert.equal((await listForms(GID)).length, 0, 'nothing was stored by the refused ones');

  const form = await makeForm();
  assert.equal(form.name, 'Staff');
  assert.equal(form.fillMode, 'both');
  assert.equal(form.questions.length, 2);
  assert.ok(
    form.questions.every((q) => q.id),
    'every question got an id'
  );
  assert.ok(form.version > 0);
  assert.equal(form.problems.setup, null);
  assert.equal((await listForms(GID)).length, 1);
  assert.equal(
    (await auditRows(GID, 'module:applications')).some((r) => /created the form Staff/.test(r.detail)),
    true
  );
  // a closed draft may be saved incomplete
  const draft = await api.post('/applications/forms', { name: 'Draft', enabled: false });
  assert.equal(draft.status, 200);
  assert.equal((await json(draft)).form.problems.setup, 'The form has no questions.');
});

test('editing a form keeps the question ids, moves the version, and a new fill mode is stored', async () => {
  const form = await makeForm({ name: 'Edit me' });
  const res = await api.post(`/applications/forms/${form.id}`, {
    ...form,
    fillMode: 'web',
    questions: [form.questions[1], form.questions[0]], // reordered
  });
  assert.equal(res.status, 200);
  const next = (await json(res)).form;
  assert.equal(next.fillMode, 'web');
  assert.deepEqual(
    next.questions.map((q) => q.id),
    [form.questions[1].id, form.questions[0].id]
  );
  assert.ok(next.version > form.version, 'a save changes the version, so an open web form is told');
  assert.equal((await api.post('/applications/forms/99999', FORM)).status, 404);
});

test('a server has at most 10 forms; one can be deleted and another made', async () => {
  const have = (await listForms(GID)).length;
  for (let i = have; i < MAX_FORMS; i += 1) await makeForm({ name: `Form ${i}` });
  const over = await api.post('/applications/forms', FORM);
  assert.equal(over.status, 400);
  assert.match((await json(over)).error, /at most 10 forms/);
  const [first] = await listForms(GID);
  const del = await api.post(`/applications/forms/${first.id}/delete`, {});
  assert.equal(del.status, 200);
  assert.equal((await listForms(GID)).length, MAX_FORMS - 1);
  assert.equal((await api.post(`/applications/forms/${first.id}/delete`, {})).status, 404);
  await makeForm({ name: 'One more' });
});

test('forms can be put in an order', async () => {
  const forms = await listForms(GID);
  const ids = forms.map((f) => f.id).reverse();
  const res = await api.post('/applications/forms/reorder', { ids });
  assert.equal(res.status, 200);
  assert.deepEqual(
    (await listForms(GID)).map((f) => f.id),
    ids
  );
});

test('saving the module settings keeps the panel ids server-side and limits the retention to at least 7 days', async () => {
  await setGuildModule(GID, 'applications', {
    config: { panelChannelId: CH.general, panelMessageId: '123456789012345678', retentionDays: 90 },
  });
  const res = await api.post('/modules/applications/config', {
    retentionDays: 2,
    panelText: 'Apply!',
    panelMessageId: '999999999999999999',
  });
  assert.equal(res.status, 200);
  const { config } = await json(res);
  assert.equal(config.retentionDays, 7);
  assert.equal(config.panelText, 'Apply!');
  assert.equal(
    config.panelMessageId,
    '123456789012345678',
    'the form cannot choose which message is the panel'
  );
  await setGuildModule(GID, 'applications', { config: {} });
});

test('the panel: published to a channel, republished (old deleted by id), removed', async () => {
  const first = await api.post('/applications/panel/publish', { channelId: CH.general, text: 'Apply here' });
  assert.equal(first.status, 200);
  const a = (await json(first)).config;
  assert.equal(a.panelChannelId, CH.general);
  assert.ok(a.panelMessageId);
  const sent = app.sink.messages.filter((m) => m.channel === CH.general).at(-1).payload;
  assert.equal(sent.content, 'Apply here');
  assert.ok(sent.components.length > 0);
  const again = await api.post('/applications/panel/publish', { channelId: CH.bots });
  assert.equal(again.status, 200);
  const b = (await json(again)).config;
  assert.equal(b.panelChannelId, CH.bots);
  assert.notEqual(b.panelMessageId, a.panelMessageId);
  const off = await api.post('/applications/panel/unpublish', {});
  assert.equal(off.status, 200);
  assert.equal((await json(off)).config.panelMessageId, '');
  assert.equal((await getGuildModule(GID, 'applications')).config.panelMessageId, '');
  assert.equal(
    (await api.post('/applications/panel/publish', { channelId: '' })).status,
    400,
    'a channel is needed'
  );
});

// --- submissions ------------------------------------------------------------------------------------------

test('the list filters by form, status and member; the detail has the answers, history and source', async () => {
  const [formA, formB] = (await listForms(GID)).slice(0, 2);
  const a = await makeSubmission(formA);
  const b = await makeSubmission(formB, { userId: '900000000000000055', status: 'denied' });
  const all = await json(await api.get('/applications/submissions'));
  assert.ok(all.total >= 2);
  assert.equal(all.pageSize, 25);
  const byForm = await json(await api.get(`/applications/submissions?formId=${formB.id}`));
  assert.deepEqual(
    byForm.submissions.map((s) => s.id),
    [b]
  );
  const byStatus = await json(await api.get('/applications/submissions?status=pending'));
  assert.ok(byStatus.submissions.every((s) => s.status === 'pending'));
  assert.ok(byStatus.submissions.some((s) => s.id === a));
  const byUser = await json(await api.get(`/applications/submissions?userId=900000000000000055`));
  assert.deepEqual(
    byUser.submissions.map((s) => s.id),
    [b]
  );

  const detail = await json(await api.get(`/applications/submissions/${a}`));
  const s = detail.submission;
  assert.equal(s.source, 'web');
  assert.deepEqual(
    s.answers.map((x) => [x.label, x.answer]),
    [
      ['Why do you want to join?', 'because of =trains'],
      ['Pick one', 'Red'],
    ]
  );
  assert.equal(s.history[0].action, 'submitted');
  assert.equal((await api.get('/applications/submissions/99999')).status, 404);
  // the page of a member lists all of theirs
  const history = await json(await api.get(`/applications/members/${MEMBER_ID}`));
  assert.ok(history.submissions.some((x) => x.id === a));
  assert.equal((await api.get('/applications/members/not-an-id')).status, 400);
});

test('accept or deny from the dashboard with a reason; the post and the applicant follow, a second try is refused', async () => {
  const [form] = await listForms(GID);
  const id = await makeSubmission(form, { userId: '900000000000000088' });
  app.sink.dms.length = 0;
  const res = await api.post(`/applications/submissions/${id}/decide`, {
    action: 'deny',
    reason: 'Not this time',
  });
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.submission.status, 'denied');
  assert.equal(body.submission.reason, 'Not this time');
  assert.equal((await getSubmission(GID, id)).status, 'denied');
  assert.match(app.sink.dms.at(-1).payload.content, /Not this time/);
  assert.equal(
    (await auditRows(GID, 'module:applications')).some((r) => r.detail === `denied application #${id}`),
    true
  );
  const second = await api.post(`/applications/submissions/${id}/decide`, { action: 'accept' });
  assert.equal(second.status, 409);
});

test('retrying roles when none are waiting is fine, and deleting removes the row and its post', async () => {
  const [form] = await listForms(GID);
  const id = await makeSubmission(form, { userId: '900000000000000066' });
  const retry = await api.post(`/applications/submissions/${id}/retry-roles`, {});
  assert.equal(retry.status, 200);
  assert.equal((await json(retry)).remaining, 0);
  const del = await api.post(`/applications/submissions/${id}/delete`, {});
  assert.equal(del.status, 200);
  assert.equal(await getSubmission(GID, id), null);
});

// --- export -------------------------------------------------------------------------------------------------

test('the export is the answers only, as CSV or JSON, a formula cell is made text, and every download is logged', async () => {
  const [form] = await listForms(GID);
  const questions = normaliseQuestions(form.config.questions);
  const id = await makeSubmission(form, {
    userId: '900000000000000077',
    answers: { [questions[0].id]: '=HYPERLINK("x")', [questions[1].id]: questions[1].options[1].id },
  });
  const csv = await api.get(`/applications/export?formId=${form.id}&format=csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /attachment; filename="applications-form-\d+\.csv"/);
  assert.equal(csv.headers.get('cache-control'), 'private, no-store');
  const body = await csv.text();
  assert.match(body, /Submission,Applicant,Status,Submitted,Why do you want to join\?,Pick one/);
  assert.ok(body.includes("'=HYPERLINK("), 'a cell that would run as a formula is made text');
  assert.ok(!body.includes(',=HYPERLINK') && !body.includes('"=HYPERLINK'), 'and is never left as a formula');
  assert.ok(!body.includes('Not this time'), 'no reasons or reviewers');

  const asJson = await json(
    await api.get(`/applications/export?formId=${form.id}&format=json&status=pending`)
  );
  assert.ok(asJson.some((r) => r.submission === id));
  assert.ok(asJson.every((r) => r.status === 'pending'));

  const log = await auditRows(GID, 'applications:export');
  assert.equal(log.length, 2);
  assert.match(log[1].detail, new RegExp(`form #${form.id}.*CSV`));
  assert.ok(
    log.every((r) => !r.detail.includes('trains')),
    'the answers are never in the log'
  );
  assert.equal((await api.get('/applications/export?formId=99999&format=csv')).status, 404);
});
