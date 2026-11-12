// The pure half of Applications (modules/lib/applicationsForm.js): the limits on a form, reading and
// checking an answer (and that the DM questionnaire and the web form agree), the requirements, the
// texts, the post inside Discord's limits, and the export.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIMITS,
  MAX_OPTIONS,
  buildSubmissionEmbeds,
  canonicalise,
  checkRequirements,
  chunkText,
  csvCell,
  displayAnswer,
  dmQuestionOf,
  exportCsv,
  exportJson,
  fillTemplate,
  formSetupProblem,
  normaliseApplicationsConfig,
  normaliseForm,
  normaliseQuestions,
  rolesOfForm,
  validateAnswers,
} from '../src/modules/lib/applicationsForm.js';

const roleId = (i) => String(100000000000000000n + BigInt(i));
const DAY = 86_400_000;

const [text, pick, multi, team, yes] = normaliseQuestions([
  { id: 'q_text', type: 'text', label: 'Why?', required: true, long: true, minLength: 5, maxLength: 50 },
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
  {
    id: 'q_team',
    type: 'role',
    label: 'Team',
    grant: 'accept',
    options: [{ id: roleId(1) }, { id: roleId(2) }],
  },
  { id: 'q_yes', type: 'yesno', label: 'Over 18?', required: true },
]);

// --- limits ----------------------------------------------------------------------------------------------

test('a form keeps within its limits: 25 questions, 10 options, lengths, short and long text', () => {
  const form = normaliseForm({
    name: 'x'.repeat(100),
    description: 'd'.repeat(900),
    questions: Array.from({ length: 40 }, (_, i) => ({
      type: 'choice',
      label: `q${i}`.padEnd(150, 'x'),
      help: 'h'.repeat(500),
      options: Array.from({ length: 15 }, (_, j) => ({ label: `o${j}`.padEnd(120, 'x') })),
    })),
  });
  assert.equal(form.name.length, LIMITS.name.maxLength);
  assert.equal(form.description.length, LIMITS.description.maxLength);
  assert.equal(form.questions.length, LIMITS.questions.maxItems);
  const q = form.questions[0];
  assert.equal(q.label.length, LIMITS['questions[].label'].maxLength);
  assert.equal(q.help.length, LIMITS['questions[].help'].maxLength);
  assert.equal(q.options.length, MAX_OPTIONS);
  assert.equal(q.options[0].label.length, LIMITS['questions[].options[].label'].maxLength);
  assert.equal(new Set(form.questions.map((x) => x.id)).size, 25, 'every question has its own id');

  const short = normaliseQuestions([{ type: 'text', label: 's', maxLength: 99999 }])[0];
  const long = normaliseQuestions([{ type: 'text', label: 'l', long: true, maxLength: 99999 }])[0];
  assert.equal(short.maxLength, 1024, 'a short answer is at most 1024 characters');
  assert.equal(long.maxLength, 4000, 'a long one at most 4000');
  assert.equal(
    normaliseQuestions([{ type: 'text', label: 'z', minLength: 50, maxLength: 10 }])[0].maxLength,
    50
  );
});

test('question ids stay when they are valid and unique, and a type that does not exist is text', () => {
  const out = normaliseQuestions([
    { id: 'keep', label: 'a', type: 'nonsense' },
    { id: 'keep', label: 'b' },
    { label: '' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 'keep');
  assert.notEqual(out[1].id, 'keep');
  assert.equal(out[0].type, 'text');
});

test('role options are the roles themselves (snowflakes only), and choice counts follow the options', () => {
  const q = normaliseQuestions([
    {
      type: 'role',
      label: 'r',
      options: [{ id: 'not-a-role' }, { id: roleId(1) }, { id: roleId(1) }, { id: roleId(2) }],
    },
    {
      type: 'choice',
      label: 'c',
      multiple: true,
      minChoices: 9,
      maxChoices: 9,
      options: [{ label: 'a' }, { label: 'b' }],
    },
  ]);
  assert.deepEqual(
    q[0].options.map((o) => o.id),
    [roleId(1), roleId(2)]
  );
  assert.equal(q[1].maxChoices, 2);
  assert.equal(q[1].minChoices, 2);
});

test('a new form defaults to both ways, closed, with the four texts; the module keeps 180 days and at least 7', () => {
  const form = normaliseForm({ name: 'x' });
  assert.equal(form.fillMode, 'both');
  assert.equal(form.enabled, false);
  assert.ok(form.messages.accepted && form.messages.denied && form.messages.completed && form.messages.start);
  assert.equal(normaliseApplicationsConfig({}).retentionDays, 180);
  assert.equal(normaliseApplicationsConfig({ retentionDays: 1 }).retentionDays, 7);
  assert.equal(normaliseApplicationsConfig({ retentionDays: 99999 }).retentionDays, LIMITS.retentionDays.max);
  assert.equal(
    normaliseForm({ name: 'x', messages: { start: '' } }).messages.start,
    '',
    'an empty text sends nothing'
  );
});

test('a form needs questions and a channel for new applications before it can be open', () => {
  assert.match(formSetupProblem(normaliseForm({ name: 'x' })), /no questions/i);
  assert.match(formSetupProblem(normaliseForm({ name: 'x', questions: [{ label: 'q' }] })), /channel/i);
  assert.equal(
    formSetupProblem(normaliseForm({ name: 'x', questions: [{ label: 'q' }], pendingChannelId: roleId(9) })),
    null
  );
});

test('rolesOfForm lists every role a form may add or remove, including role questions that grant', () => {
  const form = normaliseForm({
    name: 'x',
    questions: [team, { ...pick }],
    pendingRoleId: roleId(10),
    removeOnSubmitRoleIds: [roleId(11)],
    acceptAddRoleIds: [roleId(12)],
    denyRemoveRoleIds: [roleId(13)],
  });
  assert.deepEqual(
    [...rolesOfForm(form)].sort(),
    [roleId(1), roleId(2), roleId(10), roleId(11), roleId(12), roleId(13)].sort()
  );
});

// --- answers: one code for DM and web ----------------------------------------------------------------------

test('text: cleaned, with a shortest and a longest answer', () => {
  assert.deepEqual(canonicalise(text, 'I like trains @everyone'), { ok: true, value: 'I like trains' });
  assert.match(canonicalise(text, 'abc').error, /at least 5/);
  assert.match(canonicalise(text, 'x'.repeat(51)).error, /limit is 50/);
  assert.deepEqual(canonicalise(text, '   '), { ok: true, value: '' });
  assert.equal(canonicalise(text, ['a']).ok, false);
});

test('choice, role and yes/no are stored the same way whatever the order they were given in', () => {
  assert.deepEqual(canonicalise(multi, ['c', 'a']), { ok: true, value: 'a,c' });
  assert.deepEqual(canonicalise(team, [roleId(2)]), { ok: true, value: roleId(2) });
  assert.match(canonicalise(pick, ['red', 'blue']).error, /only one/i);
  assert.match(canonicalise(multi, ['a', 'b', 'c']).error, /at most 2/);
  assert.match(canonicalise(pick, ['green']).error, /not one of the options/);
  assert.deepEqual(canonicalise(yes, 'Y'), { ok: true, value: 'yes' });
  assert.deepEqual(canonicalise(yes, false), { ok: true, value: 'no' });
  assert.equal(canonicalise(yes, 'maybe').ok, false);
  assert.equal(displayAnswer(multi, 'a,c'), 'Chess, Hiking');
  assert.equal(displayAnswer(yes, 'yes'), 'Yes');
});

test('the DM questionnaire and the web form read the same answer, and refuse the same ones', () => {
  const dm = (q) => dmQuestionOf(q);
  // numbers in DM are the same choice as ids on the web
  assert.equal(dm(multi).normalise('3, 1'), canonicalise(multi, ['c', 'a']).value);
  assert.equal(dm(pick).normalise('2'), canonicalise(pick, ['blue']).value);
  assert.equal(dm(yes).normalise('no'), canonicalise(yes, 'no').value);
  assert.equal(dm(text).normalise('because trains'), canonicalise(text, 'because trains').value);
  // and the refusals say the same thing
  assert.equal(dm(multi).normalise('1,2,3').error, canonicalise(multi, ['a', 'b', 'c']).error);
  assert.equal(dm(pick).normalise('1 2').error, canonicalise(pick, ['red', 'blue']).error);
  assert.equal(dm(text).normalise('abc').error, canonicalise(text, 'abc').error);
  assert.equal(dm(yes).normalise('maybe').error, canonicalise(yes, 'maybe').error);
  // numbers that are not an option, and words where numbers are expected
  assert.match(dm(pick).normalise('3').error, /no option 3/i);
  assert.match(dm(pick).normalise('0').error, /no option 0/i);
  assert.match(dm(pick).normalise('red').error, /numbers/i);
  // what is already stored passes the check, a stale value does not
  assert.equal(dm(multi).validate('a,c'), null);
  assert.match(dm(multi).validate('a,zzz'), /not one of the options/);
  assert.match(dm(pick).validate(''), /required/i);
});

test('the DM question lists the options as numbers and says how to answer', () => {
  const asked = dmQuestionOf(multi);
  assert.match(asked.prompt, /\*\*1\.\*\* Chess/);
  assert.match(asked.prompt, /\*\*3\.\*\* Hiking/);
  assert.match(asked.hint, /numbers.*1 to 2|1 to 2.*numbers/);
  assert.equal(asked.exact, true);
  assert.equal(dmQuestionOf(text).exact, false);
  assert.equal(dmQuestionOf(text).maxLength, 50);
});

test('a whole set of answers: required ones, extra keys ignored, every error by question', () => {
  const questions = [text, pick, multi, yes];
  const ok = validateAnswers(questions, {
    q_text: 'a good reason',
    q_pick: ['red'],
    q_multi: ['b'],
    q_yes: 'yes',
    extra: 'ignored',
  });
  assert.deepEqual(ok, {
    ok: true,
    answers: { q_text: 'a good reason', q_pick: 'red', q_multi: 'b', q_yes: 'yes' },
  });
  const bad = validateAnswers(questions, { q_text: 'abc', q_pick: [], q_multi: ['a', 'b', 'c'] });
  assert.equal(bad.ok, false);
  assert.deepEqual(Object.keys(bad.errors).sort(), ['q_multi', 'q_pick', 'q_text', 'q_yes']);
  assert.match(bad.errors.q_pick, /required/);
  // an optional question may stay empty
  assert.equal(validateAnswers([team], {}).ok, true);
});

// --- requirements -------------------------------------------------------------------------------------------

test('every requirement has a reason, in the order the member meets them', () => {
  const R1 = roleId(1);
  const R2 = roleId(2);
  const form = (over) => normaliseForm({ name: 'x', ...over });
  const facts = (over) => ({
    roleIds: [],
    accountCreatedAt: Date.now() - 400 * DAY,
    joinedAt: Date.now() - 400 * DAY,
    ...over,
  });
  const reason = (f, fa) => checkRequirements(f, fa)?.reason ?? null;

  assert.equal(reason(form({}), facts()), null);
  // required roles: all, or any
  assert.equal(reason(form({ requiredRoleIds: [R1, R2] }), facts({ roleIds: [R1] })), 'missing_roles');
  assert.equal(reason(form({ requiredRoleIds: [R1, R2] }), facts({ roleIds: [R1, R2] })), null);
  assert.equal(
    reason(form({ requiredRoleIds: [R1, R2], requiredRolesMode: 'any' }), facts({ roleIds: [R2] })),
    null
  );
  assert.equal(
    reason(form({ requiredRoleIds: [R1], requiredRolesMode: 'any' }), facts({ roleIds: [] })),
    'missing_roles'
  );
  // restricted roles: has any, or has all
  assert.equal(reason(form({ restrictedRoleIds: [R1, R2] }), facts({ roleIds: [R2] })), 'restricted_role');
  assert.equal(
    reason(form({ restrictedRoleIds: [R1, R2], restrictedRolesMode: 'all' }), facts({ roleIds: [R2] })),
    null
  );
  assert.equal(
    reason(form({ restrictedRoleIds: [R1, R2], restrictedRolesMode: 'all' }), facts({ roleIds: [R1, R2] })),
    'restricted_role'
  );
  // account age and time on the server
  assert.equal(
    reason(form({ minAccountDays: 30 }), facts({ accountCreatedAt: Date.now() - 5 * DAY })),
    'account_age'
  );
  assert.equal(reason(form({ minServerDays: 30 }), facts({ joinedAt: Date.now() - 5 * DAY })), 'server_time');
  assert.equal(reason(form({ minAccountDays: 30, minServerDays: 30 }), facts()), null);
  // a time the platform did not tell fails the check that needs it, never passes it
  assert.equal(reason(form({ minServerDays: 1 }), facts({ joinedAt: null })), 'server_time');
  assert.equal(reason(form({ minAccountDays: 1 }), facts({ accountCreatedAt: null })), 'account_age');
  // cooldown, then one pending
  assert.equal(reason(form({}), facts({ cooldownUntil: Date.now() + 3 * 3_600_000 })), 'cooldown');
  assert.equal(reason(form({}), facts({ cooldownUntil: Date.now() - 1 })), null);
  assert.equal(reason(form({}), facts({ pending: true })), 'pending');
  // each failure gives text a member can read
  assert.match(
    checkRequirements(form({ minAccountDays: 30 }), facts({ accountCreatedAt: Date.now() }))?.text,
    /30 days old/
  );
  assert.match(
    checkRequirements(form({}), facts({ cooldownUntil: Date.now() + 5 * 3_600_000 }))?.text,
    /5 hours/
  );
});

// --- texts ---------------------------------------------------------------------------------------------------------

test('placeholders are filled in one pass, so a value is never expanded again', () => {
  assert.equal(
    fillTemplate('Hi {user}, {form} in {server}: {reason}', {
      user: 'mira',
      server: 'HQ',
      form: '{reason}',
      reason: '{user}',
    }),
    'Hi mira, {reason} in HQ: {user}'
  );
  assert.equal(fillTemplate('Done. {reason}', { reason: '' }), 'Done.');
});

// --- the post ------------------------------------------------------------------------------------------------------

const sub = (over = {}) => ({
  id: 7,
  formName: 'Staff',
  userId: '700000000000000010',
  status: 'pending',
  source: 'dm',
  createdAt: 1_700_000_000_000,
  questions: [text, pick],
  answers: { q_text: 'hello', q_pick: 'red' },
  reason: '',
  decidedBy: null,
  dmNote: '',
  rolesPending: [],
  ...over,
});

const size = (embeds) =>
  embeds.reduce(
    (n, e) =>
      n +
      (e.title?.length ?? 0) +
      (e.description?.length ?? 0) +
      (e.footer?.text.length ?? 0) +
      e.fields.reduce((m, f) => m + f.name.length + f.value.length, 0),
    0
  );

test('the post shows the answers as fields and stays inside Discord limits, even with 25 long answers', () => {
  const small = buildSubmissionEmbeds({ submission: sub(), applicant: '<@1>' });
  assert.equal(small.length, 1);
  assert.deepEqual(
    small[0].fields.map((f) => [f.name, f.value]),
    [
      ['Why?', 'hello'],
      ['Colour', 'Red'],
    ]
  );

  const long = normaliseQuestions(
    Array.from({ length: 25 }, (_, i) => ({
      id: `l${i}`,
      type: 'text',
      label: `Question ${i}`.padEnd(100, '?'),
      long: true,
      maxLength: 4000,
    }))
  );
  const answers = Object.fromEntries(long.map((q, i) => [q.id, `${i}: ` + 'word '.repeat(800)]));
  const big = buildSubmissionEmbeds({
    submission: sub({
      questions: long,
      answers,
      reason: 'r'.repeat(600),
      rolesPending: [{ op: 'add', roleId: roleId(1) }],
    }),
    applicant: '<@1>',
    decidedBy: '<@2>',
    warning: 'w'.repeat(900),
  });
  assert.ok(big.length >= 1 && big.length <= 10, `embeds: ${big.length}`);
  assert.ok(size(big) <= 6000, `total ${size(big)} characters`);
  for (const e of big) {
    assert.ok(e.fields.length <= 25);
    for (const f of e.fields) {
      assert.ok(f.value.length <= 1024 && f.value.length > 0, 'a field value is 1 to 1024 characters');
      assert.ok(f.name.length <= 256 && f.name.length > 0);
    }
  }
  assert.match(big.at(-1).fields.at(-1)?.value ?? big.at(-1).footer.text, /dashboard/);
});

test('more than 25 fields go over a second embed', () => {
  const many = normaliseQuestions(
    Array.from({ length: 25 }, (_, i) => ({
      id: `m${i}`,
      type: 'text',
      label: `Q${i}`,
      long: true,
      maxLength: 4000,
    }))
  );
  const answers = Object.fromEntries(many.map((q, i) => [q.id, i === 24 ? 'y'.repeat(3000) : `a${i}`]));
  const embeds = buildSubmissionEmbeds({ submission: sub({ questions: many, answers }), applicant: '<@1>' });
  assert.equal(embeds.length, 2);
  assert.equal(embeds[0].fields.length, 25);
  assert.ok(embeds[1].fields.every((f) => f.name.startsWith('Q24')));
  assert.ok(size(embeds) <= 6000);
});

test('a long answer is split over several fields of one question, and nothing is lost', () => {
  const answer = ('line of text\n'.repeat(60) + 'x'.repeat(2500)).trim();
  const embeds = buildSubmissionEmbeds({
    submission: sub({ questions: [text], answers: { q_text: answer } }),
    applicant: '<@1>',
  });
  const fields = embeds.flatMap((e) => e.fields);
  assert.ok(fields.length >= 3);
  assert.equal(fields[0].name, 'Why?');
  assert.ok(fields.slice(1).every((f) => f.name === 'Why? (cont.)'));
  const joined = fields.map((f) => f.value).join('');
  assert.equal(joined.replace(/\s/g, ''), answer.replace(/\s/g, ''));
});

test('chunkText never makes a piece longer than allowed or cuts an emoji in half', () => {
  // an odd offset puts the cut between the two halves of an emoji unless it is moved
  const pieces = chunkText(`a${'😀'.repeat(1500)}`, 1024);
  assert.ok(pieces.every((p) => p.length <= 1024));
  assert.ok(pieces.every((p) => !/[\uD800-\uDBFF]$/.test(p) && !/^[\uDC00-\uDFFF]/.test(p)));
  assert.equal(pieces.join(''), `a${'😀'.repeat(1500)}`);
});

test('answers cannot make the post ping or format: they are escaped, and the header names who decided', () => {
  const embeds = buildSubmissionEmbeds({
    submission: sub({
      answers: { q_text: '**bold** @everyone <@&123> [x](http://e.com)', q_pick: 'red' },
      status: 'denied',
      reason: '@here no',
      decidedBy: '2',
    }),
    applicant: '<@1>',
    decidedBy: '<@2>',
  });
  const body = embeds[0].fields[0].value;
  assert.ok(body.includes('\\*\\*bold\\*\\*'));
  assert.ok(body.includes('\\<@&123\\>'));
  assert.match(embeds[0].description, /Denied by <@2>/);
});

// --- the export -------------------------------------------------------------------------------------------------------

test('the export holds the answers only, and a cell that would run as a formula is made text', () => {
  assert.equal(csvCell('=SUM(A1)'), "'=SUM(A1)");
  assert.equal(csvCell('+1'), "'+1");
  assert.equal(csvCell('@a'), "'@a");
  assert.equal(csvCell('a,"b"'), '"a,""b"""');
  const subs = [
    sub({ answers: { q_text: '=cmd()', q_pick: 'blue' }, reason: 'secret reason', decidedBy: '999' }),
  ];
  const csv = exportCsv(subs);
  assert.match(csv, /^Submission,Applicant,Status,Submitted,Why\?,Colour\r\n/);
  assert.ok(csv.includes("'=cmd()"));
  assert.ok(csv.includes('Blue'));
  const json = exportJson(subs);
  assert.ok(!json.includes('secret reason') && !json.includes('999'), 'no reviewer, no reason');
  assert.deepEqual(
    JSON.parse(json)[0].answers.map((a) => a.answer),
    ['=cmd()', 'Blue']
  );
});
