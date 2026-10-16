import { err, ok, type Result } from '@forgeax/engine-types';
import type { GpuPassTimingEntry, GpuPassTimingMeasuredEntry } from './contract.js';
import type { GpuPassTimingReason } from './errors.js';

export interface GpuPassTimingTickInput {
  readonly beginningTick: string;
  readonly endTick: string;
  readonly timestampPeriodNanoseconds: number;
}

export type GpuPassTimingTickResult = Omit<
  GpuPassTimingMeasuredEntry,
  'passName' | 'passKind' | 'executionIndex' | 'measurementSource'
>;

function failure(
  code: GpuPassTimingReason['code'],
  expected: string,
  hint: string,
  detail: { readonly [key: string]: null | boolean | number | string },
): GpuPassTimingReason {
  return { code, expected, hint, detail };
}

function decimal(value: string): bigint | undefined {
  return /^(0|[1-9][0-9]*)$/.test(value) ? BigInt(value) : undefined;
}

export function parseGpuPassTimingTicks(
  input: GpuPassTimingTickInput,
): Result<GpuPassTimingTickResult, GpuPassTimingReason> {
  const period = input.timestampPeriodNanoseconds;
  if (!Number.isFinite(period) || period <= 0) {
    return err(
      failure(
        'timestamp-period-unavailable',
        'timestampPeriodNanoseconds is finite and greater than zero',
        'use a device with a trustworthy positive timestamp period',
        { timestampPeriodNanoseconds: period },
      ),
    );
  }
  const beginning = decimal(input.beginningTick);
  const end = decimal(input.endTick);
  if (beginning === undefined || end === undefined) {
    return err(
      failure(
        'timestamp-range-invalid',
        'raw timestamp ticks are unsigned decimal strings',
        'retain the GPU u64 readback as a decimal string before parsing',
        { beginningTick: input.beginningTick, endTick: input.endTick },
      ),
    );
  }
  if (end < beginning) {
    return err(
      failure(
        'timestamp-range-invalid',
        'end tick is greater than or equal to beginning tick',
        'discard the readback and wait for a later receipt',
        { beginningTick: input.beginningTick, endTick: input.endTick },
      ),
    );
  }
  const delta = end - beginning;
  if (delta > BigInt(Number.MAX_SAFE_INTEGER)) {
    return err(
      failure(
        'timestamp-range-invalid',
        'tick delta converts to a safe finite duration',
        'use a bounded timestamp range or capture a later receipt',
        { beginningTick: input.beginningTick, endTick: input.endTick },
      ),
    );
  }
  const durationNanoseconds = Number(delta) * period;
  if (
    !Number.isFinite(durationNanoseconds) ||
    !Number.isSafeInteger(Math.round(durationNanoseconds))
  ) {
    return err(
      failure(
        'timestamp-range-invalid',
        'derived duration is finite and safely representable',
        'use a smaller tick range or a trustworthy timestamp period',
        { timestampPeriodNanoseconds: period },
      ),
    );
  }
  return ok({
    status: 'measured',
    beginningTick: input.beginningTick,
    endTick: input.endTick,
    durationNanoseconds,
    ...(delta === 0n ? { timerResolution: 'equal-ticks' as const } : {}),
  });
}

export interface GpuPassTimingIntervalSummary {
  readonly measuredPassCount: number;
  readonly unmeasuredPassCount: number;
  /** Sum of intervals, including repeated coverage. Never frame latency. */
  readonly sumNanoseconds: number;
  /** Coverage of the selected intervals, including copy marker envelopes. */
  readonly unionNanoseconds: number;
  /** First beginning to last end, including gaps. Not a native outer query. */
  readonly envelopeNanoseconds: number;
  readonly overlapNanoseconds: number;
}

/** Derive coverage from raw ticks; neither coverage nor a pass is exclusive cost. */
export function summarizeGpuPassTimingIntervals(
  passes: readonly GpuPassTimingEntry[],
  timestampPeriodNanoseconds: number,
): Result<GpuPassTimingIntervalSummary, GpuPassTimingReason> {
  const ranges: { begin: bigint; end: bigint }[] = [];
  let sum = 0n;
  for (const pass of passes) {
    if (pass.status !== 'measured') continue;
    const parsed = parseGpuPassTimingTicks({ ...pass, timestampPeriodNanoseconds });
    if (!parsed.ok) return parsed;
    const begin = BigInt(pass.beginningTick);
    const end = BigInt(pass.endTick);
    ranges.push({ begin, end });
    sum += end - begin;
  }
  ranges.sort((left, right) => (left.begin < right.begin ? -1 : left.begin > right.begin ? 1 : 0));
  let union = 0n;
  let envelope = 0n;
  const first = ranges[0];
  if (first !== undefined) {
    let begin = first.begin;
    let end = first.end;
    for (const range of ranges.slice(1)) {
      if (range.begin > end) {
        union += end - begin;
        begin = range.begin;
      }
      if (range.end > end) end = range.end;
    }
    union += end - begin;
    envelope = end - first.begin;
  }
  const durations: [number, number, number, number] = [0, 0, 0, 0];
  for (const [index, ticks] of [sum, union, envelope, sum - union].entries()) {
    const parsed = parseGpuPassTimingTicks({
      beginningTick: '0',
      endTick: ticks.toString(),
      timestampPeriodNanoseconds,
    });
    if (!parsed.ok) return parsed;
    durations[index] = parsed.value.durationNanoseconds;
  }
  return ok({
    measuredPassCount: ranges.length,
    unmeasuredPassCount: passes.length - ranges.length,
    sumNanoseconds: durations[0],
    unionNanoseconds: durations[1],
    envelopeNanoseconds: durations[2],
    overlapNanoseconds: durations[3],
  });
}
