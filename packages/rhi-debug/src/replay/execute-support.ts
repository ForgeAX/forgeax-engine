// @forgeax/engine-rhi-debug/src/replay/execute-support -- replay event helpers.

import type { RhiCommandEncoder } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import { createRhiDebugError, type RhiDebugError } from '../errors';
import type { InitialDataSlice, RhiCallEvent, Tape, TapeBlob } from '../protocol/types';
import type { ReplayExecutionContext } from './execute';
import type { ReplayResource, ReplayResourceValues } from './resources';

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

export function bootstrapBlob(
  tape: Tape,
  slice: InitialDataSlice,
  event: RhiCallEvent,
  eventIndex: number,
): Result<Uint8Array, RhiDebugError> {
  const bytes = blob(tape, slice.hash, event, eventIndex);
  if (!bytes.ok) return bytes;
  const end = slice.byteOffset + slice.byteLength;
  if (
    !Number.isSafeInteger(slice.byteOffset) ||
    !Number.isSafeInteger(slice.byteLength) ||
    slice.byteOffset < 0 ||
    slice.byteLength < 0 ||
    end > bytes.value.byteLength
  ) {
    return eventFailure(
      eventIndex,
      event,
      'lookup',
      `blob ${slice.hash} does not contain initialData slice [${slice.byteOffset}, ${end})`,
    );
  }
  return ok(bytes.value.subarray(slice.byteOffset, end));
}

export function clearBuffer(
  context: ReplayExecutionContext,
  event: Extract<RhiCallEvent, { kind: 'clearBuffer' }>,
  eventIndex: number,
): Result<void, RhiDebugError> {
  const encoder = requireResource(context, event.cmdHandleId, 'command', eventIndex, event.kind);
  const buffer = requireResource(context, event.handleId, 'buffer', eventIndex, event.kind);
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
  const encoder = requireResource(context, event.cmdHandleId, 'command', eventIndex, event.kind);
  if (!encoder.ok) return encoder;
  call(encoder.value);
  return ok(undefined);
}

export function finish(
  context: ReplayExecutionContext,
  event: Extract<RhiCallEvent, { kind: 'finish' }>,
  eventIndex: number,
): Result<void, RhiDebugError> {
  const encoder = requireResource(context, event.cmdHandleId, 'command', eventIndex, event.kind);
  if (!encoder.ok) return encoder;
  const result = encoder.value.finish();
  if (!result.ok) return eventFailure(eventIndex, event, 'finish', result.error);
  return context.table.set(
    event.cmdHandleId,
    { kind: 'command-buffer', value: result.value },
    eventRecord(event),
  );
}

export function endPass(
  context: ReplayExecutionContext,
  event: Extract<RhiCallEvent, { kind: 'endRenderPass' | 'endComputePass' }>,
  eventIndex: number,
  kind: 'render-pass' | 'compute-pass',
): Result<void, RhiDebugError> {
  const pass = requireResource(context, event.passHandleId, kind, eventIndex, event.kind);
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

export function requireResource<K extends ReplayResource['kind']>(
  context: ReplayExecutionContext,
  resourceId: string,
  kind: K,
  eventIndex: number,
  eventKind: RhiCallEvent['kind'],
): Result<ReplayResourceValues[K], RhiDebugError> {
  const entry = context.table.get(resourceId);
  if (entry === undefined || entry.resource.kind !== kind) {
    return missingResource(eventIndex, { kind: eventKind } as RhiCallEvent, resourceId, kind);
  }
  return ok(entry.resource.value as ReplayResourceValues[K]);
}

export function passCall<K extends 'render-pass' | 'compute-pass' | 'pass'>(
  context: ReplayExecutionContext,
  event: RhiCallEvent,
  eventIndex: number,
  kind: K,
  call: (
    pass: ReplayResourceValues[K extends 'pass' ? 'render-pass' | 'compute-pass' : K],
  ) => Result<void, RhiDebugError>,
): Result<void, RhiDebugError> {
  const passId = 'passHandleId' in event ? event.passHandleId : undefined;
  if (passId === undefined)
    return eventFailure(eventIndex, event, 'lookup', 'pass handle is missing');
  const resource = context.table.get(passId)?.resource;
  if (
    resource === undefined ||
    (resource.kind !== 'render-pass' && resource.kind !== 'compute-pass') ||
    (kind !== 'pass' && resource.kind !== kind)
  ) {
    return missingResource(eventIndex, event, passId, kind);
  }
  return call(
    resource.value as ReplayResourceValues[K extends 'pass' ? 'render-pass' | 'compute-pass' : K],
  );
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
