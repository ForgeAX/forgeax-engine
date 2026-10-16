import type { RhiCommandEncoder } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import { createRhiDebugError, type RhiDebugError } from '../errors';
import type { WorkEntry } from '../frame-model';
import type { TapeIndex, TapeWorkEntry } from '../protocol/tape-index';
import type { RhiCallEvent } from '../protocol/types';
import { eventFailure, executeEvent, type ReplayExecutionContext } from './execute';
import {
  activeOcclusionQuery,
  closeReplayDebugGroups,
  closeReplayPass,
  findNextEvent,
  isCommandClosureEvent,
  isRetainedCreate,
  openDebugGroups,
  replayThroughWork,
} from './prefix';
import {
  type ReadbackSubresource,
  type ReplayReadbackResult,
  readReplayResource,
} from './readback';

export interface BatchReadRequest {
  readonly resourceId: string;
  /** Omit to read the bootstrap (pre-frame) state. */
  readonly workIndex?: number;
  readonly subresource?: ReadbackSubresource;
}

export type BatchReadResults = readonly Result<ReplayReadbackResult, RhiDebugError>[];

/**
 * The read request for what one work bound at `@group(group) @binding(binding)`:
 * the bound buffer window (static plus dynamic offset) or the bound texture view.
 */
export function bindingReadRequest(
  work: WorkEntry,
  group: number,
  binding: number,
): Result<BatchReadRequest, RhiDebugError> {
  const bound = work.bindings.find(
    (candidate) => candidate.groupIndex === group && candidate.binding === binding,
  );
  if (bound?.resourceId == null)
    return err(
      createRhiDebugError('readback-failed', {
        stage: 'readback',
        cause: `work ${work.workIndex} binds no readable resource at group ${group} binding ${binding}`,
      }),
    );
  const base = { resourceId: bound.resourceId, workIndex: work.workIndex };
  if (bound.bufferOffset === null && bound.bufferSize === null && bound.dynamicOffset === null)
    return ok(base);
  const offset = (bound.bufferOffset ?? 0) + (bound.dynamicOffset ?? 0);
  return ok({
    ...base,
    subresource: bound.bufferSize === null ? { offset } : { offset, size: bound.bufferSize },
  });
}

/** @internal Session state a batch drives; `reset` also re-prepares bootstrap resources. */
export interface BatchHost {
  readonly context: ReplayExecutionContext;
  readonly index: TapeIndex;
  readonly retained: ReadonlySet<string>;
  reset(): Promise<Result<void, RhiDebugError>>;
}

type PassBegin = Extract<RhiCallEvent, { kind: 'beginRenderPass' | 'beginComputePass' }>;

interface SplitPoint {
  readonly work: TapeWorkEntry;
  readonly pass: TapeIndex['passes'][number];
  readonly begin: PassBegin;
  readonly submitEventIndex: number;
}

const PASS_STATE_KINDS = new Set<RhiCallEvent['kind']>([
  'setPipeline',
  'setBindGroup',
  'setVertexBuffer',
  'setIndexBuffer',
  'setViewport',
  'setScissorRect',
  'setStencilReference',
  'setBlendConstant',
  'resetRenderState',
  'setComputePipeline',
]);

/**
 * Batch readback. Requests at one work share one replay. Works that can be
 * split share a single forward replay: at each requested work the open pass
 * is closed (attachments stored), its encoder submitted with the queue uploads
 * ordered before that submission, the requests read, and recording resumes in
 * a fresh encoder whose pass loads the stored attachments and re-binds the
 * recorded pass state. Works that cannot be split without reordering GPU work
 * (active occlusion query, multi-buffer or intervening submits, or a closure
 * copy that writes a requested resource) replay standalone exactly like
 * `readResourceAtWork`.
 */
export async function readAtWorks(
  host: BatchHost,
  requests: readonly BatchReadRequest[],
  signal?: AbortSignal,
): Promise<Result<BatchReadResults, RhiDebugError>> {
  const results: Result<ReplayReadbackResult, RhiDebugError>[] = new Array(requests.length);
  const bootstrap: number[] = [];
  const byWork = new Map<number, number[]>();
  requests.forEach((request, slot) => {
    if (request.workIndex === undefined) {
      bootstrap.push(slot);
    } else if (host.index.works[request.workIndex] === undefined) {
      results[slot] = err(
        createRhiDebugError('replay-position-invalid', {
          requested: request.workIndex,
          available: host.index.works.length,
        }),
      );
    } else {
      const slots = byWork.get(request.workIndex) ?? [];
      slots.push(slot);
      byWork.set(request.workIndex, slots);
    }
  });

  if (bootstrap.length > 0) {
    const prepared = await host.reset();
    if (!prepared.ok) return prepared;
    const read = await readSlots(host, requests, bootstrap, undefined, results, signal);
    if (!read.ok) return read;
  }

  const splits: SplitPoint[] = [];
  const standalone: number[] = [];
  for (const workIndex of [...byWork.keys()].sort((a, b) => a - b)) {
    const work = host.index.works[workIndex] as TapeWorkEntry;
    const resourceIds = (byWork.get(workIndex) ?? []).map((slot) => requests[slot]?.resourceId);
    const split = splitPoint(host, work, resourceIds as string[]);
    if (split === undefined) standalone.push(workIndex);
    else splits.push(split);
  }

  if (splits.length > 0) {
    const forward = await forwardReplay(host, splits, requests, byWork, results, signal);
    if (!forward.ok) return forward;
  }
  for (const workIndex of standalone) {
    const work = host.index.works[workIndex] as TapeWorkEntry;
    const prepared = await host.reset();
    if (!prepared.ok) return prepared;
    const replayed = await replayThroughWork(host.context, host.index, work, host.retained, signal);
    if (!replayed.ok) return replayed;
    const read = await readSlots(
      host,
      requests,
      byWork.get(workIndex) ?? [],
      work,
      results,
      signal,
    );
    if (!read.ok) return read;
  }
  return ok(results);
}

async function readSlots(
  host: BatchHost,
  requests: readonly BatchReadRequest[],
  slots: readonly number[],
  work: TapeWorkEntry | undefined,
  results: Result<ReplayReadbackResult, RhiDebugError>[],
  signal: AbortSignal | undefined,
): Promise<Result<void, RhiDebugError>> {
  for (const slot of slots) {
    if (signal?.aborted) return aborted();
    const request = requests[slot] as BatchReadRequest;
    const read = await readReplayResource(
      host.context.device,
      host.context.table,
      request.resourceId,
      request.subresource,
      host.context.createShaderModule,
    );
    results[slot] =
      !read.ok || work === undefined
        ? read
        : ok({
            ...read.value,
            provenance: { ...read.value.provenance, selectedWorkIndex: work.workIndex },
          });
  }
  return ok(undefined);
}

function splitPoint(
  host: BatchHost,
  work: TapeWorkEntry,
  resourceIds: readonly string[],
): SplitPoint | undefined {
  const events = host.context.tape.events;
  const pass = host.index.passes.find((candidate) => candidate.passIndex === work.passIndex);
  if (pass === undefined || pass.endEventIndex === undefined) return undefined;
  const begin = events[pass.beginEventIndex];
  if (begin?.kind !== 'beginRenderPass' && begin?.kind !== 'beginComputePass') return undefined;
  const query = activeOcclusionQuery(
    events,
    begin.kind === 'beginRenderPass' ? begin.passHandleId : undefined,
    pass.beginEventIndex,
    work.eventIndex,
  );
  if (!query.ok || query.value !== undefined) return undefined;
  const finishEventIndex = findNextEvent(events, pass.endEventIndex, 'finish', begin.cmdHandleId);
  if (finishEventIndex === undefined) return undefined;
  const submitEventIndex = findNextEvent(events, finishEventIndex, 'submit', begin.cmdHandleId);
  const submit = submitEventIndex === undefined ? undefined : events[submitEventIndex];
  if (submit?.kind !== 'submit' || submit.cmdHandleIds.length !== 1) return undefined;
  for (let index = work.eventIndex + 1; index < (submitEventIndex as number); index++) {
    if (events[index]?.kind === 'submit') return undefined;
  }
  const watched = new Set<string>();
  for (const id of resourceIds) {
    watched.add(id);
    const source = viewSource(host, id);
    if (source !== undefined) watched.add(source);
  }
  for (let index = pass.endEventIndex + 1; index < finishEventIndex; index++) {
    const event = events[index];
    if (event === undefined || !isCommandClosureEvent(event)) continue;
    if (event.cmdHandleId !== begin.cmdHandleId) continue;
    const destination = closureDestination(event);
    if (destination !== undefined && watched.has(destination)) return undefined;
  }
  return { work, pass, begin, submitEventIndex: submitEventIndex as number };
}

async function forwardReplay(
  host: BatchHost,
  splits: readonly SplitPoint[],
  requests: readonly BatchReadRequest[],
  byWork: ReadonlyMap<number, readonly number[]>,
  results: Result<ReplayReadbackResult, RhiDebugError>[],
  signal: AbortSignal | undefined,
): Promise<Result<void, RhiDebugError>> {
  const { context } = host;
  const prepared = await host.reset();
  if (!prepared.ok) return prepared;
  const splitAt = new Map(splits.map((split) => [split.work.eventIndex, split]));
  const splitsPerPass = new Map<number, number[]>();
  for (const split of splits) {
    const list = splitsPerPass.get(split.pass.beginEventIndex) ?? [];
    list.push(split.work.eventIndex);
    splitsPerPass.set(split.pass.beginEventIndex, list);
  }
  const last = splits[splits.length - 1] as SplitPoint;
  const earlyWrites = new Set<number>();
  for (let eventIndex = 0; eventIndex <= last.work.eventIndex; eventIndex++) {
    const event = context.tape.events[eventIndex];
    if (event === undefined) break;
    if (signal?.aborted) return aborted();
    if (earlyWrites.has(eventIndex) || isRetainedCreate(context, event, host.retained)) continue;
    const replayEvent =
      (event.kind === 'beginRenderPass' || event.kind === 'beginComputePass') &&
      splitsPerPass.has(eventIndex)
        ? segmentBegin(event, { load: false, store: true })
        : event;
    const executed = await executeEvent(context, replayEvent, eventIndex);
    if (!executed.ok) return executed;
    const split = splitAt.get(eventIndex);
    if (split === undefined) continue;
    const submitted = await submitSegment(context, split, earlyWrites);
    if (!submitted.ok) return submitted;
    const read = await readSlots(
      host,
      requests,
      byWork.get(split.work.workIndex) ?? [],
      split.work,
      results,
      signal,
    );
    if (!read.ok) return read;
    if (split === last) break;
    const morePass = (splitsPerPass.get(split.pass.beginEventIndex) ?? []).some(
      (index) => index > eventIndex,
    );
    const resumed = await resumeSegment(context, split, morePass);
    if (!resumed.ok) return resumed;
  }
  return ok(undefined);
}

async function submitSegment(
  context: ReplayExecutionContext,
  split: SplitPoint,
  earlyWrites: Set<number>,
): Promise<Result<void, RhiDebugError>> {
  const { begin, pass, work } = split;
  const entry = context.table.get(begin.passHandleId);
  if (entry === undefined)
    return eventFailure(
      pass.beginEventIndex,
      begin,
      'lookup',
      `pass ${begin.passHandleId} is not open`,
    );
  const closed = closeReplayPass(context, entry, begin, pass, work.eventIndex);
  if (!closed.ok) return closed;
  const encoder = context.table.get(begin.cmdHandleId);
  if (encoder?.resource.kind !== 'encoder' || encoder.resource.role !== 'command')
    return eventFailure(
      work.eventIndex,
      begin,
      'lookup',
      `encoder ${begin.cmdHandleId} is not open`,
    );
  const command = encoder.resource.value as RhiCommandEncoder;
  const groups = closeReplayDebugGroups(context, begin.cmdHandleId, work.eventIndex, command);
  if (!groups.ok) return groups;
  const finished = command.finish();
  if (!finished.ok) return eventFailure(work.eventIndex, begin, 'finish', finished.error);
  // Queue uploads before the recorded submission precede every command of
  // this encoder; apply them now and skip them when the stream reaches them.
  for (let index = work.eventIndex + 1; index < split.submitEventIndex; index++) {
    const event = context.tape.events[index];
    if (event?.kind !== 'writeBuffer' && event?.kind !== 'writeTexture') continue;
    if (earlyWrites.has(index)) continue;
    const target =
      event.kind === 'writeBuffer' ? event.handleId : event.destination.textureHandleId;
    if (context.table.get(target) === undefined) continue;
    const uploaded = await executeEvent(context, event, index);
    if (!uploaded.ok) return uploaded;
    earlyWrites.add(index);
  }
  const submitted = context.queue.submit([finished.value]);
  if (!submitted.ok) return eventFailure(work.eventIndex, begin, 'submit', submitted.error);
  await context.queue.onSubmittedWorkDone();
  return ok(undefined);
}

async function resumeSegment(
  context: ReplayExecutionContext,
  split: SplitPoint,
  morePass: boolean,
): Promise<Result<void, RhiDebugError>> {
  const { begin, pass, work } = split;
  const events = context.tape.events;
  let createIndex = pass.beginEventIndex;
  while (createIndex >= 0) {
    const event = events[createIndex];
    if (event?.kind === 'createCommandEncoder' && event.cmdHandleId === begin.cmdHandleId) break;
    createIndex--;
  }
  const create = events[createIndex];
  if (create === undefined)
    return eventFailure(
      work.eventIndex,
      begin,
      'lookup',
      `encoder ${begin.cmdHandleId} has no creation`,
    );
  const steps: { readonly event: RhiCallEvent; readonly eventIndex: number }[] = [
    { event: create, eventIndex: createIndex },
    ...openDebugGroups(context, begin.cmdHandleId, work.eventIndex),
    {
      event: segmentBegin(begin, { load: true, store: morePass }),
      eventIndex: pass.beginEventIndex,
    },
    ...openDebugGroups(context, begin.passHandleId, work.eventIndex),
  ];
  for (let index = pass.beginEventIndex + 1; index <= work.eventIndex; index++) {
    const event = events[index];
    if (event === undefined || !PASS_STATE_KINDS.has(event.kind)) continue;
    if ((event as { readonly passHandleId?: unknown }).passHandleId !== begin.passHandleId)
      continue;
    steps.push({ event, eventIndex: index });
  }
  for (const step of steps) {
    const executed = await executeEvent(context, step.event, step.eventIndex);
    if (!executed.ok) return executed;
  }
  return ok(undefined);
}

/**
 * A pass segment around a split point: earlier segments store their
 * attachments, later ones load them, and only the first segment keeps the
 * recorded timestamp writes.
 */
function segmentBegin(
  begin: PassBegin,
  mode: { readonly load: boolean; readonly store: boolean },
): PassBegin {
  if (begin.kind === 'beginComputePass') {
    if (!mode.load) return begin;
    const { timestampWrites: _timestamps, ...desc } = begin.desc ?? {};
    return { ...begin, desc };
  }
  const { timestampWrites: _timestamps, ...rest } = begin.desc;
  const desc = mode.load ? rest : begin.desc;
  const colorAttachments = Array.from(desc.colorAttachments).map((attachment) =>
    attachment === null || attachment === undefined
      ? attachment
      : {
          ...attachment,
          ...(mode.load ? { loadOp: 'load' as const } : {}),
          ...(mode.store ? { storeOp: 'store' as const } : {}),
        },
  );
  const depth = desc.depthStencilAttachment;
  const depthStencilAttachment =
    depth === undefined
      ? undefined
      : {
          ...depth,
          ...(mode.load && depth.depthLoadOp !== undefined ? { depthLoadOp: 'load' as const } : {}),
          ...(mode.load && depth.stencilLoadOp !== undefined
            ? { stencilLoadOp: 'load' as const }
            : {}),
          ...(mode.store && depth.depthStoreOp !== undefined
            ? { depthStoreOp: 'store' as const }
            : {}),
          ...(mode.store && depth.stencilStoreOp !== undefined
            ? { stencilStoreOp: 'store' as const }
            : {}),
        };
  return {
    ...begin,
    desc: {
      ...desc,
      colorAttachments,
      ...(depthStencilAttachment === undefined ? {} : { depthStencilAttachment }),
    },
  } as PassBegin;
}

function viewSource(host: BatchHost, id: string): string | undefined {
  const { tape } = host.context;
  for (const resource of tape.bootstrap) {
    if (resource.handleId !== id || resource.kind !== 'texture-view') continue;
    const source = (resource.create as { readonly sourceHandleId?: unknown }).sourceHandleId;
    return typeof source === 'string' ? source : undefined;
  }
  for (const event of tape.events) {
    if (event.kind === 'createTextureView' && event.resultHandleId === id)
      return event.sourceHandleId;
  }
  return undefined;
}

/** The resource a closure command writes; its sources are only read. */
function closureDestination(
  event: Extract<
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
  >,
): string | undefined {
  switch (event.kind) {
    case 'copyBufferToBuffer':
    case 'resolveQuerySet':
      return event.destinationHandleId;
    case 'copyBufferToTexture':
    case 'copyTextureToTexture':
      return event.destination.textureHandleId;
    case 'copyTextureToBuffer':
      return event.destination.bufferHandleId;
    case 'clearBuffer':
      return event.handleId;
  }
}

function aborted(): Result<never, RhiDebugError> {
  return err(
    createRhiDebugError('readback-failed', { stage: 'readback', cause: 'readback was aborted' }),
  );
}
