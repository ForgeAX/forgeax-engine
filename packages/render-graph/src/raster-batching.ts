import { accessResourceId, type CompiledPass } from './kernel-internal.js';
import type {
  GraphAccessUsage,
  GraphPass,
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
  readonly depthStencilAttachment: RasterDepthStencilAttachment<Frame> | undefined;
}

function joinDepth<Frame>(
  a: RasterDepthStencilAttachment<Frame> | undefined,
  b: RasterDepthStencilAttachment<Frame> | undefined,
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

const BATCH_BARRIERS: ReadonlySet<GraphAccessUsage> = new Set([
  'storage-write',
  'storage-read-write',
  'sampled-storage-write',
  'sampled-storage-read-write',
  'copy-dst',
  'acceleration-structure-build',
]);

function eligible<Frame>(descriptor: RasterGraphPass<Frame>): boolean {
  return (
    descriptor.executeIf === undefined &&
    descriptor.occlusionQuerySet === undefined &&
    descriptor.accesses.every((access) => !BATCH_BARRIERS.has(access.usage))
  );
}

/** Undefined breaks the run. A true result leaves a store or resolve decision open. */
function consecutiveAttachments<Frame>(
  previous: RasterGraphPass<Frame>,
  next: RasterGraphPass<Frame>,
): boolean | undefined {
  if (
    previous.colorAttachments.length !== next.colorAttachments.length ||
    !joinDepth(previous.depthStencilAttachment, next.depthStencilAttachment)
  )
    return undefined;
  let checkPlacement = false;
  for (let i = 0; i < previous.colorAttachments.length; i++) {
    const a = previous.colorAttachments[i];
    const b = next.colorAttachments[i];
    if (
      a === undefined ||
      b === undefined ||
      a.view !== b.view ||
      a.depthSlice !== b.depthSlice ||
      (a.storeOp !== 'store' && a.storeOp !== 'auto') ||
      b.loadOp !== 'load'
    )
      return undefined;
    checkPlacement ||= a.resolveTarget !== undefined || a.storeOp === 'auto';
  }
  return checkPlacement;
}

interface RasterCandidate {
  readonly first: number;
  readonly end: number;
  readonly checkPlacement: boolean;
}

/** Find possible native runs as passes are declared. Color store and
 * resolve placement may still change, so only immutable boundaries split a candidate. */
export class RasterBatchCandidates<Frame extends RenderGraphFrame> {
  private previous: RasterGraphPass<Frame> | undefined;
  private previousId = -1;
  private first: number | undefined;
  private checkPlacement = false;
  private ranges: RasterCandidate[] | undefined;

  append(id: number, current: RasterGraphPass<Frame>): void {
    const previous = this.previous;
    const previousId = this.previousId;
    this.previous = current;
    this.previousId = id;
    if (previous !== undefined && previousId + 1 === id) {
      const placement = consecutiveAttachments(previous, current);
      if (
        placement !== undefined &&
        (this.first !== undefined || eligible(previous)) &&
        eligible(current)
      ) {
        this.first ??= previousId;
        this.checkPlacement ||= placement;
        return;
      }
    }
    this.endRun(previousId + 1);
  }

  finish(): readonly RasterCandidate[] | undefined {
    this.endRun(this.previousId + 1);
    return this.ranges;
  }

  private endRun(end: number): void {
    if (this.first === undefined) return;
    this.ranges ??= [];
    this.ranges.push({ first: this.first, end, checkPlacement: this.checkPlacement });
    this.first = undefined;
    this.checkPlacement = false;
  }
}

/** Other uses of an attachment's backing, even from a different mip, cannot share its pass. */
function admitRasterUses<Frame extends RenderGraphFrame>(
  descriptor: RasterGraphPass<Frame>,
  attachments: ReadonlySet<number | undefined>,
  reads: Set<number | undefined>,
): boolean {
  for (const access of descriptor.accesses) {
    if (
      access.usage === 'color-attachment' ||
      access.usage === 'depth-stencil-read' ||
      access.usage === 'depth-stencil-write'
    )
      continue;
    const id = accessResourceId(access);
    if (attachments.has(id)) return false;
    reads.add(id);
  }
  for (const attachment of descriptor.colorAttachments)
    if (
      attachment.resolveTarget !== undefined &&
      reads.has(accessResourceId({ resource: attachment.resolveTarget, usage: 'color-attachment' }))
    )
      return false;
  return true;
}

const NO_RASTER_BATCHES = Object.freeze([]);

type RasterEntry<Frame extends RenderGraphFrame> = CompiledPass<Frame> & {
  readonly pass: Extract<GraphPass<Frame>, { kind: 'raster' }>;
};

function batchFromRange<Frame extends RenderGraphFrame>(
  passes: readonly CompiledPass<Frame>[],
  first: number,
  last: number,
  initial: RasterGraphPass<Frame>,
  final: RasterGraphPass<Frame>,
): RasterBatch<Frame> {
  const names: string[] = [];
  for (let i = first; i <= last; i++) names.push((passes[i] as CompiledPass<Frame>).name);
  const depth = initial.depthStencilAttachment;
  return Object.freeze({
    first,
    last,
    names: Object.freeze(names),
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
}

/** Use only the stream's candidate runs and the final attachment placement. */
export function planRasterBatches<Frame extends RenderGraphFrame>(
  passes: readonly CompiledPass<Frame>[],
  candidates: readonly RasterCandidate[] | undefined,
): readonly (RasterBatch<Frame> | undefined)[] {
  if (candidates === undefined) return NO_RASTER_BATCHES;
  const batches: (RasterBatch<Frame> | undefined)[] = [];
  const attachments = new Set<number | undefined>();
  const reads = new Set<number | undefined>();

  for (const candidate of candidates) {
    let first = candidate.first;
    while (first + 1 < candidate.end) {
      const initial = (passes[first] as RasterEntry<Frame>).pass.descriptor;
      let final = initial;
      let last = first;
      while (last + 1 < candidate.end) {
        if (
          candidate.checkPlacement &&
          final.colorAttachments.some(
            (attachment) =>
              attachment.resolveTarget !== undefined || attachment.storeOp !== 'store',
          )
        )
          break;
        if (last === first) {
          reads.clear();
          attachments.clear();
          for (const attachment of initial.colorAttachments)
            attachments.add(
              accessResourceId({ resource: attachment.view, usage: 'color-attachment' }),
            );
          if (initial.depthStencilAttachment !== undefined)
            attachments.add(
              accessResourceId({
                resource: initial.depthStencilAttachment.view,
                usage: 'depth-stencil-read',
              }),
            );
          if (!admitRasterUses(initial, attachments, reads)) break;
        }
        const next = (passes[last + 1] as RasterEntry<Frame>).pass.descriptor;
        if (!admitRasterUses(next, attachments, reads)) break;
        final = next;
        last++;
      }
      if (last > first) {
        const batch = batchFromRange(passes, first, last, initial, final);
        for (let i = first; i <= last; i++) batches[i] = batch;
      }
      first = last + 1;
    }
  }
  return batches;
}
