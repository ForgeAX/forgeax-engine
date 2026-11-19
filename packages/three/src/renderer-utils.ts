// Reuse r187's implementation with a structural state protocol for the native renderer.

import type {
  SceneState,
  RendererState as UpstreamRendererState,
} from 'three/src/renderers/common/RendererUtils.js';
import * as upstream from 'three/src/renderers/common/RendererUtils.js';
import type { Scene } from 'three/src/Three.Core.js';
import type { WebGPURenderer } from './renderer';

export type { SceneState };
export interface RendererState extends UpstreamRendererState {
  renderTarget: null;
  renderObjectFunction: null;
  mrt: null;
}
export interface RendererAndSceneState extends RendererState, SceneState {}

type StateRenderer = Pick<
  WebGPURenderer,
  | 'toneMapping'
  | 'toneMappingExposure'
  | 'outputColorSpace'
  | 'getRenderTarget'
  | 'setRenderTarget'
  | 'getActiveCubeFace'
  | 'getActiveMipmapLevel'
  | 'getRenderObjectFunction'
  | 'setRenderObjectFunction'
  | 'getPixelRatio'
  | 'setPixelRatio'
  | 'getMRT'
  | 'setMRT'
  | 'getClearColor'
  | 'setClearColor'
  | 'getClearAlpha'
  | 'autoClear'
  | 'autoClearColor'
  | 'autoClearDepth'
  | 'autoClearStencil'
  | 'opaque'
  | 'transparent'
  | 'getScissorTest'
  | 'setScissorTest'
>;

// Keep the original function identities. The narrower state describes values this
// renderer actually saves; it does not admit arbitrary MRTs or draw callbacks.
export const saveRendererState = upstream.saveRendererState as typeof upstream.saveRendererState &
  ((renderer: StateRenderer, state?: Partial<RendererState>) => RendererState);
export const resetRendererState =
  upstream.resetRendererState as typeof upstream.resetRendererState &
    ((renderer: StateRenderer, state?: Partial<RendererState>) => RendererState);
export const restoreRendererState =
  upstream.restoreRendererState as typeof upstream.restoreRendererState &
    ((renderer: StateRenderer, state: RendererState) => void);
export const saveSceneState = upstream.saveSceneState;
export const resetSceneState = upstream.resetSceneState as (
  scene: Scene,
  state?: Partial<SceneState>,
) => SceneState;
export const restoreSceneState = upstream.restoreSceneState;
export const saveRendererAndSceneState = upstream.saveRendererAndSceneState as unknown as (
  renderer: StateRenderer,
  scene: Scene,
  state?: Partial<RendererAndSceneState>,
) => RendererAndSceneState;
export const resetRendererAndSceneState = upstream.resetRendererAndSceneState as unknown as (
  renderer: StateRenderer,
  scene: Scene,
  state?: Partial<RendererAndSceneState>,
) => RendererAndSceneState;
export const restoreRendererAndSceneState = upstream.restoreRendererAndSceneState as unknown as (
  renderer: StateRenderer,
  scene: Scene,
  state: RendererAndSceneState,
) => void;
