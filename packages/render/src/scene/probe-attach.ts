import type { ExtractedFrame, RenderableSnapshot } from '../render-system-extract';
import { type FrameList, FrameProjection } from './frame-list';
import type { ProbeBlendBufferProjection, ProbeBlendSceneProjection } from './probe-blend';
import type { ProbeBlendRecord } from './probe-blend-record';
import type { SceneSlotFrame } from './scene-slots';

/**
 * Probe attachment memo: a candidate keeps its attached snapshot while its
 * record is unchanged, and the output array keeps its identity while every
 * element does, so camera-only frames stay on identity-keyed caches.
 */
export interface ProbeAttachMemo {
  readonly bySnapshot: WeakMap<
    RenderableSnapshot,
    { readonly record: ProbeBlendRecord; readonly value: RenderableSnapshot }
  >;
  previous:
    | {
        readonly candidates: FrameList<RenderableSnapshot>;
        readonly slots: SceneSlotFrame;
        readonly records: ProbeBlendBufferProjection;
        readonly value: FrameList<RenderableSnapshot>;
      }
    | undefined;
}

export function attachProbeRecord(
  candidate: RenderableSnapshot,
  record: RenderableSnapshot['probeBlendRecord'],
  memo: ProbeAttachMemo['bySnapshot'],
): RenderableSnapshot {
  if (record === undefined) return candidate;
  const cached = memo.get(candidate);
  if (cached?.record === record) return cached.value;
  const value = { ...candidate, probeBlendRecord: record };
  memo.set(candidate, { record, value });
  return value;
}

export function attachProbeRecords(
  frame: ExtractedFrame,
  candidates: FrameList<RenderableSnapshot>,
  slots: SceneSlotFrame,
  projection: ProbeBlendSceneProjection,
  memo: ProbeAttachMemo,
): ExtractedFrame {
  if (!projection.hasRecords()) {
    memo.previous = undefined;
    return frame.renderables === candidates ? frame : { ...frame, renderables: candidates };
  }
  const records = projection.recordBufferProjection();
  const previous = memo.previous;
  if (
    previous?.candidates === candidates &&
    previous.slots === slots &&
    previous.records === records
  )
    return { ...frame, renderables: previous.value };
  const probeAt = projection.captureRecordLookup();
  const attachments = memo.bySnapshot;
  const value = new FrameProjection(candidates, (candidate) => {
    const slot = slots.lookup(candidate.worldId, candidate.entityKey);
    return attachProbeRecord(
      candidate,
      slot === undefined ? undefined : probeAt(slot.slot),
      attachments,
    );
  });
  memo.previous = { candidates, slots, records, value };
  return { ...frame, renderables: value };
}
