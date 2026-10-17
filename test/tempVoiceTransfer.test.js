// When a temp channel's owner leaves and others stay, ownership moves on. The move used to give
// the new owner their permissions but leave the old owner's: they could rejoin and still manage
// the channel (or lift a ban on themselves). The manual transfer already removed them.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { onLeaveTemp } from '../src/modules/tempVoice.js';
import { addTempChannel, getTempChannel } from '../src/db/tempVoice.js';
import { setGuildModule } from '../src/db/modules.js';

const G = '900000000000000951';
const HUB = '900000000000000952';
const CH = '900000000000000953';
const OLD = '900000000000000954';
const NEXT = '900000000000000955';
const BOT = '900000000000000956';

test('an automatic transfer removes the old owner’s permissions and skips bots', async () => {
  await setGuildModule(G, 'temp-voice', { enabled: true, config: { hubs: [{ hubChannelId: HUB }] } });
  await addTempChannel({ channelId: CH, guildId: G, hubId: HUB, ownerId: OLD });
  const edits = [];
  const deletes = [];
  const members = new Map([
    [BOT, { id: BOT, user: { bot: true } }],
    [NEXT, { id: NEXT, user: { bot: false } }],
  ]);
  members.first = () => members.values().next().value;
  members.find = (fn) => [...members.values()].find(fn);
  const channel = {
    id: CH,
    members,
    permissionOverwrites: {
      edit: async (id) => edits.push(id),
      delete: async (id) => deletes.push(id),
    },
  };
  const guild = { id: G, channels: { cache: new Map([[CH, channel]]) } };

  await onLeaveTemp(guild, CH);

  assert.equal((await getTempChannel(CH)).owner_id, NEXT);
  assert.deepEqual(deletes, [OLD]);
  assert.deepEqual(edits, [NEXT]);
});
