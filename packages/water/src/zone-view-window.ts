import type { WaterZoneSnapshot } from './system.js';

export const WATER_LOCAL_TESSELLATION_EXTENT_M = Object.freeze([512, 100, 512] as const);
export const WATER_LOCAL_TESSELLATION_UPDATE_MARGIN_M = 150;

export type WaterZoneViewWindow = Readonly<{
  zoneGuid: string;
  zoneGeneration: number;
  viewId: string;
  sourceGeneration: number;
  centerM: readonly [number, number, number];
  centerXZ: readonly [number, number];
  extentXZ: readonly [number, number];
  meshOriginXZ: readonly [number, number];
  meshExtentXZ: readonly [number, number];
  resolution: readonly [number, number];
  updateHalfExtentXZ: readonly [number, number];
}>;

/** The dynamic diameter controls horizontal hysteresis; truncate tile ratios before power-of-two rounding. */
export function createWaterZoneViewWindow(
  zone: WaterZoneSnapshot,
  viewId: string,
  positionM: ArrayLike<number>,
  sourceGeneration: number,
  previous?: WaterZoneViewWindow,
): WaterZoneViewWindow {
  const matrix = zone.worldMatrixM;
  const local = zone.asset.waterInfo.localTessellation;
  const x = positionM[0],
    y = positionM[1],
    z = positionM[2];
  const scaleX = matrix[0],
    scaleZ = matrix[10];
  const originX = matrix[12],
    originY = matrix[13],
    originZ = matrix[14];
  if (
    x === undefined ||
    y === undefined ||
    z === undefined ||
    scaleX === undefined ||
    scaleZ === undefined ||
    originX === undefined ||
    originY === undefined ||
    originZ === undefined
  )
    throw new Error('Validated Water Zone matrix or observer position is incomplete');
  if (
    previous?.zoneGuid === zone.guid &&
    previous.viewId === viewId &&
    previous.zoneGeneration === zone.generation &&
    previous.sourceGeneration === sourceGeneration &&
    (!local ||
      (Math.abs(x - previous.centerXZ[0]) < previous.updateHalfExtentXZ[0] &&
        Math.abs(z - previous.centerXZ[1]) < previous.updateHalfExtentXZ[1]))
  )
    return previous;
  const authored = zone.asset.waterInfo.localExtentM ?? WATER_LOCAL_TESSELLATION_EXTENT_M;
  const extentXZ = [
    (local ? authored[0] : zone.asset.extentM.spanXM) * Math.abs(scaleX),
    (local ? authored[2] : zone.asset.extentM.spanZM) * Math.abs(scaleZ),
  ] as const;
  const tileSize = zone.asset.tileSizeM;
  const centerM = local
    ? ([
        Math.round(x / tileSize) * tileSize,
        Math.round(y / tileSize) * tileSize,
        Math.round(z / tileSize) * tileSize,
      ] as const)
    : ([originX, originY, originZ] as const);
  const resolution = [
    2 * 2 ** Math.ceil(Math.log2(Math.max(1, Math.floor(extentXZ[0] / 2 / tileSize)))),
    2 * 2 ** Math.ceil(Math.log2(Math.max(1, Math.floor(extentXZ[1] / 2 / tileSize)))),
  ] as const;
  const meshExtentXZ = [resolution[0] * tileSize, resolution[1] * tileSize] as const;
  const meshCenterXZ = [
    Math.round(centerM[0] / tileSize) * tileSize,
    Math.round(centerM[2] / tileSize) * tileSize,
  ] as const;
  return Object.freeze({
    zoneGuid: zone.guid,
    zoneGeneration: zone.generation,
    viewId,
    sourceGeneration,
    centerM: Object.freeze(centerM),
    centerXZ: Object.freeze([centerM[0], centerM[2]] as const),
    extentXZ: Object.freeze(extentXZ),
    meshOriginXZ: Object.freeze([
      meshCenterXZ[0] - meshExtentXZ[0] / 2,
      meshCenterXZ[1] - meshExtentXZ[1] / 2,
    ] as const),
    meshExtentXZ: Object.freeze(meshExtentXZ),
    resolution: Object.freeze(resolution),
    updateHalfExtentXZ: Object.freeze(
      [extentXZ[0], extentXZ[1]].map((extent) =>
        zone.asset.farMeshBoundary === 'view-window'
          ? Math.min(tileSize, extent / 2)
          : Math.max(0.01, extent / 2 - WATER_LOCAL_TESSELLATION_UPDATE_MARGIN_M),
      ),
    ) as readonly [number, number],
  });
}
