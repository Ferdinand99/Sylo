import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { prepareOutgoing, attachActions, dispatchToCollectors } from '../src/platform/outgoing.js';
import { getComponentAction } from '../src/db/componentReactions.js';

const row = () =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('gaw:enter:7').setLabel('🎉 Enter').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('other').setLabel('Other').setStyle(ButtonStyle.Secondary)
  );

function fakeSent(id = 'msg1') {
  const reacted = [];
  const log = { removeAll: 0 };
  return {
    message: {
      id,
      channelId: 'chan1',
      react: async (e) => {
        reacted.push(e);
      },
      reactions: {
        removeAll: async () => {
          log.removeAll += 1;
        },
      },
    },
    reacted,
    log,
  };
}

test('prepareOutgoing turns components into a legend plus actions', () => {
  const out = prepareOutgoing({ content: 'Verify below', components: [row()], ephemeral: true });
  assert.equal(out.ephemeral, true);
  assert.equal(out.touchesComponents, true);
  assert.deepEqual(
    out.actions.map((a) => a.emoji),
    ['🎉', '1️⃣']
  );
  assert.match(out.payload.content, /^Verify below\n\nReact to choose:\n🎉 Enter\n1️⃣ Other$/);
  assert.equal('components' in out.payload, false);
});

test('a payload without a components key does not touch components', () => {
  const out = prepareOutgoing({ content: 'x' });
  assert.equal(out.touchesComponents, false);
  assert.deepEqual(out.actions, []);
});

test('attachActions reacts in order and stores the actions', async () => {
  const { message, reacted } = fakeSent('m-a');
  const out = prepareOutgoing({ content: 'x', components: [row()] });
  await attachActions(message, out, { guildId: 'fluxer:900000000000000091' });
  assert.deepEqual(reacted, ['🎉', '1️⃣']);
  const stored = await getComponentAction('m-a', '🎉');
  assert.equal(stored.customId, 'gaw:enter:7');
  assert.equal(stored.guildId, 'fluxer:900000000000000091');
  assert.equal(stored.expiresAt, null);
});

test('a ttl makes the stored actions expire', async () => {
  const { message } = fakeSent('m-b');
  const out = prepareOutgoing({ components: [row()] });
  const before = Date.now();
  await attachActions(message, out, { guildId: '', ttlMs: 60_000 });
  const { expiresAt } = await getComponentAction('m-b', '🎉');
  assert.ok(expiresAt >= before + 60_000 && expiresAt <= Date.now() + 60_000);
});

test('a reaction that fails does not stop the others or throw', async () => {
  const { message } = fakeSent('m-c');
  const reacted = [];
  message.react = async (e) => {
    if (e === '🎉') throw new Error('Unknown Emoji');
    reacted.push(e);
  };
  await attachActions(message, prepareOutgoing({ components: [row()] }), { guildId: '' });
  assert.deepEqual(reacted, ['1️⃣']);
});

test('editing with components: [] clears old reactions and stored actions', async () => {
  const { message, log } = fakeSent('m-d');
  await attachActions(message, prepareOutgoing({ components: [row()] }), { guildId: '' });
  await attachActions(message, prepareOutgoing({ components: [] }), { guildId: '', edit: true });
  assert.equal(log.removeAll, 1);
  assert.equal(await getComponentAction('m-d', '🎉'), null);
});

test('an edit that leaves components alone leaves reactions alone', async () => {
  const { message, log, reacted } = fakeSent('m-e');
  await attachActions(message, prepareOutgoing({ content: 'new text' }), { guildId: '', edit: true });
  assert.equal(log.removeAll, 0);
  assert.deepEqual(reacted, []);
});

test('a new message with no actions stores nothing and reacts with nothing', async () => {
  const { message, reacted } = fakeSent('m-f');
  await attachActions(message, prepareOutgoing({ content: 'plain' }), { guildId: '' });
  assert.deepEqual(reacted, []);
});

test('an edit with new components replaces the old reactions', async () => {
  const { message, log, reacted } = fakeSent('m-g');
  await attachActions(message, prepareOutgoing({ components: [row()] }), { guildId: '' });
  reacted.length = 0;
  await attachActions(message, prepareOutgoing({ components: [row()] }), { guildId: '', edit: true });
  assert.equal(log.removeAll, 1);
  assert.deepEqual(reacted, ['🎉', '1️⃣']);
});

test('createMessageComponentCollector: collects what passes the filter, and ends on stop', async () => {
  const { message } = fakeSent('m-h');
  await attachActions(message, prepareOutgoing({ components: [row()] }), { guildId: '' });
  const collector = message.createMessageComponentCollector({ filter: (i) => i.user.id === 'u1' });
  const got = [];
  let ended = false;
  collector.on('collect', (i) => got.push(i.user.id));
  collector.on('end', () => {
    ended = true;
  });

  assert.equal(await dispatchToCollectors('m-h', { user: { id: 'u2' } }), true); // owned by a collector, filtered out
  assert.equal(await dispatchToCollectors('m-h', { user: { id: 'u1' } }), true);
  assert.deepEqual(got, ['u1']);

  collector.stop();
  assert.equal(ended, true);
  assert.equal(await dispatchToCollectors('m-h', { user: { id: 'u1' } }), false); // nobody listening any more
});

test('a collector ends by itself after its time', async () => {
  const { message } = fakeSent('m-i');
  await attachActions(message, prepareOutgoing({ components: [row()] }), { guildId: '' });
  const collector = message.createMessageComponentCollector({ time: 10 });
  const ended = new Promise((resolve) => collector.on('end', resolve));
  // The collector's own timer is unref'd (it must not keep the process alive), so
  // hold the event loop open while waiting for it — a bare await would let Node
  // cancel the test when nothing else is pending.
  const keepAlive = setTimeout(() => {}, 5000);
  await ended;
  clearTimeout(keepAlive);
  assert.equal(await dispatchToCollectors('m-i', { user: { id: 'u1' } }), false);
});

test('a platform with native components keeps them and bridges nothing', async () => {
  const { CAPABILITIES } = await import('../src/platform/capabilities.js');
  CAPABILITIES.fluxer.components = true;
  try {
    const out = prepareOutgoing({ content: 'x', components: [row()] }, { platform: 'fluxer' });
    assert.equal(out.payload.components.length, 1);
    assert.deepEqual(out.actions, []);
    assert.equal(out.touchesComponents, false);
    assert.equal(out.payload.content, 'x');
  } finally {
    CAPABILITIES.fluxer.components = false;
  }
});

test("an edit clears reactions through message.removeAllReactions() on Fluxer's SDK", async () => {
  const { message } = fakeSent('m-j');
  delete message.reactions;
  let cleared = 0;
  message.removeAllReactions = async () => {
    cleared += 1;
  };
  await attachActions(message, prepareOutgoing({ components: [] }), { guildId: '', edit: true });
  assert.equal(cleared, 1);
});

test('preparing an already-prepared edit payload does not lose the cleared legend', () => {
  const first = prepareOutgoing({ components: [] }, { edit: true });
  assert.equal(first.payload.content, '');
  assert.equal(prepareOutgoing(first.payload, { edit: true }).payload.content, '');
});
