import {
  type CompiledPass,
  handleData,
  type PhysicalGraphSlots,
  type ResourceRecord,
} from './kernel-internal.js';
import type { RenderGraphFrame } from './types.js';

const RENDER_ATTACHMENT = 0x10;

export function privateSamples<Frame>(resource: ResourceRecord<Frame> | undefined): boolean {
  if (resource?.kind !== 'texture' || resource.origin !== 'created') return false;
  const descriptor = resource.descriptor;
  return (
    (descriptor.sampleCount ?? 1) > 1 &&
    descriptor.lifetime !== 'persistent' &&
    // Explicit diagnostic usage can observe contents outside graph callbacks.
    ((descriptor.usage ?? 0) & ~RENDER_ATTACHMENT) === 0
  );
}

/** Most render passes change just one color attachment. */
export type AttachmentSlots = number | Set<number>;
export function addAttachmentSlot(slots: AttachmentSlots | undefined, id: number): AttachmentSlots {
  if (slots === undefined || slots === id) return id;
  if (typeof slots === 'number') return new Set([slots, id]);
  return slots.add(id);
}

function contains(slots: AttachmentSlots | undefined, id: number): boolean {
  return typeof slots === 'number' ? slots === id : slots?.has(id) === true;
}

/** Materialize the actual attachment operations and their content writes together. */
export function placeColorAttachments<Frame extends RenderGraphFrame>(
  entry: CompiledPass<Frame>,
  omitted: AttachmentSlots | undefined,
  physical: PhysicalGraphSlots<Frame>,
  lastSubgraph: number,
): CompiledPass<Frame> {
  if (entry.pass.kind !== 'raster') return entry;
  const descriptor = entry.pass.descriptor;
  let discarded: AttachmentSlots | undefined;
  const colorAttachments = descriptor.colorAttachments.map((attachment) => {
    const target = omitted === undefined ? undefined : handleData(attachment.resolveTarget);
    const omit = target?.kind === 'texture-view' && contains(omitted, target.textureId);
    let storeOp = attachment.storeOp;
    if (storeOp === 'auto') {
      const data = handleData(attachment.view);
      const use = data?.kind === 'texture-view' ? physical.resource(data.textureId) : undefined;
      if (
        !omit &&
        attachment.resolveTarget !== undefined &&
        descriptor.executeIf === undefined &&
        data?.kind === 'texture-view' &&
        use?.lastUse === entry.id &&
        lastSubgraph < entry.id &&
        use.firstClear === data.id
      ) {
        discarded = addAttachmentSlot(discarded, data.textureId);
        storeOp = 'discard';
      } else storeOp = 'store';
    }
    if (omit) {
      const { resolveTarget: _resolve, ...retained } = attachment;
      return Object.freeze({ ...retained, storeOp });
    }
    return storeOp === attachment.storeOp ? attachment : Object.freeze({ ...attachment, storeOp });
  });
  let textureWrites = entry.textureWrites;
  if (omitted !== undefined || discarded !== undefined) {
    const writes: (typeof textureWrites)[number][] = [];
    for (const write of textureWrites) {
      if (contains(omitted, write.texture.id)) continue;
      writes.push(
        contains(discarded, write.texture.id) ? Object.freeze({ ...write, stored: false }) : write,
      );
    }
    textureWrites = Object.freeze(writes);
  }
  return Object.freeze({
    ...entry,
    pass: {
      kind: 'raster' as const,
      descriptor: Object.freeze({
        ...descriptor,
        colorAttachments: Object.freeze(colorAttachments),
      }),
    },
    textureWrites,
  });
}
