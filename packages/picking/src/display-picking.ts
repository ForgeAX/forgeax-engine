import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { mat4, ray, vec2 } from '@forgeax/engine-math';
import {
  type BarrelDistortionMapping,
  type DisplayPoint,
  mapDisplayToScene,
  mapSceneToDisplay,
} from '@forgeax/engine-render';
import { type PickHit, pickWithScreenRay } from './pick';
import { computeScreenRayFromMatrices, type ScreenRay } from './pick-core';
import { pickTriangleWithScreenRay, type TrianglePickResult } from './pick-triangle';
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

interface DisplayQuery {
  readonly scene: DisplayPoint;
  readonly screenRay: ScreenRay;
  readonly mapping: BarrelDistortionMapping;
}

/** Validate the submitted extent and resolve one display sample before any World access. */
function displayQuery(
  displayX: number,
  displayY: number,
  mapping: BarrelDistortionMapping | undefined,
  viewportWidth: number,
  viewportHeight: number,
): DisplayQuery | undefined {
  if (mapping === undefined || mapping.camera === undefined) return undefined;
  if (
    !Number.isFinite(mapping.width) ||
    !Number.isFinite(mapping.height) ||
    mapping.width <= 0 ||
    mapping.height <= 0 ||
    viewportWidth !== mapping.width ||
    viewportHeight !== mapping.height ||
    !Number.isFinite(displayX) ||
    !Number.isFinite(displayY) ||
    displayX < 0 ||
    displayX > mapping.width ||
    displayY < 0 ||
    displayY > mapping.height
  )
    return undefined;
  const scene = { x: 0, y: 0 };
  if (!displayToScenePixel(scene, mapping, displayX, displayY)) return undefined;
  const camera = mapping.camera;
  const screenRay = computeScreenRayFromMatrices(
    scene.x,
    scene.y,
    mapping.width,
    mapping.height,
    camera.viewMatrix,
    camera.projectionMatrix,
  );
  return screenRay === undefined ? undefined : { scene, screenRay, mapping };
}

/** Build a world ray from the physical pixel currently visible on screen. */
export function computeDisplayScreenRay(
  displayX: number,
  displayY: number,
  mapping: BarrelDistortionMapping | undefined,
  viewportWidth: number,
  viewportHeight: number,
): ScreenRay | undefined {
  return displayQuery(displayX, displayY, mapping, viewportWidth, viewportHeight)?.screenRay;
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
  const query = displayQuery(displayX, displayY, mapping, viewportWidth, viewportHeight);
  return query === undefined ? undefined : pickWithScreenRay(world, query.screenRay);
}

/** Exact triangle pick through the camera and distortion mapping of a submitted frame. */
export function pickTriangleDisplay(
  world: World,
  displayX: number,
  displayY: number,
  mapping: BarrelDistortionMapping | undefined,
  viewportWidth: number,
  viewportHeight: number,
): TrianglePickResult {
  const query = displayQuery(displayX, displayY, mapping, viewportWidth, viewportHeight);
  return query === undefined
    ? { status: 'miss', precision: 'triangle' }
    : pickTriangleWithScreenRay(world, query.screenRay);
}

function remapVertexHits(
  hits: readonly VertexHit[],
  displayX: number,
  displayY: number,
  mapping: BarrelDistortionMapping,
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
      hit.worldPos,
      viewProj,
      viewportWidth,
      viewportHeight,
    );
    if (projected.behind) continue;
    if (!mapSceneToDisplay(displayPoint, mapping, scenePoint[0] as number, scenePoint[1] as number))
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

function pickDisplayVertices(
  world: World,
  displayX: number,
  displayY: number,
  mapping: BarrelDistortionMapping | undefined,
  viewportWidth: number,
  viewportHeight: number,
  options: DisplayVertexPickOptions | undefined,
  entity?: EntityHandle,
): VertexHit | VertexHit[] | undefined {
  const query = displayQuery(displayX, displayY, mapping, viewportWidth, viewportHeight);
  if (query === undefined) return options === undefined ? undefined : [];
  const { scene, screenRay, mapping: submitted } = query;
  const collectOptions = { limit: Number.MAX_SAFE_INTEGER };
  const hitResult =
    entity === undefined
      ? pickVertexWithScreenRay(
          world,
          screenRay,
          scene.x,
          scene.y,
          submitted.width,
          submitted.height,
          collectOptions,
        )
      : pickVertexOnEntityWithScreenRay(
          world,
          screenRay,
          scene.x,
          scene.y,
          submitted.width,
          submitted.height,
          entity,
          collectOptions,
        );
  const remapped = remapVertexHits(
    Array.isArray(hitResult) ? hitResult : [],
    displayX,
    displayY,
    submitted,
    screenRay,
    submitted.width,
    submitted.height,
    options?.radius,
  );
  return options === undefined
    ? remapped[0]
    : options.limit === undefined
      ? remapped
      : remapped.slice(0, options.limit);
}

/** Pick vertices using displayed-pixel radius and ordering under the same mapping. */
export function pickVertexDisplay(
  world: World,
  displayX: number,
  displayY: number,
  mapping: BarrelDistortionMapping | undefined,
  viewportWidth: number,
  viewportHeight: number,
  options?: DisplayVertexPickOptions,
): VertexHit | VertexHit[] | undefined {
  return pickDisplayVertices(
    world,
    displayX,
    displayY,
    mapping,
    viewportWidth,
    viewportHeight,
    options,
  );
}

/** Pick vertices on one entity using displayed-pixel radius and ordering. */
export function pickVertexOnEntityDisplay(
  world: World,
  displayX: number,
  displayY: number,
  mapping: BarrelDistortionMapping | undefined,
  viewportWidth: number,
  viewportHeight: number,
  entity: EntityHandle,
  options?: DisplayVertexPickOptions,
): VertexHit | VertexHit[] | undefined {
  return pickDisplayVertices(
    world,
    displayX,
    displayY,
    mapping,
    viewportWidth,
    viewportHeight,
    options,
    entity,
  );
}
