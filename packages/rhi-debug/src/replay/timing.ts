import type { Buffer, QuerySet, RhiCommandEncoder } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import { createRhiDebugError, type RhiDebugError } from '../errors';
import type { TapeIndex } from '../protocol/tape-index';
import type { RhiCallEvent } from '../protocol/types';
import { eventFailure, executeEvent, type ReplayExecutionContext } from './execute';
import { isRetainedCreate } from './prefix';
import { readReplayResource } from './readback';
import {
  createIsolation,
  isEncoderDebugEvent,
  type ReplayIsolation,
  splitEncoder,
  submitIsolated,
} from './timing-isolate';
import { passLabel, type ReplaySkipPlan } from './timing-plan';
import type { TimedInterval } from './timing-stats';
import type { SteadyRestoreSummary } from './timing-steady';

export interface PassTiming {
  readonly passIndex: number;
  readonly kind: 'render' | 'compute';
  readonly label: string | null;
  /** Works recorded inside the pass, in order. */
  readonly workIndices: readonly number[];
  /** GPU time between the pass's begin and end timestamps; null when never executed. */
  readonly gpuNanoseconds: number | null;
}

export interface FrameTiming {
  readonly passes: readonly PassTiming[];
  /** Sum of every timed pass. */
  readonly totalGpuNanoseconds: number;
}

/** @internal Outcome of switching a session to steady replay. */
export type SteadyEntry =
  | { readonly steady: true; readonly summary: SteadyRestoreSummary }
  | { readonly steady: false; readonly reason: string };

/** @internal Session state a timing replay drives; `reset` re-prepares bootstrap resources. */
export interface TimingHost {
  readonly context: ReplayExecutionContext;
  readonly index: TapeIndex;
  readonly retained: ReadonlySet<string>;
  /** Start a replay from capture-start state: reload, or GPU-restore while steady. */
  reset(): Promise<Result<void, RhiDebugError>>;
  /**
   * Keep every bootstrap resource across replays and restore mutable bytes
   * from pristine GPU copies, so replays need no CPU upload.
   */
  enterSteady?(): Promise<Result<SteadyEntry, RhiDebugError>>;
  leaveSteady?(): Result<void, RhiDebugError>;
  /** Keep a replay-owned resource across steady resets. */
  keep?(handleId: string): void;
}

type PassBegin = Extract<RhiCallEvent, { kind: 'beginRenderPass' | 'beginComputePass' }>;

/** @internal Options of one timed replay. */
export interface ReplayRunOptions {
  /** Submit and drain the queue around every timed pass; see `ReplayIsolation`. */
  readonly isolate?: boolean;
  /** Events the replay leaves out; skipped passes report no interval. */
  readonly skip?: ReplaySkipPlan;
}

/** Why an executed pass has no usable interval in a replay. */
export type MissingTimestampReason = 'unwritten' | 'zero' | 'inverted';

/** @internal A pass the replay executed whose timestamps cannot form an interval. */
export interface MissingTimestamp {
  readonly slot: number;
  readonly reason: MissingTimestampReason;
}

/** @internal One timed replay, aligned with `closedPasses(index)`. */
export interface TimedReplay {
  /** Pass interval in nanoseconds from the earliest timed begin; null when skipped or unwritten. */
  readonly intervals: readonly (TimedInterval | null)[];
  /** Executed passes whose interval is null, with the reason. */
  readonly missing: readonly MissingTimestamp[];
}

interface EventPlan {
  readonly slotByBegin: ReadonlyMap<number, number>;
  readonly skip: ReadonlySet<number>;
  readonly isolation: ReplayIsolation | undefined;
  readonly splitBefore: ReadonlyMap<number, string>;
  readonly splitAfter: ReadonlyMap<number, string>;
}

/** @internal Queries per replay-owned timestamp set. */
export const QUERIES_PER_SET = 4096;
const QUERY_RESOLVE_COPY_SRC = 0x200 | 0x4;
const TIMING_ID = 'replay:timing';

/** @internal Passes that have both a begin and an end on the tape; timing slots follow this order. */
export function closedPasses(index: TapeIndex): TapeIndex['passes'] {
  return index.passes.filter((pass) => pass.endEventIndex !== undefined);
}

/**
 * Replay the whole frame once with replay-owned begin/end timestamps on every
 * closed pass. Recorded pass timestamps are replaced for this replay only;
 * their resolves then read unwritten queries, which affects no timed pass.
 * Times come from the replay device, so they rank passes rather than restate
 * the capture device's frame time.
 */
export async function timeReplayPasses(
  host: TimingHost,
  signal?: AbortSignal,
): Promise<Result<FrameTiming, RhiDebugError>> {
  const replay = await replayTimedFrame(host, {}, signal);
  if (!replay.ok) return replay;
  let total = 0;
  const timed = closedPasses(host.index).map((pass, slot): PassTiming => {
    const interval = replay.value.intervals[slot] ?? null;
    const nanoseconds = interval === null ? null : interval.end - interval.begin;
    total += nanoseconds ?? 0;
    return {
      passIndex: pass.passIndex,
      kind: pass.kind,
      label: passLabel(host.context.tape, pass.beginEventIndex),
      workIndices: pass.workIndices,
      gpuNanoseconds: nanoseconds,
    };
  });
  return ok({ passes: timed, totalGpuNanoseconds: total });
}

/** @internal Reset, replay the frame once with timestamps on every executed pass, and read them. */
export async function replayTimedFrame(
  host: TimingHost,
  options: ReplayRunOptions,
  signal?: AbortSignal,
): Promise<Result<TimedReplay, RhiDebugError>> {
  const { context } = host;
  const period = timestampPeriod(context);
  if (!period.ok) return period;
  const passes = closedPasses(host.index);
  const prepared = await host.reset();
  if (!prepared.ok) return prepared;
  const sets = createQuerySets(context, passes.length * 2, TIMING_ID);
  if (!sets.ok) return sets;
  const encoded = await encodeTimedFrame(host, options, sets.value, signal);
  if (!encoded.ok) return encoded;
  const ticks = await resolveTicks(context, sets.value, passes.length * 2);
  if (!ticks.ok) return ticks;
  const skipped = new Set(options.skip?.passIndices ?? []);
  return ok(timedReplay(ticks.value, passes, skipped, period.value));
}

/** @internal Intervals and missing-timestamp reasons of one replay's resolved ticks. */
export function timedReplay(
  ticks: BigUint64Array,
  passes: TapeIndex['passes'],
  skipped: ReadonlySet<number>,
  period: number,
): TimedReplay {
  const missing: MissingTimestamp[] = [];
  passes.forEach((pass, slot) => {
    if (skipped.has(pass.passIndex)) return;
    const begin = ticks[slot * 2] ?? 0n;
    const end = ticks[slot * 2 + 1] ?? 0n;
    if (begin === 0n && end === 0n) missing.push({ slot, reason: 'unwritten' });
    else if (begin === 0n || end === 0n) missing.push({ slot, reason: 'zero' });
    else if (end < begin) missing.push({ slot, reason: 'inverted' });
  });
  return { intervals: tickIntervals(ticks, passes, skipped, period), missing };
}

/** @internal Nanoseconds per timestamp tick, or a capability error without timestamp queries. */
export function timestampPeriod(context: ReplayExecutionContext): Result<number, RhiDebugError> {
  const period = context.device.caps.timestampPeriodNanoseconds;
  if (!context.device.caps.timestampQuery || period === null)
    return err(
      createRhiDebugError('replay-capability-mismatch', {
        stage: 'replay',
        cause: 'per-pass timing needs a replay device with the timestamp-query feature',
      }),
    );
  return ok(period);
}

/**
 * @internal Run every recorded event once, writing pass `slot`'s begin and
 * end timestamps to queries `2 * slot` and `2 * slot + 1` of `sets`.
 */
export async function encodeTimedFrame(
  host: TimingHost,
  options: ReplayRunOptions,
  sets: readonly string[],
  signal?: AbortSignal,
): Promise<Result<void, RhiDebugError>> {
  const { context } = host;
  const plan = eventPlan(context, closedPasses(host.index), options);
  for (let eventIndex = 0; eventIndex < context.tape.events.length; eventIndex++) {
    const event = context.tape.events[eventIndex] as RhiCallEvent;
    if (signal?.aborted) return eventFailure(eventIndex, event, 'lookup', 'timing was aborted');
    if (isRetainedCreate(context, event, host.retained)) continue;
    const executed = await runEvent(context, plan, sets, event, eventIndex);
    if (!executed.ok) return executed;
  }
  return ok(undefined);
}

function eventPlan(
  context: ReplayExecutionContext,
  passes: TapeIndex['passes'],
  options: ReplayRunOptions,
): EventPlan {
  const skippedPasses = new Set(options.skip?.passIndices ?? []);
  const splitBefore = new Map<number, string>();
  const splitAfter = new Map<number, string>();
  for (const pass of passes) {
    if (!options.isolate || skippedPasses.has(pass.passIndex)) continue;
    const begin = context.tape.events[pass.beginEventIndex] as PassBegin;
    splitBefore.set(pass.beginEventIndex, begin.cmdHandleId);
    splitAfter.set(pass.endEventIndex as number, begin.cmdHandleId);
  }
  return {
    slotByBegin: new Map(passes.map((pass, slot) => [pass.beginEventIndex, slot])),
    skip: options.skip?.events ?? new Set(),
    isolation: options.isolate ? createIsolation() : undefined,
    splitBefore,
    splitAfter,
  };
}

async function runEvent(
  context: ReplayExecutionContext,
  plan: EventPlan,
  sets: readonly string[],
  event: RhiCallEvent,
  eventIndex: number,
): Promise<Result<void, RhiDebugError>> {
  if (plan.skip.has(eventIndex)) return ok(undefined);
  const { isolation } = plan;
  if (isolation !== undefined) {
    if (isEncoderDebugEvent(event)) return ok(undefined);
    if (event.kind === 'submit') return submitIsolated(context, isolation, event, eventIndex);
    const before = plan.splitBefore.get(eventIndex);
    if (before !== undefined) {
      const split = splitEncoder(context, isolation, before, event, eventIndex);
      if (!split.ok) return split;
    }
  }
  const slot = plan.slotByBegin.get(eventIndex);
  const replayEvent =
    slot === undefined || (event.kind !== 'beginRenderPass' && event.kind !== 'beginComputePass')
      ? event
      : timedBegin(event, sets, slot);
  const executed = await executeEvent(context, replayEvent, eventIndex);
  if (!executed.ok) return executed;
  const after = plan.splitAfter.get(eventIndex);
  if (isolation === undefined || after === undefined) return ok(undefined);
  return splitEncoder(context, isolation, after, event, eventIndex);
}

/** @internal Pass intervals from raw ticks; unwritten (zero) or inverted pairs become null. */
export function tickIntervals(
  ticks: BigUint64Array,
  passes: TapeIndex['passes'],
  skipped: ReadonlySet<number>,
  period: number,
): (TimedInterval | null)[] {
  const raw = passes.map((pass, slot) => {
    const begin = ticks[slot * 2] ?? 0n;
    const end = ticks[slot * 2 + 1] ?? 0n;
    return skipped.has(pass.passIndex) || begin === 0n || end === 0n || end < begin
      ? null
      : { begin, end };
  });
  let origin: bigint | undefined;
  for (const interval of raw)
    if (interval !== null && (origin === undefined || interval.begin < origin))
      origin = interval.begin;
  return raw.map((interval) =>
    interval === null || origin === undefined
      ? null
      : {
          begin: Number(interval.begin - origin) * period,
          end: Number(interval.end - origin) * period,
        },
  );
}

/** @internal Register timestamp query sets holding `queryCount` queries under `prefix`. */
export function createQuerySets(
  context: ReplayExecutionContext,
  queryCount: number,
  prefix: string,
): Result<string[], RhiDebugError> {
  const sets: string[] = [];
  for (let first = 0; first < queryCount; first += QUERIES_PER_SET) {
    const count = Math.min(QUERIES_PER_SET, queryCount - first);
    const querySet = context.device.createQuerySet({ type: 'timestamp', count });
    if (!querySet.ok) return timingFailure(`timestamp query set: ${querySet.error.hint}`);
    const id = `${prefix}:set:${sets.length}`;
    const registered = context.table.set(id, { kind: 'query-set', value: querySet.value });
    if (!registered.ok) return registered;
    sets.push(id);
  }
  return ok(sets);
}

function timedBegin(begin: PassBegin, sets: readonly string[], slot: number): PassBegin {
  const first = (slot * 2) % QUERIES_PER_SET;
  const timestampWrites = { beginningOfPassWriteIndex: first, endOfPassWriteIndex: first + 1 };
  const timestampQuerySetHandleId = sets[Math.floor((slot * 2) / QUERIES_PER_SET)] as string;
  return {
    ...begin,
    timestampQuerySetHandleId,
    desc: { ...begin.desc, timestampWrites },
  } as PassBegin;
}

async function resolveTicks(
  context: ReplayExecutionContext,
  sets: readonly string[],
  queryCount: number,
): Promise<Result<BigUint64Array, RhiDebugError>> {
  const { device, table } = context;
  const size = Math.max(8, queryCount * 8);
  const buffer = device.createBuffer({ size, usage: QUERY_RESOLVE_COPY_SRC });
  if (!buffer.ok) return timingFailure(`timestamp resolve buffer: ${buffer.error.hint}`);
  const bufferId = `${TIMING_ID}:resolve`;
  const registered = table.set(
    bufferId,
    { kind: 'buffer', value: buffer.value as Buffer },
    {
      desc: { size },
    },
  );
  if (!registered.ok) return registered;
  const encoder = device.createCommandEncoder({});
  if (!encoder.ok) return timingFailure(`timestamp resolve encoder: ${encoder.error.hint}`);
  const command: RhiCommandEncoder = encoder.value;
  for (const [setIndex, id] of sets.entries()) {
    const first = setIndex * QUERIES_PER_SET;
    const count = Math.min(QUERIES_PER_SET, queryCount - first);
    const querySet = table.get(id)?.resource.value as QuerySet;
    const resolved = command.resolveQuerySet(querySet, 0, count, buffer.value, first * 8);
    if (!resolved.ok) return timingFailure(`timestamp resolve: ${resolved.error.hint}`);
  }
  const finished = command.finish();
  if (!finished.ok) return timingFailure(`timestamp resolve finish: ${finished.error.hint}`);
  const submitted = device.queue.submit([finished.value]);
  if (!submitted.ok) return timingFailure(`timestamp resolve submit: ${submitted.error.hint}`);
  const read = await readReplayResource(
    device,
    table,
    bufferId,
    undefined,
    context.createShaderModule,
  );
  if (!read.ok) return read;
  return ok(new BigUint64Array(read.value.bytes.slice(0, queryCount * 8).buffer));
}

/** @internal */
export function timingFailure(cause: string): Result<never, RhiDebugError> {
  return err(createRhiDebugError('readback-failed', { stage: 'readback', cause }));
}
