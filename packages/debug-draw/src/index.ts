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
export type { CreateShaderModule, DebugDrawOptions, DepthMode } from './types';
