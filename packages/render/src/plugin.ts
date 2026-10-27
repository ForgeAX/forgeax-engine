import type { Component, World } from '@forgeax/engine-ecs';
import type { Plugin } from '@forgeax/engine-plugin';
import { Terrain } from '@forgeax/engine-terrain';
import { AmbientOcclusion } from './components/ambient-occlusion';
import { Atmosphere } from './components/atmosphere';
import { BarrelDistortion } from './components/barrel-distortion';
import { Camera } from './components/camera';
import { CameraView } from './components/camera-view';
import { CapsuleShadow } from './components/capsule-shadow';
import { ClippingPlanes } from './components/clipping-planes';
import { CloudLayer } from './components/cloud-layer';
import { CubeCamera } from './components/cube-camera';
import { DepthOfField } from './components/depth-of-field';
import { DirectionalLight } from './components/directional-light';
import { DynamicResolution } from './components/dynamic-resolution';
import { Fog } from './components/fog';
import { GradientSky } from './components/gradient-sky';
import { Instances } from './components/instances';
import { Layer } from './components/layer';
import { LensEffects } from './components/lens-effects';
import { LensFlare } from './components/lens-flare';
import { LightProbe } from './components/light-probe';
import { Lines } from './components/lines';
import { MeshFilter } from './components/mesh-filter';
import { MeshRenderer } from './components/mesh-renderer';
import { MotionBlur } from './components/motion-blur';
import { Outline } from './components/outline';
import { PlanarReflection } from './components/planar-reflection';
import { PointLight } from './components/point-light';
import { PointLightShadow } from './components/point-light-shadow';
import { Points } from './components/points';
import { PostProcessParams } from './components/post-process-params';
import { RectAreaLight } from './components/rect-area-light';
import { ReflectionProbe } from './components/reflection-probe';
import { SceneInstance } from './components/scene-instance';
import { ScreenSpaceReflection } from './components/screen-space-reflection';
import { ShadowParticipation } from './components/shadow-participation';
import { SkyboxBackground } from './components/skybox-background';
import { Skylight } from './components/skylight';
import { SortKey } from './components/sort-key';
import { SpotLight } from './components/spot-light';
import { SpriteAnimation } from './components/sprite-animation';
import { SpriteInstances } from './components/sprite-instances';
import { SpriteRegionOverride } from './components/sprite-region-override';
import { StereoCamera } from './components/stereo-camera';
import { Tilemap } from './components/tilemap';
import { Visibility } from './components/visibility';
import { ProjectedDecal } from './decals/component';
import { VolumetricFog } from './volume/component';

const RENDER_COMPONENTS: readonly Component[] = [
  AmbientOcclusion,
  Atmosphere,
  BarrelDistortion,
  LensEffects,
  LensFlare,
  ClippingPlanes,
  Outline,
  ProjectedDecal,
  Camera,
  CameraView,
  CapsuleShadow,
  ShadowParticipation,
  PlanarReflection,
  CloudLayer,
  CubeCamera,
  DirectionalLight,
  DynamicResolution,
  DepthOfField,
  Fog,
  GradientSky,
  Instances,
  Layer,
  LightProbe,
  MeshFilter,
  Terrain,
  MeshRenderer,
  MotionBlur,
  PointLight,
  PointLightShadow,
  Points,
  Lines,
  PostProcessParams,
  RectAreaLight,
  ReflectionProbe,
  SceneInstance,
  ScreenSpaceReflection,
  SkyboxBackground,
  Skylight,
  SortKey,
  SpotLight,
  SpriteAnimation,
  SpriteInstances,
  SpriteRegionOverride,
  StereoCamera,
  Tilemap,
  Visibility,
  VolumetricFog,
];

function registerRenderComponents(world: World): () => void {
  const leases = RENDER_COMPONENTS.map((component) =>
    world.components.register(component).unwrap(),
  );
  return () => {
    for (let index = leases.length - 1; index >= 0; index -= 1) leases[index]?.dispose();
  };
}

/** Install the built-in render ECS vocabulary in one World. */
export function renderComponentsPlugin(): Plugin {
  return {
    name: 'render-components',
    inject: ['world'],
    apply(ctx) {
      ctx.effect(() => registerRenderComponents(ctx.world), 'render/components');
    },
  };
}
