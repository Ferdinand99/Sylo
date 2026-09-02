import './helpers/tmpDb.js';
import './helpers/openMode.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerComponent, routeComponent, _resetComponents } from '../src/bot/lib/components.js';
import { overrideBlockReason } from '../src/bot/events/interactionCreate.js';
import { setCommandOverride } from '../src/db/commandOverrides.js';
import { fakeComponentInteraction, fakeCommandInteraction } from './helpers/fakeInteraction.js';

test('routeComponent', async (t) => {
  t.beforeEach(() => _resetComponents());

  await t.test('runs the handler for a matching prefix and reports a match', async () => {
    let seen = null;
    registerComponent('demo', 'foo:', (i) => {
      seen = i.customId;
    });
    const matched = await routeComponent(fakeComponentInteraction('foo:123'));
    assert.equal(matched, true);
    assert.equal(seen, 'foo:123');
  });

  await t.test('longest prefix wins regardless of registration order', async () => {
    const hits = [];
    registerComponent('demo', 'rr:', () => hits.push('short'));
    registerComponent('demo', 'rrsel:', () => hits.push('long'));
    await routeComponent(fakeComponentInteraction('rrsel:5'));
    assert.deepEqual(hits, ['long']);
  });

  await t.test('unknown prefix: no handler, returns false', async () => {
    let ran = false;
    registerComponent('demo', 'foo:', () => {
      ran = true;
    });
    const matched = await routeComponent(fakeComponentInteraction('bar:9'));
    assert.equal(matched, false);
    assert.equal(ran, false);
  });

  await t.test('handler throw is swallowed, still counts as matched, one error reply', async () => {
    registerComponent('demo', 'boom:', () => {
      throw new Error('kaboom');
    });
    const interaction = fakeComponentInteraction('boom:1');
    const matched = await routeComponent(interaction);
    assert.equal(matched, true);
    assert.equal(interaction._replies.length, 1);
    assert.match(interaction._replies[0].content, /went wrong/i);
  });

  await t.test('no error reply when the handler already replied', async () => {
    registerComponent('demo', 'boom:', async (i) => {
      await i.reply({ content: 'handled' });
      throw new Error('after reply');
    });
    const interaction = fakeComponentInteraction('boom:1');
    await routeComponent(interaction);
    assert.equal(interaction._replies.length, 1);
    assert.equal(interaction._replies[0].content, 'handled');
  });
});

test('overrideBlockReason', async (t) => {
  const G = '700000000000000001';
  const CH_OK = '700000000000000010';
  const CH_NO = '700000000000000011';
  const ROLE = '700000000000000020';

  await t.test('no override → allowed', () => {
    assert.equal(
      overrideBlockReason(fakeCommandInteraction({ guildId: G, commandName: 'ping', channelId: CH_OK })),
      null
    );
  });

  await t.test('disabled → blocked for everyone, admins included', () => {
    setCommandOverride(G, 'ping', { enabled: false });
    const reason = overrideBlockReason(
      fakeCommandInteraction({ guildId: G, commandName: 'ping', channelId: CH_OK, isAdmin: true })
    );
    assert.match(reason, /disabled/i);
  });

  await t.test('channel restriction blocks a non-admin outside the allowed channel', () => {
    setCommandOverride(G, 'rank', { enabled: true, allowedChannels: [CH_OK] });
    assert.match(
      overrideBlockReason(fakeCommandInteraction({ guildId: G, commandName: 'rank', channelId: CH_NO })),
      /can only be used in/i
    );
    assert.equal(
      overrideBlockReason(fakeCommandInteraction({ guildId: G, commandName: 'rank', channelId: CH_OK })),
      null
    );
    // admins bypass channel/role limits
    assert.equal(
      overrideBlockReason(
        fakeCommandInteraction({ guildId: G, commandName: 'rank', channelId: CH_NO, isAdmin: true })
      ),
      null
    );
  });

  await t.test('role restriction blocks a member without an allowed role', () => {
    setCommandOverride(G, 'stats', { enabled: true, allowedRoles: [ROLE] });
    assert.match(
      overrideBlockReason(fakeCommandInteraction({ guildId: G, commandName: 'stats', channelId: CH_OK })),
      /do not have a role/i
    );
    assert.equal(
      overrideBlockReason(
        fakeCommandInteraction({ guildId: G, commandName: 'stats', channelId: CH_OK, roleIds: [ROLE] })
      ),
      null
    );
  });
});
