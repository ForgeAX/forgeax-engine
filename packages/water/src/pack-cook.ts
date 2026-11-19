import type { PackOutput, PackOutputMap } from '@forgeax/engine-pack';
import {
  AssetGuid,
  type AssetGuid as AssetGuidType,
  type PackageId,
} from '@forgeax/engine-pack/source';
import {
  err,
  type MeshAsset,
  ok,
  type Result,
  type WaterBodyCollisionDescriptorV1,
  type WaterBodyCollisionDescriptorV2,
  type WaterBodyGeometrySnapshot,
} from '@forgeax/engine-types';
import { FillRule, type PathsD, unionD } from 'clipper2-ts';
import { buildWaterBodyGeometry, waterBodyCollisionDescriptor } from './body-geometry.js';
import type { WaterError, WaterWaveSetAsset } from './contracts.js';
import { requireWaterValue } from './required-value.js';
import {
  cookWaterAsset,
  waterCollisionDescriptorDigest,
  waterMeshFootprintDigest,
  waterQueryFootprintDigest,
  waterQueryVolume,
  waterQueryVolumeDigest,
} from './validate.js';
export type WaterPackCookOptions = Parameters<typeof cookWaterAsset>[1] & {
  readonly packageId?: PackageId;
  readonly readByGuid?: (guid: AssetGuidType) => Promise<Result<PackOutput, unknown>>;
  readonly bodyWorldTransformsM?: Readonly<Record<string, readonly number[]>>;
};
const invalid = (expected: string, detail?: unknown): WaterError => ({
  code: 'invalid-source',
  expected,
  hint: 'repair the Water source closure and cook it again',
  ...(detail === undefined ? {} : { detail }),
});
const identityMatrix = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
function worldToLocalPosition(
  matrix: readonly number[],
  point: readonly [number, number, number],
): readonly [number, number, number] | undefined {
  const c0 = [
      requireWaterValue(matrix[0]),
      requireWaterValue(matrix[1]),
      requireWaterValue(matrix[2]),
    ],
    c1 = [requireWaterValue(matrix[4]), requireWaterValue(matrix[5]), requireWaterValue(matrix[6])],
    c2 = [
      requireWaterValue(matrix[8]),
      requireWaterValue(matrix[9]),
      requireWaterValue(matrix[10]),
    ];
  const cross = (a: readonly number[], b: readonly number[]) => [
    requireWaterValue(a[1]) * requireWaterValue(b[2]) -
      requireWaterValue(a[2]) * requireWaterValue(b[1]),
    requireWaterValue(a[2]) * requireWaterValue(b[0]) -
      requireWaterValue(a[0]) * requireWaterValue(b[2]),
    requireWaterValue(a[0]) * requireWaterValue(b[1]) -
      requireWaterValue(a[1]) * requireWaterValue(b[0]),
  ];
  const dot = (a: readonly number[], b: readonly number[]) =>
    requireWaterValue(a[0]) * requireWaterValue(b[0]) +
    requireWaterValue(a[1]) * requireWaterValue(b[1]) +
    requireWaterValue(a[2]) * requireWaterValue(b[2]);
  const determinant = dot(c0, cross(c1, c2));
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return undefined;
  const relative = [
    point[0] - requireWaterValue(matrix[12]),
    point[1] - requireWaterValue(matrix[13]),
    point[2] - requireWaterValue(matrix[14]),
  ];
  return [
    dot(relative, cross(c1, c2)) / determinant,
    dot(relative, cross(c2, c0)) / determinant,
    dot(relative, cross(c0, c1)) / determinant,
  ];
}
function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Object.freeze(value.map(deepFreeze)) as T;
  return Object.freeze(
    Object.fromEntries(Object.entries(value).map(([key, child]) => [key, deepFreeze(child)])),
  ) as T;
}
function projectCustomMeshFootprint(
  mesh: MeshAsset,
): readonly (readonly (readonly [number, number])[])[] | undefined {
  const positionSource = mesh.attributes.position;
  const positions =
    positionSource instanceof Float32Array
      ? positionSource
      : positionSource instanceof ArrayBuffer && positionSource.byteLength % 4 === 0
        ? new Float32Array(positionSource)
        : undefined;
  if (
    !positions ||
    positions.length < 9 ||
    positions.length % 3 !== 0 ||
    !positions.every(Number.isFinite)
  )
    return undefined;
  const vertexCount = positions.length / 3;
  const paths: PathsD = [];
  const emit = (a: number, b: number, c: number) => {
    if (
      ![a, b, c].every((index) => Number.isSafeInteger(index) && index >= 0 && index < vertexCount)
    )
      return false;
    const pa = {
      x: requireWaterValue(positions[a * 3]),
      y: requireWaterValue(positions[a * 3 + 2]),
    };
    let pb = { x: requireWaterValue(positions[b * 3]), y: requireWaterValue(positions[b * 3 + 2]) };
    let pc = { x: requireWaterValue(positions[c * 3]), y: requireWaterValue(positions[c * 3 + 2]) };
    const area = (pb.x - pa.x) * (pc.y - pa.y) - (pb.y - pa.y) * (pc.x - pa.x);
    if (Math.abs(area) <= 1e-12) return true;
    if (area < 0) [pb, pc] = [pc, pb];
    paths.push([pa, pb, pc]);
    return true;
  };
  const emitSequence = (sequence: readonly number[], topology: string) => {
    if (topology === 'triangle-list') {
      if (sequence.length % 3 !== 0) return false;
      for (let index = 0; index < sequence.length; index += 3)
        if (
          !emit(
            requireWaterValue(sequence[index]),
            requireWaterValue(sequence[index + 1]),
            requireWaterValue(sequence[index + 2]),
          )
        )
          return false;
      return true;
    }
    if (topology === 'triangle-strip') {
      for (let index = 0; index + 2 < sequence.length; index++)
        if (
          !emit(
            requireWaterValue(sequence[index]),
            requireWaterValue(sequence[index + 1]),
            requireWaterValue(sequence[index + 2]),
          )
        )
          return false;
      return true;
    }
    return true;
  };
  try {
    const emitMeshTriangles = (): boolean => {
      if (mesh.indices) {
        for (const submesh of mesh.submeshes) {
          if (submesh.topology !== 'triangle-list' && submesh.topology !== 'triangle-strip')
            continue;
          const end = submesh.indexOffset + submesh.indexCount;
          if (
            !Number.isSafeInteger(submesh.indexOffset) ||
            !Number.isSafeInteger(submesh.indexCount) ||
            submesh.indexOffset < 0 ||
            end > mesh.indices.length
          )
            return false;
          if (
            !emitSequence(
              Array.from(mesh.indices.subarray(submesh.indexOffset, end)),
              submesh.topology,
            )
          )
            return false;
        }
      } else {
        let vertexOffset = 0;
        for (const submesh of mesh.submeshes) {
          if (submesh.topology === 'triangle-list' || submesh.topology === 'triangle-strip') {
            const sequence = Array.from(
              { length: submesh.vertexCount },
              (_, index) => vertexOffset + index,
            );
            if (!emitSequence(sequence, submesh.topology)) return false;
          }
          vertexOffset += submesh.vertexCount;
          if (vertexOffset > vertexCount) return false;
        }
      }

      return true;
    };
    if (!emitMeshTriangles()) return undefined;
    if (paths.length === 0) return undefined;
    const rings = unionD(paths, [], FillRule.NonZero, 6);
    const projected = rings
      .filter((ring) => ring.length >= 3)
      .map((ring) => Object.freeze(ring.map(({ x, y }) => Object.freeze([x, y] as const))));
    return projected.length > 0 ? Object.freeze(projected) : undefined;
  } catch {
    return undefined;
  }
}
function publishCollisionDescriptor(
  asset: Parameters<typeof waterCollisionDescriptorDigest>[0],
  collision: ReturnType<typeof waterBodyCollisionDescriptor>,
): WaterBodyGeometrySnapshot['collisionDescriptor'] {
  if (collision === null) return null;
  if (collision.riverSegmentConvexTopCapVertexIndices !== undefined) {
    if (collision.riverSegmentConvexes === undefined)
      throw new Error('River cap roles require their cooker-owned convex geometry');
    const descriptor: Omit<WaterBodyCollisionDescriptorV2, 'digest'> = {
      version: 2,
      footprint: collision.footprint,
      minimumYM: collision.minimumYM,
      maximumYM: collision.maximumYM,
      riverSegmentConvexes: collision.riverSegmentConvexes,
      riverSegmentConvexTopCapVertexIndices: collision.riverSegmentConvexTopCapVertexIndices,
    };
    return { ...descriptor, digest: waterCollisionDescriptorDigest(asset, descriptor) };
  }
  const { riverSegmentConvexTopCapVertexIndices: _roles, ...geometry } = collision;
  const descriptor: Omit<WaterBodyCollisionDescriptorV1, 'digest'> = { version: 1, ...geometry };
  return { ...descriptor, digest: waterCollisionDescriptorDigest(asset, descriptor) };
}

/** Cook Water assets and their GUID-linked geometry outputs in one Pack build map. */
export async function buildWaterPackOutputs(
  sources: Readonly<Record<string, unknown>>,
  options: WaterPackCookOptions = {},
): Promise<Result<PackOutputMap, WaterError>> {
  const output: Record<string, PackOutputMap[string]> = {};
  const bodies: Array<{
    sourceKey: string;
    asset: Extract<
      PackOutputMap[string],
      {
        kind: 'water-body';
      }
    >;
  }> = [];
  const admitSources = () => {
    for (const [sourceKey, source] of Object.entries(sources)) {
      if (!sourceKey.trim()) return err(invalid('non-empty Pack sourceKey'));
      const cooked = cookWaterAsset(source, options);
      if (!cooked.ok) return cooked;
      if (
        cooked.value.kind === 'water-body' &&
        [
          'riverSegmentMeshGuids',
          'visibleMeshGuid',
          'waterInfoMeshGuid',
          'dilatedWaterInfoMeshGuid',
          'brushShapeMeshGuid',
          'collisionMeshGuid',
          'waterGeometryVersion',
          'geometrySnapshot',
        ].some((field) => Object.hasOwn(source as object, field))
      ) {
        return err(invalid('derived Water geometry GUIDs generated by the Pack cooker', sourceKey));
      }
      output[sourceKey] = cooked.value;
      if (cooked.value.kind === 'water-body') bodies.push({ sourceKey, asset: cooked.value });
    }

    return undefined;
  };
  const sourceFailure = admitSources();
  if (sourceFailure !== undefined) return sourceFailure;
  const resolveLocalOrExternal = async (guid: string): Promise<PackOutput | undefined> => {
    if (options.packageId)
      for (const [sourceKey, value] of Object.entries(output)) {
        if (
          AssetGuid.format(AssetGuid.derive(options.packageId, sourceKey)).toLowerCase() ===
          guid.toLowerCase()
        )
          return value;
      }
    if (!options.readByGuid) return undefined;
    const parsed = AssetGuid.parse(guid);
    if (!parsed.ok) return undefined;
    const read = await options.readByGuid(parsed.value);
    return read.ok ? read.value : undefined;
  };
  for (const { sourceKey, asset } of bodies) {
    if (!options.packageId)
      return err(invalid('Pack packageId when publishing Water geometry outputs', sourceKey));
    const admitWaveBound = async () => {
      if (asset.type !== 'river' && asset.waveSetGuid) {
        const resolved = await resolveLocalOrExternal(asset.waveSetGuid);
        if (resolved?.kind === 'water-wave-set') {
          const waves = resolved as WaterWaveSetAsset;
          if (asset.maxWaveHeightM < waves.maxWaveHeightM + (asset.maxWaveHeightOffsetM ?? 0))
            return err(
              invalid(
                'Body maxWaveHeightM covering the WaveSet bound and authored component-bound offset',
                {
                  sourceKey,
                  maxWaveHeightM: asset.maxWaveHeightM,
                  waveSetBoundM: waves.maxWaveHeightM,
                  maxWaveHeightOffsetM: asset.maxWaveHeightOffsetM ?? 0,
                },
              ),
            );
        }
      }

      return undefined;
    };
    const waveFailure = await admitWaveBound();
    if (waveFailure !== undefined) return waveFailure;
    const loadCustomMeshes = async () => {
      let customOverride: MeshAsset | undefined;
      if (
        asset.type === 'custom' &&
        (asset.flags.affectsWaterInfo || asset.flags.affectsWaterMesh) &&
        !asset.customMeshOverrideGuid
      ) {
        return err(
          invalid(
            'Custom WaterInfo or WaterMesh participation requires customMeshOverrideGuid',
            sourceKey,
          ),
        );
      }
      if (asset.customMeshOverrideGuid) {
        const resolved = await resolveLocalOrExternal(asset.customMeshOverrideGuid);
        if (resolved?.kind !== 'mesh')
          return err({
            code: 'missing-dependency' as const,
            expected: 'resolved MeshAsset for customMeshOverrideGuid',
            hint: 'include or read the Custom body override MeshAsset in the Pack closure',
            detail: asset.customMeshOverrideGuid,
          });
        customOverride = resolved as MeshAsset;
      }
      let customCollisionMesh: MeshAsset | undefined;
      if (
        asset.collision.type === 'custom-mesh' &&
        asset.collision.enabled &&
        asset.collision.meshGuid
      ) {
        const resolved = await resolveLocalOrExternal(asset.collision.meshGuid);
        if (resolved?.kind !== 'mesh')
          return err({
            code: 'missing-dependency' as const,
            expected: 'resolved MeshAsset for collision.meshGuid',
            hint: 'include or read the Custom collision MeshAsset in the Pack closure',
            detail: asset.collision.meshGuid,
          });
        customCollisionMesh = resolved as MeshAsset;
      }

      return ok({ customOverride, customCollisionMesh });
    };
    const customMeshes = await loadCustomMeshes();
    if (!customMeshes.ok) return customMeshes;
    const { customOverride, customCollisionMesh } = customMeshes.value;
    const resolveAuthoringFrame = () => {
      const bodyWorldMatrixM =
        options.bodyWorldTransformsM?.[sourceKey] ??
        (asset.type === 'river' ||
        asset.type === 'lake' ||
        (asset.type === 'ocean' && asset.centerOnWaterZone !== false)
          ? identityMatrix
          : undefined);
      if (
        bodyWorldMatrixM &&
        (bodyWorldMatrixM.length !== 16 || !Array.from(bodyWorldMatrixM).every(Number.isFinite))
      )
        return err(
          invalid('finite 4x4 authoring Body world transform', { sourceKey, bodyWorldMatrixM }),
        );
      let authoredAsset = asset;
      const resolveOceanCenter = () => {
        if (asset.type === 'ocean') {
          const saved = asset.savedZoneLocationWorldXZ;
          const centerOnWaterZone = asset.centerOnWaterZone !== false;
          let oceanCenterM: readonly [number, number] = [0, 0];
          if (centerOnWaterZone && asset.zoneGuid && !saved)
            return err(
              invalid('savedZoneLocationWorldXZ for a Zone-centered Ocean', {
                sourceKey,
                zoneGuid: asset.zoneGuid,
              }),
            );
          if (centerOnWaterZone && saved) {
            const worldMatrix = options.bodyWorldTransformsM?.[sourceKey];
            if (!worldMatrix)
              return err(
                invalid(
                  'authoring Body world transform when cooking a saved world-space Ocean center',
                  { sourceKey, savedZoneLocationWorldXZ: saved },
                ),
              );
            const local = worldToLocalPosition(worldMatrix, [
              saved[0],
              requireWaterValue(worldMatrix[13]),
              saved[1],
            ]);
            if (!local)
              return err(
                invalid('invertible authoring Body world transform for saved Ocean center', {
                  sourceKey,
                  worldMatrix,
                }),
              );
            oceanCenterM = [local[0], local[2]];
          }
          authoredAsset = Object.freeze({ ...asset, oceanCenterM });
        }

        return undefined;
      };
      const oceanCenterFailure = resolveOceanCenter();
      if (oceanCenterFailure !== undefined) return oceanCenterFailure;
      if (
        bodyWorldMatrixM &&
        (asset.type === 'river' ||
          asset.type === 'lake' ||
          (asset.type === 'ocean' && asset.centerOnWaterZone !== false))
      ) {
        authoredAsset = Object.freeze({
          ...authoredAsset,
          geometryAuthoringWorldMatrixM: Object.freeze([...bodyWorldMatrixM]),
        });
      }

      return ok({ bodyWorldMatrixM, authoredAsset });
    };
    const authoringFrame = resolveAuthoringFrame();
    if (!authoringFrame.ok) return authoringFrame;
    const { bodyWorldMatrixM, authoredAsset } = authoringFrame.value;
    const geometry = buildWaterBodyGeometry(authoredAsset, {
      ...(bodyWorldMatrixM ? { bodyWorldMatrixM } : {}),
      ...(authoredAsset.type === 'ocean' && authoredAsset.oceanCenterM
        ? { oceanCenterM: authoredAsset.oceanCenterM }
        : {}),
      ...(customOverride ? { customOverride } : {}),
      ...(customCollisionMesh ? { customCollisionMesh } : {}),
    });
    if (!geometry.ok)
      return err(invalid(geometry.error.expected, { sourceKey, cause: geometry.error.detail }));
    const acceptedGeometry = geometry.value;
    const captureGeometrySnapshot = () => {
      const queryFootprint = {
        version: 1 as const,
        outer: acceptedGeometry.queryFootprint.outer,
        holes: acceptedGeometry.queryFootprint.holes,
      };
      const collision = waterBodyCollisionDescriptor(
        authoredAsset,
        undefined,
        customCollisionMesh,
        bodyWorldMatrixM,
      );
      const publishedCollision = publishCollisionDescriptor(asset, collision);
      const queryVolume = waterQueryVolume(authoredAsset);
      const waterMeshFootprintRings =
        authoredAsset.type === 'custom' && authoredAsset.flags.affectsWaterMesh && customOverride
          ? projectCustomMeshFootprint(customOverride)
          : undefined;
      if (
        authoredAsset.type === 'custom' &&
        authoredAsset.flags.affectsWaterMesh &&
        !waterMeshFootprintRings
      )
        return err(
          invalid('Custom WaterMesh override with a non-degenerate projected triangle footprint', {
            sourceKey,
            customMeshOverrideGuid: authoredAsset.customMeshOverrideGuid,
          }),
        );
      const geometrySnapshot = deepFreeze({
        queryFootprint: {
          ...queryFootprint,
          digest: waterQueryFootprintDigest(authoredAsset, queryFootprint, {
            ...(authoredAsset.type !== 'ocean' || authoredAsset.oceanCenterM === undefined
              ? {}
              : { oceanCenterM: authoredAsset.oceanCenterM }),
            ...(authoredAsset.geometryAuthoringWorldMatrixM === undefined
              ? {}
              : { geometryAuthoringWorldMatrixM: authoredAsset.geometryAuthoringWorldMatrixM }),
          }),
        },
        queryVolume: { ...queryVolume, digest: waterQueryVolumeDigest(asset, queryVolume) },
        ...(waterMeshFootprintRings
          ? {
              waterMeshFootprint: {
                version: 1 as const,
                rings: waterMeshFootprintRings,
                digest: waterMeshFootprintDigest(authoredAsset, {
                  version: 1,
                  rings: waterMeshFootprintRings,
                }),
              },
            }
          : {}),
        collisionDescriptor: publishedCollision,
      });

      return ok(geometrySnapshot);
    };
    const geometrySnapshotResult = captureGeometrySnapshot();
    if (!geometrySnapshotResult.ok) return geometrySnapshotResult;
    const geometrySnapshot = geometrySnapshotResult.value;
    const publishBodyGeometry = () => {
      const generated: Record<string, unknown> = {};
      const publishMesh = (suffix: string, mesh: MeshAsset): string => {
        const outputSourceKey = `${sourceKey}/${suffix}`;
        if (Object.hasOwn(output, outputSourceKey) || Object.hasOwn(generated, outputSourceKey))
          throw new Error(`Water output key collision: ${outputSourceKey}`);
        const guid = AssetGuid.format(
          AssetGuid.derive(requireWaterValue(options.packageId), outputSourceKey),
        );
        output[outputSourceKey] = mesh;
        generated[suffix] = guid;
        return guid;
      };
      let riverSegmentMeshGuids: readonly string[] | undefined;
      let visibleMeshGuid: string | undefined;
      let waterInfoMeshGuid: string | undefined;
      let dilatedWaterInfoMeshGuid: string | undefined;
      let brushShapeMeshGuid: string | undefined;
      let collisionMeshGuid: string | undefined;
      const staticMaterial = AssetGuid.parse(asset.lodMaterialGuid ?? asset.surfaceMaterialGuid);
      if (!staticMaterial.ok)
        return err(invalid('valid generated static Water material GUID', { sourceKey }));
      const staticMesh = (mesh: MeshAsset): MeshAsset =>
        Object.freeze({
          ...mesh,
          materialSlots: Object.freeze(
            mesh.materialSlots.map((slot) =>
              Object.freeze({
                ...slot,
                defaultMaterial: staticMaterial.value,
              }),
            ),
          ),
        });
      try {
        if (asset.type === 'river' && asset.renderOptions?.visible !== false) {
          riverSegmentMeshGuids = acceptedGeometry.riverSegments.map((segment, index) =>
            publishMesh(`river-segment/${index}`, staticMesh(segment.visibleMesh)),
          );
        } else if (asset.type === 'custom') {
          visibleMeshGuid = asset.customMeshOverrideGuid;
        } else if (asset.renderOptions?.visible !== false && acceptedGeometry.visibleMesh) {
          visibleMeshGuid = publishMesh('visible-mesh', staticMesh(acceptedGeometry.visibleMesh));
        }
        if (acceptedGeometry.waterInfoMesh)
          waterInfoMeshGuid = publishMesh('water-info', acceptedGeometry.waterInfoMesh);
        if (acceptedGeometry.dilatedWaterInfoMesh)
          dilatedWaterInfoMeshGuid = publishMesh(
            'water-info-dilated',
            acceptedGeometry.dilatedWaterInfoMesh,
          );
        if (acceptedGeometry.brushShapeMesh)
          brushShapeMeshGuid = publishMesh('brush-shape', acceptedGeometry.brushShapeMesh);
        if (acceptedGeometry.collisionMesh && asset.collision.type !== 'custom-mesh')
          collisionMeshGuid = publishMesh('collision', acceptedGeometry.collisionMesh);
      } catch (cause) {
        return err(invalid('unique Water-derived Pack output sourceKeys', String(cause)));
      }
      output[sourceKey] = Object.freeze({
        ...authoredAsset,
        ...(riverSegmentMeshGuids
          ? { riverSegmentMeshGuids: Object.freeze(riverSegmentMeshGuids) }
          : {}),
        ...(visibleMeshGuid ? { visibleMeshGuid } : {}),
        ...(waterInfoMeshGuid ? { waterInfoMeshGuid } : {}),
        ...(dilatedWaterInfoMeshGuid ? { dilatedWaterInfoMeshGuid } : {}),
        ...(brushShapeMeshGuid ? { brushShapeMeshGuid } : {}),
        ...(collisionMeshGuid ? { collisionMeshGuid } : {}),
        waterGeometryVersion: 2 as const,
        geometrySnapshot,
      });
      return undefined;
    };
    const publicationFailure = publishBodyGeometry();
    if (publicationFailure !== undefined) return publicationFailure;
  }
  return ok(Object.freeze(output));
}
