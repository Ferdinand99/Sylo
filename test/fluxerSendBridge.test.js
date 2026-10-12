import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { installSendBridge } from '../src/platform/fluxerSendBridge.js';
import { getComponentAction } from '../src/db/componentReactions.js';

const GUILD = '900000000000000097';

function makeClasses() {
  const reacted = [];
  const removedAll = [];
  // The SDK defines send() on a shared base (a mixin), not on TextChannel itself.
  class TextCapable {
    async send(payload) {
      this.lastSend = payload;
      return makeMessage(`sent-${Math.random()}`, this.guildId, this);
    }
  }
  class TextChannel extends TextCapable {
    constructor() {
      super();
      this.id = 'chan1';
      this.guildId = GUILD;
    }
  }
  class DMChannel extends TextCapable {
    constructor() {
      super();
      this.id = 'dm1';
      this.guildId = null;
    }
  }
  class Message {
    async reply(payload) {
      this.lastReply = payload;
      return makeMessage('reply1', this.guildId, this.channel);
    }
    async edit(payload) {
      this.lastEdit = payload;
      return this;
    }
  }
  function makeMessage(id, guildId, channel) {
    const m = new Message();
    Object.assign(m, {
      id,
      guildId,
      channel,
      channelId: channel?.id,
      react: async (e) => reacted.push([id, e]),
      removeAllReactions: async () => removedAll.push(id),
    });
    return m;
  }
  return { TextChannel, DMChannel, Message, makeMessage, reacted, removedAll };
}

const row = () =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('gaw:enter:9').setLabel('🎉 Enter').setStyle(ButtonStyle.Primary)
  );

test('channel.send() with components sends the legend, reacts, and stores a permanent action', async () => {
  const k = makeClasses();
  installSendBridge({ channelClasses: [k.TextChannel, k.DMChannel], Message: k.Message });
  const channel = new k.TextChannel();
  const sent = await channel.send({ content: 'Join', components: [row()] });
  assert.match(channel.lastSend.content, /^Join\n\nReact to choose:\n🎉 Enter$/);
  assert.equal('components' in channel.lastSend, false);
  assert.deepEqual(k.reacted, [[sent.id, '🎉']]);
  const stored = await getComponentAction(sent.id, '🎉');
  assert.equal(stored.customId, 'gaw:enter:9');
  assert.equal(stored.guildId, `fluxer:${GUILD}`);
  assert.equal(stored.expiresAt, null);
});

test('discord.js files are converted on every send', async () => {
  const k = makeClasses();
  installSendBridge({ channelClasses: [k.TextChannel], Message: k.Message });
  const channel = new k.TextChannel();
  const buf = Buffer.from('x');
  await channel.send({ files: [new AttachmentBuilder(buf, { name: 'a.txt' })] });
  assert.deepEqual(channel.lastSend.files, [{ name: 'a.txt', data: buf }]);
});

test('a DM has no guild in the stored action', async () => {
  const k = makeClasses();
  installSendBridge({ channelClasses: [k.DMChannel], Message: k.Message });
  const sent = await new k.DMChannel().send({ components: [row()] });
  assert.equal((await getComponentAction(sent.id, '🎉')).guildId, '');
});

test('message.reply() goes through the bridge', async () => {
  const k = makeClasses();
  installSendBridge({ channelClasses: [k.TextChannel], Message: k.Message });
  const channel = new k.TextChannel();
  const parent = k.makeMessage('parent', GUILD, channel);
  await parent.reply({ content: 'hi', components: [row()] });
  assert.match(parent.lastReply.content, /React to choose/);
  assert.equal((await getComponentAction('reply1', '🎉')).guildId, `fluxer:${GUILD}`);
});

test('message.edit() replaces the reactions when components change', async () => {
  const k = makeClasses();
  installSendBridge({ channelClasses: [k.TextChannel], Message: k.Message });
  const channel = new k.TextChannel();
  const msg = k.makeMessage('edit1', GUILD, channel);
  await msg.edit({ content: 'x', components: [row()] });
  assert.deepEqual(k.removedAll, ['edit1']);
  assert.deepEqual(k.reacted, [['edit1', '🎉']]);
  await msg.edit({ content: 'plain' });
  assert.deepEqual(k.removedAll, ['edit1']); // an edit that leaves components alone leaves reactions alone
});

test('installing twice does not wrap twice', async () => {
  const k = makeClasses();
  installSendBridge({ channelClasses: [k.TextChannel], Message: k.Message });
  installSendBridge({ channelClasses: [k.TextChannel], Message: k.Message });
  const sent = await new k.TextChannel().send({ components: [row()] });
  assert.equal(k.reacted.filter(([id]) => id === sent.id).length, 1);
});
