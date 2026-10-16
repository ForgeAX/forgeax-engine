import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { mat4, ray, type Vec3Like, vec2 } from '@forgeax/engine-math';
import {
  type BarrelDistortionMapping,
  type DisplayPoint,
  mapDisplayToScene,
  mapSceneToDisplay,
} from '@forgeax/engine-render';
import { type PickHit, pickWithScreenRay } from './pick';
import { computeScreenRayFromMatrices, type ScreenRay } from './pick-core';
import {
  pickVertexOnEntityWithScreenRay,
  pickVertexWithScreenRay,
  type VertexHit,
} from './pick-vertex';

export interface DisplayVertexPickOptions {
  readonly limit?: number;
  /** Maximum distance in displayed physical pixels; omitted keeps all ray hits. */
  readonly radius?: number;
}

/**
 * Convert a displayed output pixel to the matching unwarped scene pixel.
 *
 * `undefined` is the fail-closed signal that no accepted submitted frame is
 * available. It is not an identity mapping; callers must wait for a new
 * submitted frame (including an explicit zero-strength mapping).
 */
export function displayToScenePixel(
  out: DisplayPoint,
  mapping: BarrelDistortionMapping | undefined,
  displayX: number,
  displayY: number,
): boolean {
  if (mapping === undefined) return false;
  return mapDisplayToScene(out, mapping, displayX, displayY);
}

/**
 * Display coordinates are meaningful only against the accepted submitted
 * output extent. Keep the legacy viewport arguments as an explicit boundary
 * check for callers migrating from unwarped picking; never let them select a
 * second ray viewport or manufacture an identity mapping. An omitted mapping
 * therefore rejects the query before any World or camera access.
 */
function submittedExtent(
  mapping: BarrelDistortionMapping | undefined,
  viewportWidth: number,
  viewportHeight: number,
): { readonly width: number; readonly height: number } | undefined {
  if (mapping === undefined) return undefined;
  if (
    !Number.isFinite(mapping.width) ||
    !Number.isFinite(mapping.height) ||
    mapping.width <= 0 ||
    mapping.height <= 0 ||
    !Number.isFinite(viewportWidth) ||
    !Number.isFinite(viewportHeight) ||
    viewportWidth !== mapping.width ||
    viewportHeight !== mapping.height
  ) {
    return undefined;
  }
  return { width: mapping.width, height: mapping.height };
}

/** Build a world ray from the physical pixel currently visible on screen. */
export function computeDisplayScreenRay(
  world: World,
  cameraEntity: EntityHandle,
  displayX: number,
  displayY: number,
  mapping: BarrelDistortionMapping | undefined,
  viewportWidth: number,
  viewportHeight: number,
): ScreenRay | undefined {
  // The signature retains the world/entity pair for the shared picking
  // surface, but an accepted frame context is mandatory for display rays.
  void world;
  void cameraEntity;
  const extent = submittedExtent(mapping, viewportWidth, viewportHeight);
  if (
    extent === undefined ||
    !Number.isFinite(displayX) ||
    !Number.isFinite(displayY) ||
    displayX < 0 ||
    displayX > extent.width ||
    displayY < 0 ||
    displayY > extent.height
  ) {
    return undefined;
  }
  const scene = { x: 0, y: 0 };
  if (!displayToScenePixel(scene, mapping, displayX, displayY)) return undefined;
  return computeSceneScreenRay(scene.x, scene.y, mapping);
}

function computeSceneScreenRay(
  sceneX: number,
  sceneY: number,
  mapping: BarrelDistortionMapping | undefined,
): ScreenRay | undefined {
  if (mapping === undefined || mapping.camera === undefined) return undefined;
  const camera = mapping.camera;
  const submitted = mapping;
  return computeScreenRayFromMatrices(
    sceneX,
    sceneY,
    submitted.width,
    submitted.height,
    camera.viewMatrix,
    camera.projectionMatrix,
    camera.projection,
  );
}

/** Explicit display-space entity pick; legacy `pick` remains unwarped. */
export function pickDisplay(
  world: World,
  displayX: number,
  displayY: number,
  mapping: BarrelDistortionMapping | undefined,
  viewportWidth: number,
  viewportHeight: number,
): PickHit | undefined {
  const extent = submittedExtent(mapping, viewportWidth, viewportHeight);
  if (
    extent === undefined ||
    !Number.isFinite(displayX) ||
    !Number.isFinite(displayY) ||
    displayX < 0 ||
    displayX > extent.width ||
    displayY < 0 ||
    displayY > extent.height
  ) {
    return undefined;
  }
  const scene = { x: 0, y: 0 };
  if (!displayToScenePixel(scene, mapping, displayX, displayY)) return undefined;
  const screenRay = computeSceneScreenRay(scene.x, scene.y, mapping);
  if (screenRay === undefined) return undefined;
  return pickWithScreenRay(world, screenRay);
}

function remapVertexHits(
  hits: readonly VertexHit[],
  displayX: number,
  displayY: number,
  mapping: BarrelDistortionMapping | undefined,
  screenRay: ScreenRay,
  viewportWidth: number,
  viewportHeight: number,
  radius: number | undefined,
): VertexHit[] {
  const viewProj = mat4.create();
  mat4.multiply(viewProj, screenRay.proj, screenRay.view);
  const scenePoint = vec2.create();
  const displayPoint: DisplayPoint = { x: 0, y: 0 };
  const remapped: VertexHit[] = [];
  for (const hit of hits) {
    const projected = ray.worldToScreen(
      scenePoint,
      hit.worldPos as unknown as Vec3Like,
      viewProj,
      viewportWidth,
      viewportHeight,
    );
    if (projected.behind) continue;
    if (
      mapping === undefined ||
      !mapSceneToDisplay(displayPoint, mapping, scenePoint[0] as number, scenePoint[1] as number)
    )
      continue;
    const dx = displayPoint.x - displayX;
    const dy = displayPoint.y - displayY;
    const screenDist = Math.hypot(dx, dy);
    if (radius !== undefined && (!Number.isFinite(radius) || screenDist > radius)) continue;
    remapped.push({ ...hit, screenDist });
  }
  remapped.sort((left, right) => left.screenDist - right.screenDist);
  return remapped;
}

function displayVertexQuery(
  displayX: number,
  displayY: number,
  mapping: BarrelDistortionMapping | undefined,
  viewportWidth: number,
  viewportHeight: number,
): DisplayPoint | undefined {
  const extent = submittedExtent(mapping, viewportWidth, viewportHeight);
  if (
    extent === undefined ||
    !Number.isFinite(displayX) ||
    !Number.isFinite(displayY) ||
    displayX < 0 ||
    displayX > extent.width ||
    displayY < 0 ||
    displayY > extent.height
  ) {
    return undefined;
  }
  const scene = { x: 0, y: 0 };
  if (!displayToScenePixel(scene, mapping, displayX, displayY)) return undefined;
  return scene;
}

/** Pick vertices using displayed-pixel radius and ordering under the same mapping. */
export function pickVertexDisplay(
  world: World,
  _cameraEntity: EntityHandle,
  displayX: number,
  displayY: number,
  mapping: BarrelDistortionMapping | undefined,
  viewportWidth: number,
  viewportHeight: number,
  options?: DisplayVertexPickOptions,
): VertexHit | VertexHit[] | undefined {
  const scene = displayVertexQuery(displayX, displayY, mapping, viewportWidth, viewportHeight);
  if (scene === undefined) return options === undefined ? undefined : [];
  const screenRay = computeSceneScreenRay(scene.x, scene.y, mapping);
  if (screenRay === undefined) return options === undefined ? undefined : [];
  const extent =
    mapping === undefined ? undefined : { width: mapping.width, height: mapping.height };
  if (extent === undefined) return options === undefined ? undefined : [];
  const hitResult = pickVertexWithScreenRay(
    world,
    screenRay,
    scene.x,
    scene.y,
    extent.width,
    extent.height,
    {
      limit: Number.MAX_SAFE_INTEGER,
    },
  );
  const hits = Array.isArray(hitResult) ? hitResult : [];
  const remapped = remapVertexHits(
    hits,
    displayX,
    displayY,
    mapping,
    screenRay,
    extent.width,
    extent.height,
    options?.radius,
  );
  return options === undefined
    ? remapped[0]
    : options.limit === undefined
      ? remapped
      : remapped.slice(0, options.limit);
}

/** Pick vertices on one entity using displayed-pixel radius and ordering. */
export function pickVertexOnEntityDisplay(
  world: World,
  _cameraEntity: EntityHandle,
  displayX: number,
  displayY: number,
  mapping: BarrelDistortionMapping | undefined,
  viewportWidth: number,
  viewportHeight: number,
  entity: EntityHandle,
  options?: DisplayVertexPickOptions,
): VertexHit | VertexHit[] | undefined {
  const scene = displayVertexQuery(displayX, displayY, mapping, viewportWidth, viewportHeight);
  if (scene === undefined) return options === undefined ? undefined : [];
  const screenRay = computeSceneScreenRay(scene.x, scene.y, mapping);
  if (screenRay === undefined) return options === undefined ? undefined : [];
  const extent =
    mapping === undefined ? undefined : { width: mapping.width, height: mapping.height };
  if (extent === undefined) return options === undefined ? undefined : [];
  const hitResult = pickVertexOnEntityWithScreenRay(
    world,
    screenRay,
    scene.x,
    scene.y,
    extent.width,
    extent.height,
    entity,
    { limit: Number.MAX_SAFE_INTEGER },
  );
  const hits = Array.isArray(hitResult) ? hitResult : [];
  const remapped = remapVertexHits(
    hits,
    displayX,
    displayY,
    mapping,
    screenRay,
    extent.width,
    extent.height,
    options?.radius,
  );
  return options === undefined
    ? remapped[0]
    : options.limit === undefined
      ? remapped
      : remapped.slice(0, options.limit);
}
