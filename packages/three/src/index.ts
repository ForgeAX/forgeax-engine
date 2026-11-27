// CPU constructor alias only; GPU work is owned by the facade's native target boundary.
export { default as WebGLCubeRenderTarget } from 'three/src/renderers/common/CubeRenderTarget.js';
export type { RendererParameters, RenderItem } from 'three/src/renderers/common/Renderer.js';
export * from './cpu';
export { ThreeCompatibilityError, type ThreeCompatibilityErrorCode } from './errors';
export { type MountThreeSceneOptions, mountThreeScene, type ThreeSceneMount } from './interop';
export {
  bindThreeSurface,
  type SurfaceFailure,
  ThreeSurfaceError,
  type ThreeSurfaceRecipe,
} from './node-surface';
export type * from './node-types';
export { createThreePipeline } from './pipeline';
export { QuadMesh } from './quad-mesh';
export {
  readThreeFrame,
  setThreePlanarReflection,
  type ThreeFrameCapture,
  type ThreeFrameObservation,
  type ThreePlanarReflectionOptions,
  WebGPURenderer,
  type WebGPURendererParameters,
} from './renderer';
export type { RendererErrorInfo } from './renderer-events';
export type { ThreeSourceIdentity } from './scene';
export { setThreeSceneTracking } from './source-changes';
export { enableThreeSourceTracking } from './source-collections';
