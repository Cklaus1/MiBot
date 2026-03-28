import { describe, it, expect, beforeEach } from 'vitest';
import { loadConfig, reloadConfig, isBot, shouldSkipMeeting, fmtTime } from '../src/config.js';

describe('isBot', () => {
  it('detects common meeting bots', () => {
    expect(isBot('Otter.ai Notetaker')).toBe(true);
    expect(isBot('Fireflies.ai Notetaker')).toBe(true);
    expect(isBot('Circleback Notetaker')).toBe(true);
    expect(isBot("chris's Circleback (Unverified)")).toBe(true);
    expect(isBot('Gong.io Recorder')).toBe(true);
    expect(isBot('Read.ai')).toBe(true);
    expect(isBot('MiBot')).toBe(true);
    expect(isBot('My Recording Bot')).toBe(true);
  });

  it('does not flag real people', () => {
    expect(isBot('Chris Klaus')).toBe(false);
    expect(isBot('Alice Johnson')).toBe(false);
    expect(isBot('Bob Smith')).toBe(false);
    expect(isBot('Jennifer Whitlow')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isBot('FIREFLIES')).toBe(true);
    expect(isBot('otter.AI')).toBe(true);
  });
});

describe('shouldSkipMeeting', () => {
  it('skips lunch and personal events', () => {
    expect(shouldSkipMeeting('Lunch break')).toBe(true);
    expect(shouldSkipMeeting('Personal appointment')).toBe(true);
    expect(shouldSkipMeeting('Focus time block')).toBe(true);
    expect(shouldSkipMeeting('No bot allowed')).toBe(true);
  });

  it('does not skip regular meetings', () => {
    expect(shouldSkipMeeting('All Hands')).toBe(false);
    expect(shouldSkipMeeting('Sprint Planning')).toBe(false);
    expect(shouldSkipMeeting('1:1 with Chris')).toBe(false);
  });
});

describe('fmtTime', () => {
  it('formats UTC timestamps to local time', () => {
    const result = fmtTime('2026-03-27T16:00:00.0000000');
    expect(result).toContain('Mar');
    expect(result).toContain('27');
  });

  it('handles ISO strings with Z suffix', () => {
    const result = fmtTime('2026-03-27T16:00:00Z');
    expect(result).toBeTruthy();
  });
});
