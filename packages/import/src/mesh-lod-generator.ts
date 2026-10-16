import {
  deriveVertexLayoutProjection,
  packInterleavedVertexAttributes,
  prepareMeshData,
} from '@forgeax/engine-geometry';
import { box3 } from '@forgeax/engine-math';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  err,
  type MeshAsset,
  type MeshLodLevel,
  ok,
  type Result,
  type VertexAttributeMap,
} from '@forgeax/engine-types';
import { MeshoptSimplifier } from 'meshoptimizer/simplifier';
import { validateMeshLodContract } from './mesh-lod.js';

export interface MeshLodGenerationOptions {
  /** Stable producer-owned GUIDs and coverage, ordered from fine to coarse. */
  readonly levels: readonly (MeshLodLevel & { readonly triangleRatio: number })[];
  /** Relative to the source position extent; includes weighted attribute error. */
  readonly maxError: number;
  /** Keep open edges fixed, useful for adjoining terrain tiles. Defaults to true. */
  readonly lockBorder?: boolean;
}

export interface MeshLodGenerationReport {
  readonly triangleCount: number;
  readonly vertexCount: number;
  readonly error: number;
  /** False when the error budget or protected topology prevents the requested reduction. */
  readonly targetReached: boolean;
}

export interface GeneratedMeshLods {
  readonly root: MeshAsset;
  /** In options.levels order; publish each using its supplied ordinary Mesh GUID. */
  readonly meshes: readonly MeshAsset[];
  readonly reports: readonly MeshLodGenerationReport[];
}

export interface MeshLodGenerationError {
  readonly code: 'mesh-lod-generation-invalid' | 'mesh-lod-generation-unavailable';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly reason: string };
}

function invalid(reason: string): Result<never, MeshLodGenerationError> {
  return err({
    code: 'mesh-lod-generation-invalid',
    expected: 'canonical triangle meshes and decreasing LOD ratios with a finite error budget',
    hint: 'repair the source mesh or LOD generation options and rebuild the same GUIDs',
    detail: { reason },
  });
}

/** Offline production only: never called by Renderer or the asset loader. */
export async function generateMeshLods(
  mesh: MeshAsset,
  options: MeshLodGenerationOptions,
): Promise<Result<GeneratedMeshLods, MeshLodGenerationError>> {
  try {
    if (mesh.lods?.length) return invalid('source already owns an authored LOD chain');
    if (
      !options.levels.length ||
      !Number.isFinite(options.maxError) ||
      options.maxError < 0 ||
      options.maxError > 1
    )
      return invalid('require one to seven levels and maxError in [0, 1]');
    const contract = validateMeshLodContract({
      lods: options.levels.map(({ mesh: guid, screenCoverage }) => ({
        meshGuid: AssetGuid.format(guid),
        screenCoverage,
      })),
      ...(mesh.lodHysteresis === undefined ? {} : { lodHysteresis: mesh.lodHysteresis }),
    });
    if (!contract.ok) return invalid(contract.error.reason);
    let previous = 1;
    for (const level of options.levels) {
      if (
        !Number.isFinite(level.triangleRatio) ||
        level.triangleRatio <= 0 ||
        level.triangleRatio >= previous
      )
        return invalid('triangleRatio must strictly decrease inside (0, 1)');
      previous = level.triangleRatio;
    }
    const refs = mesh.materialSlots.flatMap((slot) =>
      slot.defaultMaterial === undefined ? [] : [AssetGuid.format(slot.defaultMaterial)],
    );
    const prepared = prepareMeshData(mesh, 'lod-source', refs);
    if (!prepared.ok) return invalid(prepared.error.actual);
    const count = prepared.value.vertexCount;
    if (!count || mesh.attributes.position === undefined)
      return invalid('source requires positions and vertices');
    const positions = mesh.attributes.position as Float32Array;
    const indices =
      mesh.indices === undefined
        ? Uint32Array.from({ length: count }, (_, i) => i)
        : Uint32Array.from(mesh.indices);
    if (!indices.length || !mesh.submeshes.length)
      return invalid('source requires triangle sections');
    for (const index of indices)
      if (index >= count) return invalid('index exceeds vertex cardinality');
    let offset = 0;
    for (const section of mesh.submeshes) {
      if (
        section.topology !== 'triangle-list' ||
        section.indexOffset !== offset ||
        !Number.isSafeInteger(section.indexCount) ||
        section.indexCount < 3 ||
        section.indexCount % 3 ||
        !Number.isSafeInteger(section.materialSlot) ||
        section.materialSlot < 0 ||
        section.materialSlot >= mesh.materialSlots.length
      )
        return invalid(
          'triangle sections must partition the index buffer and reference existing material slots',
        );
      offset += section.indexCount;
    }
    if (offset !== indices.length) return invalid('sections must cover the complete index buffer');
    const source =
      mesh.indices === undefined
        ? { ...mesh, indices: count <= 65536 ? Uint16Array.from(indices) : indices }
        : mesh;
    if (!MeshoptSimplifier.supported)
      return err({
        code: 'mesh-lod-generation-unavailable',
        expected: 'WebAssembly mesh simplification',
        hint: 'run the source producer on a WebAssembly-capable build host',
        detail: { reason: 'WebAssembly unavailable' },
      });
    await MeshoptSimplifier.ready;
    const projection = deriveVertexLayoutProjection(mesh.attributes);
    // Skin/morph variation is a hard constraint, not a bind-pose approximation.
    const locks = deformationLocks(mesh, indices, count);
    const attributeEntries = projection.attributes.filter(
      (a) => a.key !== 'position' && a.key !== 'skinIndex' && a.key !== 'skinWeight',
    );
    const attributeStride = attributeEntries.reduce((sum, a) => sum + a.byteLength / 4, 0);
    const attributes = new Float32Array(count * attributeStride);
    const weights: number[] = [];
    let lane = 0;
    for (const entry of attributeEntries) {
      const values = mesh.attributes[entry.key] as Float32Array;
      const components = entry.byteLength / 4;
      weights.push(
        ...Array.from({ length: components }, () =>
          entry.key === 'normal' || entry.key === 'tangent' ? 0.5 : 1,
        ),
      );
      for (let vertex = 0; vertex < count; vertex++)
        attributes.set(
          values.subarray(vertex * components, (vertex + 1) * components),
          vertex * attributeStride + lane,
        );
      lane += components;
    }
    const meshes: MeshAsset[] = [];
    const reports: MeshLodGenerationReport[] = [];
    for (const level of options.levels) {
      const chunks: Uint32Array[] = [];
      const submeshes: MeshAsset['submeshes'][number][] = [];
      let outputOffset = 0;
      let error = 0;
      for (const section of mesh.submeshes) {
        const source = indices.slice(section.indexOffset, section.indexOffset + section.indexCount);
        const target = Math.max(3, Math.floor((section.indexCount / 3) * level.triangleRatio) * 3);
        const [simplified, sectionError] = MeshoptSimplifier.simplifyWithAttributes(
          source,
          positions,
          3,
          attributes,
          attributeStride,
          weights,
          locks,
          target,
          options.maxError,
          options.lockBorder === false ? [] : ['LockBorder'],
        );
        // Budgets and locked topology take precedence over triangle ratios.
        const result = simplified.length ? simplified : source;
        chunks.push(result);
        submeshes.push({ ...section, indexOffset: outputOffset, indexCount: result.length });
        outputOffset += result.length;
        error = Math.max(error, sectionError);
      }
      const combined = new Uint32Array(outputOffset);
      let start = 0;
      for (const chunk of chunks) {
        combined.set(chunk, start);
        start += chunk.length;
      }
      const [remap, vertexCount] = MeshoptSimplifier.compactMesh(combined);
      const generated = compactMesh(source, combined, remap, vertexCount, submeshes);
      meshes.push(generated);
      reports.push({
        triangleCount: combined.length / 3,
        vertexCount,
        error,
        targetReached: combined.length <= indices.length * level.triangleRatio,
      });
    }
    return ok({
      root: {
        ...source,
        lods: options.levels.map(({ mesh: guid, screenCoverage }) => ({
          mesh: guid,
          screenCoverage,
        })),
      },
      meshes,
      reports,
    });
  } catch (error) {
    return invalid(error instanceof Error ? error.message : String(error));
  }
}

function deformationLocks(mesh: MeshAsset, indices: Uint32Array, count: number): Uint8Array {
  const locks = new Uint8Array(count);
  const streams = [
    mesh.attributes.skinIndex,
    mesh.attributes.skinWeight,
    ...(mesh.morphTargets ?? []).flatMap((target) => [
      target.position,
      target.normal,
      target.tangent,
    ]),
  ].filter(
    (stream): stream is Float32Array | Uint16Array =>
      stream instanceof Float32Array || stream instanceof Uint16Array,
  );
  for (let i = 0; i < indices.length; i += 3) {
    for (let edge = 0; edge < 3; edge++) {
      const a = indices[i + edge] as number;
      const b = indices[i + ((edge + 1) % 3)] as number;
      for (const stream of streams) {
        const width = stream.length / count;
        for (let lane = 0; lane < width; lane++) {
          if (stream[a * width + lane] !== stream[b * width + lane]) {
            locks[a] = 1;
            locks[b] = 1;
          }
        }
      }
    }
  }
  return locks;
}

function compactMesh(
  mesh: MeshAsset,
  indices: Uint32Array,
  remap: Uint32Array,
  count: number,
  submeshes: MeshAsset['submeshes'],
): MeshAsset {
  const remapStream = <T extends Float32Array | Uint16Array>(stream: T, width: number): T => {
    const output = (
      stream instanceof Uint16Array
        ? new Uint16Array(count * width)
        : new Float32Array(count * width)
    ) as T;
    for (let old = 0; old < remap.length; old++) {
      const next = remap[old] as number;
      if (next !== 0xffffffff)
        output.set(stream.subarray(old * width, (old + 1) * width), next * width);
    }
    return output;
  };
  const attributes = Object.fromEntries(
    deriveVertexLayoutProjection(mesh.attributes).attributes.map((entry) => {
      const stream = mesh.attributes[entry.key] as Float32Array | Uint16Array;
      return [entry.key, remapStream(stream, entry.byteLength / stream.BYTES_PER_ELEMENT)];
    }),
  ) as VertexAttributeMap;
  const packed = packInterleavedVertexAttributes(attributes, count);
  if (!packed.ok) throw packed.error;
  const positions = attributes.position as Float32Array;
  const aabb = box3.fromPositions(box3.create(), positions);
  return {
    kind: 'mesh',
    vertices: packed.value.vertices,
    attributes,
    // A LOD chain shares one GPU index-buffer format with its source.
    indices: mesh.indices instanceof Uint32Array ? indices : Uint16Array.from(indices),
    aabb,
    submeshes: submeshes.map((section) => ({ ...section, vertexCount: count })),
    materialSlots: mesh.materialSlots.map((slot) => ({ ...slot })),
    ...(mesh.morphTargets === undefined
      ? {}
      : {
          morphTargets: mesh.morphTargets.map((target) =>
            Object.fromEntries(
              Object.entries(target).map(([key, stream]) => [
                key,
                remapStream(stream, key === 'tangent' ? 4 : 3),
              ]),
            ),
          ),
        }),
    ...(mesh.morphWeights === undefined ? {} : { morphWeights: mesh.morphWeights.slice() }),
  };
}
