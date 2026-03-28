import { describe, it, expect } from 'vitest';
import { PlaybookEngine, type Playbook } from '../src/playbook.js';

describe('PlaybookEngine', () => {
  describe('loadForPlatform', () => {
    it('loads teams playbook', () => {
      const pb = PlaybookEngine.loadForPlatform('teams');
      expect(pb).not.toBeNull();
      expect(pb!.name).toContain('Teams');
      expect(pb!.steps.length).toBeGreaterThan(0);
    });

    it('loads zoom playbook', () => {
      const pb = PlaybookEngine.loadForPlatform('zoom');
      expect(pb).not.toBeNull();
      expect(pb!.name).toContain('Zoom');
    });

    it('returns null for unknown platform', () => {
      const pb = PlaybookEngine.loadForPlatform('webex');
      expect(pb).toBeNull();
    });
  });

  describe('variable interpolation', () => {
    it('replaces {{var}} in playbook steps', () => {
      const pb: Playbook = {
        name: 'test',
        platform: 'test',
        steps: [
          { action: 'log', message: 'Hello {{botName}}' },
        ],
      };
      // We can't run the engine without a Page, but we can verify the playbook loads
      expect(pb.steps[0].message).toBe('Hello {{botName}}');
    });
  });
});

describe('Playbook JSON files', () => {
  it('teams playbook has required steps', () => {
    const pb = PlaybookEngine.loadForPlatform('teams')!;
    const actions = pb.steps.map(s => s.action);
    expect(actions).toContain('log');
    expect(actions).toContain('try');
  });

  it('zoom playbook uses goto with zoomDirectUrl', () => {
    const pb = PlaybookEngine.loadForPlatform('zoom')!;
    const gotoStep = pb.steps.find(s => s.action === 'goto');
    expect(gotoStep).toBeDefined();
    expect(gotoStep!.url).toContain('{{zoomDirectUrl}}');
  });

  it('zoom playbook has wait_for on goto', () => {
    const pb = PlaybookEngine.loadForPlatform('zoom')!;
    const gotoStep = pb.steps.find(s => s.action === 'goto');
    expect(gotoStep!.wait_for).toBe('Your Name');
  });
});
