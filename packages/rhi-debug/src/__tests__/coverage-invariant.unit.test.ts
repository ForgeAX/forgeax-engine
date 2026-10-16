// AC-06: DEFERRED_COMMANDS set assertion.
//
// Verifies the deferred-commands constant contains exactly the 1 deferred
// command (writeTimestamp) — no more, no less. Any drift in
// the constant (missing member, extra member) will fail this test,
// catching both accidental removal and accidental addition of commands
// that should either be fully captured or documented as explicitly
// out-of-scope.

import { describe, expect, it } from 'vitest';
import { DEFERRED_COMMANDS } from '../types';

describe('DEFERRED_COMMANDS (AC-06)', () => {
  it('contains exactly the 1 deferred command', () => {
    expect(DEFERRED_COMMANDS.size).toBe(1);

    const expected = new Set(['writeTimestamp']);

    for (const cmd of expected) {
      expect(DEFERRED_COMMANDS.has(cmd)).toBe(true);
    }
  });

  it('has no unexpected members', () => {
    // Every member must be in the AC-06 contract set.
    const allowed = new Set(['writeTimestamp']);

    for (const cmd of DEFERRED_COMMANDS) {
      expect(allowed.has(cmd)).toBe(true);
    }
  });
});
