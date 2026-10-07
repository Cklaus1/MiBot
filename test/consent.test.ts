import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  findStopRequest, consentMessage, announceSteps, postConsent, DEFAULT_ANNOUNCE_STEPS,
  DEFAULT_CONSENT_MESSAGE, DEFAULT_STOP_KEYWORD,
} from '../src/consent.js';
import { checkLeaveRequests } from '../src/meeting.js';
import { PlaybookEngine, validatePlaybook } from '../src/playbook.js';
import { validateConfig } from '../src/config.js';

// Wave 10 #2: the bot recorded silently, and nobody but the operator could stop it.
let spy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { spy = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => spy.mockRestore());

const notBot = () => false;

describe('findStopRequest', () => {
  const msg = (sender: string, text: string) => ({ sender, text });
  it('the whole message must be the keyword (case/space-insensitive)', () => {
    expect(findStopRequest([msg('Ann', '  !STOP ')], '!stop', notBot)).toBe('Ann');
    expect(findStopRequest([msg('Ann', 'please !stop now')], '!stop', notBot)).toBeNull();
    expect(findStopRequest([msg('Ann', 'stop')], '!stop', notBot)).toBeNull();
  });
  it('ignores the bot itself and other bots', () => {
    const isBot = (n: string) => n.startsWith('MiBot') || n === 'Otter.ai';
    expect(findStopRequest([msg('MiBot (recording)', '!stop'), msg('Otter.ai', '!stop')], '!stop', isBot)).toBeNull();
    expect(findStopRequest([msg('Otter.ai', '!stop'), msg('Bob', '!stop')], '!stop', isBot)).toBe('Bob');
  });
  it('a blank keyword never matches', () => expect(findStopRequest([msg('Ann', '')], ' ', notBot)).toBeNull());
});

describe('checkLeaveRequests (shared by both monitor loops)', () => {
  it('stop keyword → who and why', () => {
    expect(checkLeaveRequests({ stopKeyword: '!stop' }, [{ sender: 'Ann', text: '!stop' }]))
      .toEqual({ stoppedBy: 'Ann', leftBecause: 'Ann asked the bot to stop (!stop)' });
  });
  it('an external request (operator) also leaves', () => {
    expect(checkLeaveRequests({ external: () => 'operator ran mibot leave' }, [])).toEqual({ leftBecause: 'operator ran mibot leave' });
  });
  it('nothing → stay', () => {
    expect(checkLeaveRequests({ stopKeyword: '!stop', external: () => null }, [{ sender: 'Ann', text: 'hi' }])).toBeNull();
  });
});

describe('the notice', () => {
  it('default message names the bot and the keyword', () => {
    expect(consentMessage(DEFAULT_CONSENT_MESSAGE, { botName: 'MiBot (recording)', stopKeyword: '!stop' }))
      .toBe("Hi — I'm MiBot (recording), recording and transcribing this meeting. Type !stop in chat and I'll leave.");
  });
  it('every platform has default announce steps; a playbook "announce" overrides them', () => {
    for (const p of ['teams', 'zoom', 'meet']) expect(DEFAULT_ANNOUNCE_STEPS[p].length).toBeGreaterThan(0);
    const custom = [{ action: 'log' as const, message: 'x' }];
    expect(announceSteps({ announce: custom }, 'teams')).toBe(custom);
    expect(announceSteps({}, 'teams')).toBe(DEFAULT_ANNOUNCE_STEPS.teams);
  });
  it('validatePlaybook rejects a malformed "announce"', () => {
    expect(() => validatePlaybook({ steps: [], announce: 'nope' })).toThrow(/announce/);
    expect(() => validatePlaybook({ steps: [], announce: [{ action: 'log' }] })).not.toThrow();
  });
});

describe('postConsent', () => {
  it('runs the steps with {{consentMessage}} bound, and reports success', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    expect(await postConsent({ run }, DEFAULT_ANNOUNCE_STEPS.teams, 'hello', 'teams')).toBe(true);
    expect(run.mock.calls[0][0].variables).toEqual({ consentMessage: 'hello' });
  });
  it('a failing step → false, never throws (the caller keeps recording, OQ-4)', async () => {
    const run = vi.fn().mockRejectedValue(new Error('chat disabled'));
    expect(await postConsent({ run }, DEFAULT_ANNOUNCE_STEPS.teams, 'hello', 'teams')).toBe(false);
  });
  it('an empty message (operator opt-out) posts nothing', async () => {
    const run = vi.fn();
    expect(await postConsent({ run }, DEFAULT_ANNOUNCE_STEPS.teams, '  ', 'teams')).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('the real engine types the message into the Teams composer and presses Enter', async () => {
    const log: string[] = [];
    const loc = (desc: string) => ({
      first() { return this; }, locator() { return this; },
      isVisible: async () => true,
      click: async () => { log.push(`click:${desc}`); },
      fill: async (v: string) => { log.push(`fill:${v}`); },
    });
    const page: any = {
      frames: () => [page], mainFrame: () => page, url: () => 'x',
      locator: (sel: string) => loc(sel), getByRole: () => loc('role'), getByText: () => loc('text'),
      keyboard: { press: async (k: string) => { log.push(`press:${k}`); }, type: async () => {} },
    };
    const ok = await postConsent(new PlaybookEngine(page, { botName: 'MiBot' }), DEFAULT_ANNOUNCE_STEPS.teams, 'Recording — type !stop', 'teams');
    expect(ok).toBe(true);
    expect(log).toContain('fill:Recording — type !stop');
    expect(log[log.length - 1]).toBe('press:Enter');
  });
});

describe('config', () => {
  it('defaults: notice on, !stop, " (recording)" suffix', () => {
    const c = validateConfig({});
    expect(c.consentMessage).toBe(DEFAULT_CONSENT_MESSAGE);
    expect(c.consentStopKeyword).toBe(DEFAULT_STOP_KEYWORD);
    expect(c.botNameSuffix).toBe(' (recording)');
  });
  it('an empty consentMessage is an explicit opt-out and is kept', () => expect(validateConfig({ consentMessage: '' } as any).consentMessage).toBe(''));
  it('a blank stop keyword is rejected (it would be unmatchable)', () =>
    expect(validateConfig({ consentStopKeyword: '  ' } as any).consentStopKeyword).toBe(DEFAULT_STOP_KEYWORD));
});

describe('the suffixed display name is still recognized as the bot', () => {
  it('isBot matches the configured botName under any suffix, without relying on botPatterns', async () => {
    const { isBot, loadConfig } = await import('../src/config.js');
    const cfg = loadConfig() as any;
    const saved = { name: cfg.botName, pats: cfg.botPatterns };
    cfg.botName = 'NoteBuddy'; cfg.botPatterns = [];
    try {
      expect(isBot('NoteBuddy (recording)')).toBe(true);
      expect(isBot('Ann')).toBe(false);
    } finally { cfg.botName = saved.name; cfg.botPatterns = saved.pats; }
  });
});
