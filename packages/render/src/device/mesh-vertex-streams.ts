import type { MeshVertexStreamRange } from '@forgeax/engine-geometry';
import type { Buffer, RenderPipeline, RhiRenderCommands } from '@forgeax/engine-rhi';

/** A resident allocation may expose several streams without duplicating storage. */
export function bindMeshVertexStreams(
  commands: Pick<RhiRenderCommands, 'setVertexBuffer'>,
  buffer: Buffer,
  streams: readonly MeshVertexStreamRange[] | undefined,
): number {
  if (streams === undefined) {
    commands.setVertexBuffer(0, buffer);
    return 1;
  }
  for (let slot = 0; slot < streams.length; slot++) {
    const range = streams[slot];
    if (range === undefined) throw new Error('Missing resident mesh vertex stream range');
    commands.setVertexBuffer(slot, buffer, range.offset, range.size);
  }
  return streams.length;
}

/** Vertex slots belong to the encoder. Setting slot zero leaves every upper
 * slot bound, including across points, compute-produced and depth draws. */
export class PassMeshVertexBindings {
  private baseBuffer: Buffer | undefined;
  private baseOffset = 0;
  private baseSize: number | undefined;
  private readonly upperSlots: { buffer: Buffer; offset: number; size: number }[] = [];

  constructor(private readonly commands: Pick<RhiRenderCommands, 'setVertexBuffer'>) {}

  bindSingle(buffer: Buffer): void {
    if (this.baseBuffer === buffer && this.baseSize === undefined) return;
    this.commands.setVertexBuffer(0, buffer);
    this.baseBuffer = buffer;
    this.baseOffset = 0;
    this.baseSize = undefined;
  }

  bind(
    buffer: Buffer,
    streams: readonly MeshVertexStreamRange[] | undefined,
    pipeline?: RenderPipeline,
  ): void {
    if (streams === undefined) {
      this.bindSingle(buffer);
      return;
    }
    if (streams.length === 0) return;
    const base = streams[0];
    if (base === undefined) throw new Error('Missing resident mesh vertex stream range');
    if (
      this.baseBuffer !== buffer ||
      this.baseOffset !== base.offset ||
      this.baseSize !== base.size
    ) {
      this.commands.setVertexBuffer(0, buffer, base.offset, base.size);
      this.baseBuffer = buffer;
      this.baseOffset = base.offset;
      this.baseSize = base.size;
    }
    if (streams.length === 1) return;
    if (pipeline !== undefined && positionOnlyPipelines.has(pipeline)) return;
    for (let slot = 1; slot < streams.length; slot++) {
      const range = streams[slot];
      if (range === undefined) throw new Error('Missing resident mesh vertex stream range');
      const bound = this.upperSlots[slot - 1];
      if (bound?.buffer === buffer && bound.offset === range.offset && bound.size === range.size)
        continue;
      this.commands.setVertexBuffer(slot, buffer, range.offset, range.size);
      if (bound === undefined)
        this.upperSlots[slot - 1] = { buffer, offset: range.offset, size: range.size };
      else {
        bound.buffer = buffer;
        bound.offset = range.offset;
        bound.size = range.size;
      }
    }
  }
}

const positionOnlyPipelines = new WeakSet<RenderPipeline>();
const positionRanges = new WeakMap<
  readonly MeshVertexStreamRange[],
  readonly MeshVertexStreamRange[]
>();

/** The material builder records which admitted PSO consumes a position-only binding. */
export function markPositionOnlyMeshPipeline(pipeline: RenderPipeline): void {
  positionOnlyPipelines.add(pipeline);
}

export function meshVertexStreamsForPipeline(
  pipeline: RenderPipeline,
  streams: readonly MeshVertexStreamRange[] | undefined,
): readonly MeshVertexStreamRange[] | undefined {
  if (streams === undefined || !positionOnlyPipelines.has(pipeline)) return streams;
  let ranges = positionRanges.get(streams);
  if (ranges === undefined) {
    ranges = Object.freeze(streams.slice(0, 1));
    positionRanges.set(streams, ranges);
  }
  return ranges;
}
