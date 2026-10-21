import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { type World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { createSphereGeometry } from '@forgeax/engine-geometry';
import { quat } from '@forgeax/engine-math';
import type { AssetHandle } from '@forgeax/engine-types';
import {
  ANTIALIAS_MSAA,
  Camera,
  Materials,
  MeshFilter,
  MeshRenderer,
  perspective,
  PointLight,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';

const ALPHA_BLEND = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
} as const;

export interface TransparencyScene {
  readonly materials: readonly {
    readonly handle: AssetHandle<'material'>;
    readonly color: readonly [number, number, number];
  }[];
}

function spawnMesh(
  world: World,
  mesh: AssetHandle<'mesh'>,
  material: AssetHandle<'material'>,
  pos: readonly [number, number, number],
  scale: readonly [number, number, number] = [1, 1, 1],
): void {
  world.spawn(
    { component: Transform, data: { pos, quat: [0, 0, 0, 1], scale } },
    { component: MeshFilter, data: { assetHandle: mesh } },
    { component: MeshRenderer, data: { materials: [material] } },
  );
}

export function buildTransparencyWorld(world: World, assets: AssetRegistry, aspect: number): TransparencyScene {
  const cube = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  const plane = assets.create(Materials.standard({
    baseColor: [0.18, 0.18, 0.18, 1],
    roughness: 1,
  })).unwrap();
  spawnMesh(world, cube, plane, [0, -0.05, 0], [8, 0.05, 8]);

  const sphereGeometry = createSphereGeometry(0.5, 32, 16);
  if (!sphereGeometry.ok) throw new Error(`transparency-3d sphere geometry failed: ${sphereGeometry.error.code}`);
  const sphere = assets.create(sphereGeometry.value).unwrap();

  const opaqueRed = assets.create(Materials.standard({
    baseColor: [0.9, 0.05, 0.05, 1],
    roughness: 0.35,
  })).unwrap();
  spawnMesh(world, sphere, opaqueRed, [0, 0.5, -1.5]);

  const maskedGreen = assets.create(Materials.standard({
    baseColor: [0.05, 0.8, 0.1, 1],
    roughness: 0.45,
    alphaCutoff: 0.5,
    queue: 2450,
  })).unwrap();
  spawnMesh(world, sphere, maskedGreen, [1, 0.5, -1.5]);

  const maskedUnlitGreen = assets.create(Materials.unlit([0.05, 0.8, 0.1, 1], {
    alphaCutoff: 0.1,
    queue: 2450,
  })).unwrap();
  spawnMesh(world, sphere, maskedUnlitGreen, [-1, 0.5, -1.5]);

  const blendedBlue = assets.create(Materials.standard({
    baseColor: [0.05, 0.15, 0.9, 1],
    roughness: 0.35,
    renderState: { blend: ALPHA_BLEND, depthWriteEnabled: false },
    queue: 3000,
  })).unwrap();
  spawnMesh(world, cube, blendedBlue, [0, 0.5, 0]);

  const alphaCoverageGreen = assets.create(Materials.standard({
    baseColor: [0.05, 0.8, 0.1, 1],
    roughness: 0.45,
    renderState: { alphaToCoverageEnabled: true },
    queue: 2450,
  })).unwrap();
  spawnMesh(world, cube, alphaCoverageGreen, [-1.5, 0.5, 0]);

  world.spawn(
    { component: Transform, data: { pos: [4, 8, 4], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: PointLight, data: { color: [1, 1, 1], intensity: 700, range: 40 } },
  );

  const cameraPosition = [-2, 3, 5] as const;
  world.spawn(
    { component: Transform, data: { pos: cameraPosition, quat: quat.fromLookAt(quat.create(), cameraPosition, [0, 0.5, 0], [0, 1, 0]), scale: [1, 1, 1] } },
    { component: Camera, data: { ...perspective({ fov: Math.PI / 4, aspect }), antialias: ANTIALIAS_MSAA } },
  );

  return {
    materials: [
      { handle: maskedGreen, color: [0.05, 0.8, 0.1] },
      { handle: maskedUnlitGreen, color: [0.05, 0.8, 0.1] },
      { handle: blendedBlue, color: [0.05, 0.15, 0.9] },
      { handle: alphaCoverageGreen, color: [0.05, 0.8, 0.1] },
    ],
  };
}

export function stepTransparencyAlpha(assets: AssetRegistry, scene: TransparencyScene, elapsed: number): number {
  const alpha = Math.sin(elapsed) / 2 + 0.5;
  for (const material of scene.materials) {
    assets.update(material.handle, { values: { baseColor: [...material.color, alpha] } }).unwrap();
  }
  return alpha;
}
