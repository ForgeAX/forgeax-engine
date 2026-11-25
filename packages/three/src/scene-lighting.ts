import { FogModeValue, type RenderTargetEnvironmentSource } from '@forgeax/engine-render';
import type { AssetHandle } from '@forgeax/engine-types';
import IESSpotLight from 'three/src/lights/webgpu/IESSpotLight.js';
import ProjectorLight from 'three/src/lights/webgpu/ProjectorLight.js';
import {
  AmbientLight,
  type DirectionalLight,
  Fog,
  FogExp2,
  HemisphereLight,
  type Object3D,
  PointLight,
  RectAreaLight,
  type Scene,
  SpotLight,
  Vector3,
} from 'three/src/Three.Core.js';
import { invalid, unsupported } from './errors';
import { sameValues } from './shared-assets';
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

export function hasLightingEnvironment(lighting: SceneLighting): boolean {
  return lighting.lighting !== NO_EQUIRECT || lighting.targetEnvironment !== undefined;
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

type RGB = [number, number, number];

export interface SceneAmbientLighting {
  readonly irradiance: RGB;
  readonly hemisphere?: { readonly sky: RGB; readonly ground: RGB };
}

function sameHemisphere(
  a: SceneAmbientLighting['hemisphere'],
  b: SceneAmbientLighting['hemisphere'],
): boolean {
  return (
    a === b ||
    (a !== undefined &&
      b !== undefined &&
      sameValues(a.sky, b.sky) &&
      sameValues(a.ground, b.ground))
  );
}

export function sameAmbientLighting(a: SceneAmbientLighting, b: SceneAmbientLighting): boolean {
  return sameValues(a.irradiance, b.irradiance) && sameHemisphere(a.hemisphere, b.hemisphere);
}

function addHemisphereIrradiance(
  light: HemisphereLight,
  positionScratch: Vector3,
  irradiance: RGB,
  hemisphere: SceneAmbientLighting['hemisphere'],
  hasEnvironment: boolean,
): SceneAmbientLighting['hemisphere'] {
  const { color, groundColor, intensity } = light;
  const top: RGB = [color.r, color.g, color.b];
  const bottom: RGB = [groundColor.r, groundColor.g, groundColor.b];
  if (
    ![...top, ...bottom, intensity].every(
      (value) => Number.isFinite(Math.fround(value)) && value >= 0,
    )
  )
    invalid('HemisphereLight color/groundColor/intensity', light.uuid).unwrap();
  const position = light.getWorldPosition(positionScratch);
  if (![position.x, position.y, position.z].every(Number.isFinite))
    invalid('HemisphereLight world position', light.uuid).unwrap();
  if (color.equals(groundColor) || (position.x === 0 && position.y === 0 && position.z === 0)) {
    for (const channel of [0, 1, 2] as const)
      irradiance[channel] += (top[channel] + bottom[channel]) * 0.5 * intensity;
    return hemisphere;
  }
  if (position.x !== 0 || position.z !== 0)
    unsupported('HemisphereLight direction requires a world Y axis', light.uuid).unwrap();
  if (hasEnvironment)
    unsupported(
      'HemisphereLight with Scene.environment requires independent directional diffuse irradiance',
      light.uuid,
    ).unwrap();
  const upper = position.y > 0 ? top : bottom;
  const lower = position.y > 0 ? bottom : top;
  const sum = hemisphere ?? { sky: [0, 0, 0], ground: [0, 0, 0] };
  for (const channel of [0, 1, 2] as const) {
    sum.sky[channel] += (upper[channel] * intensity) / Math.PI;
    sum.ground[channel] += (lower[channel] * intensity) / Math.PI;
  }
  return sum;
}

export function sceneAmbientLighting(
  scene: Object3D,
  visible: Iterable<Object3D>,
  changes: SceneChanges | undefined,
  mask: number,
  hasEnvironment: boolean,
): SceneAmbientLighting {
  const irradiance: RGB = changes ? [...changes.ambientIrradiance(mask)] : [0, 0, 0];
  let hemisphere: SceneAmbientLighting['hemisphere'];
  let position: Vector3 | undefined;
  for (const light of visible) {
    if (light instanceof AmbientLight && !changes?.lights.has(light)) {
      irradiance[0] += light.color.r * light.intensity;
      irradiance[1] += light.color.g * light.intensity;
      irradiance[2] += light.color.b * light.intensity;
    } else if (light instanceof HemisphereLight && light.intensity !== 0) {
      position ??= new Vector3();
      hemisphere = addHemisphereIrradiance(light, position, irradiance, hemisphere, hasEnvironment);
    }
  }
  const isFiniteRgb = (values: RGB) => values.every((value) => Number.isFinite(Math.fround(value)));
  if (
    !isFiniteRgb(irradiance) ||
    (hemisphere && (!isFiniteRgb(hemisphere.sky) || !isFiniteRgb(hemisphere.ground)))
  )
    invalid('Total ambient irradiance', scene.uuid).unwrap();
  if (hemisphere === undefined) return { irradiance };
  // Skylight reserves a zero ground color for uniform sky. The smallest
  // positive normal f32 enables the hemisphere and rounds to black at HDR16.
  if (hemisphere.ground.every((value) => Math.fround(value) === 0))
    hemisphere.ground[0] = 2 ** -126;
  return { irradiance, hemisphere };
}
