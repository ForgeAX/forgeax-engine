import type { EntityHandle, World } from '@forgeax/engine-ecs';
import {
  Camera,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  PointLight,
  Skylight,
  perspective,
} from '@forgeax/engine-render';
import { HANDLE_CUBE, HANDLE_CYLINDER, HANDLE_SPHERE } from '@forgeax/engine-assets-runtime';
import { quat } from '@forgeax/engine-math';
import { ChildOf, Transform } from '@forgeax/engine-scene';
import type { Handle } from '@forgeax/engine-types';

export interface BossSceneMaterials {
  readonly body: Handle<'MaterialAsset', 'shared'>;
  readonly accent: Handle<'MaterialAsset', 'shared'>;
  readonly mouth: Handle<'MaterialAsset', 'shared'>;
  readonly groundWarning: Handle<'MaterialAsset', 'shared'>;
  readonly strike: Handle<'MaterialAsset', 'shared'>;
}

export interface BossScene {
  readonly player: EntityHandle;
  readonly body: EntityHandle;
  readonly head: EntityHandle;
  readonly mouthGlow: EntityHandle;
  readonly mouthJoint: EntityHandle;
  readonly camera: EntityHandle;
  readonly groundWarning: EntityHandle;
  readonly strike: EntityHandle;
}

type Position = [number, number, number];
type Scale = [number, number, number];

/** One world-space attack anchor shared by the warning, strike and VFX cue. */
export const BOSS_ATTACK_TARGET = [1.3, -0.76, 0.95] as const;

function spawnMesh(
  world: World,
  mesh: Handle<'MeshAsset', 'shared'>,
  material: Handle<'MaterialAsset', 'shared'>,
  pos: Position,
  scale: Scale,
  parent?: EntityHandle,
): EntityHandle {
  const transform = { component: Transform, data: { pos, scale } };
  const renderable = [
    { component: MeshFilter, data: { assetHandle: mesh } },
    { component: MeshRenderer, data: { materials: [material] } },
  ] as const;
  if (parent === undefined) return world.spawn(transform, ...renderable).unwrap();
  return world
    .spawn(transform, { component: ChildOf, data: { parent } }, ...renderable)
    .unwrap();
}

export function createBossScene(
  world: World,
  materials: BossSceneMaterials,
): BossScene {
  // Keep the boss and its mouth-to-ground attack in one readable frame. The
  // previous long lens left a large empty field around a small subject and
  // made the warning/strike look detached from the actor.
  const cameraPosition: Position = [0.2, 1.15, 5.8];
  const cameraTarget: Position = [0.2, 0.35, 0];
  const cameraRotation = quat.fromLookAt(quat.create(), cameraPosition, cameraTarget, [0, 1, 0]);
  const player = world
    .spawn(
      { component: Transform, data: { pos: [-0.85, -0.3, 0] } },
    )
    .unwrap();
  const body = spawnMesh(world, HANDLE_CUBE, materials.body, [0, 0.78, 0], [1.15, 1.4, 0.8], player);
  for (const side of [-1, 1]) {
    spawnMesh(world, HANDLE_CUBE, materials.accent, [side * 0.7, 1.12, 0], [0.5, 0.55, 0.65], player);
    spawnMesh(world, HANDLE_CUBE, materials.body, [side * 0.85, 0.58, 0.08], [0.36, 0.7, 0.42], player);
    spawnMesh(world, HANDLE_CUBE, materials.accent, [side * 0.35, -0.12, 0.15], [0.46, 0.65, 0.65], player);
  }
  // A small collar hides the sphere intersection and gives the two body
  // masses a deliberate silhouette instead of a single egg-shaped blob.
  spawnMesh(world, HANDLE_CYLINDER, materials.accent, [0, 1.36, 0.04], [0.82, 0.12, 0.64], player);
  const head = spawnMesh(world, HANDLE_CUBE, materials.accent, [0, 1.72, 0.04], [0.75, 0.6, 0.64], player);
  spawnMesh(world, HANDLE_CYLINDER, materials.accent, [-0.3, 2.13, 0], [0.12, 0.36, 0.12], player);
  spawnMesh(world, HANDLE_CYLINDER, materials.accent, [0.3, 2.13, 0], [0.12, 0.36, 0.12], player);
  const mouthJoint = world
    .spawn(
      { component: Transform, data: { pos: [0, 1.3, 0.9] } },
      { component: ChildOf, data: { parent: player } },
    )
    .unwrap();
  const mouthGlow = spawnMesh(
    world,
    HANDLE_SPHERE,
    materials.mouth,
    [0, 1.3, 0.9],
    [0.12, 0.12, 0.1],
    player,
  );
  world.addComponent(mouthGlow, {
    component: PointLight,
    data: { color: [0.15, 0.65, 1], intensity: 4, range: 3 },
  }).unwrap();
  const camera = world
    .spawn(
      { component: Transform, data: { pos: cameraPosition, quat: cameraRotation } },
      {
        component: Camera,
        data: {
          ...perspective({ fov: Math.PI / 3, aspect: 16 / 9 }),
          tonemap: 1,
          exposure: 0.85,
          bloom: 1,
          bloomThreshold: 1.15,
          bloomIntensity: 0.5,
          bloomSoftKnee: 0.5,
          bloomScatter: 0.7,
          clearColor: [0.008, 0.012, 0.04, 1],
        },
      },
    )
    .unwrap();
  world.spawn({
    component: DirectionalLight,
    data: { direction: [-0.28, -0.55, -0.78], color: [0.75, 0.84, 1], intensity: 2.3, castShadow: false },
  }).unwrap();
  // Keep the key light directional while supplying a restrained ambient floor
  // for the unlit side of the low-poly body. This is the renderer's normal
  // Skylight route, not a second per-mesh material workaround.
  world.spawn({
    component: Skylight,
    data: { color: [0.06, 0.08, 0.18], intensity: 0.72 },
  }).unwrap();
  // A low-contrast floor gives the warning/strike a real world anchor. The
  // previous isolated cube floated against the clear color and made the
  // attack look disconnected even when its endpoint was correct.
  spawnMesh(world, HANDLE_CUBE, materials.body, [0, -0.85, 0], [12, 0.05, 10]);
  const groundWarning = spawnMesh(
    world,
    HANDLE_CYLINDER,
    materials.groundWarning,
    [BOSS_ATTACK_TARGET[0], BOSS_ATTACK_TARGET[1], BOSS_ATTACK_TARGET[2]],
    [1.0, 0.025, 0.46],
  );
  // Place the strike on the warning plane so it reads as the target marker,
  // not as a second floating object between the boss and the floor.
  const strike = spawnMesh(
    world,
    HANDLE_CUBE,
    materials.strike,
    [BOSS_ATTACK_TARGET[0], BOSS_ATTACK_TARGET[1] + 0.12, BOSS_ATTACK_TARGET[2]],
    [0.035, 0.04, 0.035],
  );
  world.addComponent(strike, {
    component: PointLight,
    data: { color: [0.12, 0.5, 1], intensity: 3, range: 2 },
  }).unwrap();
  return { player, body, head, mouthGlow, mouthJoint, camera, groundWarning, strike };
}
