import { HANDLE_CUBE, HANDLE_SPHERE } from '@forgeax/engine-assets-runtime';
import { AudioListener, AudioSource } from '@forgeax/engine-audio';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { quat } from '@forgeax/engine-math';
import type { Handle, MaterialAsset } from '@forgeax/engine-types';
import { Camera, DirectionalLight, Materials, MeshFilter, MeshRenderer, perspective } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';

export const HANDLE_NONE = 0 as unknown as Handle<'AudioClipAsset', 'shared'>;

export interface AudioScene {
  readonly camera: EntityHandle;
  readonly source: EntityHandle;
}

function material(world: World, options: Parameters<typeof Materials.standard>[0]): Handle<'MaterialAsset', 'shared'> {
  return world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', Materials.standard(options));
}

export function buildAudioWorld(world: World, aspect: number): AudioScene {
  const sourceMaterial = material(world, { baseColor: [0.05, 0.35, 1, 1], emissive: [0.02, 0.12, 0.8], emissiveIntensity: 1, roughness: 0.25 });
  const pathMaterial = material(world, { baseColor: [0.75, 0.82, 0.9, 1], roughness: 0.5 });
  const floorMaterial = material(world, { baseColor: [0.08, 0.12, 0.18, 1], roughness: 0.8 });
  const cameraPos: [number, number, number] = [0, 2.4, 7];
  const camera = world.spawn(
    { component: Transform, data: { pos: cameraPos, quat: quat.fromLookAt(quat.create(), cameraPos, [0, 0.7, 0], [0, 1, 0]) } },
    { component: Camera, data: { ...perspective({ fov: Math.PI / 3, aspect }), near: 0.1, far: 100 } },
    { component: AudioListener, data: {} },
  ).unwrap();
  const source = world.spawn(
    { component: Transform, data: { pos: [0, 0.9, 0], scale: [0.8, 0.8, 0.8] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_SPHERE } },
    { component: MeshRenderer, data: { materials: [sourceMaterial] } },
    { component: AudioSource, data: { clip: HANDLE_NONE, playing: false, loop: true, volume: 1, spatialBlend: 0, bus: 'music' } },
  ).unwrap();
  for (const x of [-2.4, -1.2, 1.2, 2.4]) {
    world.spawn(
      { component: Transform, data: { pos: [x, 0.35, 0], scale: [0.45, 0.45, 0.45] } },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [pathMaterial] } },
    );
  }
  world.spawn(
    { component: Transform, data: { pos: [0, -0.65, 0], scale: [7, 0.15, 7] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [floorMaterial] } },
  );
  world.spawn({ component: DirectionalLight, data: { direction: [-0.5, -1, -0.3], color: [1, 1, 1], intensity: 2 } });
  return { camera, source };
}
