import { accessResourceId, type CompiledPass } from './kernel-internal.js';
import type { GraphTextureView, RenderGraphFrame } from './types.js';

/** Retain every declared read and publication boundary; remove only overwritten private resolves. */
export function placeColorResolves<Frame extends RenderGraphFrame>(
  passes: readonly CompiledPass<Frame>[],
  privateTextures: ReadonlySet<number>,
): readonly CompiledPass<Frame>[] {
  const pending = new Map<number, { readonly pass: number; readonly view: GraphTextureView }>();
  const omitted = new Map<number, Set<number>>();
  for (const [index, entry] of passes.entries()) {
    if (entry.pass.kind === 'subgraph') {
      pending.clear();
      continue;
    }
    const descriptor = entry.pass.descriptor;
    const resolves = new Map<number, GraphTextureView>();
    if (entry.pass.kind === 'raster' && descriptor.executeIf === undefined) {
      for (const attachment of entry.pass.descriptor.colorAttachments) {
        const view = attachment.resolveTarget;
        if (view === undefined) continue;
        const id = accessResourceId({ resource: view, usage: 'color-attachment' });
        if (id === undefined || !privateTextures.has(id)) continue;
        // Another use of this allocation, including a view alias or attachment
        // load, is an observation boundary. Never infer subresource independence.
        const accesses = descriptor.accesses.filter((access) => accessResourceId(access) === id);
        if (
          accesses.length === 1 &&
          accesses[0]?.resource === view &&
          accesses[0].usage === 'color-attachment'
        )
          resolves.set(id, view);
      }
    }
    for (const access of descriptor.accesses) {
      const id = accessResourceId(access);
      if (id !== undefined && !resolves.has(id)) pending.delete(id);
    }
    for (const [id, view] of resolves) {
      const previous = pending.get(id);
      if (previous?.view === view) {
        let targets = omitted.get(previous.pass);
        if (targets === undefined) {
          targets = new Set();
          omitted.set(previous.pass, targets);
        }
        targets.add(id);
      }
      pending.set(id, { pass: index, view });
    }
  }
  if (omitted.size === 0) return passes;
  return passes.map((entry, index) => {
    const targets = omitted.get(index);
    if (targets === undefined || entry.pass.kind !== 'raster') return entry;
    const descriptor = entry.pass.descriptor;
    const colorAttachments = Object.freeze(
      descriptor.colorAttachments.map((attachment) => {
        const view = attachment.resolveTarget;
        if (view === undefined) return attachment;
        const id = accessResourceId({ resource: view, usage: 'color-attachment' });
        if (id === undefined || !targets.has(id)) return attachment;
        const { resolveTarget: _resolve, ...retained } = attachment;
        return Object.freeze(retained);
      }),
    );
    return Object.freeze({
      ...entry,
      // Declarations still authorize callbacks and conservatively bound allocation
      // lifetimes. Content publication follows only the actual retained writes.
      pass: {
        kind: 'raster' as const,
        descriptor: Object.freeze({ ...descriptor, colorAttachments }),
      },
      textureWrites: Object.freeze(
        entry.textureWrites.filter((write) => !targets.has(write.resourceId)),
      ),
    });
  });
}
