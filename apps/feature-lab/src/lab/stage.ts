import { AssetRegistry } from '@forgeax/engine/assets-runtime';
import type { EntityHandle, World } from '@forgeax/engine/ecs';
import { createPrimitiveMesh } from '@forgeax/engine/geometry';
import { quat } from '@forgeax/engine/math';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  perspective,
} from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';
import type { AssetHandle, MaterialAsset } from '@forgeax/engine/types';

export type Vec3 = readonly [number, number, number];

type MeshHandle = AssetHandle<'mesh'>;
type MaterialHandle = AssetHandle<'material'>;
type CameraData = Readonly<Record<string, unknown>>;

export function lookRotation(eye: Vec3, target: Vec3): Float32Array {
  return quat.fromLookAt(quat.create(), eye, target, [0, 1, 0]) as Float32Array;
}

export function material(world: World, asset: MaterialAsset): MaterialHandle {
  const assets = world.assets;
  if (!(assets instanceof AssetRegistry)) throw new Error('Stage requires its runtime asset owner');
  return assets.create(asset).unwrap();
}

export function standard(
  world: World,
  options: Parameters<typeof Materials.standard>[0],
): MaterialHandle {
  return material(world, Materials.standard(options));
}

export function unlit(
  world: World,
  rgba: readonly [number, number, number, number],
): MaterialHandle {
  return material(world, Materials.unlit(rgba));
}

export interface CameraOptions {
  readonly eye?: Vec3;
  readonly target?: Vec3;
  readonly fov?: number;
  /** Extra Camera fields (tonemap, bloom, clearColor, ...). */
  readonly data?: CameraData;
}

export function spawnCamera(world: World, options: CameraOptions = {}): EntityHandle {
  const eye = options.eye ?? [0, 1.5, 5];
  const target = options.target ?? [0, 0.5, 0];
  return world
    .spawn(
      { component: Transform, data: { pos: eye, quat: lookRotation(eye, target) } },
      {
        component: Camera,
        data: {
          ...perspective({ fov: options.fov ?? Math.PI / 4, aspect: 16 / 9 }),
          clearColor: [0.08, 0.09, 0.12, 1],
          ...options.data,
        } as never,
      },
    )
    .unwrap() as EntityHandle;
}

export function spawnSun(
  world: World,
  options: {
    readonly direction?: Vec3;
    readonly intensity?: number;
    readonly data?: Record<string, unknown>;
  } = {},
): EntityHandle {
  return world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: options.direction ?? [-0.4, -1, -0.5],
        color: [1, 1, 1],
        intensity: options.intensity ?? 2,
        ...options.data,
      } as never,
    })
    .unwrap() as EntityHandle;
}

export interface MeshOptions {
  readonly pos?: Vec3;
  readonly scale?: Vec3;
  readonly rotation?: readonly [number, number, number, number] | Float32Array;
}

export function spawnMesh(
  world: World,
  mesh: MeshHandle,
  mat: MaterialHandle,
  options: MeshOptions = {},
  ...extra: readonly { readonly component: unknown; readonly data?: unknown }[]
): EntityHandle {
  return world
    .spawn(
      {
        component: Transform,
        data: {
          pos: options.pos ?? [0, 0, 0],
          quat: options.rotation ?? [0, 0, 0, 1],
          scale: options.scale ?? [1, 1, 1],
        },
      },
      { component: MeshFilter, data: { assetHandle: mesh } as never },
      { component: MeshRenderer, data: { materials: [mat] } as never },
      ...(extra as never[]),
    )
    .unwrap() as EntityHandle;
}

/** A 12 m grey floor slab whose top face sits at y = 0. */
export function spawnGround(
  world: World,
  color: readonly [number, number, number, number] = [0.55, 0.55, 0.58, 1],
): EntityHandle {
  const assets = world.assets;
  if (!(assets instanceof AssetRegistry)) throw new Error('Stage requires its runtime asset owner');
  const cube = assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();
  return spawnMesh(world, cube, standard(world, { baseColor: color, roughness: 0.9 }), {
    pos: [0, -0.05, 0],
    scale: [12, 0.1, 12],
  });
}

/** Camera + sun + floor: the default stage most visual features start from. */
export function spawnStage(
  world: World,
  camera: CameraOptions = {},
): { camera: EntityHandle; sun: EntityHandle } {
  spawnGround(world);
  return { camera: spawnCamera(world, camera), sun: spawnSun(world) };
}
