import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Collection } from '@fluxerjs/collection';
import { createVoiceTracker } from '../src/platform/voiceStates.js';

const G = '900000000000000070';

function setup() {
  const member = { id: 'u1', user: { id: 'u1' } };
  const channel = { id: 'vc1', guildId: G };
  const guild = {
    id: G,
    members: new Map([['u1', member]]),
    channels: new Map([['vc1', channel]]),
  };
  const client = new EventEmitter();
  client.guilds = new Map([[G, guild]]);
  const tracker = createVoiceTracker({ Collection });
  return { client, guild, member, channel, tracker };
}

const raw = (over = {}) => ({
  guild_id: G,
  user_id: 'u1',
  channel_id: 'vc1',
  connection_id: 'conn-a',
  self_mute: true,
  ...over,
});

test('joining a voice channel gives an old state with no channel and a new state with one', () => {
  const { client, tracker } = setup();
  const pair = tracker.apply(client, raw());
  assert.equal(pair.old.channelId, null);
  assert.equal(pair.new.channelId, 'vc1');
  assert.equal(pair.new.connectionId, 'conn-a');
  assert.equal(pair.new.selfMute, true);
  assert.equal(tracker.statesFor(G).get('u1').channelId, 'vc1');
});

test('moving between channels reports the previous channel as old', () => {
  const { client, tracker } = setup();
  tracker.apply(client, raw());
  const pair = tracker.apply(client, raw({ channel_id: 'vc2' }));
  assert.equal(pair.old.channelId, 'vc1');
  assert.equal(pair.new.channelId, 'vc2');
});

test('leaving removes the member from the tracked states', () => {
  const { client, tracker } = setup();
  tracker.apply(client, raw());
  const pair = tracker.apply(client, raw({ channel_id: null }));
  assert.equal(pair.old.channelId, 'vc1');
  assert.equal(pair.new.channelId, null);
  assert.equal(tracker.statesFor(G).has('u1'), false);
});

test('a state resolves its guild, member and channel from the client caches', () => {
  const { client, tracker, guild, member, channel } = setup();
  const { new: state } = tracker.apply(client, raw());
  assert.equal(state.guild, guild);
  assert.equal(state.member, member);
  assert.equal(state.channel, channel);
  assert.equal(tracker.apply(client, raw({ channel_id: null })).new.channel, null);
});

test('membersIn lists the cached members connected to one channel', () => {
  const { client, tracker, member } = setup();
  tracker.apply(client, raw());
  tracker.apply(client, raw({ user_id: 'ghost', channel_id: 'vc1' })); // not in the member cache
  tracker.apply(client, raw({ user_id: 'u3', channel_id: 'vc2' }));
  const here = tracker.membersIn(G, 'vc1');
  assert.deepEqual([...here.keys()], ['u1']);
  assert.equal(here.first(), member); // a Collection, like discord.js's channel.members
  assert.equal(tracker.membersIn(G, 'nope').size, 0);
});

test('a payload without a guild or user is ignored', () => {
  const { client, tracker } = setup();
  assert.equal(tracker.apply(client, { user_id: 'u1', channel_id: 'vc1' }), null);
  assert.equal(tracker.apply(client, { guild_id: G, channel_id: 'vc1' }), null);
});

test('track(): the initial sync seeds the states silently, later updates report changes', () => {
  const { client, tracker } = setup();
  const seen = [];
  tracker.track(client, (oldState, newState) => seen.push([oldState.channelId, newState.channelId]));
  client.emit('voiceStatesSync', {
    guildId: G,
    voiceStates: [raw(), raw({ user_id: 'u2', channel_id: null })],
  });
  assert.deepEqual(seen, []);
  assert.deepEqual([...tracker.statesFor(G).keys()], ['u1']);

  client.emit('voiceStateUpdate', raw({ channel_id: 'vc2' }));
  assert.deepEqual(seen, [['vc1', 'vc2']]);
});

test('track(): a guild the bot leaves is forgotten', () => {
  const { client, tracker } = setup();
  tracker.track(client, () => {});
  client.emit('voiceStateUpdate', raw());
  assert.equal(tracker.statesFor(G).size, 1);
  client.emit('guildDelete', { id: G });
  assert.equal(tracker.statesFor(G).size, 0);
});

test('track(): a listener that throws does not stop later updates', () => {
  const { client, tracker } = setup();
  let calls = 0;
  tracker.track(client, () => {
    calls += 1;
    throw new Error('boom');
  });
  assert.doesNotThrow(() => client.emit('voiceStateUpdate', raw()));
  assert.doesNotThrow(() => client.emit('voiceStateUpdate', raw({ channel_id: 'vc2' })));
  assert.equal(calls, 2);
});
