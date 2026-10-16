import { describe, expect, it } from 'vitest';
import { createExclusiveTiming, type ToolTimingPhase } from '../src/index.js';

describe('exclusive tool timing', () => {
  it('accounts for each operation phase exactly once', () => {
    const clock = [0, 3, 3, 10, 10, 14, 14, 20, 20, 25, 25, 40];
    let index = 0;
    const timing = createExclusiveTiming(() => clock[index++] ?? 40);
    const phases: ToolTimingPhase[] = ['lookup', 'lease', 'transport', 'capture', 'finalize', 'analyze'];
    for (const phase of phases) {
      timing.begin(phase);
      timing.end(phase);
    }
    const result = timing.finish();
    expect(result.totalMs).toBe(40);
    expect(result.phases.lookup).toEqual({ status: 'observed', durationMs: 3 });
    expect(
      Object.values(result.phases).reduce(
        (sum, value) => (value.status === 'observed' ? sum + value.durationMs : sum),
        0,
      ),
    ).toBe(40);
    expect(result.phases.execute).toEqual({ status: 'not-applicable' });
  });

  it('rejects overlapping, repeated, and unclosed phases', () => {
    const timing = createExclusiveTiming(() => 0);
    timing.begin('lookup');
    expect(() => timing.begin('lease')).toThrow();
    expect(() => timing.end('lease')).toThrow();
    timing.end('lookup');
    expect(() => timing.end('lookup')).toThrow();
  });
});
