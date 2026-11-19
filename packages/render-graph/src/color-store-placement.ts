import { accessResourceId, type CompiledPass, type ResourceRecord } from './kernel-internal.js';
import type { GraphTextureView, RenderGraphFrame } from './types.js';

const RENDER_ATTACHMENT = 0x10;

interface TextureUse {
  readonly resetView: GraphTextureView | undefined;
  last: number;
}

function firstReset<Frame extends RenderGraphFrame>(
  entry: CompiledPass<Frame>,
  id: number,
): GraphTextureView | undefined {
  if (entry.pass.kind !== 'raster' || entry.pass.descriptor.executeIf !== undefined)
    return undefined;
  const descriptor = entry.pass.descriptor;
  const accesses = descriptor.accesses.filter((access) => accessResourceId(access) === id);
  if (accesses.length !== 1 || accesses[0]?.usage !== 'color-attachment') return undefined;
  return descriptor.colorAttachments.find(
    (attachment) => attachment.view === accesses[0]?.resource && attachment.loadOp === 'clear',
  )?.view;
}

function textureUses<Frame extends RenderGraphFrame>(passes: readonly CompiledPass<Frame>[]) {
  const uses = new Map<number, TextureUse>();
  let lastSubgraph = -1;
  for (const [index, entry] of passes.entries()) {
    if (entry.pass.kind === 'subgraph') lastSubgraph = index;
    for (const access of entry.pass.descriptor.accesses) {
      const id = accessResourceId(access);
      if (id === undefined) continue;
      const previous = uses.get(id);
      if (previous === undefined) uses.set(id, { resetView: firstReset(entry, id), last: index });
      else previous.last = index;
    }
  }
  return { uses, lastSubgraph };
}

function privateSamples<Frame>(resource: ResourceRecord<Frame> | undefined): boolean {
  if (resource?.kind !== 'texture' || resource.origin !== 'created') return false;
  const descriptor = resource.descriptor;
  return (
    (descriptor.sampleCount ?? 1) > 1 &&
    descriptor.lifetime !== 'persistent' &&
    // Explicit diagnostic usage can observe contents outside graph callbacks.
    ((descriptor.usage ?? 0) & ~RENDER_ATTACHMENT) === 0
  );
}

/** Resolve auto once at compile time, after unnecessary resolves have been removed. */
export function placeColorStores<Frame extends RenderGraphFrame>(
  passes: readonly CompiledPass<Frame>[],
  resources: ReadonlyMap<number, ResourceRecord<Frame>>,
): readonly CompiledPass<Frame>[] {
  const { uses, lastSubgraph } = textureUses(passes);
  return passes.map((entry, index) => {
    if (entry.pass.kind !== 'raster') return entry;
    const descriptor = entry.pass.descriptor;
    if (!descriptor.colorAttachments.some((attachment) => attachment.storeOp === 'auto'))
      return entry;
    const discarded = new Set<number>();
    const colorAttachments = descriptor.colorAttachments.map((attachment) => {
      if (attachment.storeOp !== 'auto') return attachment;
      const id = accessResourceId({ resource: attachment.view, usage: 'color-attachment' });
      const use = id === undefined ? undefined : uses.get(id);
      const release =
        id !== undefined &&
        privateSamples(resources.get(id)) &&
        attachment.resolveTarget !== undefined &&
        descriptor.executeIf === undefined &&
        use?.resetView === attachment.view &&
        use.last === index &&
        lastSubgraph < index;
      if (release && id !== undefined) discarded.add(id);
      return Object.freeze({
        ...attachment,
        storeOp: release ? ('discard' as const) : ('store' as const),
      });
    });
    return Object.freeze({
      ...entry,
      pass: {
        kind: 'raster' as const,
        descriptor: Object.freeze({
          ...descriptor,
          colorAttachments: Object.freeze(colorAttachments),
        }),
      },
      textureWrites: Object.freeze(
        entry.textureWrites.map((write) =>
          discarded.has(write.resourceId) ? Object.freeze({ ...write, stored: false }) : write,
        ),
      ),
    });
  });
}
