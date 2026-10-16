import type { World } from '@forgeax/engine-ecs';
import type { RenderFeatureExtractView } from '@forgeax/engine-render';

export interface ParticleRenderCamera {
  readonly position: Float32Array;
  readonly right: Float32Array;
  readonly up: Float32Array;
  readonly viewProjection: Float32Array;
}

export interface ParticleRenderCameraSource {
  readonly read: (
    world: World,
    views: readonly RenderFeatureExtractView[],
  ) => ParticleRenderCamera | undefined;
}
