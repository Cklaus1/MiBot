import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { DEFAULT_SELECTORS, loadSelectors, reloadSelectors } from '../src/selectors.js';

const SELECTORS_DIR = path.join(os.homedir(), '.config', 'mibot', 'selectors');

describe('selectors', () => {
  beforeEach(() => reloadSelectors());
  afterEach(() => reloadSelectors());

  it('returns bundled defaults for a known platform', () => {
    const sel = loadSelectors('meet');
    expect(sel.participantNames).toEqual(DEFAULT_SELECTORS.meet.participantNames);
    expect(sel.activeSpeaker).toEqual(DEFAULT_SELECTORS.meet.activeSpeaker);
  });

  it('keeps the fragile Meet classes as the single source of truth', () => {
    // These minified classes must live only here, not scattered in scraper code.
    expect(DEFAULT_SELECTORS.meet.activeSpeaker).toContain('.KV1GEc');
  });

  it('returns empty lists for an unknown platform', () => {
    const sel = loadSelectors('webex');
    expect(sel.participantNames).toEqual([]);
    expect(sel.activeSpeaker).toEqual([]);
  });

  it('does not share array references with the defaults (defensive copy)', () => {
    const sel = loadSelectors('teams');
    expect(sel.participantNames).not.toBe(DEFAULT_SELECTORS.teams.participantNames);
    sel.participantNames.push('mutated');
    expect(DEFAULT_SELECTORS.teams.participantNames).not.toContain('mutated');
  });

  describe('JSON override', () => {
    const overridePath = path.join(SELECTORS_DIR, 'zoom.json');
    let existed = false;
    let backup: string | null = null;

    beforeEach(() => {
      fs.mkdirSync(SELECTORS_DIR, { recursive: true });
      existed = fs.existsSync(overridePath);
      backup = existed ? fs.readFileSync(overridePath, 'utf8') : null;
    });

    afterEach(() => {
      if (backup !== null) fs.writeFileSync(overridePath, backup);
      else if (fs.existsSync(overridePath)) fs.unlinkSync(overridePath);
      reloadSelectors();
    });

    it('replaces a specified key wholesale and leaves others at default', () => {
      fs.writeFileSync(overridePath, JSON.stringify({ activeSpeaker: ['.new-zoom-class'] }));
      reloadSelectors();
      const sel = loadSelectors('zoom');
      expect(sel.activeSpeaker).toEqual(['.new-zoom-class']);
      // participantNames not in the override → stays default
      expect(sel.participantNames).toEqual(DEFAULT_SELECTORS.zoom.participantNames);
    });

    it('falls back to defaults on malformed JSON', () => {
      fs.writeFileSync(overridePath, '{ not valid json ');
      reloadSelectors();
      const sel = loadSelectors('zoom');
      expect(sel.activeSpeaker).toEqual(DEFAULT_SELECTORS.zoom.activeSpeaker);
    });
  });
});
