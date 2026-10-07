import type { Playbook, PlaybookStep } from './playbook.js';
import { interpolateVars } from './playbook.js';

/**
 * Wave 10 #2: recording disclosure. The bot used to join and record silently, with no notice and
 * no way for anyone but the operator to stop it — a legal exposure on the first external call.
 *
 * Decisions (spec §7): a participant typing the stop keyword makes the bot LEAVE; the recording
 * is kept (OQ-2). If the notice can't be posted the bot KEEPS recording and flags it (OQ-4).
 */
export const DEFAULT_CONSENT_MESSAGE =
  "Hi — I'm {{botName}}, recording and transcribing this meeting. Type {{stopKeyword}} in chat and I'll leave.";
export const DEFAULT_STOP_KEYWORD = '!stop';

/**
 * Chat-posting steps per platform, used when a playbook has no "announce" section. Chat UIs are
 * among the most volatile surfaces, so these are deliberately overridable from
 * ~/.config/mibot/playbooks/<platform>.json ("announce": [...]) without a rebuild — and they
 * need one live check per platform (spec §6). {{consentMessage}} is the text to send.
 */
export const DEFAULT_ANNOUNCE_STEPS: Record<string, PlaybookStep[]> = {
  teams: [
    { action: 'click', selector: "[data-tid='chat-button'], #chat-button, button[aria-label='Chat']", optional: true, timeout: 10000 },
    { action: 'fill', selector: "[data-tid='ckeditor'], div[role='textbox'][contenteditable='true']", value: '{{consentMessage}}', timeout: 15000 },
    { action: 'press', key: 'Enter' },
  ],
  zoom: [
    { action: 'click', selector: "button[aria-label*='chat' i]", frame: 'any', optional: true, timeout: 10000 },
    { action: 'fill', selector: "#chat-textarea, textarea[class*='chat'], [contenteditable='true'][class*='chat']", frame: 'any', value: '{{consentMessage}}', timeout: 15000 },
    { action: 'press', key: 'Enter' },
  ],
  // Camofox's `press` sends synthetic key events, which Meet's composer ignores — click Send instead.
  meet: [
    { action: 'js_click', text: 'Chat with everyone', optional: true },
    { action: 'wait', delay: 1500 },
    { action: 'type', text: 'Send a message', value: '{{consentMessage}}' },
    {
      action: 'js_click',
      expression: `(() => { const b = document.querySelector('button[aria-label^="Send"], button[jsname="SoqoBf"]'); if (!b) return 'not found'; b.click(); return 'clicked send'; })()`,
    },
  ],
};

export function consentMessage(template: string, vars: { botName: string; stopKeyword: string }): string {
  return interpolateVars(template, vars);
}

export function announceSteps(playbook: Pick<Playbook, 'announce'>, platform: string): PlaybookStep[] {
  return playbook.announce ?? DEFAULT_ANNOUNCE_STEPS[platform] ?? [];
}

/**
 * Post the notice through the meeting's own playbook engine. Never throws: returns whether it
 * was posted, because the caller keeps recording either way (OQ-4) and only needs to know.
 */
export async function postConsent(
  engine: { run(playbook: Playbook): Promise<void> },
  steps: PlaybookStep[],
  message: string,
  platform: string,
): Promise<boolean> {
  if (!message.trim() || steps.length === 0) return false;
  try {
    await engine.run({ name: `${platform} recording notice`, platform, steps, variables: { consentMessage: message } });
    return true;
  } catch (err) {
    console.error(`[mibot] WARN: could not post the recording notice: ${(err as Error).message}`);
    return false;
  }
}

/**
 * The first chat message that asks the bot to stop: the whole message (trimmed) equals the
 * keyword, case-insensitively, from someone who is not the bot itself or another bot.
 * Returns the sender, or null.
 */
export function findStopRequest(
  messages: Array<{ sender: string; text: string }>,
  keyword: string,
  isBotSender: (name: string) => boolean,
): string | null {
  const want = keyword.trim().toLowerCase();
  if (!want) return null;
  for (const m of messages) {
    if (m.text.trim().toLowerCase() !== want) continue;
    if (!m.sender || isBotSender(m.sender)) continue;
    return m.sender;
  }
  return null;
}
