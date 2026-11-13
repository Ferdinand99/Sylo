// Introductions: the settings normaliser, the card, posting and editing it, keeping it current,
// removing it, and the rules about mentions and sizes.
import './helpers/tmpDb.js';
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_QUESTIONS,
  LIMITS,
  _resetIntroductions,
  buildIntroCard,
  cleanAnswer,
  cut,
  escapeMarkdown,
  introChannelMention,
  introRateLeft,
  normaliseIntroductionsConfig,
  postIntroduction,
  refreshIntroduction,
  removeIntroduction,
  scheduleRefresh,
  viewIntroduction,
} from '../src/modules/introductions.js';
import '../src/modules/welcome.js'; // registers the welcome handlers the {intro} tests dispatch to
import { dispatch } from '../src/modules/dispatch.js';
import { purgeGuild } from '../src/db/purge.js';
import { setGuildModule } from '../src/db/modules.js';
import { getIntroduction, saveIntroduction, answersOf } from '../src/db/introductions.js';
import { GID, INTRO_CH, ROLE, dropFakeClient, fakeIntroGuild, fakeMember } from './helpers/fakeIntro.js';

const U = '700000000000000010';
const NO_MENTIONS = { parse: [] };

let env;
beforeEach(async () => {
  _resetIntroductions();
  await purgeGuild(GID); // every test starts with no settings and no introductions
  env = fakeIntroGuild();
});
afterEach(() => dropFakeClient());

const enable = (config = {}) =>
  setGuildModule(GID, 'introductions', { enabled: true, config: { channelId: INTRO_CH, ...config } });

// --- settings ---------------------------------------------------------------------------------------

test('a fresh config gets the default questions and a safe shape', () => {
  const cfg = normaliseIntroductionsConfig({});
  assert.deepEqual(
    cfg.questions.map((q) => q.label),
    ['About me', 'Likes', 'Dislikes', 'Pronouns', 'DMs']
  );
  assert.equal(cfg.channelId, '');
  assert.deepEqual(cfg.roleGroups, []);
  assert.equal(cfg.deleteOnLeave, true, 'on by default');
  assert.equal(cfg.showRoles, false);
  assert.equal(cfg.colorMode, 'fixed');
  assert.deepEqual(normaliseIntroductionsConfig(undefined), cfg, 'no input is the same as {}');
});

test('questions that were all removed stay removed', () => {
  assert.deepEqual(normaliseIntroductionsConfig({ questions: [] }).questions, []);
});

test('questions are cleaned: labels cut, lengths clamped, ids kept or made, at most 8', () => {
  const cfg = normaliseIntroductionsConfig({
    questions: [
      {
        id: 'about',
        label: 'x'.repeat(100),
        prompt: 'p'.repeat(1000),
        maxLength: 5000,
        required: 'yes',
        inline: 1,
      },
      { id: 'about', label: 'duplicate id', maxLength: 0 },
      { label: '   ' },
      { label: 'No length', maxLength: 'abc' },
      { label: 'Bad id', id: 'has space' },
      ...Array.from({ length: 12 }, (_, i) => ({ label: `Q${i}` })),
    ],
  });
  assert.equal(cfg.questions.length, 8);
  const [first, dup, noLength, badId] = cfg.questions;
  assert.equal(first.id, 'about');
  assert.equal(first.label.length, 45);
  assert.equal(first.prompt.length, 300);
  assert.equal(first.maxLength, 1024, 'clamped down');
  assert.equal(first.required, false, 'only true counts');
  assert.equal(first.inline, false, 'only true counts');
  assert.equal(dup.maxLength, 1, 'clamped up');
  assert.notEqual(dup.id, 'about', 'a repeated id gets a new one');
  assert.equal(noLength.maxLength, 500, 'unreadable: the default');
  assert.match(badId.id, /^q[0-9a-f]{8}$/);
  assert.equal(new Set(cfg.questions.map((q) => q.id)).size, 8, 'every id is different');
});

test('role groups are cleaned: names without braces, no repeats, roles as ids, at most 10 groups', () => {
  const cfg = normaliseIntroductionsConfig({
    roleGroups: [
      {
        name: ' Country {} ',
        roleIds: [ROLE.norway, ROLE.norway, 'junk', ROLE.sweden],
        hideWhenEmpty: true,
      },
      { name: 'country', roleIds: [] },
      { name: '', roleIds: [ROLE.adult] },
      { name: 'Age', roleIds: 'not-a-list' },
      ...Array.from({ length: 14 }, (_, i) => ({ name: `G${i}` })),
    ],
  });
  assert.equal(cfg.roleGroups.length, 10);
  assert.deepEqual(cfg.roleGroups[0], {
    name: 'Country',
    roleIds: [ROLE.norway, ROLE.sweden],
    hideWhenEmpty: true,
  });
  assert.equal(cfg.roleGroups[1].name, 'Age');
  assert.deepEqual(cfg.roleGroups[1].roleIds, []);
  assert.equal(cfg.roleGroups[1].hideWhenEmpty, false);
});

test('the other settings are clamped: channel id, colour, texts, switches', () => {
  const cfg = normaliseIntroductionsConfig({
    channelId: 'nope',
    color: 'ABCDEF',
    colorMode: 'surprise',
    description: 'd'.repeat(5000),
    footer: 'f'.repeat(5000),
    promptText: 'p'.repeat(5000),
    deleteOnLeave: false,
    showRoles: 'true',
  });
  assert.equal(cfg.channelId, '');
  assert.equal(cfg.color, '#abcdef');
  assert.equal(cfg.colorMode, 'fixed');
  assert.equal(cfg.description.length, LIMITS.description.maxLength);
  assert.equal(cfg.footer.length, LIMITS.footer.maxLength);
  assert.equal(cfg.promptText.length, LIMITS.promptText.maxLength);
  assert.equal(cfg.deleteOnLeave, false);
  assert.equal(cfg.showRoles, false, 'only true counts');
  assert.equal(normaliseIntroductionsConfig({ color: 'red' }).color, '');
  assert.equal(normaliseIntroductionsConfig({ colorMode: 'role' }).colorMode, 'role');
  assert.equal(normaliseIntroductionsConfig({ channelId: INTRO_CH }).channelId, INTRO_CH);
});

test('the default questions are not shared between configs', () => {
  const a = normaliseIntroductionsConfig({});
  a.questions[0].label = 'changed';
  assert.equal(DEFAULT_QUESTIONS[0].label, 'About me');
  assert.equal(normaliseIntroductionsConfig({}).questions[0].label, 'About me');
});

// --- text rules ---------------------------------------------------------------------------------------

test('answers lose @everyone, @here and role mentions, but plain text stays', () => {
  assert.equal(cleanAnswer('hi @everyone and @HERE <@&123456789012345678> bye'), 'hi  and   bye');
  assert.equal(cleanAnswer('  plain text  '), 'plain text');
  const zeroWidthSpace = String.fromCodePoint(0x200b);
  const bell = String.fromCodePoint(0x07);
  const rightToLeftOverride = String.fromCodePoint(0x202e);
  const joiner = String.fromCodePoint(0x200d);
  assert.equal(cleanAnswer(`a${zeroWidthSpace}b${bell}c`), 'abc', 'zero-width and control characters go');
  assert.equal(cleanAnswer('line one\nline\ttwo'), 'line one\nline\ttwo', 'a line break and a tab stay');
  assert.equal(cleanAnswer(`a${rightToLeftOverride}b`), 'ab', 'a right-to-left override goes');
  const family = ['👨', '👩', '👧'].join(joiner);
  assert.equal(cleanAnswer(family), family, 'the joiner inside an emoji stays');
});

test('markdown that would change the embed is escaped', () => {
  assert.equal(
    escapeMarkdown('**bold** _it_ ~~x~~ `code` ||spoiler||'),
    '\\*\\*bold\\*\\* \\_it\\_ \\~\\~x\\~\\~ \\`code\\` \\|\\|spoiler\\|\\|'
  );
  assert.equal(escapeMarkdown('[click](https://evil.example)'), '\\[click\\](https://evil.example)');
  assert.equal(
    escapeMarkdown('<@123456789012345678> <#1> <t:1:R>'),
    '\\<@123456789012345678\\> \\<#1\\> \\<t:1:R\\>'
  );
  assert.equal(escapeMarkdown('# heading\n> quote\n- item'), '\\# heading\n\\> quote\n\\- item');
  assert.equal(escapeMarkdown('plain words, 100% fine.'), 'plain words, 100% fine.');
});

test('cut ends with an ellipsis and never splits an emoji or an escape', () => {
  assert.equal(cut('short', 10), 'short');
  assert.equal(cut('abcdefghij', 5), 'abcd…');
  assert.equal(cut('ab😀cd', 4), 'ab…', 'half of an emoji is dropped');
  assert.equal(cut('ab\\*cd', 4), 'ab…', 'a lone backslash is dropped');
  assert.equal(cut('ab\\\\cd', 5), 'ab\\\\…', 'an escaped backslash stays whole');
});

// --- the card -----------------------------------------------------------------------------------------

const baseCfg = (extra = {}) => normaliseIntroductionsConfig({ channelId: INTRO_CH, ...extra });
const card = (member, cfg, answers = {}) =>
  buildIntroCard({ guild: env.guild, member, cfg, answers, defaultColor: 0x7aa2f7 });
const fieldsOf = (payload) => payload.embeds[0].toJSON().fields ?? [];
const field = (payload, name) => fieldsOf(payload).find((f) => f.name === name);

test('the card has the avatar, the name and username, the answers in order and when they joined', () => {
  const member = fakeMember(env.guild, U, { username: 'mira' });
  member.displayName = 'Mira';
  const payload = card(member, baseCfg(), { about: 'I like trains', pronouns: 'she/her', likes: '' });
  const json = payload.embeds[0].toJSON();
  assert.equal(json.title, 'Mira (@mira)');
  assert.equal(json.thumbnail.url, `https://cdn.example/${U}.png`);
  assert.deepEqual(
    fieldsOf(payload).map((f) => f.name),
    ['About me', 'Pronouns', 'Member since'],
    'questions in order; an empty answer is left out'
  );
  assert.equal(field(payload, 'About me').inline, false);
  assert.equal(field(payload, 'Pronouns').inline, true, 'the inline flag of the question');
  assert.equal(field(payload, 'Member since').value, `<t:${Math.floor(1_700_000_000_000 / 1000)}:R>`);
  assert.deepEqual(payload.allowedMentions, NO_MENTIONS);
  assert.equal(json.color, 0x7aa2f7);
});

test('a name equal to the username is not repeated in the title', () => {
  const member = fakeMember(env.guild, U, { username: 'mira' });
  assert.equal(card(member, baseCfg()).embeds[0].toJSON().title, 'mira');
});

test('role groups show the roles of the member from that group, joined with a comma', () => {
  const member = fakeMember(env.guild, U, { roleIds: [ROLE.sweden, ROLE.norway, ROLE.gamer] });
  const cfg = baseCfg({
    roleGroups: [
      { name: 'Country', roleIds: [ROLE.norway, ROLE.sweden] },
      { name: 'Age', roleIds: [ROLE.adult] },
    ],
  });
  const payload = card(member, cfg);
  assert.equal(field(payload, 'Country').value, 'Norway, Sweden', 'highest role first');
  assert.equal(field(payload, 'Age').value, '—', 'none: a dash');
});

test('hideWhenEmpty leaves a group out when the member has none of its roles', () => {
  const member = fakeMember(env.guild, U, { roleIds: [ROLE.norway] });
  const cfg = baseCfg({
    roleGroups: [
      { name: 'Country', roleIds: [ROLE.norway] },
      { name: 'Age', roleIds: [ROLE.adult], hideWhenEmpty: true },
      { name: 'Region', roleIds: [ROLE.sweden], hideWhenEmpty: false },
    ],
  });
  const names = fieldsOf(card(member, cfg)).map((f) => f.name);
  assert.ok(names.includes('Country'));
  assert.ok(!names.includes('Age'));
  assert.ok(names.includes('Region'));
});

test('the Roles toggle lists the other roles: not @everyone, not managed, not in a group, top 10 by position', () => {
  const member = fakeMember(env.guild, U, {
    roleIds: [ROLE.norway, ROLE.gamer, ROLE.mod, ROLE.bot, ROLE.adult],
  });
  const cfg = baseCfg({ showRoles: true, roleGroups: [{ name: 'Country', roleIds: [ROLE.norway] }] });
  assert.equal(
    field(card(member, cfg), 'Roles').value,
    'Moderator, Gamer, 18+',
    'by position, group role left out'
  );
  assert.equal(field(card(member, baseCfg({ showRoles: false })), 'Roles'), undefined, 'off by default');

  // more than ten
  for (let i = 0; i < 14; i += 1) {
    const id = `100000000000009${String(i).padStart(3, '0')}`;
    env.guild.roles.cache.set(id, { id, name: `Extra${i}`, position: 20 + i, color: 0, managed: false });
    member.roles.cache.set(id, env.guild.roles.cache.get(id));
  }
  const names = field(card(member, cfg), 'Roles').value.split(', ');
  assert.equal(names.length, 10);
  assert.equal(names[0], 'Extra13', 'the highest first');
});

test('the description template fills {user}, {user.name}, {server} and {rolegroup:<name>}', () => {
  const member = fakeMember(env.guild, U, { username: 'mira', roleIds: [ROLE.norway] });
  const cfg = baseCfg({
    description:
      '{user} / {user.name} lives in {rolegroup:country} on {server}. {rolegroup:Missing}!{rolegroup:Age}',
    footer: 'Welcome to {server}',
    roleGroups: [
      { name: 'Country', roleIds: [ROLE.norway] },
      { name: 'Age', roleIds: [ROLE.adult] },
    ],
  });
  const json = card(member, cfg).embeds[0].toJSON();
  assert.equal(json.description, `<@${U}> / mira lives in Norway on Hedgerow HQ. !—`);
  assert.equal(json.footer.text, 'Welcome to Hedgerow HQ');
});

test('colour: the default, a fixed colour, or the top role colour', () => {
  const member = fakeMember(env.guild, U, { roleIds: [ROLE.gamer, ROLE.mod] });
  assert.equal(card(member, baseCfg()).embeds[0].toJSON().color, 0x7aa2f7);
  assert.equal(card(member, baseCfg({ color: '#112233' })).embeds[0].toJSON().color, 0x112233);
  assert.equal(
    card(member, baseCfg({ colorMode: 'role' })).embeds[0].toJSON().color,
    0xe74c3c,
    'highest coloured role'
  );
  const plain = fakeMember(env.guild, '700000000000000011', { roleIds: [ROLE.norway] });
  assert.equal(
    card(plain, baseCfg({ colorMode: 'role', color: '#112233' })).embeds[0].toJSON().color,
    0x112233,
    'no coloured role: the fixed colour'
  );
});

test('a member who answers with mentions and markdown cannot ping or format the card', () => {
  const member = fakeMember(env.guild, U);
  const payload = card(member, baseCfg(), {
    about: '@everyone **look** <@&123456789012345678> [x](https://evil.example) <@123456789012345678>',
  });
  const value = field(payload, 'About me').value;
  assert.ok(!/@everyone|@here|<@&/.test(value));
  assert.ok(value.includes('\\*\\*look\\*\\*'));
  assert.ok(value.includes('\\[x\\]'));
  assert.ok(value.includes('\\<@123456789012345678\\>'), 'a user mention is shown as text, not as a mention');
  assert.deepEqual(payload.allowedMentions, NO_MENTIONS);
});

test("the card stays under Discord's limits and long answers end with an ellipsis", () => {
  const member = fakeMember(env.guild, U, { roleIds: [ROLE.norway, ROLE.gamer] });
  const questions = Array.from({ length: 8 }, (_, i) => ({
    id: `q${i}`,
    label: `Question ${i}`,
    maxLength: 1024,
  }));
  const answers = Object.fromEntries(questions.map((q) => [q.id, '*'.repeat(1024)])); // escaped: 2048 each
  const cfg = baseCfg({
    questions,
    description: 'D'.repeat(1000),
    footer: 'F'.repeat(200),
    showRoles: true,
    roleGroups: [{ name: 'Country', roleIds: [ROLE.norway] }],
  });
  const json = card(member, cfg, answers).embeds[0].toJSON();
  const total =
    (json.title?.length ?? 0) +
    (json.description?.length ?? 0) +
    (json.footer?.text.length ?? 0) +
    json.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
  assert.ok(total <= 6000, `total ${total}`);
  assert.ok(json.fields.length <= 25);
  for (const f of json.fields) {
    assert.ok(f.value.length > 0 && f.value.length <= 1024);
    assert.ok(f.name.length > 0 && f.name.length <= 256);
  }
  assert.ok(json.description.length <= 4096);
  const answer = json.fields.find((f) => f.name === 'Question 0');
  assert.ok(answer.value.endsWith('…'), 'a long answer ends with an ellipsis');
  assert.ok(!answer.value.endsWith('\\…'), 'and does not end in half an escape');
  assert.ok(
    json.fields.some((f) => f.name === 'Country'),
    'the role groups survive'
  );
});

// --- posting and editing ------------------------------------------------------------------------------

test('posting a card sends it to the channel and stores the answers and the message', async () => {
  await enable();
  fakeMember(env.guild, U, { username: 'mira' });
  const result = await postIntroduction({
    guild: env.guild,
    userId: U,
    answers: { about: 'Hi', ghost: 'not a question' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.edited, false);
  assert.equal(env.channel.log.sent.length, 1);
  assert.deepEqual(env.channel.log.sent[0].allowedMentions, NO_MENTIONS);
  const row = await getIntroduction(GID, U);
  assert.equal(row.channel_id, INTRO_CH);
  assert.equal(row.message_id, result.messageId);
  assert.deepEqual(answersOf(row), { about: 'Hi' }, 'only the answers to current questions are kept');
});

test('posting again edits the card in place: same message, no new post', async () => {
  await enable();
  fakeMember(env.guild, U);
  const first = await postIntroduction({ guild: env.guild, userId: U, answers: { about: 'One' } });
  const second = await postIntroduction({ guild: env.guild, userId: U, answers: { about: 'Two' } });
  assert.equal(second.ok, true);
  assert.equal(second.edited, true);
  assert.equal(second.messageId, first.messageId);
  assert.equal(env.channel.log.sent.length, 1, 'nothing new was posted');
  assert.equal(env.channel.log.edits.length, 1);
  const edited = env.channel.store.get(first.messageId).payload.embeds[0].toJSON();
  assert.equal(edited.fields.find((f) => f.name === 'About me').value, 'Two');
  assert.deepEqual(answersOf(await getIntroduction(GID, U)), { about: 'Two' });
});

test('if the card message is gone, posting again posts a new one and stores its id', async () => {
  await enable();
  fakeMember(env.guild, U);
  const first = await postIntroduction({ guild: env.guild, userId: U, answers: { about: 'One' } });
  env.channel.store.delete(first.messageId); // deleted by staff, without our event
  const second = await postIntroduction({ guild: env.guild, userId: U, answers: { about: 'Two' } });
  assert.equal(second.ok, true);
  assert.equal(second.edited, false);
  assert.notEqual(second.messageId, first.messageId);
  assert.equal(env.channel.log.sent.length, 2);
  assert.equal((await getIntroduction(GID, U)).message_id, second.messageId);
});

test('there is one card per member per server', async () => {
  await enable();
  fakeMember(env.guild, U);
  fakeMember(env.guild, '700000000000000012');
  await postIntroduction({ guild: env.guild, userId: U, answers: {} });
  await postIntroduction({ guild: env.guild, userId: U, answers: {} });
  await postIntroduction({ guild: env.guild, userId: '700000000000000012', answers: {} });
  assert.equal(env.channel.log.sent.length, 2, 'one post per member');
});

test('posting fails with a clear reason when the channel is not set, gone, or not writable', async () => {
  fakeMember(env.guild, U);
  await setGuildModule(GID, 'introductions', { enabled: true, config: {} });
  assert.match((await postIntroduction({ guild: env.guild, userId: U, answers: {} })).error, /not set up/);

  await enable({ channelId: '100000000000009999' });
  assert.match(
    (await postIntroduction({ guild: env.guild, userId: U, answers: {} })).error,
    /no longer exists/
  );

  dropFakeClient();
  env = fakeIntroGuild({ canSend: false });
  fakeMember(env.guild, U);
  await enable();
  assert.match((await postIntroduction({ guild: env.guild, userId: U, answers: {} })).error, /cannot post/);
  assert.equal(await getIntroduction(GID, U), null, 'nothing was stored');

  assert.match(
    (await postIntroduction({ guild: env.guild, userId: '700000000000099999', answers: {} })).error,
    /could not find you/
  );
});

test('answers longer than the question allows are cut when stored', async () => {
  await enable({ questions: [{ id: 'about', label: 'About', maxLength: 5 }] });
  fakeMember(env.guild, U);
  await postIntroduction({ guild: env.guild, userId: U, answers: { about: '@everyone abcdefgh' } });
  assert.deepEqual(answersOf(await getIntroduction(GID, U)), { about: 'abcd…' });
});

test('view returns the card built from the stored answers, or null', async () => {
  await enable();
  fakeMember(env.guild, U);
  assert.equal(await viewIntroduction(env.guild, U), null);
  await postIntroduction({ guild: env.guild, userId: U, answers: { about: 'Hello' } });
  const viewed = await viewIntroduction(env.guild, U);
  assert.equal(viewed.embeds[0].toJSON().fields.find((f) => f.name === 'About me').value, 'Hello');
  assert.equal(await viewIntroduction(env.guild, '700000000000000099'), null);
});

// --- keeping it true ------------------------------------------------------------------------------------

test('a deleted card message is forgotten, the answers stay, and the next post is a new card', async () => {
  await enable();
  fakeMember(env.guild, U);
  const first = await postIntroduction({ guild: env.guild, userId: U, answers: { about: 'Keep me' } });
  await dispatch('messageDelete', GID, { id: first.messageId, channelId: INTRO_CH });
  const row = await getIntroduction(GID, U);
  assert.equal(row.message_id, null);
  assert.deepEqual(answersOf(row), { about: 'Keep me' });
  const again = await postIntroduction({ guild: env.guild, userId: U, answers: answersOf(row) });
  assert.equal(again.edited, false);
  assert.equal((await getIntroduction(GID, U)).message_id, again.messageId);
});

test('a bulk delete forgets the cards in it', async () => {
  await enable();
  fakeMember(env.guild, U);
  const first = await postIntroduction({ guild: env.guild, userId: U, answers: {} });
  await dispatch('messageDeleteBulk', GID, {
    messages: new Map([[first.messageId, {}]]),
    channel: env.channel,
  });
  assert.equal((await getIntroduction(GID, U)).message_id, null);
});

test('when a member leaves, their card and answers are deleted (the default)', async () => {
  await enable();
  const member = fakeMember(env.guild, U);
  const first = await postIntroduction({ guild: env.guild, userId: U, answers: { about: 'Bye' } });
  await dispatch('guildMemberRemove', GID, member);
  assert.equal(await getIntroduction(GID, U), null);
  assert.equal(env.channel.store.has(first.messageId), false, 'the message is gone');
});

test('with the leave switch off, the card stays', async () => {
  await enable({ deleteOnLeave: false });
  const member = fakeMember(env.guild, U);
  const first = await postIntroduction({ guild: env.guild, userId: U, answers: {} });
  await dispatch('guildMemberRemove', GID, member);
  assert.ok(await getIntroduction(GID, U));
  assert.equal(env.channel.store.has(first.messageId), true);
});

test('removing deletes the card message and the row; a second time there is nothing', async () => {
  await enable();
  fakeMember(env.guild, U);
  const first = await postIntroduction({ guild: env.guild, userId: U, answers: {} });
  assert.equal(await removeIntroduction(env.guild, U), 'removed');
  assert.equal(await getIntroduction(GID, U), null);
  assert.equal(env.channel.store.has(first.messageId), false);
  assert.equal(await removeIntroduction(env.guild, U), 'none');
});

test('a role change refreshes the card, once, about 30 seconds later', async (t) => {
  await enable({ roleGroups: [{ name: 'Country', roleIds: [ROLE.norway, ROLE.sweden] }] });
  const member = fakeMember(env.guild, U, { roleIds: [ROLE.norway] });
  const first = await postIntroduction({ guild: env.guild, userId: U, answers: { about: 'Hi' } });
  assert.equal(env.channel.log.edits.length, 0);

  t.mock.timers.enable({ apis: ['setTimeout'] });
  const before = { ...member, roles: { cache: new Map(member.roles.cache) }, partial: false };
  member.roles.cache.set(ROLE.sweden, env.guild.roles.cache.get(ROLE.sweden));
  // three updates in a row
  for (let i = 0; i < 3; i += 1) await dispatch('guildMemberUpdate', GID, { old: before, new: member });
  assert.equal(env.channel.log.edits.length, 0, 'not yet: debounced');
  t.mock.timers.tick(29_000);
  await new Promise((r) => setImmediate(r));
  assert.equal(env.channel.log.edits.length, 0, 'still not after 29 s');
  t.mock.timers.tick(1_500);
  for (let i = 0; i < 20 && env.channel.log.edits.length === 0; i += 1)
    await new Promise((r) => setImmediate(r));
  assert.equal(env.channel.log.edits.length, 1, 'one edit for the three updates');
  const country = env.channel.store
    .get(first.messageId)
    .payload.embeds[0].toJSON()
    .fields.find((f) => f.name === 'Country');
  assert.equal(country.value, 'Norway, Sweden');
});

test('an update that does not touch the roles is ignored when the old member is known', async (t) => {
  await enable();
  const member = fakeMember(env.guild, U);
  await postIntroduction({ guild: env.guild, userId: U, answers: {} });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const before = { ...member, roles: { cache: new Map(member.roles.cache) }, partial: false };
  await dispatch('guildMemberUpdate', GID, { old: before, new: member });
  t.mock.timers.tick(31_000);
  await new Promise((r) => setImmediate(r));
  assert.equal(env.channel.log.edits.length, 0);
});

test('a refresh that would change nothing edits nothing', async () => {
  await enable();
  fakeMember(env.guild, U);
  await postIntroduction({ guild: env.guild, userId: U, answers: { about: 'Same' } });
  await refreshIntroduction(GID, U);
  await refreshIntroduction(GID, U);
  assert.equal(env.channel.log.edits.length, 0, 'the card on screen is already right');
});

test('scheduleRefresh with a short delay refreshes a changed card', async () => {
  await enable({ roleGroups: [{ name: 'Country', roleIds: [ROLE.norway] }] });
  const member = fakeMember(env.guild, U);
  await postIntroduction({ guild: env.guild, userId: U, answers: {} });
  member.roles.cache.set(ROLE.norway, env.guild.roles.cache.get(ROLE.norway));
  scheduleRefresh(GID, U, 10);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(env.channel.log.edits.length, 1);
});

test('a member without a card is not refreshed', async () => {
  await enable();
  const member = fakeMember(env.guild, U);
  await dispatch('guildMemberUpdate', GID, { old: member, new: member });
  await refreshIntroduction(GID, U);
  assert.equal(env.channel.log.edits.length, 0);
});

test('nothing happens while the module is off', async () => {
  await setGuildModule(GID, 'introductions', { enabled: false, config: { channelId: INTRO_CH } });
  const member = fakeMember(env.guild, U);
  await saveIntroduction({ guildId: GID, userId: U, channelId: INTRO_CH, messageId: 'm1', answers: {} });
  await dispatch('guildMemberRemove', GID, member);
  assert.ok(await getIntroduction(GID, U), 'the leave handler did not run');
});

// --- the welcome module's {intro} --------------------------------------------------------------------------

test('{intro} is a mention of the introductions channel while the module is on and has a channel', async () => {
  assert.equal(await introChannelMention(GID), '', 'module off');
  await setGuildModule(GID, 'introductions', { enabled: true, config: {} });
  assert.equal(await introChannelMention(GID), '', 'on, but no channel');
  await enable();
  assert.equal(await introChannelMention(GID), `<#${INTRO_CH}>`);
  await setGuildModule(GID, 'introductions', { enabled: false });
  assert.equal(await introChannelMention(GID), '', 'off again');
});

test('the welcome message fills {intro}, and leaves it empty when Introductions is off', async () => {
  const member = fakeMember(env.guild, U, { username: 'mira' });
  member.user.tag = 'mira#0';
  member.guild = env.guild;
  env.guild.memberCount = 5;
  await setGuildModule(GID, 'welcome', {
    enabled: true,
    config: {
      joinEnabled: true,
      joinChannel: INTRO_CH,
      joinMessage: 'Hi {user}! Say hello in {intro}.',
      dmEnabled: true,
      dmMessage: 'Welcome. {intro}',
    },
  });
  const sent = [];
  env.channel.send = async (payload) => sent.push(payload) && { id: 'x' };
  member.send = async (payload) => sent.push({ dm: payload });

  await dispatch('guildMemberAdd', GID, member);
  assert.equal(sent[0].content, `Hi <@${U}>! Say hello in .`, 'module off: empty text');
  assert.equal(sent[1].dm.content, 'Welcome. ');

  await enable();
  sent.length = 0;
  // the first welcome is on record, so the member has to have left for another one
  await dispatch('guildMemberRemove', GID, member);
  await dispatch('guildMemberAdd', GID, member);
  assert.equal(sent[0].content, `Hi <@${U}>! Say hello in <#${INTRO_CH}>.`);
  assert.equal(sent[1].dm.content, `Welcome. <#${INTRO_CH}>`);
});

test('{intro} is one of the welcome placeholders the dashboard offers', async () => {
  const { WELCOME_PLACEHOLDERS } = await import('../src/modules/welcome.js');
  assert.ok(WELCOME_PLACEHOLDERS.includes('{intro}'));
});

// --- rate limit -------------------------------------------------------------------------------------------

test('/intro may be used once per 30 seconds per member', () => {
  const t0 = 1_000_000;
  assert.equal(introRateLeft('discord', 'rate-user', t0), 0);
  assert.equal(introRateLeft('discord', 'rate-user', t0 + 10_000), 20);
  assert.equal(introRateLeft('discord', 'rate-user', t0 + 29_999), 1);
  assert.equal(introRateLeft('discord', 'rate-user', t0 + 30_000), 0);
  assert.equal(introRateLeft('discord', 'other-user', t0 + 30_001), 0, 'per member');
  assert.equal(introRateLeft('fluxer', 'rate-user', t0 + 30_001), 0, 'per platform');
});
