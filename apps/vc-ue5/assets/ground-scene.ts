import { quat } from '@forgeax/engine/math';
import {
  ANTIALIAS_NONE, Atmosphere, Camera, CameraView, DirectionalLight, MeshFilter, MeshRenderer,
  ShadowParticipation, Skylight, TONEMAP_ACES_FILMIC, Visibility, VisibilityStateValue,
  VolumetricCloudLayer, perspective,
} from '@forgeax/engine/render';
import { Name, Transform } from '@forgeax/engine/scene';
import type { SceneAsset } from '@forgeax/engine/types';
import { UE_CLOUD_SCENE_PRESET } from '@forgeax-assets/volumetric-clouds/reference';
import {
  OCCLUDER_CENTER, REFERENCE_VERTICAL_FOV, SUN_DIRECTION,
  referenceCamera, viewDirection, type GroundCamera,
} from './terrain.ts';
import { DEFAULT_CLOUD_BOUNDS } from './weather-presets.ts';

export const GROUND_SCENE_KEY = 'scene/ground-reference';
export const GROUND_SCENE_COMPONENTS = [
  Name, Transform, Camera, CameraView, MeshFilter, MeshRenderer, ShadowParticipation,
  Visibility, DirectionalLight, Skylight, Atmosphere, VolumetricCloudLayer,
] as const;
export const GROUND_ENTITY_KEYS = [
  'camera', 'ground', 'occluder', 'sun', 'skylight', 'atmosphere', 'cloud',
] as const;
export type GroundEntityKey = typeof GROUND_ENTITY_KEYS[number];

export function cameraTransform(camera: GroundCamera) {
  const position = [camera.x, camera.y, camera.z] as const;
  const dir = viewDirection(camera.yaw, camera.pitch);
  const rotation = quat.fromLookAt(
    quat.create(), position, [position[0] + dir[0], position[1] + dir[1], position[2] + dir[2]], [0, 1, 0],
  );
  return { pos: position, quat: [rotation[0], rotation[1], rotation[2], rotation[3]] as const };
}

interface GroundSceneReferences {
  readonly ground: string;
  readonly groundMaterial: string;
  readonly occluder: string;
  readonly occluderMaterial: string;
  readonly cloudMaterial: string;
}

/** The formal preview and the running Demo instantiate this same authored Scene. */
export function groundReferenceScene(refs: GroundSceneReferences) {
  return {
    kind: 'scene',
    entities: {
      camera: { components: {
        Name: { value: 'Simulation Blank ground camera' },
        Transform: cameraTransform(referenceCamera()),
        Camera: {
          ...perspective({ fov: REFERENCE_VERTICAL_FOV, aspect: 16 / 9, near: 0.05, far: 25_000 }),
          autoAspect: false, tonemap: TONEMAP_ACES_FILMIC, exposure: 0.00022,
          antialias: ANTIALIAS_NONE,
        },
        CameraView: { resolutionScale: 1 },
      } },
      ground: { components: {
        Name: { value: 'Reference flat ground' },
        Transform: {},
        MeshFilter: { assetHandle: refs.ground },
        MeshRenderer: { materials: [refs.groundMaterial] },
        ShadowParticipation: { cast: false, receive: false },
      } },
      occluder: { components: {
        Name: { value: 'Foreground depth fixture' },
        Transform: { pos: OCCLUDER_CENTER },
        MeshFilter: { assetHandle: refs.occluder },
        MeshRenderer: { materials: [refs.occluderMaterial] },
        Visibility: { state: VisibilityStateValue.visible },
        ShadowParticipation: { cast: false, receive: false },
      } },
      sun: { components: {
        Name: { value: 'Daylight sun' },
        DirectionalLight: {
          direction: SUN_DIRECTION, color: [1, 1, 1], intensity: 120_000, castShadow: false,
        },
      } },
      skylight: { components: {
        Name: { value: 'Sky irradiance' },
        Skylight: { ambientIrradiance: [6000, 7500, 10000], intensity: 1 },
      } },
      atmosphere: { components: {
        Name: { value: 'Clear atmosphere' },
        Atmosphere: { aerialPerspectiveStart: 100 },
      } },
      cloud: { components: {
        Name: { value: 'Volumetric cloud layer' },
        VolumetricCloudLayer: { material: refs.cloudMaterial, ...UE_CLOUD_SCENE_PRESET, ...DEFAULT_CLOUD_BOUNDS },
      } },
    },
  } satisfies SceneAsset;
}
