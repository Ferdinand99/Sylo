// What Fluxer sees of Events: the chat form of /event is understood by the prefix-command parser,
// and the three buttons become three different reactions with a legend.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationCommandOptionType as T } from 'discord.js';
import { data } from '../src/bot/commands/event.js';
import { parseArgs, ParseError } from '../src/bot/framework/parser.js';
import { planComponents, withComponentText } from '../src/platform/components.js';
import { buildEventPayload } from '../src/modules/events.js';

const schema = data.toJSON();

test('!event create takes quoted values and name:value options', () => {
  const r = parseArgs(
    schema,
    'create title:"Game night" start:"2026-11-05 19:00" timezone:Europe/Oslo capacity:10 reminder:0 location:"Voice 1"'
  );
  assert.equal(r.subcommand, 'create');
  assert.deepEqual(Object.fromEntries(Object.entries(r.values).map(([k, v]) => [k, v.value])), {
    title: 'Game night',
    start: '2026-11-05 19:00',
    timezone: 'Europe/Oslo',
    capacity: 10,
    reminder: 0,
    location: 'Voice 1',
  });
  assert.equal(r.values.capacity.type, T.Integer);
});

test('!event create also works positionally with quotes, and the number options are range-checked', () => {
  const r = parseArgs(schema, 'create "Game night" "2026-11-05 19:00"');
  assert.equal(r.values.title.value, 'Game night');
  assert.equal(r.values.start.value, '2026-11-05 19:00');
  assert.throws(() => parseArgs(schema, 'create title:x start:"2026-11-05 19:00" capacity:0'), ParseError);
  assert.throws(() => parseArgs(schema, 'create title:x start:"2026-11-05 19:00" capacity:501'), ParseError);
  assert.throws(() => parseArgs(schema, 'create title:x start:"2026-11-05 19:00" reminder:1441'), ParseError);
  assert.throws(() => parseArgs(schema, 'create title:x'), /start/);
  assert.throws(() => parseArgs(schema, `create title:${'a'.repeat(101)} start:x`), ParseError);
});

test('!event list and !event cancel id:3', () => {
  assert.equal(parseArgs(schema, 'list').subcommand, 'list');
  const c = parseArgs(schema, 'cancel id:3');
  assert.equal(c.subcommand, 'cancel');
  assert.equal(c.values.id.value, 3);
  assert.equal(parseArgs(schema, 'cancel 7').values.id.value, 7);
  assert.throws(() => parseArgs(schema, 'cancel'), /id/);
});

test('the Join / Maybe / Leave buttons become three different reactions with a legend', () => {
  const payload = buildEventPayload({
    id: 4,
    guild_id: '1',
    channel_id: '2',
    title: 'Game night',
    description: '',
    location: '',
    image_url: '',
    start_at: Date.UTC(2030, 0, 1),
    end_at: null,
    time_zone: 'UTC',
    capacity: null,
    role_id: null,
    host_id: '3',
    state: 'scheduled',
  });
  const plan = planComponents(payload.components);
  assert.deepEqual(
    plan.actions.map((a) => [a.emoji, a.customId]),
    [
      ['✅', 'evt:join:4'],
      ['❔', 'evt:maybe:4'],
      ['❌', 'evt:leave:4'],
    ]
  );
  assert.match(withComponentText({}, plan).content, /✅ Join\n❔ Maybe\n❌ Leave/);
  // a finished event has nothing to react to
  const done = buildEventPayload({
    ...{ id: 4, host_id: '3', title: 't', start_at: 0, time_zone: 'UTC' },
    state: 'ended',
  });
  assert.deepEqual(planComponents(done.components).actions, []);
});
