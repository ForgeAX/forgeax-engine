import { err, ok, type Result } from '@forgeax/engine-types';
import { createRhiDebugError, type RhiDebugError } from '../errors';
import type { TapeIndex } from '../protocol/tape-index';
import type { RhiCallEvent, Tape } from '../protocol/types';

/**
 * Work a replay leaves out to estimate its cost. A skipped pass is never
 * begun, so its attachments and storage writes keep whatever the replay
 * started with (zero, seeded bytes or the cleared target); later passes still
 * run and read that content. A skipped work drops one draw or dispatch while
 * its pass still runs. The image is no longer correct; the timing delta is a
 * cost estimate.
 */
export interface ReplaySkip {
  /** RegExp source matched against each closed pass's label. */
  readonly passLabel?: string;
  /** `passIndex` values from `timePasses` / `rhi summary --passes`. */
  readonly passIndices?: readonly number[];
  /** `workIndex` values of draws or dispatches to drop inside their pass. */
  readonly workIndices?: readonly number[];
}

export interface ReplaySkipPlan {
  readonly passIndices: readonly number[];
  readonly workIndices: readonly number[];
  /** Tape event indices the replay does not execute. */
  readonly events: ReadonlySet<number>;
}

type PassBegin = Extract<RhiCallEvent, { kind: 'beginRenderPass' | 'beginComputePass' }>;

export function passLabel(tape: Tape, beginEventIndex: number): string | null {
  const event = tape.events[beginEventIndex] as PassBegin | undefined;
  return event?.desc?.label ?? null;
}

/**
 * Resolve a skip request against the tape. Only closed passes can be skipped;
 * the events dropped for a pass are its begin and every event naming its pass
 * handle, so queue writes recorded while it was open still run.
 */
export function planReplaySkip(
  tape: Tape,
  index: TapeIndex,
  skip: ReplaySkip,
): Result<ReplaySkipPlan, RhiDebugError> {
  const label = compileLabel(skip.passLabel);
  if (!label.ok) return label;
  const closed = index.passes.filter((pass) => pass.endEventIndex !== undefined);
  const wanted = new Set(skip.passIndices ?? []);
  for (const passIndex of wanted)
    if (!closed.some((pass) => pass.passIndex === passIndex))
      return position(passIndex, index.passes.length);
  const events = new Set<number>();
  const passIndices: number[] = [];
  for (const pass of closed) {
    const name = passLabel(tape, pass.beginEventIndex);
    const byLabel = label.value !== undefined && name !== null && label.value.test(name);
    if (!byLabel && !wanted.has(pass.passIndex)) continue;
    passIndices.push(pass.passIndex);
    for (const eventIndex of passEvents(tape, pass.beginEventIndex, pass.endEventIndex as number))
      events.add(eventIndex);
  }
  const workIndices: number[] = [];
  for (const workIndex of skip.workIndices ?? []) {
    const work = index.works[workIndex];
    if (work === undefined) return position(workIndex, index.works.length);
    if (events.has(work.eventIndex)) continue;
    events.add(work.eventIndex);
    workIndices.push(workIndex);
  }
  return ok({ passIndices, workIndices: workIndices.sort((a, b) => a - b), events });
}

function passEvents(tape: Tape, begin: number, end: number): number[] {
  const handle = (tape.events[begin] as PassBegin).passHandleId;
  const events = [begin];
  for (let eventIndex = begin + 1; eventIndex <= end; eventIndex++) {
    const event = tape.events[eventIndex] as { passHandleId?: unknown };
    if (event.passHandleId === handle) events.push(eventIndex);
  }
  return events;
}

function compileLabel(source: string | undefined): Result<RegExp | undefined, RhiDebugError> {
  if (source === undefined || source === '') return ok(undefined);
  try {
    return ok(new RegExp(source));
  } catch (cause) {
    return invalid(`passLabel is not a valid RegExp: ${String(cause)}`);
  }
}

function position(requested: number, available: number): Result<never, RhiDebugError> {
  return err(createRhiDebugError('replay-position-invalid', { requested, available }));
}

function invalid(cause: string): Result<never, RhiDebugError> {
  return err(createRhiDebugError('replay-capability-mismatch', { stage: 'replay', cause }));
}
