import {
  deriveVertexCount,
  interleavedMesh,
  prepareStaticMeshVertexStreams,
  projectStaticMeshVertexStreams,
} from '@forgeax/engine-geometry';
import { err, ok, type Result, RhiError } from '@forgeax/engine-rhi';
import type { MeshAsset as TypesMeshAsset } from '@forgeax/engine-types';
import { deriveRenderDataMesh, type MeshRenderData } from '../render-data';

export interface MeshGpuRange {
  readonly first: number;
  readonly count: number;
  readonly baseVertex: number;
}

interface PackedMeshLodGeometry {
  readonly staticStreams: ReturnType<typeof projectStaticMeshVertexStreams>;
  readonly vertices: Float32Array;
  readonly indices: Uint16Array | Uint32Array | undefined;
  readonly lodRanges: readonly (readonly MeshGpuRange[])[] | undefined;
}

function projectMeshLodLayouts(
  root: TypesMeshAsset,
  rootData: MeshRenderData,
  lowerMeshes: readonly (TypesMeshAsset | undefined)[],
): Result<(MeshRenderData | undefined)[], RhiError> {
  const lowerData: (MeshRenderData | undefined)[] = [];
  for (const lower of lowerMeshes) {
    if (lower === undefined) {
      lowerData.push(undefined);
      continue;
    }
    const projected = deriveRenderDataMesh(lower);
    if (!projected.ok) {
      return err(
        new RhiError({
          code: 'asset-not-registered',
          expected: 'every MeshAsset LOD to project to a compatible GPU layout',
          hint: 'repair the lower-detail MeshAsset attributes before drawing the LOD chain',
        }),
      );
    }
    lowerData.push(projected.value);
  }
  if (
    deriveVertexCount(root.vertices, rootData.layoutProjection) === undefined ||
    lowerMeshes.some((mesh, index) => {
      if (mesh === undefined) return false;
      const data = lowerData[index];
      return (
        data === undefined || deriveVertexCount(mesh.vertices, data.layoutProjection) === undefined
      );
    })
  ) {
    return err(
      new RhiError({
        code: 'asset-not-registered',
        expected: 'every MeshAsset LOD vertex byte length to match its layout projection stride',
        hint: 'reimport the LOD chain so interleaved vertex bytes match attributes',
      }),
    );
  }
  if (
    lowerData.some(
      (data) =>
        data !== undefined &&
        (data.layoutProjection.digest !== rootData.layoutProjection.digest ||
          data.submeshes.length !== rootData.submeshes.length ||
          data.indexFormat !== rootData.indexFormat),
    )
  ) {
    return err(
      new RhiError({
        code: 'asset-not-registered',
        expected: 'LOD meshes to share vertex/index layout and material-slot topology',
        hint: 'reimport LOD meshes with matching attributes, index format, and submesh slots',
      }),
    );
  }
  return ok(lowerData);
}

function writeMeshLodVertices(
  mesh: TypesMeshAsset,
  data: MeshRenderData,
  vertexWords: Uint32Array,
  vertexCursor: number,
  rootStride: number,
  staticStreams: PackedMeshLodGeometry['staticStreams'],
): Result<void, RhiError> {
  if (staticStreams?.layout.streams !== undefined) {
    const count = (mesh.vertices.length * 4) / rootStride;
    if (count > 0) {
      const source = new Uint32Array(
        mesh.vertices.buffer,
        mesh.vertices.byteOffset,
        mesh.vertices.length,
      );
      const sourcePlan =
        mesh.attributeStorage === 'static-streams'
          ? projectStaticMeshVertexStreams(data.layoutProjection, count)
          : prepareStaticMeshVertexStreams(mesh.vertices, data.layoutProjection);
      for (const [slot, stream] of staticStreams.layout.streams.entries()) {
        const destination = staticStreams.ranges[slot];
        const range = sourcePlan?.ranges[slot];
        if (sourcePlan === undefined || range === undefined || destination === undefined)
          return err(
            new RhiError({
              code: 'asset-not-registered',
              expected: 'matching static vertex stream ranges across LODs',
              hint: 're-cook the static mesh LOD chain',
            }),
          );
        const payload =
          'pack' in sourcePlan && typeof sourcePlan.pack === 'function'
            ? sourcePlan.pack(slot)
            : source.subarray(range.offset / 4, (range.offset + range.size) / 4);
        vertexWords.set(
          payload,
          (destination.offset + ((vertexCursor * 4) / rootStride) * stream.arrayStride) / 4,
        );
      }
    }
  } else {
    const source =
      mesh.attributeStorage === 'static-streams' ? interleavedMesh(mesh).vertices : mesh.vertices;
    vertexWords.set(new Uint32Array(source.buffer, source.byteOffset, source.length), vertexCursor);
  }
  return ok(undefined);
}

function projectMeshLodRanges(
  data: MeshRenderData,
  rootData: MeshRenderData,
  indexed: boolean,
  indexCursor: number,
  vertexBase: number,
): Result<MeshGpuRange[], RhiError> {
  const levelRanges: MeshGpuRange[] = [];
  for (let submeshIndex = 0; submeshIndex < data.submeshes.length; submeshIndex += 1) {
    const submesh = data.submeshes[submeshIndex];
    const rootSubmesh = rootData.submeshes[submeshIndex];
    if (
      submesh === undefined ||
      rootSubmesh === undefined ||
      submesh.materialSlot !== rootSubmesh.materialSlot ||
      submesh.topology !== rootSubmesh.topology
    ) {
      return err(
        new RhiError({
          code: 'asset-not-registered',
          expected: 'LOD submeshes to preserve root material-slot and topology identity',
          hint: 'repair LOD material slots and primitive topology before import',
        }),
      );
    }
    levelRanges.push(
      indexed
        ? { first: indexCursor + submesh.indexOffset, count: submesh.indexCount, baseVertex: 0 }
        : { first: vertexBase, count: submesh.vertexCount, baseVertex: 0 },
    );
  }
  return ok(levelRanges);
}

export function packMeshLodGeometry(
  root: TypesMeshAsset,
  rootData: MeshRenderData,
  lowerMeshes: readonly (TypesMeshAsset | undefined)[],
  split: boolean,
): Result<PackedMeshLodGeometry, RhiError> {
  const rootStride = rootData.layoutProjection.arrayStride;
  if (lowerMeshes.length === 0) return ok(singleMeshLodGeometry(root, rootData, split));
  const allMeshes = [root, ...lowerMeshes];
  const words = allMeshes.reduce((sum, mesh) => sum + (mesh?.vertices.length ?? 0), 0);
  const staticStreams =
    split && allMeshes.some((mesh) => mesh?.attributeStorage === 'static-streams')
      ? projectStaticMeshVertexStreams(rootData.layoutProjection, (words * 4) / rootStride)
      : undefined;
  const layouts = projectMeshLodLayouts(root, rootData, lowerMeshes);
  if (!layouts.ok) return layouts;
  const lowerData = layouts.value;
  if (
    allMeshes.some(
      (mesh) => mesh !== undefined && (mesh.indices === undefined) !== (root.indices === undefined),
    )
  ) {
    return err(
      new RhiError({
        code: 'asset-not-registered',
        expected: 'all LOD meshes to use the same indexed or non-indexed draw mode',
        hint: 'reimport the LOD chain with consistent index data',
      }),
    );
  }
  const vertices = new Float32Array(words);
  const vertexWords = new Uint32Array(vertices.buffer);
  const ranges: MeshGpuRange[][] = [];
  let vertexCursor = 0;
  let indexCursor = 0;
  const indexed = root.indices !== undefined;
  const sourceIndices: number[] = [];
  let requiresUint32 = root.indices instanceof Uint32Array;
  for (let level = 0; level < allMeshes.length; level += 1) {
    const mesh = allMeshes[level];
    const data = level === 0 ? rootData : lowerData[level - 1];
    if (mesh === undefined || data === undefined) {
      // Preserve the authored level index without allocating substitute geometry.
      ranges.push([]);
      continue;
    }
    const copied = writeMeshLodVertices(
      mesh,
      data,
      vertexWords,
      vertexCursor,
      rootStride,
      staticStreams,
    );
    if (!copied.ok) return copied;
    const levelRanges = projectMeshLodRanges(
      data,
      rootData,
      indexed,
      indexCursor,
      vertexCursor / (rootStride / 4),
    );
    if (!levelRanges.ok) return levelRanges;
    ranges.push(levelRanges.value);
    if (indexed) {
      const indices = mesh.indices;
      if (indices === undefined) continue;
      // Rebase into the packed vertex buffer here instead of through draw
      // baseVertex: WebGL2 has no base-vertex draw, and CPU-lane LOD draws
      // each level through the ordinary drawIndexed(firstIndex) path.
      const levelBase = vertexCursor / (rootStride / 4);
      if (indices instanceof Uint32Array) requiresUint32 = true;
      for (const value of indices) {
        const absolute = value + levelBase;
        sourceIndices.push(absolute);
        if (absolute > 0xffff) requiresUint32 = true;
      }
      indexCursor += indices.length;
    }
    vertexCursor += mesh.vertices.length;
  }
  const indices = indexed
    ? requiresUint32
      ? Uint32Array.from(sourceIndices)
      : Uint16Array.from(sourceIndices)
    : undefined;
  return ok({ vertices, indices, lodRanges: ranges, staticStreams });
}

function singleMeshLodGeometry(
  mesh: TypesMeshAsset,
  data: MeshRenderData,
  split: boolean,
): PackedMeshLodGeometry {
  if (mesh.attributeStorage !== 'static-streams')
    return {
      vertices: mesh.vertices,
      indices: mesh.indices,
      lodRanges: undefined,
      staticStreams: undefined,
    };
  const staticStreams = split
    ? projectStaticMeshVertexStreams(
        data.layoutProjection,
        mesh.vertices.byteLength / data.layoutProjection.arrayStride,
      )
    : undefined;
  const vertices = staticStreams === undefined ? interleavedMesh(mesh).vertices : mesh.vertices;
  return { vertices, indices: mesh.indices, lodRanges: undefined, staticStreams };
}
