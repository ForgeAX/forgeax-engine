import { accessResourceId, type CompiledPass } from './kernel-internal.js';
import type {
  RasterColorAttachment,
  RasterDepthStencilAttachment,
  RasterGraphPass,
  RenderGraphFrame,
} from './types.js';

/** Logical membership remains intact; only the native attachment lifetime is joined. */
export interface RasterBatch<Frame extends RenderGraphFrame> {
  readonly first: number;
  readonly last: number;
  readonly name: string;
  readonly names: readonly string[];
  readonly colorAttachments: readonly RasterColorAttachment<Frame>[];
  readonly depthStencilAttachment: RasterDepthStencilAttachment | undefined;
}

function joinDepth(
  a: RasterDepthStencilAttachment | undefined,
  b: RasterDepthStencilAttachment | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.view === b.view &&
    (a.depthReadOnly ?? false) === (b.depthReadOnly ?? false) &&
    (a.stencilReadOnly ?? false) === (b.stencilReadOnly ?? false) &&
    (a.depthReadOnly === true || b.depthLoadOp === undefined || b.depthLoadOp === 'load') &&
    (a.stencilReadOnly === true || b.stencilLoadOp === undefined || b.stencilLoadOp === 'load') &&
    (a.depthStoreOp === undefined || a.depthStoreOp === 'store') &&
    (a.stencilStoreOp === undefined || a.stencilStoreOp === 'store')
  );
}

function eligible<Frame extends RenderGraphFrame>(pass: CompiledPass<Frame>): boolean {
  if (pass.pass.kind !== 'raster') return false;
  const descriptor = pass.pass.descriptor;
  if (descriptor.executeIf !== undefined || descriptor.occlusionQuerySet !== undefined)
    return false;
  // A native pass has one resource-usage scope. Do not turn an inter-pass
  // storage barrier into simultaneous read/write usage or writable aliasing.
  return descriptor.accesses.every(
    (access) =>
      ![
        'storage-write',
        'storage-read-write',
        'sampled-storage-write',
        'sampled-storage-read-write',
        'copy-dst',
        'acceleration-structure-build',
      ].includes(access.usage),
  );
}

function compatible<Frame extends RenderGraphFrame>(
  previous: RasterGraphPass<Frame>,
  next: RasterGraphPass<Frame>,
): boolean {
  if (
    previous.colorAttachments.length !== next.colorAttachments.length ||
    !joinDepth(previous.depthStencilAttachment, next.depthStencilAttachment)
  )
    return false;
  for (const [i, a] of previous.colorAttachments.entries()) {
    const b = next.colorAttachments[i];
    if (
      b === undefined ||
      a.view !== b.view ||
      a.depthSlice !== b.depthSlice ||
      a.resolveTarget !== undefined ||
      a.storeOp !== 'store' ||
      b.loadOp !== 'load'
    )
      return false;
  }
  const attachments = new Set([
    ...previous.colorAttachments.map((a) =>
      accessResourceId({ resource: a.view, usage: 'color-attachment' }),
    ),
    ...next.colorAttachments.flatMap((a) =>
      a.resolveTarget === undefined
        ? []
        : [accessResourceId({ resource: a.resolveTarget, usage: 'color-attachment' })],
    ),
    ...(previous.depthStencilAttachment === undefined
      ? []
      : [
          accessResourceId({
            resource: previous.depthStencilAttachment.view,
            usage: 'depth-stencil-read',
          }),
        ]),
  ]);
  // Include all view aliases of attachment allocations: even disjoint mips
  // can violate the backend's simultaneous render-attachment usage scope.
  return [...previous.accesses, ...next.accesses].every(
    (access) =>
      !attachments.has(accessResourceId(access)) ||
      access.usage === 'color-attachment' ||
      access.usage === 'depth-stencil-read' ||
      access.usage === 'depth-stencil-write',
  );
}

/** Build only consecutive, unconditional groups; never reorder feature work. */
export function planRasterBatches<Frame extends RenderGraphFrame>(
  passes: readonly CompiledPass<Frame>[],
): ReadonlyMap<number, RasterBatch<Frame>> {
  const batches = new Map<number, RasterBatch<Frame>>();
  let first = 0;
  while (first < passes.length) {
    const start = passes[first];
    if (start === undefined || start.pass.kind !== 'raster' || !eligible(start)) {
      first++;
      continue;
    }
    let last = first;
    while (last + 1 < passes.length) {
      const previous = passes[last],
        next = passes[last + 1];
      if (
        previous?.pass.kind !== 'raster' ||
        next?.pass.kind !== 'raster' ||
        !eligible(next) ||
        !compatible(previous.pass.descriptor, next.pass.descriptor)
      )
        break;
      const nextDescriptor = next.pass.descriptor;
      // Usage compatibility must hold across the entire physical group.
      if (
        passes
          .slice(first, last)
          .some(
            (member) =>
              member.pass.kind !== 'raster' || !compatible(member.pass.descriptor, nextDescriptor),
          )
      )
        break;
      last++;
    }
    const end = passes[last];
    if (last > first && end?.pass.kind === 'raster') {
      const initial = start.pass.descriptor,
        final = end.pass.descriptor;
      const names = Object.freeze(passes.slice(first, last + 1).map((p) => p.name));
      const depth = initial.depthStencilAttachment;
      const batch: RasterBatch<Frame> = Object.freeze({
        first,
        last,
        names,
        name: names.join(' + '),
        colorAttachments: Object.freeze(
          initial.colorAttachments.map((attachment, i) =>
            Object.freeze({
              ...attachment,
              storeOp: final.colorAttachments[i]?.storeOp ?? attachment.storeOp,
              resolveTarget: final.colorAttachments[i]?.resolveTarget,
            }),
          ),
        ),
        depthStencilAttachment:
          depth === undefined
            ? undefined
            : Object.freeze({
                ...depth,
                depthStoreOp: final.depthStencilAttachment?.depthStoreOp,
                stencilStoreOp: final.depthStencilAttachment?.stencilStoreOp,
              }),
      });
      for (let i = first; i <= last; i++) batches.set(i, batch);
    }
    first = last + 1;
  }
  return batches;
}
