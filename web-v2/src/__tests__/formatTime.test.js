import { describe, expect, it } from 'vitest';
import { describeTime, formatDateTime, formatDay, formatRelative } from '../formatTime.js';

const NOW = Date.UTC(2026, 10, 5, 12, 0); // Thu 5 Nov 2026, 12:00 UTC
const opts = { locale: 'en-GB', timeZone: 'UTC', now: NOW };

describe('formatDateTime', () => {
  it('writes weekday, day, month and time without seconds', () => {
    expect(formatDateTime(Date.UTC(2026, 10, 7, 23, 5, 41), opts)).toBe('Sat 7 Nov, 23:05');
  });

  it('adds the year when it is not this year', () => {
    expect(formatDateTime(Date.UTC(2027, 0, 2, 9, 30), opts)).toBe('Sat 2 Jan 2027, 09:30');
  });

  it('follows the viewer locale but never writes a numeric day/month', () => {
    const us = formatDateTime(Date.UTC(2026, 10, 7, 23, 5), { ...opts, locale: 'en-US' });
    expect(us).toBe('Sat Nov 7, 11:05 PM');
    expect(us).not.toMatch(/\d+\/\d+/);
  });

  it('can show the time in a given zone', () => {
    expect(formatDateTime(Date.UTC(2026, 10, 7, 23, 5), { ...opts, timeZone: 'Europe/Oslo' })).toBe(
      'Sun 8 Nov, 00:05'
    );
  });

  it('takes ISO strings and Dates, and gives nothing for no date', () => {
    expect(formatDateTime('2026-11-07T23:05:00Z', opts)).toBe('Sat 7 Nov, 23:05');
    expect(formatDateTime(new Date(Date.UTC(2026, 10, 7, 23, 5)), opts)).toBe('Sat 7 Nov, 23:05');
    expect(formatDateTime(null, opts)).toBe('');
    expect(formatDateTime('nonsense', opts)).toBe('');
  });
});

describe('formatDay', () => {
  it('is the date alone', () => {
    expect(formatDay(Date.UTC(2026, 10, 7, 23, 5), opts)).toBe('7 Nov');
    expect(formatDay(Date.UTC(2025, 10, 7), opts)).toBe('7 Nov 2025');
  });
});

describe('formatRelative', () => {
  it('counts minutes and hours compactly', () => {
    expect(formatRelative(NOW - 3 * 60_000, opts)).toBe('3m ago');
    expect(formatRelative(NOW + 5 * 3_600_000, opts)).toBe('in 5h');
    expect(formatRelative(NOW + 20_000, opts)).toBe('just now');
  });

  it('spells out days', () => {
    expect(formatRelative(NOW + 2 * 86_400_000, opts)).toBe('in 2 days');
    expect(formatRelative(NOW - 86_400_000, opts)).toBe('1 day ago');
  });

  it('falls back to the plain date far out', () => {
    expect(formatRelative(NOW + 200 * 86_400_000, opts)).toBe('24 May 2027');
  });
});

describe('describeTime', () => {
  it('shows the exact time with the relative form in the tooltip', () => {
    expect(describeTime(NOW + 2 * 86_400_000, opts)).toEqual({
      text: 'Sat 7 Nov, 12:00',
      title: 'in 2 days',
    });
  });

  it('shows the relative time with the exact one in the tooltip', () => {
    expect(describeTime(NOW - 3 * 60_000, { ...opts, relative: true })).toEqual({
      text: '3m ago',
      title: 'Thu 5 Nov, 11:57',
    });
  });

  it('is empty without a date', () => {
    expect(describeTime(undefined, opts)).toEqual({ text: '', title: '' });
  });
});
