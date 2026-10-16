import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { quat } from '@forgeax/engine-math';
import type { MaterialAsset } from '@forgeax/engine-types';
import { Camera, DirectionalLight, Materials, MeshFilter, MeshRenderer, perspective, Skylight, TONEMAP_ACES_FILMIC } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';

export const DOF_MODE_OFF = 0;
export const DOF_MODE_GAUSSIAN = 1;
export const DOF_MODE_BOKEH = 2;
export const DOF_PARAM_BYTES = 32;

export interface DepthOfFieldScene {
  readonly camera: EntityHandle;
  readonly meshCount: number;
}

export function packDofParams(
  focalDistance: number,
  aperture: number,
  mode: number,
  nearClip = 0.1,
  farClip = 60,
  maxBlurPixels = 10,
): Uint8Array {
  const bytes = new ArrayBuffer(DOF_PARAM_BYTES);
  const values = new Float32Array(bytes);
  values[0] = focalDistance;
  values[1] = nearClip;
  values[2] = farClip;
  values[3] = mode;
  values[4] = aperture;
  values[5] = maxBlurPixels;
  return new Uint8Array(bytes);
}

export function buildDepthOfFieldWorld(world: World, aspect: number): DepthOfFieldScene {
  const colors: readonly [number, number, number, number][] = [
    [0.95, 0.22, 0.16, 1],
    [0.18, 0.58, 0.98, 1],
    [0.96, 0.68, 0.12, 1],
    [0.25, 0.88, 0.42, 1],
  ];
  const positions: readonly [number, number, number][] = [
    [-2.4, 0.0, 4.0],
    [2.1, 0.2, 0.5],
    [-1.6, 0.1, -3.5],
    [1.8, -0.05, -7.0],
  ];
  for (let i = 0; i < positions.length; i += 1) {
    const position = positions[i];
    if (position === undefined) continue;
    const material = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', Materials.standard({
      baseColor: colors[i] ?? [1, 1, 1, 1],
      roughness: 0.42,
      metallic: 0.05,
    }));
    world.spawn(
      { component: Transform, data: { pos: position, scale: [1.05, 1.05, 1.05] } },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [material] } },
    ).unwrap();
  }

  const floorMaterial = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', Materials.standard({
    baseColor: [0.16, 0.19, 0.24, 1],
    roughness: 0.9,
  }));
  world.spawn(
    { component: Transform, data: { pos: [0, -1.3, -1.5], scale: [7.5, 0.15, 10] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [floorMaterial] } },
  ).unwrap();

  world.spawn({ component: DirectionalLight, data: { direction: [-0.35, -0.8, -0.4], color: [1, 0.92, 0.78], intensity: 3.2, castShadow: true } });
  world.spawn({ component: Skylight, data: { color: [0.22, 0.28, 0.4], intensity: 0.7 } });

  const eye: [number, number, number] = [0, 2.1, 12];
  const camera = world.spawn(
    { component: Transform, data: { pos: eye, quat: quat.fromLookAt(quat.create(), eye, [0, 0.0, -2], [0, 1, 0]) } },
    { component: Camera, data: { ...perspective({ fov: Math.PI / 4, aspect, near: 0.1, far: 60 }), tonemap: TONEMAP_ACES_FILMIC, clearColor: [0.015, 0.02, 0.035, 1] } },
  ).unwrap();
  return { camera, meshCount: positions.length + 1 };
}
