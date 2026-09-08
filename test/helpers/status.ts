import { updateMeetingStatus } from '../../src/db.js';
import type { MeetingStatus } from '../../src/status.js';

/**
 * Walk a meeting along the real lifecycle to `target`, one legal step at a time.
 *
 * Tests used to set up state by writing the status they wanted directly — usually
 * `scheduled -> in_call`, skipping `joining`. That jump was only ever possible because
 * updateMeeting validated the column NAME and never the VALUE; production has always gone
 * through `joining` (bot.ts stamps it before either engine reaches in_call). Now that the
 * transition table is enforced, setup has to take the same path production takes, which is
 * what we want: a fixture that can't be built by a legal sequence is a fixture that can't
 * occur in production either.
 */
const MAIN_LINE: MeetingStatus[] = ['scheduled', 'joining', 'in_call', 'processing', 'done'];

export function advanceMeeting(id: number, target: MeetingStatus, from: MeetingStatus = 'scheduled'): void {
  const start = MAIN_LINE.indexOf(from);
  const end = MAIN_LINE.indexOf(target);
  if (end === -1) {
    // Off the main line (failed/missed/cancelled) — reachable in one step from any active status.
    updateMeetingStatus(id, target);
    return;
  }
  for (let i = start + 1; i <= end; i++) updateMeetingStatus(id, MAIN_LINE[i]);
}
