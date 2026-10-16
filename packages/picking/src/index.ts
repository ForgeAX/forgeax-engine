// @forgeax/engine-picking -- screen-to-entity + vertex-level + tile-cell picking.
//
// All three query surfaces are free functions (NOT methods on World -- charter F1),
// taking `(world, ...)` and returning a hit / undefined / Result. Extracted from
// @forgeax/engine-runtime in feat-20260705 (Tier 2.2). The shared skeleton
// (camera validation -> view=invert -> projection -> screenToRay -> GlobalTransform.world)
// lives once in pick-core.ts (AC-201).

export type { DisplayVertexPickOptions } from './display-picking';
export {
  computeDisplayScreenRay,
  displayToScenePixel,
  pickDisplay,
  pickVertexDisplay,
  pickVertexOnEntityDisplay,
} from './display-picking';

// --- screen-to-entity ray-AABB pick (nearest pickable mesh) ---
export type { PickHit } from './pick';
export { pick } from './pick';

// --- pick error model (closed single-member PickErrorCode union) ---
export type { PickErrorCode } from './pick-errors';
export { PickError } from './pick-errors';
// --- tile-cell pick (Tilemap query) ---
export { type PickTileError, type PickTileHit, pickTile } from './pick-tile';
export {
  pickTriangle,
  type TriangleHit,
  type TrianglePickOptions,
  type TrianglePickResult,
  type TrianglePickUnavailableReason,
} from './pick-triangle';
// --- vertex-level pick (per-entity + full-scene) ---
export type { VertexHit } from './pick-vertex';
export { pickVertex, pickVertexOnEntity } from './pick-vertex';
export { viewportToWorld } from './viewport-to-world';
