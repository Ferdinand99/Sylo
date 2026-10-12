import test from 'node:test';
import assert from 'node:assert/strict';
import { commandText, rewriteSlashCommands } from '../src/platform/commandText.js';

test('commandText: a slash command becomes the platform prefix form on Fluxer, untouched on Discord', () => {
  assert.equal(commandText('discord', '/giveaway start', '!'), '/giveaway start');
  assert.equal(commandText('fluxer', '/giveaway start', '!'), '!giveaway start');
  assert.equal(commandText('fluxer', '/afk [reason]', '?'), '?afk [reason]');
  assert.equal(commandText('fluxer', 'plain text', '!'), 'plain text');
  assert.equal(commandText('fluxer', '/', '!'), '/');
});

const names = new Set(['giveaway', 'afk', 'leaderboard', 'poll', 'poll-end', 'voice-lock', 'voice-unlock']);

test('rewriteSlashCommands: only <code> command references that name a real command', () => {
  const html = [
    '<code>/giveaway start prize:…</code>',
    '<code>/afk [reason]</code>',
    '<code>/poll-end</code>',
    '<code>/voice-*</code>',
    '<code>/leaderboard/123456789</code>', // a URL, not the command
    '<code>/slash</code>',
    '<code>/command</code>',
    '<p>/giveaway outside code</p>',
  ].join('\n');
  assert.equal(
    rewriteSlashCommands(html, { prefix: '!', names }),
    [
      '<code>!giveaway start prize:…</code>',
      '<code>!afk [reason]</code>',
      '<code>!poll-end</code>',
      '<code>!voice-*</code>',
      '<code>/leaderboard/123456789</code>',
      '<code>/slash</code>',
      '<code>/command</code>',
      '<p>/giveaway outside code</p>',
    ].join('\n')
  );
});
