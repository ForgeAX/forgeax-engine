import type {
  RhiCommandEncoder,
  RhiComputePassEncoder,
  RhiRenderPassEncoder,
} from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import type { RhiDebugError } from '../errors';
import type { TapeIndex, TapeWorkEntry } from '../protocol/tape-index';
import type { RhiCallEvent } from '../protocol/types';
import { eventFailure, executeEvent, type ReplayExecutionContext } from './execute';

export async function replayThroughWork(
  context: ReplayExecutionContext,
  index: TapeIndex,
  work: TapeWorkEntry,
  retained: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<Result<void, RhiDebugError>> {
  for (let eventIndex = 0; eventIndex <= work.eventIndex; eventIndex++) {
    const event = context.tape.events[eventIndex];
    if (event === undefined) break;
    if (signal?.aborted) {
      return eventFailure(eventIndex, event, 'lookup', 'inspectWork was aborted');
    }
    if (isRetainedCreate(context, event, retained)) continue;
    const result = await executeEvent(context, event, eventIndex);
    if (!result.ok) return result;
  }
  return finalizeWorkPass(context, index, work);
}

/** An immutable object kept from an earlier replay generation needs no re-creation. */
export function isRetainedCreate(
  context: ReplayExecutionContext,
  event: RhiCallEvent,
  retained: ReadonlySet<string>,
): boolean {
  if (!event.kind.startsWith('create') && event.kind !== 'getBindGroupLayout') return false;
  const handleId = (event as { readonly handleId?: unknown }).handleId;
  return (
    typeof handleId === 'string' &&
    retained.has(handleId) &&
    context.table.get(handleId) !== undefined
  );
}

export async function finalizeWorkPass(
  context: ReplayExecutionContext,
  index: TapeIndex,
  work: TapeWorkEntry,
): Promise<Result<void, RhiDebugError>> {
  const pass = index.passes.find((candidate) => candidate.passIndex === work.passIndex);
  if (pass === undefined) return ok(undefined);
  const begin = context.tape.events[pass.beginEventIndex];
  if (begin?.kind !== 'beginRenderPass' && begin?.kind !== 'beginComputePass') return ok(undefined);
  const entry = context.table.get(begin.passHandleId);
  if (
    entry?.resource.kind !== 'encoder' ||
    (entry.resource.role !== 'render-pass' && entry.resource.role !== 'compute-pass')
  ) {
    return eventFailure(
      pass.beginEventIndex,
      begin,
      'lookup',
      `pass ${begin.passHandleId} is not open`,
    );
  }
  const closed = closeReplayPass(context, entry, begin, pass, work.eventIndex);
  if (!closed.ok) return closed;
  const finishEventIndex = findNextEvent(
    context.tape.events,
    pass.beginEventIndex,
    'finish',
    begin.cmdHandleId,
  );
  const encoder = context.table.get(begin.cmdHandleId);
  if (encoder?.resource.kind !== 'encoder' || encoder.resource.role !== 'command') {
    return eventFailure(
      finishEventIndex ?? work.eventIndex,
      begin,
      'lookup',
      `encoder ${begin.cmdHandleId} is not available`,
    );
  }
  const closure = await replayCommandClosure(
    context,
    begin.cmdHandleId,
    (pass.endEventIndex ?? work.eventIndex) + 1,
    finishEventIndex ?? context.tape.events.length,
  );
  if (!closure.ok) return closure;
  const groupsClosed = closeReplayDebugGroups(
    context,
    begin.cmdHandleId,
    work.eventIndex,
    encoder.resource.value as RhiCommandEncoder,
  );
  if (!groupsClosed.ok) return groupsClosed;
  const finished = (encoder.resource.value as RhiCommandEncoder).finish();
  const finishEvent = context.tape.events[finishEventIndex ?? work.eventIndex] ?? begin;
  if (!finished.ok)
    return eventFailure(finishEventIndex ?? work.eventIndex, finishEvent, 'finish', finished.error);
  context.table.set(begin.cmdHandleId, {
    kind: 'encoder',
    role: 'command-buffer',
    value: finished.value,
  });
  const submitEventIndex = findNextEvent(
    context.tape.events,
    finishEventIndex ?? pass.beginEventIndex,
    'submit',
    begin.cmdHandleId,
  );
  // Queue uploads are ordered against submission, not command recording.
  // Include later uploads to retained resources before this submission while
  // leaving later GPU work and resources outside the selected prefix alone.
  for (
    let eventIndex = work.eventIndex + 1;
    eventIndex < (submitEventIndex ?? work.eventIndex + 1);
    eventIndex++
  ) {
    const event = context.tape.events[eventIndex];
    if (event?.kind !== 'writeBuffer' && event?.kind !== 'writeTexture') continue;
    const resourceId =
      event.kind === 'writeBuffer' ? event.handleId : event.destination.textureHandleId;
    if (context.table.get(resourceId) === undefined) continue;
    const uploaded = await executeEvent(context, event, eventIndex);
    if (!uploaded.ok) return uploaded;
  }
  const submitted = context.queue.submit([finished.value]);
  const submitEvent = context.tape.events[submitEventIndex ?? work.eventIndex] ?? begin;
  if (!submitted.ok)
    return eventFailure(
      submitEventIndex ?? work.eventIndex,
      submitEvent,
      'submit',
      submitted.error,
    );
  await context.queue.onSubmittedWorkDone();
  return ok(undefined);
}

export function closeReplayPass(
  context: ReplayExecutionContext,
  entry: NonNullable<ReturnType<ReplayExecutionContext['table']['get']>>,
  begin: Extract<RhiCallEvent, { kind: 'beginRenderPass' | 'beginComputePass' }>,
  pass: TapeIndex['passes'][number],
  selectedEventIndex: number,
): Result<void, RhiDebugError> {
  const activeQuery = activeOcclusionQuery(
    context.tape.events,
    begin.kind === 'beginRenderPass' ? begin.passHandleId : undefined,
    pass.beginEventIndex,
    selectedEventIndex,
  );
  if (!activeQuery.ok) return activeQuery;
  try {
    if (activeQuery.value !== undefined) {
      if (entry.resource.role !== 'render-pass') {
        return eventFailure(
          activeQuery.value.eventIndex,
          activeQuery.value.event,
          'lookup',
          'an active occlusion query belongs to a non-render pass',
        );
      }
      const endedQuery = (entry.resource.value as RhiRenderPassEncoder).endOcclusionQuery();
      if (!endedQuery.ok) {
        return eventFailure(
          activeQuery.value.eventIndex,
          activeQuery.value.event,
          'encode',
          endedQuery.error,
        );
      }
    }
    if (entry.resource.role === 'render-pass') {
      const groupsClosed = closeReplayDebugGroups(
        context,
        begin.passHandleId,
        selectedEventIndex,
        entry.resource.value as RhiRenderPassEncoder,
      );
      if (!groupsClosed.ok) return groupsClosed;
    }
    (entry.resource.value as RhiRenderPassEncoder | RhiComputePassEncoder).end();
  } catch (cause) {
    return eventFailure(pass.endEventIndex ?? selectedEventIndex, begin, 'encode', cause);
  }
  context.table.delete(begin.passHandleId);
  return ok(undefined);
}

// Inspection stops at the selected work, before the recorded scope exits.
// Derive only the still-open scopes from that prefix; never execute later work.
export function closeReplayDebugGroups(
  context: ReplayExecutionContext,
  handleId: string,
  throughEventIndex: number,
  encoder: RhiCommandEncoder | RhiRenderPassEncoder,
): Result<void, RhiDebugError> {
  const open = openDebugGroups(context, handleId, throughEventIndex);
  for (let index = open.length - 1; index >= 0; index--) {
    const scope = open[index];
    if (scope === undefined) continue;
    try {
      encoder.popDebugGroup();
    } catch (cause) {
      return eventFailure(scope.eventIndex, scope.event, 'encode', cause);
    }
  }
  return ok(undefined);
}

export interface OpenDebugGroup {
  readonly event: Extract<RhiCallEvent, { kind: 'pushDebugGroup' | 'passPushDebugGroup' }>;
  readonly eventIndex: number;
}

/** Debug scopes of one encoder or pass still open after `throughEventIndex`, outermost first. */
export function openDebugGroups(
  context: ReplayExecutionContext,
  handleId: string,
  throughEventIndex: number,
): OpenDebugGroup[] {
  const open: OpenDebugGroup[] = [];
  for (let eventIndex = 0; eventIndex <= throughEventIndex; eventIndex++) {
    const event = context.tape.events[eventIndex];
    if (event === undefined) continue;
    if (
      (event.kind === 'pushDebugGroup' && event.cmdHandleId === handleId) ||
      (event.kind === 'passPushDebugGroup' && event.passHandleId === handleId)
    ) {
      open.push({ event, eventIndex });
    } else if (
      (event.kind === 'popDebugGroup' && event.cmdHandleId === handleId) ||
      (event.kind === 'passPopDebugGroup' && event.passHandleId === handleId)
    ) {
      open.pop();
    }
  }
  return open;
}

export async function replayCommandClosure(
  context: ReplayExecutionContext,
  cmdHandleId: string,
  start: number,
  end: number,
): Promise<Result<void, RhiDebugError>> {
  for (let eventIndex = start; eventIndex < end; eventIndex++) {
    const event = context.tape.events[eventIndex];
    if (event === undefined || !isCommandClosureEvent(event)) continue;
    if (event.cmdHandleId !== cmdHandleId) continue;
    const result = await executeEvent(context, event, eventIndex);
    if (!result.ok) return result;
  }
  return ok(undefined);
}

type ActiveOcclusionQuery = Extract<RhiCallEvent, { kind: 'beginOcclusionQuery' }>;

export function activeOcclusionQuery(
  events: readonly RhiCallEvent[],
  passHandleId: string | undefined,
  beginEventIndex: number,
  selectedEventIndex: number,
): Result<
  { readonly eventIndex: number; readonly event: ActiveOcclusionQuery } | undefined,
  RhiDebugError
> {
  if (passHandleId === undefined) return ok(undefined);
  let active: { readonly eventIndex: number; readonly event: ActiveOcclusionQuery } | undefined;
  for (let eventIndex = beginEventIndex + 1; eventIndex <= selectedEventIndex; eventIndex++) {
    const event = events[eventIndex];
    if (event === undefined || !('passHandleId' in event) || event.passHandleId !== passHandleId)
      continue;
    if (event.kind === 'beginOcclusionQuery') {
      if (active !== undefined) {
        return eventFailure(
          eventIndex,
          event,
          'encode',
          'an occlusion query is already active for this render pass',
        );
      }
      active = { eventIndex, event };
    } else if (event.kind === 'endOcclusionQuery') {
      if (active === undefined) {
        return eventFailure(
          eventIndex,
          event,
          'encode',
          'an occlusion query ended without a matching begin',
        );
      }
      active = undefined;
    }
  }
  return ok(active);
}

export function isCommandClosureEvent(event: RhiCallEvent): event is Extract<
  RhiCallEvent,
  {
    kind:
      | 'resolveQuerySet'
      | 'copyBufferToBuffer'
      | 'copyBufferToTexture'
      | 'copyTextureToBuffer'
      | 'copyTextureToTexture'
      | 'clearBuffer';
  }
> {
  switch (event.kind) {
    case 'resolveQuerySet':
    case 'copyBufferToBuffer':
    case 'copyBufferToTexture':
    case 'copyTextureToBuffer':
    case 'copyTextureToTexture':
    case 'clearBuffer':
      return true;
    default:
      return false;
  }
}

export function findNextEvent(
  events: readonly RhiCallEvent[],
  start: number,
  kind: 'finish' | 'submit',
  commandId: string,
): number | undefined {
  for (let index = start + 1; index < events.length; index++) {
    const event = events[index];
    if (event?.kind === 'finish' && kind === 'finish' && event.cmdHandleId === commandId)
      return index;
    if (event?.kind === 'submit' && kind === 'submit' && event.cmdHandleIds.includes(commandId))
      return index;
  }
  return undefined;
}
