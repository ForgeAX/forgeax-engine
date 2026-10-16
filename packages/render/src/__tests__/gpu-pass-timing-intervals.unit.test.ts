import { describe, expect, it } from 'vitest';
import type { GpuPassTimingEntry } from '../record/gpu-pass-timing/contract';
import { summarizeGpuPassTimingIntervals } from '../record/gpu-pass-timing/parser';

const pass = (begin: bigint, end: bigint): GpuPassTimingEntry => ({
  passName: 'work',
  passKind: 'compute',
  executionIndex: 0,
  status: 'measured',
  measurementSource: 'pass-boundary',
  beginningTick: begin.toString(),
  endTick: end.toString(),
  durationNanoseconds: Number(end - begin) * 0.5,
});

describe('GPU interval coverage', () => {
  it('keeps overlap, gaps, equal ticks and u64 precision distinct from summed cost', () => {
    const base = 900719925474099300n;
    const result = summarizeGpuPassTimingIntervals(
      [
        pass(base, base + 10n),
        pass(base + 5n, base + 15n),
        pass(base + 30n, base + 40n),
        pass(base + 20n, base + 20n),
      ],
      0.5,
    ).unwrap();
    expect(result).toEqual({
      measuredPassCount: 4,
      unmeasuredPassCount: 0,
      sumNanoseconds: 15,
      unionNanoseconds: 12.5,
      envelopeNanoseconds: 20,
      overlapNanoseconds: 2.5,
    });
  });

  it('does not turn missing queries into zero-duration measurements', () => {
    const missing: GpuPassTimingEntry = {
      passName: 'missing',
      passKind: 'raster',
      executionIndex: 1,
      status: 'unmeasured',
      reason: { code: 'timestamp-owner-conflict', expected: '', hint: '', detail: {} },
    };
    expect(summarizeGpuPassTimingIntervals([missing], 1).unwrap()).toMatchObject({
      measuredPassCount: 0,
      unmeasuredPassCount: 1,
      unionNanoseconds: 0,
    });
    expect(summarizeGpuPassTimingIntervals([], 1).unwrap()).toMatchObject({
      measuredPassCount: 0,
      unmeasuredPassCount: 0,
      envelopeNanoseconds: 0,
    });
    expect(summarizeGpuPassTimingIntervals([pass(2n, 1n)], 1)).toMatchObject({
      ok: false,
      error: { code: 'timestamp-range-invalid' },
    });
  });
});
