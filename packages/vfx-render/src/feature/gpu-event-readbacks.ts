import type {
  RenderFeaturePassDeclaration,
  RenderFeatureResourceDeclaration,
} from '@forgeax/engine-render';
import type { VfxGpuOutputEvent } from '@forgeax/engine-vfx';
import { VFX_GPU_OUTPUT_HEADER_BYTES } from '@forgeax/engine-vfx';

export interface VfxGpuOutputBatch {
  readonly epoch: number;
  readonly generation: number;
  readonly sequence: number;
  readonly events: readonly VfxGpuOutputEvent[];
}
interface Stream {
  sequence: number;
  next: number;
  busy: Map<number, number>;
  received: Map<number, VfxGpuOutputBatch>;
  ready: VfxGpuOutputBatch[];
}
/** Empty receipts only advance the watermark; retain one per contiguous gap. */
function appendReady(row: Stream, batch: VfxGpuOutputBatch): void {
  const previous = row.ready.at(-1);
  if (batch.events.length === 0 && previous?.events.length === 0) {
    row.ready[row.ready.length - 1] = batch;
  } else row.ready.push(batch);
}

interface Tag {
  frame: number;
  kind: 'vfx-output-events';
  key: string;
  runtimeId: number;
  epoch: number;
  generation: number;
  sequence: number;
  slot: number;
  capacity: number;
}
/** Receipt-bound bounded event readback. Only authored output records leave GPU. */
export function createVfxGpuEventReadbacks() {
  const streams = new Map<string, Stream>();
  const frames = new Map<number, Tag[]>();
  const stream = (key: string) => {
    let row = streams.get(key);
    if (!row) {
      row = { sequence: 0, next: 1, busy: new Map(), received: new Map(), ready: [] };
      streams.set(key, row);
    }
    return row;
  };
  return {
    append(o: {
      frame: number;
      runtimeId: number;
      epoch: number;
      capacity: number;
      generation: number;
      resource: string;
      resources: RenderFeatureResourceDeclaration[];
      passes: RenderFeaturePassDeclaration[];
    }) {
      const key = `${o.runtimeId}:${o.epoch}:${o.generation}`;
      for (const previous of streams.keys())
        if (previous.startsWith(`${o.runtimeId}:`) && previous !== key) streams.delete(previous);
      for (const [frame, tags] of frames) {
        const live = tags.filter((tag) => streams.has(tag.key));
        if (live.length) frames.set(frame, live);
        else frames.delete(frame);
      }
      const row = stream(key),
        size = VFX_GPU_OUTPUT_HEADER_BYTES + o.capacity * 32;
      for (const slot of [0, 1, 2])
        o.resources.push({
          kind: 'buffer',
          name: `${o.resource}.readback.${slot}`,
          size,
          usage: ['map-read'],
        });
      const slot = [0, 1, 2].find((slot) => !row.busy.has(slot));
      if (slot === undefined) return [];
      const sequence = ++row.sequence;
      row.busy.set(slot, sequence);
      const destination = `${o.resource}.readback.${slot}`;
      o.passes.push({
        kind: 'copy',
        name: `${o.resource}.readback`,
        copies: [{ source: o.resource, destination, size }],
      });
      const tag: Tag = {
        frame: o.frame,
        kind: 'vfx-output-events',
        key,
        runtimeId: o.runtimeId,
        epoch: o.epoch,
        generation: o.generation,
        sequence,
        slot,
        capacity: o.capacity,
      };
      const tags = frames.get(o.frame) ?? [];
      tags.push(tag);
      frames.set(o.frame, tags);
      return [{ resource: destination, tag }];
    },
    receive(result: { tag: unknown; bytes?: Uint8Array }) {
      const tag = result.tag as Partial<Tag> | undefined;
      if (
        tag?.kind !== 'vfx-output-events' ||
        typeof tag.key !== 'string' ||
        typeof tag.sequence !== 'number' ||
        typeof tag.slot !== 'number' ||
        typeof tag.capacity !== 'number' ||
        typeof tag.epoch !== 'number' ||
        typeof tag.generation !== 'number'
      )
        return;
      if (typeof tag.frame === 'number') {
        const tags = frames
          .get(tag.frame)
          ?.filter((value) => value.sequence !== tag.sequence || value.key !== tag.key);
        if (tags?.length) frames.set(tag.frame, tags);
        else frames.delete(tag.frame);
      }
      const row = streams.get(tag.key);
      if (!row || row.busy.get(tag.slot) !== tag.sequence) return;
      row.busy.delete(tag.slot);
      const events: VfxGpuOutputEvent[] = [];
      const bytes = result.bytes;
      if (bytes && bytes.byteLength === VFX_GPU_OUTPUT_HEADER_BYTES + tag.capacity * 32) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (view.getUint32(8, true) === tag.epoch)
          for (let index = 0; index < tag.capacity; index++) {
            const offset = VFX_GPU_OUTPUT_HEADER_BYTES + index * 32;
            if (view.getUint32(offset + 16, true) === 0) continue;
            const position = [
                view.getFloat32(offset, true),
                view.getFloat32(offset + 4, true),
                view.getFloat32(offset + 8, true),
              ] as const,
              strength = view.getFloat32(offset + 12, true);
            if (![...position, strength].every(Number.isFinite)) continue;
            events.push({
              position,
              strength,
              channel: view.getUint32(offset + 16, true),
              particleId: view.getUint32(offset + 20, true),
              tick: view.getUint32(offset + 24, true),
            });
          }
      }
      row.received.set(tag.sequence, {
        epoch: tag.epoch,
        generation: tag.generation,
        sequence: tag.sequence,
        events,
      });
      while (row.received.has(row.next)) {
        const batch = row.received.get(row.next);
        if (batch === undefined) break;
        appendReady(row, batch);
        row.received.delete(row.next++);
      }
    },
    ready(runtimeId: number, epoch: number, generation: number): readonly VfxGpuOutputBatch[] {
      return streams.get(`${runtimeId}:${epoch}:${generation}`)?.ready ?? [];
    },
    submitted(runtimeId: number, batches: readonly VfxGpuOutputBatch[]) {
      for (const batch of batches) {
        const row = streams.get(`${runtimeId}:${batch.epoch}:${batch.generation}`);
        if (row) row.ready = row.ready.filter((value) => value.sequence > batch.sequence);
      }
    },
    abort(frame: number) {
      for (const tag of frames.get(frame) ?? []) {
        const row = streams.get(tag.key);
        if (!row || row.busy.get(tag.slot) !== tag.sequence) continue;
        row.busy.delete(tag.slot);
        row.received.set(tag.sequence, {
          epoch: tag.epoch,
          generation: tag.generation,
          sequence: tag.sequence,
          events: [],
        });
        while (row.received.has(row.next)) {
          const batch = row.received.get(row.next);
          if (batch === undefined) break;
          appendReady(row, batch);
          row.received.delete(row.next++);
        }
      }
      frames.delete(frame);
    },
    reset() {
      streams.clear();
      frames.clear();
    },
  };
}
