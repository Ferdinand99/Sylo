// Suggestions, the pure parts: the settings normaliser and LIMITS, the text rules, who counts as
// staff, and what the posted embed looks like in each state (including anonymous mode).
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { MODULE_LIMITS } from '../src/modules/limits.js';
import { LIMITS as CEILINGS } from '../src/lib/limits.js';
import {
  ACTIONS,
  LIMITS,
  buildSuggestionPayload,
  canManageSuggestions,
  isFinalStatus,
  normaliseReason,
  normaliseSuggestionFields,
  normaliseSuggestionsConfig,
  parseSuggestionInput,
} from '../src/modules/suggestions.js';

const CH = '100000000000000001';
const ROLE = '100000000000000700';

test('LIMITS are served to the dashboard and match the brief', () => {
  assert.equal(MODULE_LIMITS.suggestions, LIMITS);
  assert.equal(LIMITS.title.maxLength, 100);
  assert.equal(LIMITS.text.maxLength, 1000);
  assert.equal(LIMITS.reason.maxLength, 500);
  assert.deepEqual(LIMITS.cooldownSeconds, { min: 0, max: 3600 });
  assert.equal(CEILINGS.suggestions, 5000);
  assert.equal(CEILINGS.openSuggestionsPerMember, 10);
});

test('the settings default to: DM the author on, anonymous off, message option off, 60 s cooldown', () => {
  assert.deepEqual(normaliseSuggestionsConfig({}), {
    channel: '',
    logChannel: '',
    anonymous: false,
    dmAuthor: true,
    messagesToSuggestions: false,
    cooldownSeconds: 60,
    staffRoles: [],
  });
  assert.deepEqual(normaliseSuggestionsConfig(undefined), normaliseSuggestionsConfig({}));
});

test('the settings keep valid values and drop junk', () => {
  const cfg = normaliseSuggestionsConfig({
    channel: CH,
    logChannel: 'not-an-id',
    anonymous: 1,
    dmAuthor: false,
    messagesToSuggestions: true,
    cooldownSeconds: '90',
    staffRoles: [ROLE, 'junk', ROLE],
  });
  assert.deepEqual(cfg, {
    channel: CH,
    logChannel: '',
    anonymous: true,
    dmAuthor: false,
    messagesToSuggestions: true,
    cooldownSeconds: 90,
    staffRoles: [ROLE],
  });
});

test('the cooldown is clamped to 0..3600, 0 means off, unreadable falls back to 60', () => {
  const cd = (v) => normaliseSuggestionsConfig({ cooldownSeconds: v }).cooldownSeconds;
  assert.equal(cd(0), 0);
  assert.equal(cd(-5), 0);
  assert.equal(cd(3600), 3600);
  assert.equal(cd(3601), 3600);
  assert.equal(cd(12.9), 12);
  assert.equal(cd('abc'), 60);
  assert.equal(cd(undefined), 60);
});

test('text, title and reason are trimmed and cut at the limits', () => {
  const f = normaliseSuggestionFields({ title: `  ${'t'.repeat(101)}  `, text: ` ${'x'.repeat(1001)} ` });
  assert.equal(f.title.length, 100);
  assert.equal(f.text.length, 1000);
  assert.equal(normaliseSuggestionFields({ text: 'x'.repeat(1000) }).text.length, 1000);
  assert.equal(normaliseReason('r'.repeat(501)).length, 500);
  assert.equal(normaliseReason('r'.repeat(500)).length, 500);
  assert.equal(normaliseReason(null), '');
});

test('a suggestion needs some text; the title is optional', () => {
  assert.equal(parseSuggestionInput({ text: '   ' }).ok, false);
  assert.match(parseSuggestionInput({}).error, /Write what you suggest/);
  const ok = parseSuggestionInput({ text: ' More emoji ' });
  assert.deepEqual(ok, { ok: true, value: { title: '', text: 'More emoji' } });
});

test('the four staff actions map to statuses, and only three of them are final', () => {
  assert.deepEqual(ACTIONS, {
    approve: 'approved',
    deny: 'denied',
    implement: 'implemented',
    consider: 'considering',
  });
  assert.deepEqual(['open', 'considering', 'approved', 'denied', 'implemented'].map(isFinalStatus), [
    false,
    false,
    true,
    true,
    true,
  ]);
});

test('staff: Manage Server, Administrator or a staff role; Manage Events does not count', () => {
  const perms = (...names) => ({ has: (p) => names.includes(p) });
  const member = (...roles) => ({ roles: { cache: new Map(roles.map((r) => [r, {}])) } });
  const cfg = { staffRoles: [ROLE] };
  assert.equal(canManageSuggestions(member(), perms('ManageGuild'), cfg), true);
  assert.equal(canManageSuggestions(member(), perms('Administrator'), cfg), true);
  assert.equal(canManageSuggestions(member(ROLE), perms(), cfg), true);
  assert.equal(canManageSuggestions(member(), perms('ManageEvents'), cfg), false);
  assert.equal(canManageSuggestions(member(), perms('ManageMessages'), cfg), false);
  assert.equal(canManageSuggestions(member('other'), perms(), cfg), false);
  assert.equal(canManageSuggestions(null, perms(), {}), false);
  // a permission name the platform does not know does not throw
  assert.equal(
    canManageSuggestions(
      member(),
      {
        has: () => {
          throw new RangeError('bad flag');
        },
      },
      cfg
    ),
    false
  );
});

const row = (over = {}) => ({
  id: 7,
  guild_id: '1',
  number: 12,
  channel_id: CH,
  author_id: '555555555555555555',
  anonymous: false,
  title: '',
  body: 'Add a movie night',
  status: 'open',
  reason: '',
  decided_by: null,
  created_at: Date.UTC(2030, 0, 1),
  ...over,
});
const fieldsOf = (payload) =>
  Object.fromEntries(payload.embeds[0].toJSON().fields.map((f) => [f.name, f.value]));

test('an open suggestion shows the number, text, author, status and two buttons with live counts', () => {
  const p = buildSuggestionPayload(row({ title: 'Movies' }), { up: 3, down: 1 });
  const json = p.embeds[0].toJSON();
  assert.equal(json.title, '💡 Suggestion #12: Movies');
  assert.equal(json.description, 'Add a movie night');
  const f = fieldsOf(p);
  assert.equal(f['Suggested by'], '<@555555555555555555>');
  assert.equal(f.Status, '⏳ Open');
  assert.equal(f.Votes, '👍 3 · 👎 1');
  const buttons = p.components[0].toJSON().components;
  assert.deepEqual(
    buttons.map((b) => [b.custom_id, b.label]),
    [
      ['sug:up:7', '👍 3'],
      ['sug:down:7', '👎 1'],
    ]
  );
  assert.deepEqual(p.allowedMentions, { parse: [] });
  assert.equal(buildSuggestionPayload(row(), {}).embeds[0].toJSON().title, '💡 Suggestion #12');
});

test('anonymous mode leaves the author out; so does an erased author', () => {
  assert.equal(fieldsOf(buildSuggestionPayload(row({ anonymous: true })))['Suggested by'], undefined);
  assert.equal(fieldsOf(buildSuggestionPayload(row({ author_id: null })))['Suggested by'], undefined);
  assert.ok(fieldsOf(buildSuggestionPayload(row()))['Suggested by']);
});

test('each status has its own colour, status line and reason; a final status closes voting', () => {
  const colours = new Set();
  const expect = {
    considering: ['🤔 Considering', true],
    approved: ['✅ Approved', false],
    denied: ['❌ Denied', false],
    implemented: ['🚀 Implemented', false],
  };
  for (const [status, [line, votable]] of Object.entries(expect)) {
    const p = buildSuggestionPayload(row({ status, reason: 'Because', decided_by: '777777777777777777' }), {
      up: 4,
      down: 2,
    });
    colours.add(p.embeds[0].toJSON().color);
    const f = fieldsOf(p);
    assert.equal(f.Status, `${line} by <@777777777777777777>`);
    assert.equal(f['Reason from staff'], 'Because');
    assert.equal(p.components.length > 0, votable, `${status}: buttons ${votable ? 'stay' : 'go'}`);
    if (!votable) assert.equal(f['Final votes'], '👍 4 · 👎 2');
  }
  colours.add(buildSuggestionPayload(row()).embeds[0].toJSON().color);
  assert.equal(colours.size, 5, 'five states, five colours');
});

test('a suggestion with no decision yet has no reason field', () => {
  assert.equal(fieldsOf(buildSuggestionPayload(row()))['Reason from staff'], undefined);
});
