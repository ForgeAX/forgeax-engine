import { describe, expect, it } from 'vitest';
import { retryable } from '../live-dev.js';

function look(detail: Record<string, unknown>, admitted = true) {
  return {
    status: 200,
    admitted,
    value: { ok: false, error: { code: 'live-not-ready', detail } },
  } as Parameters<typeof retryable>[0];
}

describe('retrying a look that is still starting', () => {
  it('repeats an admitted look that failed for another transient reason', () => {
    expect(retryable(look({ reason: 'bridge reopening' }), 'look', {})).toBe(true);
  });

  it('does not repeat a look that already waited out the whole startup budget', () => {
    expect(retryable(look({ startupWaited: true }), 'look', {})).toBe(false);
  });
});
