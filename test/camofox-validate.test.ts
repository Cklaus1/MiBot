import { describe, it, expect } from 'vitest';
import { parseCamofoxResponse, CamofoxApiError } from '../src/camofox.js';

// F8/R8: every camofox REST call must flow through one validator that (a) rejects non-2xx
// with a typed error carrying status + body excerpt, and (b) rejects non-JSON bodies
// (HTML error pages from a crashed server) instead of returning malformed data that
// callers treat as a valid snapshot/ref. Old api() did `return res.json()` with no
// res.ok check — a 500 "Internal Server Error" page threw an opaque SyntaxError deep in
// findRef, or worse parsed partially. This pure core makes the contract unit-testable.
describe('parseCamofoxResponse (R8 centralized validation)', () => {
  it('parses a valid 2xx JSON body', () => {
    const data = parseCamofoxResponse('/snapshot', 200, true, '{"snapshot":"button [e1]","refsCount":1}');
    expect(data).toEqual({ snapshot: 'button [e1]', refsCount: 1 });
  });

  it('throws CamofoxApiError with status on a non-2xx response', () => {
    let err: unknown;
    try {
      parseCamofoxResponse('/click', 500, false, 'Internal Server Error');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CamofoxApiError);
    expect((err as CamofoxApiError).status).toBe(500);
    expect((err as CamofoxApiError).path).toBe('/click');
  });

  it('includes a body excerpt in the error for diagnosis', () => {
    try {
      parseCamofoxResponse('/type', 404, false, 'tab not found: e99');
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as CamofoxApiError).message).toContain('404');
      expect((e as CamofoxApiError).bodyExcerpt).toContain('tab not found');
    }
  });

  it('throws CamofoxApiError (not a raw SyntaxError) on a non-JSON 2xx body', () => {
    let err: unknown;
    try {
      parseCamofoxResponse('/snapshot', 200, true, '<html><body>502 Bad Gateway</body></html>');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CamofoxApiError);
    expect((err as CamofoxApiError).message.toLowerCase()).toContain('json');
  });

  it('truncates a very long body excerpt', () => {
    const huge = 'x'.repeat(5000);
    try {
      parseCamofoxResponse('/eval', 500, false, huge);
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as CamofoxApiError).bodyExcerpt.length).toBeLessThanOrEqual(300);
    }
  });

  it('accepts a JSON body that is a bare value (e.g. array)', () => {
    const data = parseCamofoxResponse('/tabs', 200, true, '[]');
    expect(data).toEqual([]);
  });
});
