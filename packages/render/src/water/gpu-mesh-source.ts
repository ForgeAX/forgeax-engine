import type { MeshAsset } from '@forgeax/engine-types';
import { err, ok, type Result, sha256 } from '@forgeax/engine-types';
import {
  createWaterZoneViewWindow,
  type WaterBodySnapshot,
  type WaterError,
  type WaterMeshTileInstance,
  type WaterZoneSnapshot,
  type WaterZoneViewWindow,
  waterBodyRenderBounds,
  waterMeshGridTemplate,
} from '@forgeax/engine-water';
import { requireWaterValue, waterMeshFlatFarBoundaryMask } from '@forgeax/engine-water/internal';
import { waterInfoMeshView } from './water-info-producer';

export const WATER_GPU_MESH_FEATURE = 'water-gpu-mesh';
export const WATER_GPU_HEADER_MAGIC = 0x57474d31;
export type WaterGpuMeshDraw = Readonly<{
  zoneKey: string;
  materialBucket: number;
  viewIndex: number;
  viewCount: number;
  materialCount: number;
  tileCapacity: number;
  sourceBodies: readonly Readonly<{ guid: string; generation: number }>[];
}>;
export type WaterGpuMeshBody = Readonly<{
  guid: string;
  generation: number;
  type: WaterBodySnapshot['asset']['type'];
  rasterIndex: number;
  prioritySlot: number;
  materialBucket: number;
  lakeTransitionBucket: number;
  oceanTransitionBucket: number;
  vertices: Float32Array;
  yMin: number;
  yMax: number;
  surfaceY: number;
  maxWaveHeightM: number;
  flatFarBoundaryMask: number;
  waveDependency: Readonly<{ kind: 'ready' }> | Readonly<{ kind: 'pending'; guid: string }>;
}>;
export type WaterGpuMeshZone = Readonly<{
  key: string;
  worldIdentity: string;
  viewIdentity: string;
  zone: WaterZoneSnapshot;
  width: number;
  height: number;
  mipOffsets: readonly number[];
  mipWidths: readonly number[];
  mipHeights: readonly number[];
  nodeCount: number;
  tileCapacity: number;
  quadsPerDraw: number;
  quadsLod0: number;
  densityCount: number;
  originXZ: readonly [number, number];
  extentXZ: readonly [number, number];
  yMin: number;
  yMax: number;
  bodies: readonly WaterGpuMeshBody[];
  materials: readonly string[];
  mesh: MeshAsset;
  indexCount: number;
}>;
export const waterGpuMeshResource = (zoneKey: string, kind: string) =>
  `water-gpu-${zoneKey}-${kind}`;
export function waterGpuMeshBufferSizes(
  draw: Pick<WaterGpuMeshDraw, 'viewCount' | 'materialCount' | 'tileCapacity'>,
) {
  const rows = draw.viewCount * draw.materialCount,
    headerBytes = rows * 256;
  const tileBytes = draw.tileCapacity * draw.viewCount * 96;
  return {
    headerBytes,
    bindingBytes: headerBytes + tileBytes,
    totalBytes: headerBytes * 2 + tileBytes,
    argsBytes: rows * 20 + 4,
  };
}
const point = (m: readonly number[], x: number, y: number, z: number) =>
  [
    requireWaterValue(m[0]) * x +
      requireWaterValue(m[4]) * y +
      requireWaterValue(m[8]) * z +
      requireWaterValue(m[12]),
    requireWaterValue(m[1]) * x +
      requireWaterValue(m[5]) * y +
      requireWaterValue(m[9]) * z +
      requireWaterValue(m[13]),
    requireWaterValue(m[2]) * x +
      requireWaterValue(m[6]) * y +
      requireWaterValue(m[10]) * z +
      requireWaterValue(m[14]),
  ] as const;

/** Captures accepted static triangle geometry only. Occupancy and visible tiles are exclusively GPU outputs. */
function waterGpuBodyParticipatesInZone(body: WaterBodySnapshot, zone: WaterZoneSnapshot): boolean {
  return (
    body.binding.kind === 'bound' &&
    body.binding.zoneGuid === zone.guid &&
    body.binding.zoneGeneration === zone.generation &&
    body.asset.flags.affectsWaterMesh &&
    body.asset.renderOptions?.visible !== false
  );
}

export function buildWaterGpuMeshZone(
  worldIdentity: string,
  zone: WaterZoneSnapshot,
  snapshots: readonly WaterBodySnapshot[],
  view: Readonly<{
    identity: string;
    position: Readonly<ArrayLike<number>>;
    window?: WaterZoneViewWindow;
    farTiles?: readonly WaterMeshTileInstance[];
  }>,
): Result<WaterGpuMeshZone | undefined, WaterError> {
  const fail = (expected: string, detail?: unknown) =>
    err<WaterError>({
      code: 'invalid-source',
      expected,
      hint: 'repair the accepted Zone/static Water mesh source before requesting GPU WaterMesh',
      detail,
    });
  if (!zone.asset.gpuMesh) return fail('saved GPU WaterMesh settings');
  const m = zone.worldMatrixM;
  if (
    Math.abs(requireWaterValue(m[1])) +
      Math.abs(requireWaterValue(m[2])) +
      Math.abs(requireWaterValue(m[4])) +
      Math.abs(requireWaterValue(m[6])) +
      Math.abs(requireWaterValue(m[8])) +
      Math.abs(requireWaterValue(m[9])) >
      1e-6 ||
    requireWaterValue(m[0]) <= 0 ||
    requireWaterValue(m[10]) <= 0
  )
    return fail('an axis-aligned positive-scale GPU Water Zone');
  const window = view.window ?? createWaterZoneViewWindow(zone, view.identity, view.position, 0);
  const extent = window.meshExtentXZ,
    origin = window.meshOriginXZ;
  const [width, height] = window.resolution;
  const u32 = (value: number) => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff;
  if (
    ![width, height].every((value) => u32(value) && Number.isInteger(Math.log2(value))) ||
    ![...extent, ...origin].every(Number.isFinite) ||
    !extent.every((value) => value > 0)
  )
    return fail('finite GPU Water extents and positive power-of-two u32 resolution', {
      width,
      height,
    });
  const mipOffsets: number[] = [],
    mipWidths: number[] = [],
    mipHeights: number[] = [];
  let nodeCount = 0;
  const collectMipLevels = () => {
    for (let w = width, h = height; ; w = Math.max(1, w / 2), h = Math.max(1, h / 2)) {
      const nextCount = nodeCount + w * h;
      if (!u32(nextCount))
        return fail('GPU Water node count representable by the u32 storage ABI', {
          width,
          height,
          nextCount,
        });
      mipOffsets.push(nodeCount);
      mipWidths.push(w);
      mipHeights.push(h);
      nodeCount = nextCount;
      if (w === 1 && h === 1) break;
    }
    return undefined;
  };
  const mipFailure = collectMipLevels();
  if (mipFailure !== undefined) return mipFailure;
  const quadsPerDraw = Math.max(2, 2 ** Math.min(3, zone.asset.tessellationFactor));
  const quadsLod0 = Math.max(2, 2 ** zone.asset.tessellationFactor);
  const tileCapacity = width * height * (quadsLod0 / quadsPerDraw) ** 2;
  if (![quadsPerDraw, quadsLod0, tileCapacity].every(u32))
    return fail('GPU Water tile and tessellation counts representable by the u32 storage ABI', {
      tileCapacity,
      quadsLod0,
    });
  const sources: {
    snapshot: WaterBodySnapshot;
    vertices: Float32Array;
    yMin: number;
    yMax: number;
    captureYM: readonly [number, number];
    surfaceY: number;
    maxWaveHeightM: number;
    waveDependency: WaterGpuMeshBody['waveDependency'];
  }[] = [];
  const captureGpuWaterMeshBodies = () => {
    for (const body of snapshots) {
      if (!waterGpuBodyParticipatesInZone(body, zone)) continue;
      if (body.asset.transitionContinuity !== undefined)
        return fail(
          'terminal continuity support from the CPU WaterMesh producer; GPU traversal does not publish this optional payload',
        );
      if (body.dirty.has('geometry') || body.outputReceipts.geometry === undefined)
        return ok(undefined);
      const resolveGpuBodyMeshReferences = () => {
        const refs =
          body.asset.type === 'custom'
            ? [body.asset.customMeshOverrideGuid]
            : body.asset.type === 'river'
              ? (body.asset.riverSegmentMeshGuids ?? [])
              : [body.asset.visibleMeshGuid];
        if (refs.length === 0 || refs.some((guid) => !guid))
          return fail('published visible static meshes for every GPU Water body', {
            bodyGuid: body.guid,
          });
        return ok(refs);
      };
      const references = resolveGpuBodyMeshReferences();
      if (!references.ok) return references;
      const refs = references.value;
      const vertices: number[] = [];
      const localPositions: ArrayLike<number>[] = [];
      const captureMeshVertices = () => {
        for (const guid of refs) {
          const dependency = body.dependencies.find(
            (candidate) => candidate.guid === guid && candidate.status === 'valid',
          );
          const mesh =
            dependency && waterInfoMeshView(dependency.payload, dependency.payloadArrayKinds);
          if (!mesh)
            return fail('version-qualified triangle static mesh dependencies', {
              bodyGuid: body.guid,
              guid,
            });
          localPositions.push(mesh.attributes.position);
          for (const submesh of mesh.submeshes)
            if (submesh.topology === 'triangle-list')
              for (let i = submesh.indexOffset; i < submesh.indexOffset + submesh.indexCount; i++) {
                const index = requireWaterValue(mesh.indices[i]) * 3;
                const world = point(
                  body.worldMatrixM,
                  requireWaterValue(mesh.attributes.position[index]),
                  requireWaterValue(mesh.attributes.position[index + 1]),
                  requireWaterValue(mesh.attributes.position[index + 2]),
                );
                vertices.push(world[0] - origin[0], world[1], world[2] - origin[1]);
              }
        }
        return undefined;
      };
      const meshFailure = captureMeshVertices();
      if (meshFailure !== undefined) return meshFailure;
      let minX = Infinity,
        maxX = -Infinity,
        minZ = Infinity,
        maxZ = -Infinity;
      for (let i = 0; i < vertices.length; i += 3) {
        minX = Math.min(minX, requireWaterValue(vertices[i]));
        maxX = Math.max(maxX, requireWaterValue(vertices[i]));
        minZ = Math.min(minZ, requireWaterValue(vertices[i + 2]));
        maxZ = Math.max(maxZ, requireWaterValue(vertices[i + 2]));
      }
      if (maxX < 0 || minX > extent[0] || maxZ < 0 || minZ > extent[1]) continue;
      const bounds = waterBodyRenderBounds(body.asset, body.worldMatrixM, localPositions);
      if (!bounds)
        return fail('finite component, raster and capture Water bounds', { bodyGuid: body.guid });
      const maxWaveHeightM = body.asset.maxWaveHeightM;
      let waveDependency: WaterGpuMeshBody['waveDependency'] = Object.freeze({ kind: 'ready' });
      const captureWaveDependency = () => {
        if (body.asset.type !== 'river' && body.asset.waveSetGuid !== undefined) {
          const dependency = body.dependencies.find(
            (candidate) =>
              candidate.field === 'waveSetGuid' && candidate.guid === body.asset.waveSetGuid,
          );
          if (dependency?.status === 'pending')
            waveDependency = Object.freeze({ kind: 'pending', guid: dependency.guid });
          else if (dependency?.status !== 'valid')
            return fail('an accepted or explicitly pending GPU Water WaveSet dependency', {
              bodyGuid: body.guid,
              bodyGeneration: body.sceneGeneration,
              guid: body.asset.waveSetGuid,
              status: dependency?.status ?? 'missing',
              ...(dependency?.status === 'failed' ? { failure: dependency.failure } : {}),
            });
        }
        return undefined;
      };
      const waveFailure = captureWaveDependency();
      if (waveFailure !== undefined) return waveFailure;
      sources.push({
        snapshot: body,
        vertices: new Float32Array(vertices),
        yMin: bounds.rasterYM[0],
        yMax: bounds.rasterYM[1],
        captureYM: bounds.captureYM,
        maxWaveHeightM,
        waveDependency,
        surfaceY: point(
          body.worldMatrixM,
          0,
          body.asset.baseHeightM +
            (body.asset.type === 'ocean' ? (body.asset.heightOffsetM ?? 0) : 0),
          0,
        )[1],
      });
    }
    return undefined;
  };
  const sourceFailure = captureGpuWaterMeshBodies();
  if (sourceFailure !== undefined) return sourceFailure;
  if (sources.length === 0) return ok(undefined);
  if (sources.length > 127)
    return fail('at most 127 intersecting GPU Water raster bodies', { count: sources.length });
  const publishGpuMeshZone = () => {
    const priorities = [
      ...new Set(
        sources.map((source) =>
          Math.max(-8192, Math.min(8191, source.snapshot.asset.overlapPriority)),
        ),
      ),
    ].sort((a, b) => a - b);
    const materials = [
      ...new Set(
        sources.flatMap(({ snapshot: body }) =>
          [
            body.asset.surfaceMaterialGuid,
            body.asset.riverToLakeTransitionMaterialGuid,
            body.asset.riverToOceanTransitionMaterialGuid,
          ].filter((value): value is string => value !== undefined),
        ),
      ),
    ].sort();
    const bodies = sources.map(({ snapshot, captureYM: _captureYM, ...source }, index) => ({
      ...source,
      guid: snapshot.guid,
      generation: snapshot.sceneGeneration,
      type: snapshot.asset.type,
      flatFarBoundaryMask: waterMeshFlatFarBoundaryMask(
        view.farTiles ?? [],
        snapshot.guid,
        snapshot.sceneGeneration,
        source.surfaceY,
        {
          minM: [
            window.centerXZ[0] - window.extentXZ[0] / 2,
            window.centerXZ[1] - window.extentXZ[1] / 2,
          ],
          maxM: [
            window.centerXZ[0] + window.extentXZ[0] / 2,
            window.centerXZ[1] + window.extentXZ[1] / 2,
          ],
        },
      ),
      rasterIndex: index + 1,
      prioritySlot: Math.min(
        7,
        priorities.indexOf(Math.max(-8192, Math.min(8191, snapshot.asset.overlapPriority))),
      ),
      materialBucket: materials.indexOf(snapshot.asset.surfaceMaterialGuid),
      lakeTransitionBucket:
        snapshot.asset.riverToLakeTransitionMaterialGuid === undefined
          ? -1
          : materials.indexOf(snapshot.asset.riverToLakeTransitionMaterialGuid),
      oceanTransitionBucket:
        snapshot.asset.riverToOceanTransitionMaterialGuid === undefined
          ? -1
          : materials.indexOf(snapshot.asset.riverToOceanTransitionMaterialGuid),
    }));
    const template = waterMeshGridTemplate(Math.min(3, zone.asset.tessellationFactor), 0, false);
    if (!template.ok) return fail('a valid GPU Water tile template', template.error);
    return ok({
      key: sha256(JSON.stringify([worldIdentity, zone.guid, zone.generation, view.identity])),
      worldIdentity,
      viewIdentity: view.identity,
      zone,
      width,
      height,
      mipOffsets,
      mipWidths,
      mipHeights,
      nodeCount,
      tileCapacity,
      quadsPerDraw,
      quadsLod0,
      densityCount: Math.max(1, Math.min(mipOffsets.length, Math.log2(quadsLod0))),
      originXZ: origin,
      extentXZ: extent,
      yMin: Math.min(...sources.map((body) => body.captureYM[0])),
      yMax: Math.max(...sources.map((body) => body.captureYM[1])),
      bodies,
      materials,
      mesh: template.value.mesh,
      indexCount: template.value.indexCount,
    });
  };
  return publishGpuMeshZone();
}
