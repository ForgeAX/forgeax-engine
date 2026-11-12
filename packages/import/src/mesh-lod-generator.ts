import {
  deriveVertexLayoutProjection,
  packInterleavedVertexAttributes,
  prepareMeshData,
} from '@forgeax/engine-geometry';
import { box3 } from '@forgeax/engine-math';
import { AssetGuid, type PackageId } from '@forgeax/engine-pack/guid';
import type { PackOutput, PackOutputMap } from '@forgeax/engine-pack/source';
import {
  err,
  type MeshAsset,
  type MeshLodLevel,
  ok,
  type Result,
  type VertexAttributeMap,
} from '@forgeax/engine-types';
import { type Flags, MeshoptSimplifier } from 'meshoptimizer/simplifier';
import { validateMeshLodContract } from './mesh-lod.js';

export interface MeshLodGenerationOptions {
  /** Stable producer-owned GUIDs and coverage, ordered from fine to coarse. */
  readonly levels: readonly (MeshLodLevel & {
    readonly mesh: import('@forgeax/engine-types').AssetGuid;
    readonly triangleRatio: number;
    /** This level's budget; defaults to `maxError`. Coarser levels usually allow more. */
    readonly maxError?: number;
  })[];
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
      if (
        level.maxError !== undefined &&
        (!Number.isFinite(level.maxError) || level.maxError < 0 || level.maxError > 1)
      )
        return invalid('a level maxError must lie in [0, 1]');
      previous = level.triangleRatio;
    }
    const prepared = prepareMeshData(mesh, 'lod-source');
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
    const weights = attributeEntries.flatMap((entry) =>
      Array.from({ length: entry.byteLength / 4 }, () =>
        entry.key === 'normal' || entry.key === 'tangent' ? 0.5 : 1,
      ),
    );
    const topology = sourceTopology(positions, indices, options.lockBorder !== false);
    const input = simplifierInput(mesh, indices, topology.weld, attributeEntries, locks);
    const flags: Flags[] = options.lockBorder === false ? [] : ['LockBorder'];
    // Permissive collapses cross attribute seams; without it a flat-shaded or UV-split
    // part (many wedges per position) keeps every vertex and returns its source.
    const permissive: Flags[] = [...flags, 'Permissive'];
    const sectionCount = mesh.submeshes.length;
    const meshes: MeshAsset[] = [];
    const reports: MeshLodGenerationReport[] = [];
    // The source is the valid level a rejected first LOD falls back to.
    let accepted = { bySection: sectionIndices(mesh, indices), error: 0 };
    for (const level of options.levels) {
      const target = Math.max(3, Math.floor((indices.length / 3) * level.triangleRatio) * 3);
      const attempt = (levelFlags: Flags[]) => {
        const levelLocks = input.locks.slice();
        if (levelFlags === permissive)
          for (const wedge of input.sectionSeams) levelLocks[wedge] = 1;
        for (let ring = 1; ring <= TOPOLOGY_REPAIR_RINGS; ring++) {
          const [simplified, error] = MeshoptSimplifier.simplifyWithAttributes(
            input.indices,
            input.positions,
            3,
            input.attributes,
            input.stride,
            weights,
            levelLocks,
            target,
            level.maxError ?? options.maxError,
            levelFlags,
          );
          const bySection = Array.from({ length: sectionCount }, () => [] as number[]);
          const defects: number[] = [];
          for (let i = 0; i < simplified.length; i += 3) {
            const corners = [0, 1, 2].map((c) => simplified[i + c] as number);
            const section = input.section[corners[0] as number] as number;
            if (corners.some((v) => input.section[v] !== section))
              defects.push(
                ...corners.map((v) => topology.weld[input.origin[v] as number] as number),
              );
            bySection[section]?.push(...corners.map((v) => input.origin[v] as number));
          }
          defects.push(...topologyDefects(topology, bySection.flat()));
          if (!defects.length && bySection.every((section) => section.length))
            return { bySection, error };
          // Collapses near a defect created it; protect the surrounding source surface and retry.
          for (const vertex of topology.ring(defects, ring))
            for (const wedge of input.wedges(vertex)) levelLocks[wedge] = 1;
        }
        return undefined;
      };
      const adopt = (candidate: typeof accepted | undefined) => {
        if (candidate && triangleTotal(candidate.bySection) < triangleTotal(accepted.bySection))
          accepted = candidate;
      };
      adopt(attempt(flags));
      if (triangleTotal(accepted.bySection) > indices.length * level.triangleRatio)
        adopt(attempt(permissive));
      const submeshes: MeshAsset['submeshes'][number][] = [];
      let outputOffset = 0;
      for (const [index, section] of mesh.submeshes.entries()) {
        const length = (accepted.bySection[index] as number[]).length;
        submeshes.push({ ...section, indexOffset: outputOffset, indexCount: length });
        outputOffset += length;
      }
      const combined = Uint32Array.from(accepted.bySection.flat());
      const [remap, vertexCount] = MeshoptSimplifier.compactMesh(combined);
      meshes.push(compactMesh(source, combined, remap, vertexCount, submeshes));
      reports.push({
        triangleCount: combined.length / 3,
        vertexCount,
        error: accepted.error,
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

/** One Pack mesh output's LOD request: the generation options without level GUIDs. */
export interface PackMeshLodRequest extends Omit<MeshLodGenerationOptions, 'levels'> {
  /** Fine to coarse; level i publishes as `<root source key>/lod<i + 1>`. */
  readonly levels: readonly Omit<MeshLodGenerationOptions['levels'][number], 'mesh'>[];
}

export interface GeneratedPackMeshLods {
  /** The build outputs with each requested root replaced and its levels added. */
  readonly outputs: PackOutputMap;
  /** Per requested root source key, in level order. */
  readonly reports: Readonly<Record<string, readonly MeshLodGenerationReport[]>>;
}

/**
 * Pack build step: generate LODs for named mesh outputs of a build's output map.
 * Each level is an ordinary mesh output under `<key>/lod<n>`, so its GUID is
 * `AssetGuid.derive(packageId, key)` like every other output, and the Mesh producer
 * publishes the root's refs. Pass the build context's `packageId`.
 */
export async function generatePackMeshLods(
  packageId: PackageId,
  outputs: PackOutputMap,
  requests: Readonly<Record<string, PackMeshLodRequest>>,
): Promise<Result<GeneratedPackMeshLods, MeshLodGenerationError>> {
  const result: Record<string, PackOutput> = { ...outputs };
  const reports: Record<string, readonly MeshLodGenerationReport[]> = {};
  for (const key of Object.keys(requests).sort()) {
    const request = requests[key] as PackMeshLodRequest;
    const mesh = outputs[key];
    if (mesh?.kind !== 'mesh')
      return invalid(`${key}: LODs requested for a missing or non-mesh output`);
    const keys = request.levels.map((_, index) => `${key}/lod${index + 1}`);
    const taken = keys.find((level) => Object.hasOwn(result, level));
    if (taken !== undefined) return invalid(`${key}: LOD source key ${taken} is already an output`);
    const generated = await generateMeshLods(mesh as MeshAsset, {
      ...request,
      levels: request.levels.map((level, index) => ({
        ...level,
        mesh: AssetGuid.derive(packageId, keys[index] as string),
      })),
    });
    if (!generated.ok)
      return err({
        ...generated.error,
        detail: { reason: `${key}: ${generated.error.detail.reason}` },
      });
    result[key] = generated.value.root;
    for (const [index, level] of keys.entries())
      result[level] = generated.value.meshes[index] as MeshAsset;
    reports[key] = generated.value.reports;
  }
  return ok({ outputs: result, reports });
}

/** Rings of source surface locked around a rejected level's defects before it falls back. */
const TOPOLOGY_REPAIR_RINGS = 4;

function triangleTotal(bySection: readonly (readonly number[])[]): number {
  return bySection.reduce((sum, section) => sum + section.length, 0);
}

function sectionIndices(mesh: MeshAsset, indices: Uint32Array): number[][] {
  return mesh.submeshes.map((section) =>
    Array.from(indices.subarray(section.indexOffset, section.indexOffset + section.indexCount)),
  );
}

interface SourceTopology {
  /** Source vertex to its bit-identical position class: the simplifier's own weld. */
  readonly weld: Uint32Array;
  readonly edgeUses: ReadonlyMap<number, number>;
  readonly boundary: Uint8Array;
  readonly lockBorder: boolean;
  edgeKey(a: number, b: number): number;
  ring(seeds: readonly number[], hops: number): number[];
}

function sourceTopology(
  positions: Float32Array,
  indices: Uint32Array,
  lockBorder: boolean,
): SourceTopology {
  const bits = new Uint32Array(positions.buffer, positions.byteOffset, positions.length);
  const classes = new Map<string, number>();
  const weld = new Uint32Array(positions.length / 3);
  for (let vertex = 0; vertex < weld.length; vertex++) {
    const key = `${bits[vertex * 3]},${bits[vertex * 3 + 1]},${bits[vertex * 3 + 2]}`;
    let welded = classes.get(key);
    if (welded === undefined) {
      welded = classes.size;
      classes.set(key, welded);
    }
    weld[vertex] = welded;
  }
  const width = classes.size;
  const edgeKey = (a: number, b: number) => (a < b ? a * width + b : b * width + a);
  const edgeUses = countEdges(weld, indices, edgeKey);
  const boundary = new Uint8Array(width);
  const neighbours = Array.from({ length: width }, () => [] as number[]);
  for (const [key, uses] of edgeUses) {
    const a = Math.floor(key / width);
    const b = key % width;
    neighbours[a]?.push(b);
    neighbours[b]?.push(a);
    if (uses === 1) boundary[a] = boundary[b] = 1;
  }
  return {
    weld,
    edgeUses,
    boundary,
    lockBorder,
    edgeKey,
    ring(seeds, hops) {
      const reached = new Set(seeds);
      let front = [...reached];
      for (let hop = 0; hop < hops; hop++) {
        const next: number[] = [];
        for (const vertex of front)
          for (const neighbour of neighbours[vertex] ?? [])
            if (!reached.has(neighbour)) {
              reached.add(neighbour);
              next.push(neighbour);
            }
        front = next;
      }
      return [...reached];
    },
  };
}

function countEdges(
  weld: Uint32Array,
  indices: ArrayLike<number>,
  edgeKey: (a: number, b: number) => number,
): Map<number, number> {
  const uses = new Map<number, number>();
  for (let i = 0; i < indices.length; i += 3)
    for (let corner = 0; corner < 3; corner++) {
      const key = edgeKey(
        weld[indices[i + corner] as number] as number,
        weld[indices[i + ((corner + 1) % 3)] as number] as number,
      );
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  return uses;
}

/**
 * Welded vertices of edges the level made non-manifold or opened beyond the source's
 * boundary. Defects the source already owns are not the generator's to repair.
 */
function topologyDefects(topology: SourceTopology, indices: readonly number[]): number[] {
  const defects: number[] = [];
  for (const [key, uses] of countEdges(topology.weld, indices, topology.edgeKey)) {
    const source = topology.edgeUses.get(key) ?? 0;
    const width = topology.boundary.length;
    const a = Math.floor(key / width);
    const b = key % width;
    const opened =
      uses === 1 &&
      (topology.lockBorder ? source !== 1 : !(topology.boundary[a] && topology.boundary[b]));
    if ((uses > 2 && source <= 2) || opened) defects.push(a, b);
  }
  return defects;
}

interface SimplifierInput {
  readonly indices: Uint32Array;
  readonly positions: Float32Array;
  readonly attributes: Float32Array;
  readonly stride: number;
  readonly locks: Uint8Array;
  /** Simplifier vertex to source vertex and to its single owning section. */
  readonly origin: Uint32Array;
  readonly section: Uint32Array;
  wedges(welded: number): readonly number[];
  /** Wedges of positions shared by two sections: permissive collapses would mix their triangles. */
  readonly sectionSeams: readonly number[];
}

/**
 * One simplification over every section: a vertex shared by two sections is split
 * into bit-identical wedges, so section borders are seams both sides collapse together
 * and every surviving triangle still names one section.
 */
function simplifierInput(
  mesh: MeshAsset,
  indices: Uint32Array,
  weld: Uint32Array,
  attributeEntries: readonly { readonly key: string; readonly byteLength: number }[],
  locks: Uint8Array,
): SimplifierInput {
  const ids = new Map<number, number>();
  const origin: number[] = [];
  const section: number[] = [];
  const simplified = new Uint32Array(indices.length);
  for (const [index, entry] of mesh.submeshes.entries())
    for (let i = entry.indexOffset; i < entry.indexOffset + entry.indexCount; i++) {
      const vertex = indices[i] as number;
      const key = vertex * mesh.submeshes.length + index;
      let id = ids.get(key);
      if (id === undefined) {
        id = origin.length;
        ids.set(key, id);
        origin.push(vertex);
        section.push(index);
      }
      simplified[i] = id;
    }
  const source = mesh.attributes.position as Float32Array;
  const positions = new Float32Array(origin.length * 3);
  const stride = attributeEntries.reduce((sum, a) => sum + a.byteLength / 4, 0);
  const attributes = new Float32Array(origin.length * stride);
  const wedgeLocks = new Uint8Array(origin.length);
  const wedges = new Map<number, number[]>();
  for (const [id, vertex] of origin.entries()) {
    positions.set(source.subarray(vertex * 3, vertex * 3 + 3), id * 3);
    let lane = 0;
    for (const entry of attributeEntries) {
      const values = mesh.attributes[entry.key as keyof VertexAttributeMap] as Float32Array;
      const components = entry.byteLength / 4;
      attributes.set(
        values.subarray(vertex * components, (vertex + 1) * components),
        id * stride + lane,
      );
      lane += components;
    }
    wedgeLocks[id] = locks[vertex] as number;
    const welded = weld[vertex] as number;
    const list = wedges.get(welded);
    if (list) list.push(id);
    else wedges.set(welded, [id]);
  }
  return {
    indices: simplified,
    positions,
    attributes,
    stride,
    locks: wedgeLocks,
    origin: Uint32Array.from(origin),
    section: Uint32Array.from(section),
    wedges: (welded) => wedges.get(welded) ?? [],
    sectionSeams: [...wedges.values()]
      .filter((list) => list.some((id) => section[id] !== section[list[0] as number]))
      .flat(),
  };
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
