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
