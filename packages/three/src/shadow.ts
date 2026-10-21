import { DirectionalShadowFilterValue } from '@forgeax/engine-render';
import {
  BasicShadowMap,
  DirectionalLight,
  PCFShadowMap,
  PCFSoftShadowMap,
  PointLight,
  type ShadowMapType,
  type SpotLight,
  VSMShadowMap,
  WebGPUCoordinateSystem,
} from 'three/src/Three.Core.js';
import { invalid, unsupported } from './errors';

export interface ShadowMapSettings {
  readonly enabled: boolean;
  readonly type: ShadowMapType;
  readonly cameraLayers?: number;
}

type ShadowLight = DirectionalLight | PointLight | SpotLight;

function filter(light: ShadowLight, settings?: ShadowMapSettings) {
  if (settings?.enabled !== true || !light.castShadow) return undefined;
  const shadow = light.shadow;
  const selected =
    settings.type === BasicShadowMap
      ? DirectionalShadowFilterValue.pcf1
      : settings.type === PCFShadowMap
        ? DirectionalShadowFilterValue.pcfVogel
        : settings.type === PCFSoftShadowMap
          ? DirectionalShadowFilterValue.pcfSoft
          : settings.type === VSMShadowMap
            ? DirectionalShadowFilterValue.variance
            : unsupported('Unknown shadow filter', light.uuid).unwrap();
  if (
    ![shadow.mapSize.x, shadow.mapSize.y].every((value) => Number.isInteger(value) && value > 0) ||
    ![shadow.bias, shadow.normalBias, shadow.radius, shadow.intensity].every(Number.isFinite) ||
    shadow.radius < 0 ||
    shadow.intensity < 0 ||
    shadow.intensity > 1 ||
    !Number.isInteger(shadow.blurSamples) ||
    shadow.blurSamples < 1 ||
    shadow.blurSamples > 64
  )
    return invalid('LightShadow mapSize/bias/normalBias/radius/intensity', light.uuid).unwrap();
  return selected;
}

function shadowView(light: DirectionalLight | SpotLight) {
  const shadow = light.shadow;
  if (shadow.camera.coordinateSystem !== WebGPUCoordinateSystem) {
    shadow.camera.coordinateSystem = WebGPUCoordinateSystem;
    shadow.camera.updateProjectionMatrix();
  }
  if (shadow.autoUpdate || shadow.needsUpdate) shadow.updateMatrices(light);
  // LightShadow.matrix retains the submitted camera when autoUpdate is false.
  const matrix = shadow.matrix.clone().elements;
  for (let column = 0; column < 16; column += 4) {
    matrix[column] = (matrix[column] as number) * 2 - (matrix[column + 3] as number);
    matrix[column + 1] = (matrix[column + 1] as number) * 2 - (matrix[column + 3] as number);
  }
  // The source renderer exposes ordinary WebGPU depth; native rendering owns reverse-Z.
  for (let column = 0; column < 16; column += 4)
    matrix[column + 2] = (matrix[column + 3] as number) - (matrix[column + 2] as number);
  return matrix;
}

function receiver(light: ShadowLight) {
  return {
    mapSize: light.shadow.mapSize.x,
    depthBias: -light.shadow.bias,
    normalBias: light.shadow.normalBias,
    shadowBiasMode: 1,
    shadowIntensity: light.shadow.intensity,
  };
}

export function directionalShadow(light: DirectionalLight, settings?: ShadowMapSettings) {
  const shadowFilter = filter(light, settings);
  if (shadowFilter === undefined) return { castShadow: false };
  return {
    castShadow: true,
    cascadeCount: 1,
    cascadeBlend: 0,
    ...receiver(light),
    mapSize: Math.max(light.shadow.mapSize.x, light.shadow.mapSize.y),
    shadowMapAspect: light.shadow.mapSize.x / light.shadow.mapSize.y,
    shadowProjection: 1,
    shadowViewProjection: shadowView(light),
    shadowFilter,
    shadowRadius: light.shadow.radius,
    shadowBlurSamples: light.shadow.blurSamples,
  };
}

export function spotShadow(light: SpotLight, settings?: ShadowMapSettings) {
  const shadowFilter = filter(light, settings);
  if (shadowFilter === undefined) return { castShadow: false };
  const matrix = shadowView(light);
  return {
    castShadow: true,
    ...receiver(light),
    mapSize: Math.max(light.shadow.mapSize.x, light.shadow.mapSize.y),
    shadowMapAspect: light.shadow.mapSize.x / light.shadow.mapSize.y,
    shadowProjection: 1,
    shadowViewProjection: matrix,
    nearPlane: light.shadow.camera.near,
    farPlane: light.shadow.camera.far,
    shadowFilter,
    pcfKernelSize: light.shadow.radius * 2 + 1,
    shadowBlurSamples: light.shadow.blurSamples,
  };
}

export function pointShadow(light: PointLight, settings?: ShadowMapSettings) {
  const shadowFilter = filter(light, settings);
  if (shadowFilter === undefined) return undefined;
  if (light.shadow.autoUpdate || light.shadow.needsUpdate) {
    const position = light.matrixWorld.elements;
    light.shadow.matrix.makeTranslation(
      -(position[12] as number),
      -(position[13] as number),
      -(position[14] as number),
    );
    const far = light.distance || light.shadow.camera.far;
    if (far !== light.shadow.camera.far) {
      light.shadow.camera.far = far;
      light.shadow.camera.updateProjectionMatrix();
    }
  }
  const matrix = light.shadow.matrix.elements;
  return {
    shadowProjection: 1,
    shadowPosition: [-(matrix[12] as number), -(matrix[13] as number), -(matrix[14] as number)],
    ...receiver(light),
    nearPlane: light.shadow.camera.near,
    farPlane: light.shadow.camera.far,
    // PointShadowNode uses Vogel for every non-Basic shadow type.
    shadowFilter: shadowFilter === DirectionalShadowFilterValue.pcf1 ? 1 : 6,
    pcfKernelSize: light.shadow.radius * 2 + 1,
  };
}

/** Source update requests and the map extent admitted by the last update. */
export class ShadowUpdates {
  private readonly revisions = new WeakMap<
    ShadowLight,
    { revision: number; pending: boolean; width: number; height: number }
  >();
  private readonly active = new Set<ShadowLight>();

  begin() {
    this.active.clear();
  }

  project(light: ShadowLight, settings?: ShadowMapSettings) {
    if (settings?.enabled !== true || !light.castShadow) return undefined;
    let state = this.revisions.get(light);
    const update = light.shadow.autoUpdate || light.shadow.needsUpdate;
    if (state === undefined) {
      if (!update) return undefined;
      state = {
        revision: 0,
        pending: false,
        width: light.shadow.mapSize.x,
        height: light.shadow.mapSize.y,
      };
      this.revisions.set(light, state);
    }
    if (update) {
      state.width = light.shadow.mapSize.x;
      state.height = light.shadow.mapSize.y;
    }
    if (light.shadow.needsUpdate && !state.pending) {
      state.revision++;
      state.pending = true;
    }
    this.active.add(light);
    const projected =
      light instanceof DirectionalLight
        ? directionalShadow(light, settings)
        : light instanceof PointLight
          ? pointShadow(light, settings)
          : spotShadow(light, settings);
    return {
      ...projected,
      mapSize: light instanceof PointLight ? state.width : Math.max(state.width, state.height),
      ...(light instanceof PointLight ? {} : { shadowMapAspect: state.width / state.height }),
      shadowCasterChannels:
        ((light.shadow.camera.layers.mask & 0xfffffffe) === 0
          ? (settings.cameraLayers ?? 1)
          : light.shadow.camera.layers.mask) >>> 0,
      shadowAutoUpdate: light.shadow.autoUpdate,
      shadowRevision: state.revision,
    };
  }

  submitted() {
    for (const light of this.active) {
      const state = this.revisions.get(light);
      if (state?.pending) {
        light.shadow.needsUpdate = false;
        state.pending = false;
      }
    }
  }
}
