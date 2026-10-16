// Shared scene for Bevy's `spatial_audio_2d` example.

import { HANDLE_CUBE, HANDLE_SPHERE } from '@forgeax/engine-assets-runtime';
import { AudioListener, AudioSource } from '@forgeax/engine-audio';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { quat } from '@forgeax/engine-math';
import type { Handle, MaterialAsset } from '@forgeax/engine-types';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  perspective,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';

export const HANDLE_NONE = 0 as unknown as Handle<'AudioClipAsset', 'shared'>;

export interface SpatialAudio2dScene {
  readonly camera: EntityHandle;
  readonly listener: EntityHandle;
  readonly emitter: EntityHandle;
  readonly leftEar: EntityHandle;
  readonly rightEar: EntityHandle;
}

function material(
  world: World,
  options: Parameters<typeof Materials.standard>[0],
): Handle<'MaterialAsset', 'shared'> {
  return world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', Materials.standard(options));
}

function marker(
  world: World,
  assetHandle: Handle<'MeshAsset', 'shared'>,
  materialHandle: Handle<'MaterialAsset', 'shared'>,
  pos: readonly [number, number, number],
  scale: readonly [number, number, number],
): EntityHandle {
  return world
    .spawn(
      { component: Transform, data: { pos, scale } },
      { component: MeshFilter, data: { assetHandle } },
      { component: MeshRenderer, data: { materials: [materialHandle] } },
    )
    .unwrap();
}

export function buildSpatialAudio2dWorld(world: World, aspect: number): SpatialAudio2dScene {
  const emitterMaterial = material(world, {
    baseColor: [0.05, 0.35, 1, 1],
    emissive: [0.02, 0.12, 0.8],
    emissiveIntensity: 1,
    roughness: 0.25,
  });
  const leftEarMaterial = material(world, { baseColor: [0.85, 0.04, 0.04, 1], roughness: 0.45 });
  const rightEarMaterial = material(world, { baseColor: [0.04, 0.85, 0.22, 1], roughness: 0.45 });
  const guideMaterial = material(world, { baseColor: [0.08, 0.12, 0.18, 1], roughness: 0.8 });

  const cameraPos: [number, number, number] = [0, 0, 9];
  const camera = world
    .spawn(
      {
        component: Transform,
        data: { pos: cameraPos, quat: quat.fromLookAt(quat.create(), cameraPos, [0, 0, 0], [0, 1, 0]) },
      },
      { component: Camera, data: { ...perspective({ fov: Math.PI / 3, aspect }), near: 0.1, far: 100 } },
    )
    .unwrap();

  const listener = world
    .spawn({ component: Transform, data: { pos: [0, 0, 0] } }, { component: AudioListener, data: {} })
    .unwrap();

  const emitter = world
    .spawn(
      { component: Transform, data: { pos: [0, 1.2, 0], scale: [0.7, 0.7, 0.7] } },
      { component: MeshFilter, data: { assetHandle: HANDLE_SPHERE } },
      { component: MeshRenderer, data: { materials: [emitterMaterial] } },
      {
        component: AudioSource,
        data: { clip: HANDLE_NONE, playing: false, loop: true, volume: 0.8, spatialBlend: 1, bus: 'sfx' },
      },
    )
    .unwrap();

  const leftEar = marker(world, HANDLE_CUBE, leftEarMaterial, [-0.45, 0, 0], [0.08, 0.08, 0.08]);
  const rightEar = marker(world, HANDLE_CUBE, rightEarMaterial, [0.45, 0, 0], [0.08, 0.08, 0.08]);

  world.spawn(
    { component: Transform, data: { pos: [0, -2.2, -0.5], scale: [6, 0.08, 0.08] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [guideMaterial] } },
  );
  world.spawn({ component: DirectionalLight, data: { direction: [-0.5, -1, -0.3], color: [1, 1, 1], intensity: 2 } });

  return { camera, listener, emitter, leftEar, rightEar };
}
