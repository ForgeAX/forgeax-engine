import { EVENT_SEMANTICS, eventKinds, isWorkEvent, resourceKindForEvent } from './event-semantics';
import type { EventKind, ResourceKind, Tape } from './types';

export interface TapePassEntry {
  readonly passIndex: number;
  readonly kind: 'render' | 'compute';
  readonly beginEventIndex: number;
  readonly endEventIndex: number | undefined;
  readonly workIndices: readonly number[];
}

export interface TapeWorkEntry {
  readonly workIndex: number;
  readonly eventIndex: number;
  readonly passIndex: number;
  readonly kind: Extract<
    EventKind,
    | 'draw'
    | 'drawIndexed'
    | 'drawIndirect'
    | 'drawIndexedIndirect'
    | 'dispatchWorkgroups'
    | 'dispatchWorkgroupsIndirect'
  >;
}

export interface TapeResourceEntry {
  readonly resourceId: string;
  readonly kind: ResourceKind;
  readonly origin: 'bootstrap' | 'frame';
  readonly createEventIndex: number | undefined;
  readonly destroyEventIndex: number | undefined;
}

export interface TapeIndex {
  readonly passes: readonly TapePassEntry[];
  readonly works: readonly TapeWorkEntry[];
  readonly resources: readonly TapeResourceEntry[];
  readonly eventKinds: readonly EventKind[];
  readonly passIndexByEvent: readonly number[];
}

export function buildTapeIndex(tape: Tape): TapeIndex {
  const passes: TapePassEntry[] = [];
  const works: TapeWorkEntry[] = [];
  const resources = new Map<string, TapeResourceEntry>();
  const passIndexByEvent: number[] = [];
  let passIndex = -1;
  let currentPass:
    | { kind: 'render' | 'compute'; beginEventIndex: number; workIndices: number[] }
    | undefined;
  for (const [eventIndex, event] of tape.events.entries()) {
    passIndexByEvent[eventIndex] = passIndex;
    const semantics = EVENT_SEMANTICS[event.kind];
    if (event.kind === 'beginRenderPass' || event.kind === 'beginComputePass') {
      passIndex++;
      passIndexByEvent[eventIndex] = passIndex;
      currentPass = {
        kind: event.kind === 'beginRenderPass' ? 'render' : 'compute',
        beginEventIndex: eventIndex,
        workIndices: [],
      };
    }
    if (isWorkEvent(event.kind)) {
      const workIndex = works.length;
      works.push({ workIndex, eventIndex, passIndex, kind: event.kind as TapeWorkEntry['kind'] });
      currentPass?.workIndices.push(workIndex);
    }
    if (event.kind === 'endRenderPass' || event.kind === 'endComputePass') {
      if (currentPass) {
        passes.push({
          passIndex,
          kind: currentPass.kind,
          beginEventIndex: currentPass.beginEventIndex,
          endEventIndex: eventIndex,
          workIndices: currentPass.workIndices,
        });
        currentPass = undefined;
      }
    }
    const kind = resourceKindForEvent(event.kind);
    for (const resourceId of semantics.created(event)) {
      if (kind)
        resources.set(resourceId, {
          resourceId,
          kind,
          origin: 'frame',
          createEventIndex: eventIndex,
          destroyEventIndex: undefined,
        });
    }
    for (const resourceId of semantics.destroyed(event)) {
      const previous = resources.get(resourceId);
      if (previous) resources.set(resourceId, { ...previous, destroyEventIndex: eventIndex });
    }
  }
  if (currentPass)
    passes.push({
      passIndex,
      kind: currentPass.kind,
      beginEventIndex: currentPass.beginEventIndex,
      endEventIndex: undefined,
      workIndices: currentPass.workIndices,
    });
  for (const resource of tape.bootstrap)
    resources.set(resource.handleId, {
      resourceId: resource.handleId,
      kind: resource.kind,
      origin: 'bootstrap',
      createEventIndex: undefined,
      destroyEventIndex: undefined,
    });
  return {
    passes,
    works,
    resources: [...resources.values()],
    eventKinds: [...eventKinds],
    passIndexByEvent,
  };
}
