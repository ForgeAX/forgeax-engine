import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { defineSystem, FixedTime, FixedUpdate, type World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { vec3 } from '@forgeax/engine-math';
import type { PhysicsWorld, PhysicsWorld2D } from '@forgeax/engine-physics';
import { RapierPhysicsWorld3D } from '@forgeax/engine-physics-rapier3d';
import {
  Camera,
  CameraView,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  perspective,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { AssetHandle } from '@forgeax/engine-types';
import type { AppLevelCandidate, AppLevelOwner } from '../src/levels/app-level-owner';
import type { LevelRenderSelection } from '../src/levels/candidate-render-source';
import { LEVEL_STREAMING_SOURCE_COMPONENTS } from '../src/levels/source-preflight';

export interface LevelFixtureStatus {
  phase?: string;
  current?: boolean;
  memberCount?: number;
  tick: number;
  hit?: number;
  error?: string;
  failure?: string;
  cleanupFailure?: string;
  renderSelection?: LevelRenderSelection | undefined;
}

export function levelFixtureError(cause: unknown): string | undefined {
  if (cause === undefined) return undefined;
  return JSON.stringify(cause, (_key, value) =>
    value instanceof Error
      ? { ...Object.fromEntries(Object.entries(value)), message: value.message, stack: value.stack, cause: value.cause }
      : value,
  );
}

export function installLevelFixture(
  world: World,
  assets: AssetRegistry,
  physics: PhysicsWorld | PhysicsWorld2D | undefined,
  owner: Pick<AppLevelOwner, 'create'>,
  rootGuid: string,
  firstLevel = false,
) {
  for (const component of LEVEL_STREAMING_SOURCE_COMPONENTS)
    if (world.components.resolve(component.name) === undefined)
      world.components.register(component).unwrap();
  if (!(physics instanceof RapierPhysicsWorld3D))
    throw Error('Missing Rapier3D for the static Level fixture');
  const raycast = () => physics.raycast(vec3.create(0, 5, 0), vec3.create(0, -1, 0), 10);
  const camera = world.spawn(
    {
      component: Transform,
      data: { pos: [1, 2, 8], quat: [-Math.sin(0.12), 0, 0, Math.cos(0.12)] },
    },
    { component: Camera, data: perspective({ fov: 1, aspect: 1 }) },
  ).unwrap();
  world.spawn({
    component: DirectionalLight,
    data: {
      castShadow: true,
      intensity: 10000,
      direction: [-0.4, -1, -0.5],
      mapSize: 2048,
      cascadeCount: 3,
    },
  }).unwrap();
  const mesh = firstLevel
    ? undefined
    : assets.create(createBoxGeometry(0.5, 0.5, 0.5).unwrap()).unwrap();
  const permanent = world.spawn(
    { component: Transform, data: { pos: [-2, 1, 0] } },
    ...(mesh === undefined
      ? []
      : [
          { component: MeshFilter, data: { assetHandle: mesh } },
          { component: MeshRenderer, data: {} },
        ]),
  ).unwrap();
  const movement = defineSystem({
    name: 'permanent-motion',
    queries: [],
    fn: () => world.set(permanent, Transform, {
      pos: [-2 + 0.2 * Math.sin(world.getResource(FixedTime).tick * 0.03), 1, 0],
    }).unwrap(),
  });
  world.addSystem(FixedUpdate, movement).unwrap();
  let level: AppLevelCandidate | undefined;
  let loaded: AssetHandle<'scene'> | undefined;
  return {
    async request(kind: string): Promise<LevelFixtureStatus> {
      if (kind === 'load') {
        loaded = (await assets.load(rootGuid, 'scene')).unwrap();
        level = owner.create(loaded).unwrap();
      } else if (kind === 'open-split-view') {
        world.addComponent(camera, {
          component: CameraView,
          data: { viewport: [0, 0, 0.5, 1] },
        }).unwrap();
        world.spawn(
          {
            component: Transform,
            data: { pos: [1, 2, 8], quat: [-Math.sin(0.12), 0, 0, Math.cos(0.12)] },
          },
          { component: Camera, data: perspective({ fov: 1, aspect: 1 }) },
          { component: CameraView, data: { viewport: [0.5, 0, 0.5, 1], order: 1 } },
        ).unwrap();
      } else if (kind === 'active' || kind === 'prepared' || kind === 'unloaded') {
        const failure = level?.inspect().failure;
        if (failure !== undefined) throw failure;
        level?.target(kind).unwrap();
      }
      const status = level?.inspect();
      if (status?.phase === 'retired' && loaded !== undefined) {
        assets.release(loaded).unwrap();
        loaded = undefined;
      }
      return {
        phase: status?.phase,
        current: status?.current,
        failure: levelFixtureError(status?.failure),
        cleanupFailure: levelFixtureError(status?.cleanupFailure),
        renderSelection: status?.renderSelection,
        memberCount: level?.members.length,
        tick: world.getResource(FixedTime).tick,
        hit: raycast()?.entity,
      };
    },
    dispose: () => world.removeSystem(FixedUpdate, movement).unwrap(),
  };
}
