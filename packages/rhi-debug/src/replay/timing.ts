import type { Buffer, QuerySet, RhiCommandEncoder } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import { createRhiDebugError, type RhiDebugError } from '../errors';
import type { TapeIndex } from '../protocol/tape-index';
import type { RhiCallEvent } from '../protocol/types';
import { eventFailure, executeEvent, type ReplayExecutionContext } from './execute';
import { isRetainedCreate } from './prefix';
import { readReplayResource } from './readback';

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

/** @internal Session state a timing replay drives; `reset` re-prepares bootstrap resources. */
export interface TimingHost {
  readonly context: ReplayExecutionContext;
  readonly index: TapeIndex;
  readonly retained: ReadonlySet<string>;
  reset(): Promise<Result<void, RhiDebugError>>;
}

type PassBegin = Extract<RhiCallEvent, { kind: 'beginRenderPass' | 'beginComputePass' }>;

const QUERIES_PER_SET = 4096;
const QUERY_RESOLVE_COPY_SRC = 0x200 | 0x4;
const TIMING_ID = 'replay:timing';

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
  const { context, index } = host;
  const { device } = context;
  const period = device.caps.timestampPeriodNanoseconds;
  if (!device.caps.timestampQuery || period === null)
    return err(
      createRhiDebugError('replay-capability-mismatch', {
        stage: 'replay',
        cause: 'per-pass timing needs a replay device with the timestamp-query feature',
      }),
    );
  const passes = index.passes.filter((pass) => pass.endEventIndex !== undefined);
  const slotByBegin = new Map(passes.map((pass, slot) => [pass.beginEventIndex, slot]));
  const prepared = await host.reset();
  if (!prepared.ok) return prepared;
  const sets: string[] = [];
  for (let first = 0; first < passes.length * 2; first += QUERIES_PER_SET) {
    const count = Math.min(QUERIES_PER_SET, passes.length * 2 - first);
    const querySet = device.createQuerySet({ type: 'timestamp', count });
    if (!querySet.ok) return timingFailure(`timestamp query set: ${querySet.error.hint}`);
    const id = `${TIMING_ID}:set:${sets.length}`;
    const registered = context.table.set(id, { kind: 'query-set', value: querySet.value });
    if (!registered.ok) return registered;
    sets.push(id);
  }

  for (let eventIndex = 0; eventIndex < context.tape.events.length; eventIndex++) {
    const event = context.tape.events[eventIndex] as RhiCallEvent;
    if (signal?.aborted) return eventFailure(eventIndex, event, 'lookup', 'timing was aborted');
    if (isRetainedCreate(context, event, host.retained)) continue;
    const slot = slotByBegin.get(eventIndex);
    const replayEvent =
      slot === undefined || (event.kind !== 'beginRenderPass' && event.kind !== 'beginComputePass')
        ? event
        : timedBegin(event, sets, slot);
    const executed = await executeEvent(context, replayEvent, eventIndex);
    if (!executed.ok) return executed;
  }

  const ticks = await resolveTicks(context, sets, passes.length * 2);
  if (!ticks.ok) return ticks;
  let total = 0;
  const timed = passes.map((pass, slot): PassTiming => {
    const begin = ticks.value[slot * 2] ?? 0n;
    const end = ticks.value[slot * 2 + 1] ?? 0n;
    const nanoseconds = end === 0n || end < begin ? null : Number(end - begin) * period;
    total += nanoseconds ?? 0;
    const event = context.tape.events[pass.beginEventIndex] as PassBegin;
    return {
      passIndex: pass.passIndex,
      kind: pass.kind,
      label: event.desc?.label ?? null,
      workIndices: pass.workIndices,
      gpuNanoseconds: nanoseconds,
    };
  });
  return ok({ passes: timed, totalGpuNanoseconds: total });
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

function timingFailure(cause: string): Result<never, RhiDebugError> {
  return err(createRhiDebugError('readback-failed', { stage: 'readback', cause }));
}
