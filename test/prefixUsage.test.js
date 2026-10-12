import test from 'node:test';
import assert from 'node:assert/strict';
import { SlashCommandBuilder } from 'discord.js';
import { usageLines } from '../src/bot/framework/usage.js';

const ban = new SlashCommandBuilder()
  .setName('ban')
  .setDescription('Ban')
  .addUserOption((o) => o.setName('user').setDescription('u').setRequired(true))
  .addStringOption((o) => o.setName('reason').setDescription('r'))
  .toJSON();

const warn = new SlashCommandBuilder()
  .setName('warn')
  .setDescription('Warn')
  .addSubcommand((s) =>
    s
      .setName('add')
      .setDescription('a')
      .addUserOption((o) => o.setName('user').setDescription('u').setRequired(true))
      .addStringOption((o) => o.setName('reason').setDescription('r').setRequired(true))
  )
  .addSubcommand((s) => s.setName('list').setDescription('l'))
  .toJSON();

test('required options are <angle>, optional are [square]', () => {
  assert.deepEqual(usageLines('!', ban), ['!ban <user> [reason]']);
});

test('a command without options is just the prefix and name', () => {
  assert.deepEqual(usageLines('?', new SlashCommandBuilder().setName('ping').setDescription('p').toJSON()), [
    '?ping',
  ]);
});

test('each subcommand gets its own line', () => {
  assert.deepEqual(usageLines('!', warn), ['!warn add <user> <reason>', '!warn list']);
});
