import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  DEFAULT_SELECTORS, loadSelectors, reloadSelectors, sanitizeSelectorList,
} from '../src/selectors.js';

// J22: the override loader accepted any value that passed Array.isArray, so a JSON file like
// `{ "participantNames": [123, null, {}] }` fed non-string "selectors" straight into
// page.$$()/querySelectorAll, which throws (or silently no-ops) at scrape time — far from the
// config file that caused it. sanitizeSelectorList is the pure gate: an array is only accepted
// when every element is a string; otherwise the key is rejected and the default is kept.
describe('sanitizeSelectorList (J22 element-type validation)', () => {
  it('accepts an all-string array', () => {
    expect(sanitizeSelectorList(['.a', '[data-x]'])).toEqual(['.a', '[data-x]']);
  });

  it('accepts an empty array', () => {
    expect(sanitizeSelectorList([])).toEqual([]);
  });

  it('rejects a non-array', () => {
    expect(sanitizeSelectorList('nope')).toBeNull();
    expect(sanitizeSelectorList(42)).toBeNull();
    expect(sanitizeSelectorList(null)).toBeNull();
    expect(sanitizeSelectorList(undefined)).toBeNull();
  });

  it('rejects an array containing any non-string element', () => {
    expect(sanitizeSelectorList([123])).toBeNull();
    expect(sanitizeSelectorList(['.ok', null])).toBeNull();
    expect(sanitizeSelectorList(['.ok', {}])).toBeNull();
    expect(sanitizeSelectorList(['.ok', undefined])).toBeNull();
  });
});

describe('loadSelectors override (J22 rejects non-string elements)', () => {
  const SELECTORS_DIR = path.join(os.homedir(), '.config', 'mibot', 'selectors');
  const overridePath = path.join(SELECTORS_DIR, 'zoom.json');
  let existed = false;
  let backup: string | null = null;

  beforeEach(() => {
    fs.mkdirSync(SELECTORS_DIR, { recursive: true });
    existed = fs.existsSync(overridePath);
    backup = existed ? fs.readFileSync(overridePath, 'utf8') : null;
    reloadSelectors();
  });

  afterEach(() => {
    if (backup !== null) fs.writeFileSync(overridePath, backup);
    else if (fs.existsSync(overridePath)) fs.unlinkSync(overridePath);
    reloadSelectors();
  });

  it('keeps defaults when an override list has non-string elements', () => {
    fs.writeFileSync(overridePath, JSON.stringify({ participantNames: [123, null] }));
    reloadSelectors();
    const sel = loadSelectors('zoom');
    // The malformed key is rejected wholesale; the default list survives.
    expect(sel.participantNames).toEqual(DEFAULT_SELECTORS.zoom.participantNames);
  });

  it('still applies a valid sibling key when the other key is malformed', () => {
    fs.writeFileSync(overridePath, JSON.stringify({
      participantNames: [1, 2],
      activeSpeaker: ['.valid-speaker'],
    }));
    reloadSelectors();
    const sel = loadSelectors('zoom');
    expect(sel.participantNames).toEqual(DEFAULT_SELECTORS.zoom.participantNames);
    expect(sel.activeSpeaker).toEqual(['.valid-speaker']);
  });
});
