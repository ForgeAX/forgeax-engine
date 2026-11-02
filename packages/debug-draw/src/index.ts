// @forgeax/engine-debug-draw -- public barrel (feat-20260615-debug-draw-immediate-mode M1/M2)
//
// Single-entry surface: createDebugDraw factory + DebugDraw class + DebugDrawErrorCode
// closed union. Shape API (line / sphere / aabb / frustum) + flush are available
// on the returned DebugDraw instance.

export { INITIAL_VERTEX_CAPACITY, MAX_VERTEX_CAPACITY, VERTEX_STRIDE_BYTES } from './constants';
export { createDebugDraw, DebugDraw } from './debug-draw';
export type {
  DebugDrawError,
  DebugDrawErrorCode,
  DebugDrawErrorDetail,
} from './errors';
export { DEBUG_OVERLAY_SHADER } from './shader';
export type { DebugDrawSourceOptions, DebugOverlayBatch } from './source';
export { createDebugDrawSource, DebugDrawSource } from './source';
export type { CreateShaderModule, DebugDrawOptions, DebugDrawShapes, DepthMode } from './types';
