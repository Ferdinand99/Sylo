// Without the Message Content intent (INTENT_MESSAGE_CONTENT=false) Discord sends no message text,
// so the shortest-message rule cannot be applied. The module must still work: chat pays whatever the
// length, and nothing else changes. The env var is set before anything loads the config.
import './helpers/noContentIntent.js';
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getAccount } from '../src/db/economy.js';
import { setGuildModule } from '../src/db/modules.js';
import { dispatch } from '../src/modules/dispatch.js';
import { getModule, missingIntents } from '../src/modules/registry.js';
import '../src/modules/economy.js';

const G = '5600000000000000001';
const U = '800000000000000001';

test('the module is not blocked by a missing Message Content intent', () => {
  assert.deepEqual(getModule('economy').requiredIntents, []);
  assert.deepEqual(missingIntents(getModule('economy')), []);
});

test('chat still pays when no message text is delivered, and the minimum length is not applied', async () => {
  await setGuildModule(G, 'economy', {
    enabled: true,
    config: { messageMin: 9, messageMax: 9, messageMinLength: 50 },
  });
  await dispatch('messageCreate', G, {
    author: { id: U, bot: false },
    member: { roles: { cache: new Map() } },
    content: '', // what Discord sends without the intent
    channelId: '900000000000000001',
  });
  assert.equal(Number((await getAccount(G, U)).cash), 9);
});
