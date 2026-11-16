import type { Result, WaterZoneAsset } from '@forgeax/engine-types';
import type { WaterError } from './contracts.js';
import type { WaterSystem, WaterZoneMeshPublication } from './system.js';
import type { WaterMeshViewInput } from './water-mesh.js';

type WaterSystemInternalAccess = Readonly<{
  buildZoneMeshView: (
    zoneGuid: string,
    zoneGeneration: number,
    zone: WaterZoneAsset,
    view: WaterMeshViewInput,
  ) => Result<WaterZoneMeshPublication, WaterError>;
  zoneMeshView: (zoneGuid: string, viewId: string) => WaterZoneMeshPublication | undefined;
  waterMeshCandidateViews: (viewId: string) => readonly WaterZoneMeshPublication[];
  acceptWaterMeshView: (candidate: WaterZoneMeshPublication) => boolean;
}>;

const accesses = new WeakMap<WaterSystem, WaterSystemInternalAccess>();

export function registerWaterSystemInternalAccess(
  system: WaterSystem,
  access: WaterSystemInternalAccess,
): void {
  accesses.set(system, access);
}

function accessFor(system: WaterSystem): WaterSystemInternalAccess {
  const access = accesses.get(system);
  if (!access) throw new TypeError('WaterSystem internal renderer access is unavailable');
  return access;
}

/** Engine-only zero-copy candidate build path. Do not expose publications to application code. */
export function buildWaterZoneMeshViewForRenderer(
  system: WaterSystem,
  zoneGuid: string,
  zoneGeneration: number,
  zone: WaterZoneAsset,
  view: WaterMeshViewInput,
): Result<WaterZoneMeshPublication, WaterError> {
  return accessFor(system).buildZoneMeshView(zoneGuid, zoneGeneration, zone, view);
}

/** Engine-only zero-copy retained publication path. Do not expose publications to application code. */
export function waterZoneMeshViewForRenderer(
  system: WaterSystem,
  zoneGuid: string,
  viewId: string,
): WaterZoneMeshPublication | undefined {
  return accessFor(system).zoneMeshView(zoneGuid, viewId);
}

/** Engine-only zero-copy candidate enumeration for WaterInfo closure acceptance. */
export function waterMeshCandidateViewsForRenderer(
  system: WaterSystem,
  viewId: string,
): readonly WaterZoneMeshPublication[] {
  return accessFor(system).waterMeshCandidateViews(viewId);
}

/** Complete the exact scene-owned candidate retained by a submitted frame. */
export function acceptWaterMeshViewForRenderer(
  system: WaterSystem,
  candidate: WaterZoneMeshPublication,
): boolean {
  return accessFor(system).acceptWaterMeshView(candidate);
}
