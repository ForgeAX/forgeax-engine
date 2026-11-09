import type { CommandBuffer } from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import type { RhiDebugError } from '../errors';
import type { RhiCallEvent } from '../protocol/types';
import { eventFailure, type ReplayExecutionContext } from './execute';
import { requireResource } from './execute-support';

/**
 * Isolated timing splits every encoder around each timed pass and submits the
 * pieces one at a time, waiting for the queue to drain after each. Queue
 * writes recorded before the tape's submit still run before every piece, as
 * in the capture. Isolation removes overlap between passes and any GPU
 * parallelism, so the isolated sum is an upper bound of the real frame.
 */
export interface ReplayIsolation {
  /** Finished encoder pieces per command-encoder handle, in recording order. */
  readonly segments: Map<string, CommandBuffer[]>;
}

export function createIsolation(): ReplayIsolation {
  return { segments: new Map() };
}

/** Encoder-level debug groups are dropped so splitting cannot unbalance them. */
export function isEncoderDebugEvent(event: RhiCallEvent): boolean {
  return (
    event.kind === 'pushDebugGroup' ||
    event.kind === 'popDebugGroup' ||
    event.kind === 'insertDebugMarker'
  );
}

/** Finish encoder `cmdHandleId` into a segment and continue on a fresh encoder. */
export function splitEncoder(
  context: ReplayExecutionContext,
  isolation: ReplayIsolation,
  cmdHandleId: string,
  event: RhiCallEvent,
  eventIndex: number,
): Result<void, RhiDebugError> {
  const encoder = requireResource(context, cmdHandleId, 'command', eventIndex, event.kind);
  if (!encoder.ok) return encoder;
  const finished = encoder.value.finish();
  if (!finished.ok) return eventFailure(eventIndex, event, 'finish', finished.error);
  const next = context.device.createCommandEncoder({});
  if (!next.ok) return eventFailure(eventIndex, event, 'encode', next.error);
  const segments = isolation.segments.get(cmdHandleId) ?? [];
  segments.push(finished.value);
  isolation.segments.set(cmdHandleId, segments);
  const descriptor = context.table.get(cmdHandleId)?.descriptor;
  return context.table.set(cmdHandleId, { kind: 'command', value: next.value }, descriptor);
}

/** Replace a tape submit: every segment, then each final buffer, one at a time. */
export async function submitIsolated(
  context: ReplayExecutionContext,
  isolation: ReplayIsolation,
  event: Extract<RhiCallEvent, { kind: 'submit' }>,
  eventIndex: number,
): Promise<Result<void, RhiDebugError>> {
  for (const id of event.cmdHandleIds) {
    const last = requireResource(context, id, 'command-buffer', eventIndex, event.kind);
    if (!last.ok) return last;
    const buffers = [...(isolation.segments.get(id) ?? []), last.value];
    isolation.segments.delete(id);
    for (const buffer of buffers) {
      const submitted = context.queue.submit([buffer]);
      if (!submitted.ok) return eventFailure(eventIndex, event, 'submit', submitted.error);
      await context.queue.onSubmittedWorkDone();
    }
  }
  return ok(undefined);
}
