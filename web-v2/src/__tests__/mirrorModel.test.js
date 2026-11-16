import { describe, expect, it } from 'vitest';
import {
  codeLeft,
  groupNotes,
  isBusy,
  progressText,
  statusOf,
  stepOf,
  summaryLines,
  validTargetId,
} from '../mirrorModel.js';

describe('mirrorModel', () => {
  it('puts a pair at the step of the wizard its state belongs to', () => {
    expect(stepOf(null)).toBe('ask');
    expect(stepOf({ status: 'pending' })).toBe('agree');
    expect(stepOf({ status: 'ready' })).toBe('preview');
    for (const status of ['copying', 'live', 'done', 'paused', 'stopped']) {
      expect(stepOf({ status })).toBe('copy');
    }
  });

  it('names every state the server uses, and an unknown one by its own word', () => {
    for (const status of ['pending', 'ready', 'copying', 'live', 'done', 'paused', 'stopped']) {
      expect(statusOf(status).label).not.toBe(status);
    }
    expect(statusOf('paused').tone).toBe('warning');
    expect(statusOf('weird')).toEqual({ label: 'weird', tone: 'neutral' });
  });

  it('keeps asking for progress while a copy runs or changes wait', () => {
    expect(isBusy({ status: 'copying' }, null)).toBe(true);
    expect(isBusy({ status: 'live' }, { waitingChanges: 2 })).toBe(true);
    expect(isBusy({ status: 'live' }, { waitingChanges: 0 })).toBe(false);
    expect(isBusy({ status: 'paused' }, { waitingChanges: 2 })).toBe(false);
    expect(isBusy(null, null)).toBe(false);
  });

  it('sums the preview up in one line per kind', () => {
    const lines = summaryLines({
      role: { create: 2, update: 1, unchanged: 0, skip: 1 },
      channel: { create: 1, update: 0, unchanged: 4, skip: 0 },
      emoji: { create: 0, update: 0, unchanged: 0, skip: 0 },
      sticker: { create: 0, update: 2, unchanged: 0, skip: 0 },
    });
    expect(lines).toEqual([
      { kind: 'role', text: 'Create 2 roles, update 1, skip 1' },
      { kind: 'channel', text: 'Create 1 channel, 4 already match' },
      { kind: 'sticker', text: 'Update 2 stickers' },
    ]);
    expect(summaryLines(undefined)).toEqual([]);
  });

  it('groups the notes by what they are about, roles first', () => {
    const groups = groupNotes([
      { scope: 'channel', message: 'a' },
      { scope: 'role', message: 'b' },
      { scope: 'channel', message: 'c' },
    ]);
    expect(groups.map((g) => [g.title, g.items.length])).toEqual([
      ['Roles', 1],
      ['Channels and permissions', 2],
    ]);
  });

  it('says how far a copy is', () => {
    expect(progressText(null)).toBe('Nothing queued.');
    expect(progressText({ total: 0 })).toBe('Nothing queued.');
    expect(progressText({ total: 40, waiting: 28, failed: 1, skipped: 2 })).toBe(
      '12 of 40 steps done, 1 failed, 2 skipped'
    );
  });

  it('counts down a code, and says nothing once it ran out', () => {
    const now = 1_000_000;
    expect(codeLeft(now + 41 * 60_000 - 5, now)).toBe('41 minutes');
    expect(codeLeft(now + 30_000, now)).toBe('1 minute');
    expect(codeLeft(now - 1, now)).toBeNull();
    expect(codeLeft(0, now)).toBeNull();
  });

  it('accepts a Fluxer server id as a number or as fluxer:<id>', () => {
    expect(validTargetId('123456789012345678')).toBe(true);
    expect(validTargetId(' fluxer:123456789012345678 ')).toBe(true);
    expect(validTargetId('12345')).toBe(false);
    expect(validTargetId('discord:123456789012345678')).toBe(false);
    expect(validTargetId('')).toBe(false);
  });
});
