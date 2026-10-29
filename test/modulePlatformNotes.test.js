import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from '../src/runtime.js';
import { modulePlatformNote, platformInfo } from '../src/platform/modulePlatformNotes.js';
import { MODULES } from '../src/modules/registry.js';

test('Discord has no platform notes: its module pages stay exactly as they are', () => {
  for (const m of MODULES) assert.equal(modulePlatformNote('discord', m.id), null, m.id);
});

test('Fluxer notes exist only for real modules, and say something', () => {
  const notes = MODULES.map((m) => [m.id, modulePlatformNote('fluxer', m.id)]).filter(([, n]) => n);
  assert.ok(notes.length >= 5, 'the modules whose behaviour differs have a note');
  for (const [id, note] of notes) assert.ok(note.length > 20, id);
  for (const id of [
    'automod',
    'temp-voice',
    'verification',
    'giveaways',
    'events',
    'suggestions',
    'temp-roles',
    'auto-threads',
    'custom-commands',
  ]) {
    assert.ok(modulePlatformNote('fluxer', id), id);
  }
});

test('the custom-commands note names the configured chat prefix', () => {
  assert.match(modulePlatformNote('fluxer', 'custom-commands'), /!/);
});

test('platformInfo: the platform, what it supports and the note per module', () => {
  const fluxerClient = {};
  runtime.clients.fluxer = fluxerClient;
  try {
    const f = platformInfo({ client: fluxerClient });
    assert.equal(f.platform, 'fluxer');
    assert.equal(f.capabilities.nativeAutomod, false);
    assert.equal(f.capabilities.moveMembers, false);
    assert.ok(f.notes.automod);
    const d = platformInfo({ client: {} });
    assert.equal(d.platform, 'discord');
    assert.equal(d.capabilities.nativeAutomod, true);
    assert.deepEqual(d.notes, {});
  } finally {
    runtime.clients.fluxer = null;
  }
});
