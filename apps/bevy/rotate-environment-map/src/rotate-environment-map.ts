import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { type EntityHandle, type World } from '@forgeax/engine-ecs';
import { createSphereGeometry } from '@forgeax/engine-geometry';
import { quat } from '@forgeax/engine-math';
import type { Handle, MaterialAsset } from '@forgeax/engine-types';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  perspective,
  PointLight,
  SkyboxBackground,
  Skylight,
  TONEMAP_ACES_FILMIC,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';

export interface EnvironmentScene {
  readonly skylight: EntityHandle;
  readonly skybox: EntityHandle;
}

export function buildEnvironmentWorld(
  world: World,
  equirect: Handle<'EquirectAsset', 'shared'>,
  aspect: number,
): EnvironmentScene {
  const sphereGeometry = createSphereGeometry(1.25, 48, 32);
  if (!sphereGeometry.ok) throw new Error(`rotate-environment-map sphere failed: ${sphereGeometry.error.code}`);
  const sphere = world.allocSharedRef('MeshAsset', sphereGeometry.value);
  const gold = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [1, 0.72, 0.18, 1], metallic: 0.9, roughness: 0.1 }),
  );
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: MeshFilter, data: { assetHandle: sphere } },
    { component: MeshRenderer, data: { materials: [gold] } },
  );

  world.spawn(
    { component: Transform, data: { pos: [0, -1.8, 0], quat: [0, 0, 0, 1], scale: [8, 0.05, 8] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [gold] } },
  );
  world.spawn({ component: PointLight, data: { color: [1, 1, 1], intensity: 100_000, range: 40 } });
  world.spawn({ component: DirectionalLight, data: { direction: [0.4, -1, 0.3], intensity: 500 } });

  const skylight = world.spawn({ component: Skylight, data: { equirect, intensity: 1, rotation: [0, 0, 0, 1] } }).unwrap();
  const skybox = world.spawn({ component: SkyboxBackground, data: { equirect, rotation: [0, 0, 0, 1] } }).unwrap();
  const cameraPosition = [0, 0.3, 8] as const;
  world.spawn(
    { component: Transform, data: { pos: cameraPosition, quat: quat.fromLookAt(quat.create(), cameraPosition, [0, 0, 0], [0, 1, 0]), scale: [1, 1, 1] } },
    { component: Camera, data: { ...perspective({ fov: Math.PI / 3, aspect, near: 0.1, far: 100 }), tonemap: TONEMAP_ACES_FILMIC } },
  );
  return { skylight, skybox };
}

export function stepEnvironmentRotation(world: World, scene: EnvironmentScene, elapsed: number): number {
  const angle = 0.2 * elapsed;
  const rotation = quat.fromEuler(quat.create(), 0, angle, 0, 'YXZ');
  const value: [number, number, number, number] = [rotation[0] ?? 0, rotation[1] ?? 0, rotation[2] ?? 0, rotation[3] ?? 1];
  world.set(scene.skylight, Skylight, { rotation: value });
  world.set(scene.skybox, SkyboxBackground, { rotation: value });
  return angle;
}
