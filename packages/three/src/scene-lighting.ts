import { FogModeValue, type RenderTargetEnvironmentSource } from '@forgeax/engine-render';
import type { AssetHandle } from '@forgeax/engine-types';
import IESSpotLight from 'three/src/lights/webgpu/IESSpotLight.js';
import ProjectorLight from 'three/src/lights/webgpu/ProjectorLight.js';
import {
  AmbientLight,
  type DirectionalLight,
  Fog,
  FogExp2,
  type Object3D,
  PointLight,
  RectAreaLight,
  type Scene,
  SpotLight,
} from 'three/src/Three.Core.js';
import { invalid, unsupported } from './errors';
import type { SceneChanges } from './source-changes';

export function validateLight(
  object: RectAreaLight | AmbientLight | DirectionalLight | PointLight | SpotLight,
): void {
  if (
    ![...object.color.toArray(), object.intensity].every(
      (value) => Number.isFinite(value) && value >= 0,
    )
  )
    invalid('Light color/intensity', object.uuid).unwrap();
  if (
    object instanceof RectAreaLight &&
    ![object.width, object.height].every((value) => Number.isFinite(value) && value > 0)
  )
    invalid('RectAreaLight width/height', object.uuid).unwrap();
  if (
    (object instanceof PointLight || object instanceof SpotLight) &&
    (!Number.isFinite(object.distance) ||
      object.distance < 0 ||
      !Number.isFinite(Math.fround(object.decay)) ||
      object.decay < 0)
  )
    invalid('Light distance/decay', object.uuid).unwrap();
  if (object instanceof SpotLight) validateSpotLight(object);
}

function validateSpotLight(object: SpotLight): void {
  if (
    !Number.isFinite(object.angle) ||
    object.angle <= 0 ||
    object.angle > Math.PI / 2 ||
    !Number.isFinite(object.penumbra) ||
    object.penumbra < 0 ||
    object.penumbra > 1
  )
    invalid('SpotLight angle/penumbra', object.uuid).unwrap();
  if (object instanceof IESSpotLight && object.iesMap !== null)
    unsupported(
      'IESSpotLight.iesMap requires a native photometry conversion',
      object.uuid,
    ).unwrap();
  if (object instanceof ProjectorLight)
    unsupported('ProjectorLight requires native rectangular attenuation', object.uuid).unwrap();
  if (object.map !== null)
    unsupported('SpotLight map requires native projector texture projection', object.uuid).unwrap();
}

export const NO_EQUIRECT = 0 as AssetHandle<'equirect'>;

export interface SceneLighting {
  readonly targetEnvironment?: RenderTargetEnvironmentSource;
  readonly lighting: AssetHandle<'equirect'>;
  readonly background: AssetHandle<'equirect'>;
  readonly lightingRotation: number[];
  readonly backgroundRotation: number[];
  readonly fog?: ReturnType<typeof projectFog>;
}

export function projectFog(scene: Scene) {
  const fog = scene.fog;
  if (fog === null) return undefined;
  if (!(fog instanceof Fog || fog instanceof FogExp2))
    return unsupported('Scene.fog type', scene.uuid).unwrap();
  const color = fog.color.toArray();
  if (!color.every((value) => Number.isFinite(Math.fround(value)) && value >= 0))
    invalid('Scene.fog.color', scene.uuid).unwrap();
  if (fog instanceof Fog) {
    if (
      !Number.isFinite(Math.fround(fog.near)) ||
      !Number.isFinite(Math.fround(fog.far)) ||
      fog.near < 0 ||
      fog.far <= fog.near
    )
      invalid('Scene.fog.near/far', scene.uuid).unwrap();
    return {
      color,
      mode: FogModeValue.linear,
      near: fog.near,
      far: fog.far,
      density: 0,
      heightFalloff: 0,
      maxOpacity: 1,
      skyOpacity: 1,
    };
  }
  if (!Number.isFinite(Math.fround(fog.density)) || fog.density < 0)
    invalid('Scene.fog.density', scene.uuid).unwrap();
  return {
    color,
    mode: FogModeValue.exp2,
    density: fog.density,
    near: 0,
    far: 100,
    heightFalloff: 0,
    maxOpacity: 1,
    skyOpacity: 1,
  };
}

export function sceneAmbientIrradiance(
  scene: Object3D,
  visible: Iterable<Object3D>,
  changes: SceneChanges | undefined,
  mask: number,
): [number, number, number] {
  const ambientIrradiance: [number, number, number] = changes
    ? [...changes.ambientIrradiance(mask)]
    : [0, 0, 0];
  for (const object of visible) {
    if (!(object instanceof AmbientLight) || changes?.lights.has(object)) continue;
    ambientIrradiance[0] = ambientIrradiance[0] + object.color.r * object.intensity;
    ambientIrradiance[1] = ambientIrradiance[1] + object.color.g * object.intensity;
    ambientIrradiance[2] = ambientIrradiance[2] + object.color.b * object.intensity;
  }
  if (!ambientIrradiance.every((value) => Number.isFinite(Math.fround(value))))
    invalid('AmbientLight total irradiance', scene.uuid).unwrap();
  return ambientIrradiance;
}
