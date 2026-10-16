// @forgeax/engine-rhi-debug/src/replay/execute-support -- replay event helpers.

import type {
  Buffer,
  RhiCommandEncoder,
  RhiComputePassEncoder,
  RhiRenderPassEncoder,
} from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import { createRhiDebugError, type RhiDebugError } from '../errors';
import type { RhiCallEvent, Tape, TapeBlob } from '../protocol/types';
import type { ReplayExecutionContext } from './execute';
import type { ReplayResource } from './resources';

type ReplayPass = RhiRenderPassEncoder & RhiComputePassEncoder;

/** Decoded tape events are immutable replay input, so entries borrow them uncopied. */
export function eventRecord(event: RhiCallEvent): Record<string, unknown> {
  return event as unknown as Record<string, unknown>;
}

export function eventFailure(
  eventIndex: number,
  event: RhiCallEvent,
  stage: 'lookup' | 'create' | 'write' | 'encode' | 'finish' | 'submit',
  cause: unknown,
): Result<never, RhiDebugError> {
  return err(
    createRhiDebugError('replay-event-failed', {
      eventIndex,
      kind: event.kind,
      stage,
      cause: cause instanceof Error ? cause.message : String(cause),
    }),
  );
}

const blobIndexes = new WeakMap<Tape, ReadonlyMap<string, TapeBlob>>();

/** Hash lookup derived once per decoded tape; replays resolve thousands of blobs. */
export function tapeBlob(tape: Tape, hash: string): TapeBlob | undefined {
  let index = blobIndexes.get(tape);
  if (index === undefined) {
    index = new Map(tape.blobs.map((candidate) => [candidate.hash, candidate]));
    blobIndexes.set(tape, index);
  }
  return index.get(hash);
}

export function blob(
  tape: Tape,
  hash: string,
  event: RhiCallEvent,
  eventIndex: number,
): Result<Uint8Array, RhiDebugError> {
  const found = tapeBlob(tape, hash);
  return found === undefined
    ? eventFailure(eventIndex, event, 'lookup', `blob ${hash} is missing`)
    : ok(found.bytes);
}

export function clearBuffer(
  context: ReplayExecutionContext,
  event: Extract<RhiCallEvent, { kind: 'clearBuffer' }>,
  eventIndex: number,
): Result<void, RhiDebugError> {
  const encoder = requireResource<RhiCommandEncoder>(
    context,
    event.cmdHandleId,
    'encoder',
    eventIndex,
    event.kind,
    'command',
  );
  const buffer = requireResource<Buffer>(context, event.handleId, 'buffer', eventIndex, event.kind);
  if (!encoder.ok) return encoder;
  if (!buffer.ok) return buffer;
  encoder.value.clearBuffer(buffer.value, event.offset, event.size);
  return ok(undefined);
}

export function commandEncoderCall(
  context: ReplayExecutionContext,
  event: Extract<RhiCallEvent, { kind: 'pushDebugGroup' | 'popDebugGroup' | 'insertDebugMarker' }>,
  eventIndex: number,
  call: (encoder: RhiCommandEncoder) => void,
): Result<void, RhiDebugError> {
  const encoder = requireResource<RhiCommandEncoder>(
    context,
    event.cmdHandleId,
    'encoder',
    eventIndex,
    event.kind,
    'command',
  );
  if (!encoder.ok) return encoder;
  call(encoder.value);
  return ok(undefined);
}

export function finish(
  context: ReplayExecutionContext,
  event: Extract<RhiCallEvent, { kind: 'finish' }>,
  eventIndex: number,
): Result<void, RhiDebugError> {
  const encoder = requireResource<RhiCommandEncoder>(
    context,
    event.cmdHandleId,
    'encoder',
    eventIndex,
    event.kind,
    'command',
  );
  if (!encoder.ok) return encoder;
  const result = encoder.value.finish();
  if (!result.ok) return eventFailure(eventIndex, event, 'finish', result.error);
  return context.table.set(
    event.cmdHandleId,
    { kind: 'encoder', role: 'command-buffer', value: result.value },
    eventRecord(event),
  );
}

export function endPass(
  context: ReplayExecutionContext,
  event: Extract<RhiCallEvent, { kind: 'endRenderPass' | 'endComputePass' }>,
  eventIndex: number,
  role: 'render-pass' | 'compute-pass',
): Result<void, RhiDebugError> {
  const pass = requireResource<RhiRenderPassEncoder | RhiComputePassEncoder>(
    context,
    event.passHandleId,
    'encoder',
    eventIndex,
    event.kind,
    role,
  );
  if (!pass.ok) return pass;
  pass.value.end();
  context.table.delete(event.passHandleId);
  return ok(undefined);
}

export function seedInitialData(
  context: ReplayExecutionContext,
  event: Extract<RhiCallEvent, { kind: 'initialData' }>,
  eventIndex: number,
): Result<void, RhiDebugError> {
  const entry = context.table.get(event.handleId);
  const bytes = blob(context.tape, event.dataHash, event, eventIndex);
  if (!bytes.ok) return bytes;
  if (entry?.resource.kind === 'buffer') {
    const result = context.queue.writeBuffer(entry.resource.value, 0, bytes.value);
    return result.ok ? ok(undefined) : eventFailure(eventIndex, event, 'write', result.error);
  }
  return eventFailure(
    eventIndex,
    event,
    'lookup',
    'initialData currently requires a buffer resource',
  );
}

export function requireResource<T>(
  context: ReplayExecutionContext,
  resourceId: string,
  kind: ReplayResource['kind'] | string,
  eventIndex: number,
  eventKind: RhiCallEvent['kind'],
  role?: string,
): Result<T, RhiDebugError> {
  const resource = requireReplayResource(context, resourceId, kind, eventIndex, eventKind, role);
  return resource.ok ? ok(resource.value.value as T) : resource;
}

export function requireReplayResource(
  context: ReplayExecutionContext,
  resourceId: string,
  kind: ReplayResource['kind'] | string,
  eventIndex: number,
  eventKind: RhiCallEvent['kind'],
  role?: string,
): Result<ReplayResource, RhiDebugError> {
  const entry = context.table.get(resourceId);
  if (
    entry === undefined ||
    entry.resource.kind !== kind ||
    (role !== undefined && entry.resource.role !== role)
  ) {
    return missingResource(
      eventIndex,
      { kind: eventKind } as RhiCallEvent,
      resourceId,
      `${kind}${role === undefined ? '' : `/${role}`}`,
    );
  }
  return ok(entry.resource);
}

export function passCall(
  context: ReplayExecutionContext,
  event: RhiCallEvent,
  eventIndex: number,
  role: 'render-pass' | 'compute-pass' | 'pass',
  call: (pass: ReplayPass) => Result<void, RhiDebugError>,
): Result<void, RhiDebugError> {
  const passId = 'passHandleId' in event ? event.passHandleId : undefined;
  if (passId === undefined)
    return eventFailure(eventIndex, event, 'lookup', 'pass handle is missing');
  const entry = context.table.get(passId);
  const valid =
    entry?.resource.kind === 'encoder' && (role === 'pass' || entry.resource.role === role);
  if (!valid || entry === undefined || entry.resource.kind !== 'encoder') {
    return missingResource(eventIndex, event, passId, role);
  }
  return call(entry.resource.value as ReplayPass);
}

export function pipelineError<T>(
  result: Result<T, RhiDebugError>,
  event: RhiCallEvent,
  eventIndex: number,
): Result<never, RhiDebugError> {
  return result.ok
    ? eventFailure(eventIndex, event, 'lookup', 'resource has the wrong role')
    : result;
}

export function missingResource(
  eventIndex: number,
  event: RhiCallEvent,
  resourceId: string,
  expected: string,
): Result<never, RhiDebugError> {
  return eventFailure(eventIndex, event, 'lookup', `resource ${resourceId} is not a ${expected}`);
}

export function unsupportedEvent(
  eventIndex: number,
  event: RhiCallEvent,
  cause: string,
): Result<never, RhiDebugError> {
  return eventFailure(eventIndex, event, 'lookup', cause);
}
