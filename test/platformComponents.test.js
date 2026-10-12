import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import { planComponents, withComponentText } from '../src/platform/components.js';

const row = (...c) => new ActionRowBuilder().addComponents(...c);
const button = (id, label, extra = {}) => {
  const b = new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(ButtonStyle.Primary);
  if (extra.emoji) b.setEmoji(extra.emoji);
  if (extra.disabled) b.setDisabled(true);
  return b;
};

test('no components → empty plan', () => {
  assert.deepEqual(planComponents(undefined), { actions: [], links: [], text: '' });
  assert.deepEqual(planComponents([]), { actions: [], links: [], text: '' });
});

test('a button with a unicode emoji reacts with that emoji', () => {
  const plan = planComponents([row(button('gaw:enter:7', 'Enter', { emoji: '🎉' }))]);
  assert.deepEqual(plan.actions, [{ kind: 'button', customId: 'gaw:enter:7', emoji: '🎉', label: 'Enter' }]);
  assert.match(plan.text, /🎉 Enter/);
});

test('a leading emoji in the label is used as the reaction and removed from the label', () => {
  const plan = planComponents([row(button('verify:start', '✅ Verify'))]);
  assert.equal(plan.actions[0].emoji, '✅');
  assert.equal(plan.actions[0].label, 'Verify');
});

test('buttons without an emoji get numbered reactions in order', () => {
  const plan = planComponents([row(button('a', 'One'), button('b', 'Two'))]);
  assert.deepEqual(
    plan.actions.map((a) => a.emoji),
    ['1️⃣', '2️⃣']
  );
});

test('a numbered reaction never collides with an emoji another component already uses', () => {
  const plan = planComponents([row(button('a', 'One', { emoji: '1️⃣' }), button('b', 'Two'))]);
  assert.deepEqual(
    plan.actions.map((a) => a.emoji),
    ['1️⃣', '2️⃣']
  );
});

test('a custom (server) emoji falls back to a number', () => {
  const plan = planComponents([
    row(button('a', 'One', { emoji: { name: 'party', id: '123456789012345678' } })),
  ]);
  assert.equal(plan.actions[0].emoji, '1️⃣');
});

test('link buttons become text links, not reactions', () => {
  const link = new ButtonBuilder()
    .setStyle(ButtonStyle.Link)
    .setLabel('Jump to message')
    .setURL('https://x.test/m');
  const plan = planComponents([row(link)]);
  assert.deepEqual(plan.actions, []);
  assert.deepEqual(plan.links, [{ label: 'Jump to message', url: 'https://x.test/m' }]);
  assert.match(plan.text, /\[Jump to message\]\(https:\/\/x\.test\/m\)/);
});

test('disabled components are skipped', () => {
  const plan = planComponents([row(button('a', 'One', { disabled: true }), button('b', 'Two'))]);
  assert.deepEqual(
    plan.actions.map((a) => a.customId),
    ['b']
  );
});

test('a select menu becomes one numbered reaction per option, carrying the option value', () => {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('help-category')
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('Overview').setValue('overview'),
      new StringSelectMenuOptionBuilder().setLabel('Moderation').setValue('moderation').setEmoji('🛡️')
    );
  const plan = planComponents([row(menu)]);
  assert.deepEqual(plan.actions, [
    { kind: 'select', customId: 'help-category', value: 'overview', emoji: '1️⃣', label: 'Overview' },
    { kind: 'select', customId: 'help-category', value: 'moderation', emoji: '🛡️', label: 'Moderation' },
  ]);
});

test('a select menu is capped at ten options', () => {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('m')
    .addOptions(
      Array.from({ length: 14 }, (_, i) =>
        new StringSelectMenuOptionBuilder().setLabel(`o${i}`).setValue(`v${i}`)
      )
    );
  assert.equal(planComponents([row(menu)]).actions.length, 10);
});

test('plain JSON rows work as well as builders', () => {
  const plan = planComponents([{ type: 1, components: [{ type: 2, style: 1, custom_id: 'x', label: 'X' }] }]);
  assert.equal(plan.actions[0].customId, 'x');
});

test('withComponentText appends the legend to the content, or becomes the content', () => {
  const plan = planComponents([row(button('a', 'One'))]);
  assert.equal(withComponentText({ content: 'Hello' }, plan).content, `Hello\n\n${plan.text}`);
  assert.equal(withComponentText({}, plan).content, plan.text);
  assert.deepEqual(withComponentText({ content: 'Hello' }, planComponents([])), { content: 'Hello' });
});
