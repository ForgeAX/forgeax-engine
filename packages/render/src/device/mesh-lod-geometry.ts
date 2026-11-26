import {
  deriveVertexCount,
  interleavedMesh,
  interleaveStaticMeshVertexStreams,
  prepareStaticMeshVertexStreams,
  projectStaticMeshVertexStreams,
} from '@forgeax/engine-geometry';
import { err, ok, type Result, RhiError } from '@forgeax/engine-rhi';
import type { Submesh, MeshAsset as TypesMeshAsset } from '@forgeax/engine-types';
import { deriveRenderDataMesh, type MeshRenderData } from '../render-data';

export interface MeshGpuRange {
  readonly first: number;
  readonly count: number;
  readonly baseVertex: number;
}

/** Root geometry exposes random section access to every instance, including morphed draws. */
export function vertexSectionStarts(sections: readonly Submesh[]): Uint32Array {
  const starts = new Uint32Array(sections.length);
  for (let i = 1, first = 0; i < sections.length; i++) {
    first += (sections[i - 1] as Submesh).vertexCount;
    starts[i] = first;
  }
  return starts;
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
      const transpose =
        mesh.attributeStorage === 'static-streams'
          ? undefined
          : prepareStaticMeshVertexStreams(mesh.vertices, data.layoutProjection);
      const sourcePlan = transpose ?? projectStaticMeshVertexStreams(data.layoutProjection, count);
      for (const [slot, stream] of staticStreams.layout.streams.entries()) {
        const destination = staticStreams.ranges[slot];
        const range = sourcePlan?.ranges[slot];
        if (range === undefined || destination === undefined)
          return err(
            new RhiError({
              code: 'asset-not-registered',
              expected: 'matching static vertex stream ranges across LODs',
              hint: 're-cook the static mesh LOD chain',
            }),
          );
        const offset =
          (destination.offset + ((vertexCursor * 4) / rootStride) * stream.arrayStride) / 4;
        if (transpose === undefined)
          vertexWords.set(
            source.subarray(range.offset / 4, (range.offset + range.size) / 4),
            offset,
          );
        else transpose.pack(slot, vertexWords.subarray(offset, offset + range.size / 4));
      }
    }
  } else {
    const source = mesh.vertices;
    if (mesh.attributeStorage === 'static-streams') {
      const rows = new Float32Array(
        vertexWords.buffer,
        vertexWords.byteOffset + vertexCursor * 4,
        source.length,
      );
      interleaveStaticMeshVertexStreams(source, data.layoutProjection, rows);
    } else {
      vertexWords.set(
        new Uint32Array(source.buffer, source.byteOffset, source.length),
        vertexCursor,
      );
    }
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
  let firstVertex = vertexBase;
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
    const count = indexed ? submesh.indexCount : submesh.vertexCount;
    levelRanges.push({
      first: indexed ? indexCursor + submesh.indexOffset : firstVertex,
      count,
      baseVertex: 0,
    });
    if (!indexed) firstVertex += count;
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
  const staticStreams = split
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
  const indices = allocateLodIndices(allMeshes, rootStride);
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
    const source = mesh.indices;
    if (indices !== undefined && source !== undefined) {
      // Rebase into the packed vertex buffer here instead of through draw
      // baseVertex: WebGL2 has no base-vertex draw, and CPU-lane LOD draws
      // each level through the ordinary drawIndexed(firstIndex) path.
      const levelBase = vertexCursor / (rootStride / 4);
      for (let i = 0; i < source.length; i++)
        indices[indexCursor + i] = (source[i] as number) + levelBase;
      indexCursor += source.length;
    }
    vertexCursor += mesh.vertices.length;
  }
  return ok({ vertices, indices, lodRanges: ranges, staticStreams });
}

/** Choose the final width from the referenced indices. A large vertex allocation alone
 * does not require wide indices when a level only draws its first vertices. */
function allocateLodIndices(meshes: readonly (TypesMeshAsset | undefined)[], stride: number) {
  if (meshes[0]?.indices === undefined) return undefined;
  let length = 0;
  let base = 0;
  let wide = false;
  for (const mesh of meshes) {
    if (mesh?.indices === undefined) continue;
    const count = mesh.vertices.byteLength / stride;
    const source = mesh.indices;
    length += source.length;
    if (source instanceof Uint32Array) wide = true;
    // Input vertices and indices have been admitted by their asset owner.
    if (!wide && base > 0 && base + count > 0x10000) {
      for (let i = 0; i < source.length; i++) {
        if (base + (source[i] as number) > 0xffff) {
          wide = true;
          break;
        }
      }
    }
    base += count;
  }
  return wide ? new Uint32Array(length) : new Uint16Array(length);
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
