import { describe, it, expect } from 'vitest';
import { parseEventsPayload } from '../src/calendar.js';

// CA1: ms365/gws can exit non-zero while writing an error object to stdout
// (`{"error":{...}}`). The old path JSON-parsed that as success → data.value undefined →
// 0 meetings, NO error logged (silent). parseEventsPayload accepts only the expected array
// shape and throws on an error payload / wrong shape so syncCalendar logs + surfaces it.
describe('CA1 parseEventsPayload shape validation', () => {
  it('extracts the M365 .value array', () => {
    expect(parseEventsPayload('{"value":[{"id":"1"}]}')).toEqual([{ id: '1' }]);
  });

  it('extracts the Google .items array', () => {
    expect(parseEventsPayload('{"items":[{"id":"2"}]}')).toEqual([{ id: '2' }]);
  });

  it('accepts a bare top-level array', () => {
    expect(parseEventsPayload('[{"id":"3"}]')).toEqual([{ id: '3' }]);
  });

  it('throws on an error payload even though it is valid JSON (CA1 core)', () => {
    expect(() => parseEventsPayload('{"error":{"code":"InvalidAuthenticationToken"}}')).toThrow(/error/i);
  });

  it('throws when the shape has no events array', () => {
    expect(() => parseEventsPayload('{"unexpected":true}')).toThrow();
  });

  it('throws on non-JSON stdout', () => {
    expect(() => parseEventsPayload('not json')).toThrow();
  });
});
